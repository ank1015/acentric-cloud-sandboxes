# Daytona: exec_python / wait feasibility from a stateless Cloudflare Worker

Researched 2026-10-12 from docs, OpenAPI specs and source only. Nothing was run live and no credentials were used.

Source caveat: `github.com/daytonaio/daytona` `main` is a stub. Its README says development moved to a private codebase in June 2026 (see Sources [S1]). The last public source is tag `v0.190.0`. The live docs and OpenAPI specs describe a newer daemon (docs banner v0.223). Everything below marked "(source v0.190.0)" is read from that tag and must be re-verified against the live version. Everything marked "(spec)" comes from the live OpenAPI at `https://www.daytona.io/docs/toolbox-openapi.json` or `openapi.json`.

---

## 1. API surface and transport

Daytona has two HTTP APIs, both plain REST/JSON and callable from a Worker with `fetch`.

1. **Control plane** at `https://app.daytona.io/api` (spec: `openapi.json`, server URL listed as localhost, so the real base comes from the docs curl examples).
   - Auth is `Authorization: Bearer <API_KEY>` (spec `securitySchemes.bearer`, "API Key access"; JWT/OIDC is also accepted).
   - A JWT needs the `X-Daytona-Organization-ID` header. An API key is org-scoped and does not.
   - Relevant endpoints: `POST /sandbox`, `GET /sandbox/{idOrName}`, `GET /sandbox` (filters include `labels`, `states`), `POST /sandbox/{id}/start|stop|archive|pause`, `DELETE /sandbox/{id}`, `POST /sandbox/{id}/autostop/{min}`, `POST /sandbox/{id}/last-activity`, `GET /sandbox/{id}/toolbox-proxy-url`.
2. **Toolbox API**, which runs inside the sandbox. It is reached through a proxy at
   `{toolboxProxyUrl}/{sandboxId}/{endpoint}`. For Daytona Cloud the base is `https://proxy.app.daytona.io/toolbox/{sandboxId}` (spec description of `toolbox-openapi.json`; docs `tools/api`).
   - `toolboxProxyUrl` is a field on the Sandbox DTO returned by `GET /sandbox/{id}` (spec `Sandbox.toolboxProxyUrl`). Self-hosted or regional deployments can differ, so read it per sandbox.
   - Auth is the same org API key as `Authorization: Bearer <API_KEY>` (spec `securitySchemes.Bearer`). The proxy validates the bearer against the control-plane API and caches the result, then strips the header before forwarding (source v0.190.0: `apps/proxy/pkg/proxy/auth.go`, `get_sandbox_target.go`).
   - The proxy forwards to the runner, which forwards to the daemon on container port 2280 (source: `apps/runner/pkg/api/controllers/proxy.go`).

Transport per feature:

| Feature                                                                                                                             | Transport                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sandbox CRUD, session create/delete/exec, get command, send input, `/process/execute`, `/process/code-run`, files, `/user-home-dir` | plain REST                                                                                |
| Command logs `GET .../logs`                                                                                                         | REST (snapshot)                                                                           |
| Command logs `?follow=true`                                                                                                         | WebSocket from the daemon. The runner also exposes a chunked-HTTP bridge (see section 4). |
| Code interpreter `GET /process/interpreter/execute`                                                                                 | WebSocket only (spec: 101 Switching Protocols)                                            |
| PTY `GET /process/pty/{id}/connect`                                                                                                 | WebSocket only                                                                            |

**Worker compatibility.** All REST calls work with `fetch`. WebSockets can be opened outbound from a Worker by calling `fetch` with an `Upgrade: websocket` header (standard Workers behaviour, not re-verified here). That is not needed for the recommended design.

**SDK header gotcha.** The daemon changes response shapes by the `X-Daytona-SDK-Version` header (source v0.190.0: `internal/util/version.go`, `pkg/session/common.go`). A raw `fetch` with no header gets legacy shapes. See section 4.

---

## 2. Sandbox lifecycle

- **Create:** `POST /sandbox`. Useful body fields: `snapshot`, `language`, `env`, `labels`, `autoStopInterval`, `autoArchiveInterval`, `autoDeleteInterval`, `ttlMinutes`, `cpu`, `memory`, `disk` (spec `CreateSandbox`). Defaults are 1 vCPU, 1 GB RAM and 3 GiB disk (docs `sandboxes`). The SDK waits for the started state, so poll `GET /sandbox/{id}` until `state == "started"` (verify live whether `POST` returns early).
- **Get:** `GET /sandbox/{idOrName}`. The response has `state`, `toolboxProxyUrl`, `autoStopInterval`, `lastActivityAt` and more. Sandboxes can also be looked up by `name` and filtered by `labels` via `GET /sandbox?labels=<json>`. That is useful for a stateless gateway that wants "find my sandbox by label".
- **Auto-stop** (docs `sandboxes#auto-stop-interval`):
  - Default is 15 minutes of inactivity. `0` disables it. It is settable at create or via `POST /sandbox/{id}/autostop/{interval}`.
  - Docs quote: "The auto-stop triggers even if there are internal processes running in the sandbox." A stop ends the sandbox's processes. A stopped container sandbox keeps its filesystem; memory and processes are gone. "Sandboxes in a stopping or stopped state will no longer accept requests."
  - **What resets the timer** (docs): sandbox lifecycle state changes, sandbox preview network requests, SSH connections, and "API requests to the Daytona Toolbox".
  - **What does not:** background scripts, long tasks without external interaction.
  - **Verified in proxy source (v0.190.0):** every toolbox request through the proxy calls `updateLastActivity`, unless the request carries `X-Daytona-Skip-Last-Activity-Update: true` (`apps/proxy/pkg/proxy/get_sandbox_target.go`). For long-lived requests it re-pings every 50 s. Result: each `wait` poll resets the idle timer, but a background Python job whose agent never polls dies at the auto-stop interval. Set `autoStopInterval` generously or `0`. `POST /sandbox/{id}/last-activity` is an explicit refresh.
- **Auto-archive:** default 7 days of continuous stopped time. `0` means 30 days. Containers only. VM sandboxes cannot archive (docs lifecycle table).
- **Auto-delete:** default never. `-1` disables, `0` deletes immediately on stop (ephemeral). `ttlMinutes` is a hard wall-clock TTL since creation (spec).
- **Pause/resume:** `POST /sandbox/{id}/pause` and `/start`. Linux-VM and Windows classes only, not the default container class (docs lifecycle table). Pause preserves memory and filesystem, so running processes plausibly survive. VM sandboxes default to auto-pause at 60 minutes and the pause interval is mutually exclusive with auto-stop. Not verified for process survival. See open questions.
- **Idle cost** (docs `billing`, `limits`, and the pricing page [S12]):
  - Running is billed per vCPU, GiB RAM and GiB disk. Listed prices: $0.0504 per vCPU-hour, $0.0162 per GiB-hour of memory, $0.000108 per GiB-hour of storage (first 5 GiB free).
  - Default 1 vCPU / 1 GiB / 3 GiB is about $0.067 per hour while running.
  - Stopped is billed for disk only. Archived is cold-storage only.
  - There is no per-request charge. An idle running sandbox costs the full compute rate until auto-stop.

---

## 3. Starting a background process

**Sessions plus async session command** are first-class (docs `process-code-execution`; spec).

```
POST {proxy}/process/session                        {"sessionId":"<id>"}           -> 201 (empty body)
POST {proxy}/process/session/{sid}/exec             {"command":"...", "runAsync":true}  -> 202 {"cmdId":"<uuid>"}
```

- `async` is a legacy alias and `runAsync` is preferred. If either is true, the daemon returns 202 with only `cmdId` (source v0.190.0: `pkg/toolbox/process/session/execute.go`).
- Without `runAsync` the request blocks until the command finishes and returns `{cmdId, output, stdout, stderr, exitCode}` with 200.
- **Survives the HTTP request ending.** Yes. A session is a long-lived `sh` process the daemon spawns (`exec.CommandContext(ctx, shell)` with `Setpgid`), held in daemon memory. A command is written to the shell's stdin as a wrapper script. The daemon does not watch the HTTP request for async commands. Sessions persist until `DELETE /process/session/{sid}`, a sandbox stop, or a daemon restart. The session map is in memory only.
- **Commands in one session run strictly serially.** The wrapper sources the command file in the session shell in the foreground (`{ . cmd.sh; } < $ip > $sp 2> $ep`), so a second command queues behind the first. Use **one session per exec_python execution**.
- Mechanics (source v0.190.0):
  - stdout and stderr are routed through per-command FIFOs. Each line is prefixed with `\x01\x01\x01` for stdout or `\x02\x02\x02` for stderr and appended to `~/.daytona/sessions/<sid>/<cmdId>/output.log`.
  - The exit code is appended to `.../<cmdId>/exit_code` only after the output labelers have flushed.
  - The command text is written to `.../<cmdId>/cmd.sh`.
- **PTY option:** `POST /process/pty` creates a pty session and `GET /process/pty/{id}/connect` is a WebSocket (spec). The shell survives a client disconnect (SDK docs: `disconnect()` closes the WebSocket without killing the shell). I found no scrollback or replay buffer. It is WebSocket-only, so it is unsuitable for a stateless Worker. Not recommended.
- Alternative: `POST /process/execute` (body `command`, `cwd`, `envs`, `timeout` in seconds) blocks and returns `{result, exitCode}`. A detached process can still be launched from it (`setsid nohup ... >f 2>&1 </dev/null &`), because the daemon waits for pipe EOF and the detached child must not hold the stdout/stderr pipes (see section 11, mechanism B). On timeout the daemon SIGKILLs the process group and returns 408.

---

## 4. Output retrieval

**Native endpoint:** `GET /process/session/{sid}/command/{cmdId}/logs`.

- It always returns the **entire log from byte 0**. There is no offset, limit or cursor parameter. The only query parameter is `follow` (spec; source `GetSessionCommandLogs`).
- Response shape depends on `X-Daytona-SDK-Version` (source v0.190.0, `pkg/session/common.go`):
  - No header gives a combined plain-text body with prefixes stripped. Stdout and stderr are interleaved and indistinguishable.
  - Header version >= 0.167.0 gives JSON `{"output": raw-with-prefixes, "stdout": "...", "stderr": "..."}`. Send `X-Daytona-SDK-Version: 0.223.0` or similar. A dev version string containing "dev" also works.
  - Old header versions < 0.27.0 get the legacy combined text.
- **Follow mode.**
  - `?follow=true` with `Upgrade: websocket` is served by the daemon (binary frames of raw log bytes).
  - The runner also bridges `follow=true` without an Upgrade header: it dials the daemon over WebSocket and writes frames out as a chunked `application/octet-stream` HTTP response, flushing each message (source v0.190.0: `apps/runner/pkg/api/controllers/command_logs.go`). So a Worker can consume it with plain `fetch` and `response.body.getReader()`.
  - That bridge dials the daemon without headers, so the output is combined with prefixes stripped.
  - The stream starts at byte 0 of the log (replays history) and ends about 1 s after the exit-code file appears (source: `internal/util/log_reader.go`, 50 consecutive 20 ms EOF reads, then an exit-code check).
  - Whether the public `proxy.app.daytona.io` front end streams the chunked response without buffering is unverified.
- **Output delay and line buffering.**
  - The wrapper labels output line by line (`while IFS= read -r line`). A partial line without a trailing newline is not written until the next newline or EOF.
  - A child process writing to a pipe, such as Python without `-u`, is block-buffered. Use `python3 -u` or `PYTHONUNBUFFERED=1`.
- **Storage and size limits.** Logs are plain files on the sandbox disk (default 3 GiB). Log size is bounded only by disk. There is no truncation. Deleting the session removes the directory (`os.RemoveAll(session.Dir)`), including logs and exit code.
- **Cursor strategy, option 1 (recommended): own output files plus ranged reads.**
  - Do not depend on Daytona's log format. Wrap the user code so it writes to files we control (see section 11).
  - Read incrementally with `GET /files/download?path=<abs path>`, adding `Range: bytes=<offset>-` (sent as an HTTP header; the cursor is the byte offset).
  - The daemon serves downloads with gin `c.File`, which is `http.ServeFile` and supports `Range` (source v0.190.0: `fs/download_file.go`).
  - A range starting at or beyond the file size returns **416**, which is read as "no new bytes". Untested live. Whether the proxy and runner pass `Range` and 206 through is unverified. Fallback: download the whole file and slice client-side (works, but cost grows with output size).
- **Cursor strategy, option 2:** run a tiny `tail -c +N file` via `POST /process/execute` and return `result`. This works without relying on `Range` and also enables server-side long-polling (section 11).
- **Cursor strategy, option 3 (native log, fallback):** fetch the full log, then slice by byte offset. Offsets are into the raw prefixed log, so demux each new slice. Because every line begins with a 3-byte prefix, a cursor taken at a line boundary demuxes cleanly. A cursor in mid-line does not.

---

## 5. Waiting with a timeout, exit codes, retention

- There is **no wait or join endpoint**. Waiting is polling.
- **Exit code:** `GET /process/session/{sid}/command/{cmdId}` returns `{id, command, exitCode?}`. `exitCode` is **omitted while running** (Go `omitempty`; the spec schema marks it optional). Once the exit-code file exists it is returned (source v0.190.0: `pkg/session/get.go`). The docs say "Poll a command's status, including its exit code".
- A synchronous command (`runAsync` false) returns `exitCode` inline.
- **Retention:** the command record lives in daemon memory for the session's lifetime, and the files live in `~/.daytona/sessions/<sid>/<cmdId>/`. There is no TTL. Everything is gone on session delete or sandbox stop. If the daemon restarts, the in-memory command list is lost even though the files remain. A killed command may never get an exit-code file.
- **Race fixed upstream:** a comment in the wrapper says the exit code is written only after the output labelers have flushed, so "exit code present" implies "log complete" (source v0.190.0).
- `GET /process/session/{sid}` lists all commands with their exit codes.
- Server-side long-poll is possible by running a bash loop through `/process/execute`. See section 11.

---

## 6. Terminate

- There is **no per-command kill endpoint**. The toolbox spec has no signal or kill route for session commands.
- **`DELETE /process/session/{sid}`** (204) calls `terminateSession`, which:
  - sends SIGTERM to the session shell's process group (`kill(-pid)`) and walks the descendant tree with SIGTERM;
  - waits up to `DAYTONA_TERMINATION_GRACE_PERIOD`, default **5 s**;
  - then sends SIGKILL to the group and the tree;
  - cancels the context and removes the session directory, including logs and the exit-code file.
- Source v0.190.0: `pkg/session/delete.go`; grace default in `cmd/daemon/config/config.go`.
- The non-interactive shell has no job control, so the Python process and its children share the session's process group. Both group kill and tree walk get them. Processes that call `setsid` or `setpgid` are still reached by the tree walk, unless they have been reparented away.
- With a one-session-per-execution design, `terminate` is simply `DELETE /process/session/{sid}`. Cost: up to ~5 s before the response if the process ignores SIGTERM, and the native exit code is lost. Our own output files (outside `~/.daytona/sessions`) survive.
- Alternative for a graceful per-process kill: `POST /process/execute` with `kill -TERM -<pgid>`, using a pid we recorded.

---

## 7. stdin to a running command

`POST /process/session/{sid}/command/{cmdId}/input` with `{"data":"..."}` returns 204 (spec `SendInput`; source `session/input.go`).

- The daemon appends a newline if missing and writes to the command's input FIFO. Async commands keep the FIFO open with a `sleep` holder.
- It echoes the input into the log with a stdout prefix unless `suppressInputEcho` was set on exec.
- Errors: 410 Gone if the command has an exit code or the session process exited, 404 if not found.
- Python only receives it if it reads fd 0 of the sourced command, so run `python3 -u script.py` (not `python3 - <<EOF`, where the heredoc replaces stdin).
- The proposed `wait` tool has no stdin parameter, so this is optional future scope.

---

## 8. Files API

All under the toolbox base (spec `toolbox-openapi.json`):

| Operation                                           | Endpoint                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Download                                            | `GET /files/download?path=` (binary, supports Range via `http.ServeFile`)                                                          |
| Bulk download                                       | `POST /files/bulk-download`                                                                                                        |
| Upload                                              | `POST /files/upload-v2?path=` (multipart field `file`, or raw body; creates parent directories; overwrites)                        |
| Bulk upload                                         | `POST /files/bulk-upload`                                                                                                          |
| Info / list / find / search / move / delete / mkdir | `GET /files/info`, `GET /files`, `GET /files/find`, `GET /files/search`, `POST /files/move`, `DELETE /files`, `POST /files/folder` |
| Home directory                                      | `GET /user-home-dir`                                                                                                               |

I found no documented size limit. The practical limits are sandbox disk and the Worker's request and memory limits. Relative paths resolve against the daemon working directory. Use absolute paths.

---

## 9. Running Python: `codeRun` and the code interpreter

- **`POST /process/code-run`** (body `{code, language: "python", argv, envs, timeout}`) is synchronous and stateless. It returns `{result, exitCode, artifacts}`. A timeout returns 408 and kills the process group. It has no background or reattach mode. It is useful only for short scripts and blocks the Worker request for the script's duration.
- **Code interpreter** (docs `process-code-execution#...`; spec `/process/interpreter/*`):
  - `POST /process/interpreter/context` creates a stateful Python context. `GET /process/interpreter/context` lists them and `DELETE .../context/{id}` removes one.
  - `GET /process/interpreter/execute` is a **WebSocket** that streams `stdout`, `stderr`, `error` and `control` chunks (`completed`, `interrupted`). The default timeout is 600 s and `0` disables it.
  - The context is stateful and survives disconnects.
  - Output is **not buffered** for absent clients. `emitOutput` drops messages when no client is attached (source v0.190.0: `interpreter/websocket.go`). Reattaching to a run mid-flight loses earlier output.
  - Only one client is attached at a time, and a new one replaces the old.
  - **Verdict:** it fits "stateful REPL" but not "yield and resume with a stateless Worker".
- For one-shot scripts the shell-based approach in section 11 is both simpler and resumable.

---

## 10. Time, rate and concurrency limits

- **Rate limits** (docs `limits`), per organization per minute. Tier 1 has 10,000 general requests, 300 sandbox creations and 10,000 sandbox lifecycle operations. Tier 4 has 50,000, 600 and 50,000. Headers are `X-RateLimit-{Limit,Remaining,Reset}-{throttler}` and `Retry-After-{throttler}`. A 429 means back off.
- **Concurrency** is bounded by organization resources, not by an API-call count. Tier 1 has 10 vCPU, 20 GiB RAM and 30 GiB disk across running sandboxes. The per-sandbox maximum is 4 vCPU, 8 GB RAM and 10 GB disk.
- **Does toolbox traffic count against rate limits?** Unclear. The documented throttlers cover general API, sandbox create and sandbox lifecycle. The toolbox proxy path is not documented as throttled. Verify live.
- **Request duration.** I found no documented per-request cap. The proxy's `IdleTimeout` is 70 s and `ReadHeaderTimeout` 10 s (`libs/common-go/pkg/proxy/server_config.go`). The proxy's API-client timeout is 60 s for its control-plane lookups. Long polls of 30 to 60 s should be fine, but test the actual ceiling, including any CDN in front of `proxy.app.daytona.io`.
- **Subrequests from the Worker:** Cloudflare caps subrequests per invocation (50 on the free plan, 1,000 on paid; not re-verified). Server-side long-polling via a bash loop (section 11) keeps each tool call to 1 to 3 subrequests instead of dozens.

---

## 11. Verdict

**Yes: `exec_python` plus `wait` can be implemented purely over Daytona's REST API from a stateless Worker.** No WebSocket or persistent connection is needed.

### What works natively

- Background execution that outlives the HTTP request: async session command (`runAsync: true`), returns a `cmdId`.
- Exit code via `GET command` (omitted while running).
- Kill via session delete (SIGTERM to the process group and descendants, SIGKILL after 5 s).
- Stdin via the input endpoint.
- Authentication with a plain bearer API key against both the control plane and the toolbox proxy.

### What needs a workaround

- **Cursor-based incremental output.** The native logs endpoint has no offset and always returns everything. The workaround is to redirect the script's output to our own files and read them by byte offset. This also sidesteps the SDK-version-dependent response format and the line-buffering of the native labeler.
- **Wait with timeout.** No wait endpoint exists, so poll. Do the polling inside the sandbox using one `/process/execute` call with a bash loop. This keeps each Worker tool call to 1 to 3 subrequests.
- **Stateless cursor.** `wait({execution_id, yield_time_ms, terminate})` has no `cursor` parameter. A Worker has nowhere to store "last cursor". Either add `cursor` to `wait`, or make `execution_id` a self-describing token that is reissued on each response. See section 12.

### What is impossible or weak

- Per-command kill without killing the whole session (not needed with one session per execution).
- Reattaching to the code interpreter mid-run without losing output.
- Any hard guarantee against auto-stop killing the job when nobody polls. Mitigate with a long `autoStopInterval`, or `0` with a `ttlMinutes` safety net.

### Recommended mechanism (A)

**Execution id:** a base64url JSON token `{v:1, sbx, sid, cmd, dir}`. Use `sid = "acx-<random>"` and `dir = "/tmp/acx/<random>"`.

**exec_python** (typically 3 sequential subrequests; skip the first if `sandbox_id` and the proxy URL are supplied):

1. `GET {api}/sandbox/{id}` for `toolboxProxyUrl` and `state`. If `stopped`, `POST .../start` and poll until `started`.
2. `POST {proxy}/process/session` with `{"sessionId": sid}`.
3. `POST {proxy}/process/session/{sid}/exec` with `runAsync: true` and a command like the one below. The daemon writes the command to a file (`cmd.sh`) and sources it, so a quoted heredoc is safe. Pick a random delimiter so the user code cannot collide with it.

```sh
mkdir -p /tmp/acx/ID && cd /tmp/acx/ID
cat > main.py <<'ACX_EOF_9f3a'
<user code verbatim>
ACX_EOF_9f3a
python3 -u main.py > out.log 2>&1
echo $? > exit.tmp && mv exit.tmp exit
```

This returns `cmdId` (202). Redirect stderr into the same file to preserve interleaving. If separate streams are needed, use `out.log` and `err.log` with two cursors. 4. Run the shared **poll** step (below) with `offset = 0` and `T = yield_time_ms`. 5. If finished, optionally delete the session (it is not needed after completion) and return `{output, exit_code}`. If not, return `{execution_id, cursor, output_so_far}`.

**Poll step** (also the whole of `wait` without terminate): one `POST {proxy}/process/execute` with `timeout = ceil(T/1000) + 10` and a command such as:

```sh
d=/tmp/acx/ID; off=OFFSET; end=$((SECONDS + T_SECONDS))
while [ ! -e "$d/exit" ] && [ $SECONDS -lt $end ]; do
  [ "$(stat -c %s "$d/out.log" 2>/dev/null || echo 0)" -gt "$off" ] && break   # early return on new output (optional quiet-period debounce)
  sleep 0.2
done
# Read the exit marker FIRST, then the file, so a marker implies the read below is complete.
ex=$(cat "$d/exit" 2>/dev/null)
sz=$(stat -c %s "$d/out.log" 2>/dev/null || echo 0)
printf 'EXIT=%s\n' "$ex"
tail -c +$((off+1)) "$d/out.log" | head -c MAX_BYTES | base64 -w0
```

Behaviours the loop implements or should implement:

- Return early if the exit marker appears.
- Optionally return early on a short quiet period after new output.
- Otherwise return at the deadline.
- Base64 the chunk so non-UTF-8 bytes survive the JSON `result` string.
- Cap with `head -c` and set `cursor = off + bytes_returned`, not `SIZE`, when truncated.
- Read the exit marker before reading the file, so a present marker implies the read is complete (see race 1 below).

The new cursor is `off + bytes returned`. Exit is `EXIT=<n>` (marker file present). `execute` merges stdout and stderr into `result` and returns `exitCode` of the shell itself, so ignore that field.

Fallback for the exit code: if `exit` never appears but the session is alive, use `GET .../command/{cmd}` (omitted means running).

**terminate:** `DELETE {proxy}/process/session/{sid}` (grace period up to ~5 s), then do one last tail of `out.log` from the cursor so the final output is still returned. `exit_code` is reported as null or `killed`. Own files survive the session delete, so nothing is lost.

### Simpler variant (B): no Daytona session, one request per exec_python

Run everything in a single `POST /process/execute`. Write `main.py`, launch the wrapper detached with `setsid nohup sh -c '...' >/dev/null 2>&1 </dev/null &`, record the pid or pgid in `/tmp/acx/ID/pid`, then run the same poll loop in the same request. Notes:

- The detached child must fully detach its stdio. The daemon's `Wait` blocks until the stdout pipe closes.
- `setsid` is required. On `execute` timeout the daemon SIGKILLs the _process group_ (`syscall.Kill(-pid, SIGKILL)`), which would otherwise take the job with it.
- terminate is `kill -TERM -<pgid>`, wait, then `kill -KILL`, which gives you a real exit code when SIGTERM is trapped and flushes.
- Fewer API calls and no dependency on the daemon's in-memory session table. The cost is that you re-implement what sessions give for free (a process record, a kill, stdin).

I recommend **A** as the default (first-class cmdId, exit code and process-tree kill) and **B** if session semantics turn out flaky in live tests.

### Race conditions

1. **Exit marker vs. last output.** Read the exit marker first, then the file. The marker is written (via `mv`) only after the Python process exits and its fds close, so a marker seen before the read guarantees the read is complete. Reading the file first and the marker second could miss final bytes.
2. **Concurrent `wait` calls with the same cursor** return the same bytes (idempotent). That is fine. Concurrent calls with different cursors are also fine.
3. **Partial UTF-8 or partial lines at a range boundary.** The chunk boundary can split a multi-byte character. Keep the cursor in bytes and decode lossy, or hold back incomplete trailing bytes (compare with the earlier suggestion of line-boundary cutting).
4. **Auto-stop vs. in-flight job.** If polling pauses longer than `autoStopInterval`, the sandbox stops and the job is killed (docs: "triggers even if there are internal processes running"). After a restart, the output files remain on disk, but no process runs, and no exit marker exists. Detect via `state != started` and report "sandbox stopped; execution lost".
5. **Native session delete vs. late log read.** Reading `~/.daytona/sessions/...` after `DELETE session` fails. Avoid by using our own files.
6. **`exec` returning before the command starts running:** with async the 202 only means the wrapper was written to the shell's stdin. A busy session queues the command silently. One session per execution avoids this.

---

## 12. Gotchas and open questions to verify live

1. **Version drift.** The `daytonaio/daytona` repo is frozen at v0.190.0 while docs describe v0.223. Re-test every behaviour claimed from source: session log layout, async 202, `omitempty` exit code, input FIFO, process-group kill, Range support, `follow` bridge.
2. **`wait` has no cursor in the proposed signature.** A stateless Worker cannot know "the last cursor". Options: (a) add `cursor` to `wait` input and return a new one each time; (b) make `execution_id` encode the cursor, reissued on each response; (c) store a server-side cursor file in the sandbox (`/tmp/acx/ID/cursor`) updated on each read, which races with parallel waits. Recommend (a) or (b).
3. **Does the proxy pass `Range` and 206 through for `/files/download`?** And what does it return for a range at or beyond EOF (expected 416)? If not, use the `tail -c` approach.
4. **Does `https://proxy.app.daytona.io` stream the chunked `?follow=true` response without buffering?** And is there any hard cap (CDN) on request duration, for example around 100 s? Test with a 60 to 120 s long poll.
5. **`POST /sandbox` timing.** Does it return before the sandbox reaches `started`? How long does cold start take, and what does warm-pool claim cost (`warmPoolId` field)? Which `snapshot` provides `python3` and with which version?
6. **Toolbox requests to a stopped or archived sandbox.** The runner's error is "Is the Sandbox started?" (400). Confirm the status code, and whether any toolbox call auto-starts a sandbox (it should not).
7. **Is the user of toolbox commands root or `daytona`?** Determines `~` and home-dir paths. `GET /user-home-dir` tells you.
8. **Shell used for sessions** (`common.GetShell()`): confirm it is bash, since `stat -c`, `$SECONDS`, `base64 -w0` and `tail -c +N` assume GNU coreutils. On busybox or macOS-style images they may differ.
9. **Large output.** `/process/execute` buffers the whole `result` in memory and returns JSON. Cap each poll chunk (for example 256 KiB) and let the caller page via the cursor.
10. **Process-group semantics for deeply forked children** (multiprocessing, subprocesses calling `setsid`): confirm that `DELETE session` kills them, since the tree walk only follows live parent links.
11. **Pause/resume as an alternative to auto-stop** for VM-class sandboxes. Does a paused VM keep a running Python process alive across resume? This would make long jobs safe from idle stop.
12. **Rate-limit accounting for toolbox traffic**, and 429 behaviour on `proxy.app.daytona.io`.
13. **Python output buffering.** `-u` is required. Libraries that write via C stdio can still buffer. Consider `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` in the wrapper.
14. **Session reuse and cleanup.** Without a cleanup path, orphaned sessions and `/tmp/acx/*` dirs accumulate. Consider a janitor invoked opportunistically, such as at the start of each `exec_python`: delete finished sessions and dirs older than N minutes.
15. **Security.** User code runs as the sandbox user with the sandbox's network policy. `networkBlockAll`, allow lists and `outboundProxyUrl` are creation-time options in `CreateSandbox`. Per-request credentials mean the Worker must never log the API key. The proxy strips the `Authorization` header before forwarding to the sandbox.

---

## Sources (checked 2026-10-12)

- [S1] https://github.com/daytonaio/daytona (README: repo no longer maintained since June 2026; source read at tag v0.190.0: `apps/daemon/pkg/session/*.go`, `apps/daemon/pkg/toolbox/process/**`, `apps/daemon/pkg/toolbox/fs/download_file.go`, `apps/daemon/internal/util/log_reader.go`, `apps/daemon/cmd/daemon/config/config.go`, `apps/proxy/pkg/proxy/*.go`, `apps/runner/pkg/api/controllers/proxy.go`, `command_logs.go`, `libs/common-go/pkg/proxy/server_config.go`)
- [S2] https://www.daytona.io/docs/toolbox-openapi.json (Toolbox OpenAPI)
- [S3] https://www.daytona.io/docs/openapi.json (control-plane OpenAPI)
- [S4] https://www.daytona.io/docs/en/process-code-execution.md (sessions, async commands, logs, exec, codeRun, interpreter)
- [S5] https://www.daytona.io/docs/en/sandboxes.md (lifecycle, auto-stop/archive/delete/pause, defaults, "what resets the timer")
- [S6] https://www.daytona.io/docs/en/tools/api.md (toolbox base URL, endpoints)
- [S7] https://www.daytona.io/docs/en/limits.md (rate limits, tiers)
- [S8] https://www.daytona.io/docs/en/billing.md (billing by state)
- [S9] https://www.daytona.io/docs/en/pty.md (PTY)
- [S10] https://www.daytona.io/docs/en/api-keys.md (auth)
- [S11] https://www.daytona.io/docs/llms.txt (index of the markdown docs)
- [S12] https://www.daytona.io/pricing (per-hour prices)
- Not re-fetched: Cloudflare Workers outbound WebSocket and subrequest limits (general knowledge; confirm against developers.cloudflare.com).
