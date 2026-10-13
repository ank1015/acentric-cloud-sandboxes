# Blaxel Sandboxes: feasibility of `exec_python` + `wait` from a stateless Worker

Date checked: 2026-10-12. Docs/source research only; nothing was run live (no credentials).
Primary sources: Blaxel docs (markdown mirrors at `docs.blaxel.ai/<path>.md`), the sandbox-api Go daemon
(`github.com/blaxel-ai/sandbox`, `sandbox-api/docs/openapi.yml` and `sandbox-api/src/handler/**`, read at `main`),
and `@blaxel/core` TypeScript SDK (`github.com/blaxel-ai/sdk-typescript`). Claims are tagged:
**[docs]**, **[source]** (Go daemon at `main`; the version running in a given sandbox may differ), **[sdk]**, or **[inferred]**.

## TL;DR verdict

Yes, the pair can be implemented purely over Blaxel's HTTP APIs from a stateless Worker. No WebSocket is needed.
The daemon runs processes detached, keeps them by name, and reports status and exit code from a lookup.
It also offers a log stream (NDJSON) that a client can abandon without killing the process.

What is **not** native:

- There is no server-side "wait with timeout" GET and no offset/cursor on any log endpoint. A cursor must be built by us.
- `waitForCompletion` is capped at ~60 s by the edge gateway, and by 120 s in any case.
- Without `keepAlive: true`, the sandbox goes to standby about 15 s after the last connection, which **freezes the running Python process** (it is snapshotted, not killed). It resumes on the next request. The "background" script would therefore only make progress while a request is open, unless `keepAlive` is set.
- `keepAlive` may be disabled on a plan or sandbox (`BL_DISABLE_KEEPALIVE`), and the docs' `timeout` semantics conflict with the source (see Gotchas).

Recommended mechanism (details in section 11): start the script as a **named** process with `keepAlive: true`, with stdout+stderr redirected to a
file of our choosing, and use the byte offset into that file as the cursor. Read new bytes with a ranged `GET /filesystem/...`. Wait by polling
`GET /process/{name}` inside the Worker, or by holding the `logs/stream` request until the process exits or the yield deadline passes.
Fallback if you do not want a wrapper: use `GET /process/{name}/logs` and compute the cursor as a per-stream byte count, which is only safe while output stays small (see section 4).

---

## 1. API surface and transport

Two layers:

1. **Control plane**, REST, `https://api.blaxel.ai/v0/...` **[docs]**. Used to create, get, update and delete sandboxes
   (`POST /sandboxes`, `GET /sandboxes/{name}`, `DELETE /sandboxes/{name}`). Auth: API key as a bearer token, `X-Blaxel-Authorization: Bearer <key>` or
   `Authorization: Bearer <key>`, plus `X-Blaxel-Workspace: <workspace>` (or `?workspace=`). A `Blaxel-Version` header is optional (default 2026-04-16 at the time of writing).
   (api-reference/introduction; Sandboxes/Templates "Blaxel API" curl examples use `Authorization: Bearer $BL_API_KEY` and `X-Blaxel-Workspace`.)
2. **Sandbox API**, REST served by the in-sandbox `sandbox-api` daemon (port 8080 inside the VM, exposed on 443 via the edge) **[docs][source]**.
   Per-sandbox base URL: `https://sbx-{sandbox}-{workspace}.{region}.bl.run` (api-reference/process/execute-a-command and Filesystem docs).
   The control-plane sandbox object returns it as `metadata.url` (read-only, auto-generated) **[docs]**; the SDK uses `metadata.url`, and falls back to
   `https://run.blaxel.ai/{workspace}/sandboxes/{name}` **[sdk: `action.ts` `externalUrl`]**.
   Auth on that layer: the SDK sends `x-blaxel-authorization: Bearer <apikey>` and `x-blaxel-workspace: <workspace>` **[sdk: `settings.ts` `headers`]**;
   the Filesystem doc curl examples use `X-Blaxel-Authorization: Bearer <API_KEY>` against the `bl.run` host; the API reference page shows `Authorization: Bearer`.
   **Verify live** which header forms are accepted on the `bl.run` host (likely both).

Transport: everything we need is plain HTTPS request/response, with optional chunked/NDJSON streaming bodies. WebSocket exists only for the
interactive terminal (`/terminal`) and the docs' "stream process logs via WebSocket" API-reference entry (`/ws/process/{id}/logs/stream`); we do not need either.
The TS SDK's own `streamLogs` uses plain `GET /process/{id}/logs/stream` (text), not WebSocket **[sdk: `process.ts`]**.

Worker compatibility: yes. Only `fetch` is needed. The SDK itself is not required (it reads `BL_API_KEY`/`BL_WORKSPACE` from env and cannot be given
credentials per call, which is unsuitable for a per-request-credential gateway), so call the REST endpoints directly. CORS is irrelevant server-to-server.

Sandbox creation: `POST /sandboxes?createIfNotExist=true` with `{metadata:{name}, spec:{runtime:{image, memory, ttl?, ports?}, region, lifecycle?}}`.
`createIfNotExist=true` returns a live sandbox with the same name instead of 409; a 409 otherwise **[docs: api-reference/compute/create-sandbox]**.
`metadata.name`: lowercase alphanumerics and hyphens, at most 49 chars. Pre-built image `blaxel/py-app:latest` is Debian slim with Python 3.12, pip and git;
`blaxel/base-image` is Node 24 + git and has **no Python** **[source: `hub/py-app`, README]**.
The SDK passes an optional `X-Blaxel-Creation-Timeout`-style header (1 to 50 s) to bound creation **[docs: Sandboxes/Overview "Creation timeout"]**, and tolerates a 504 on create
(creation continues server-side, so poll `GET /sandboxes/{name}`) **[sdk: `sandbox.ts`]**.

## 2. Sandbox lifecycle

- **States**: active, standby, archived **[docs]**. `status` is a deployment status (UPLOADING/BUILDING/DEPLOYING/DEPLOYED/FAILED/TERMINATED/...); API reports `DEPLOYED` for both active and standby, and the control-plane object also has a read-only `state` (RUNNING | STANDBY) **[docs]**.
- **Get by name**: `GET /sandboxes/{name}`; also by external ID (`getByExternalId`, up to 64 chars alphanumeric+dash) **[docs]**.
- **Auto-standby**: without an active connection, about 15 s ("a few seconds" in the intro) **[docs: Overview, KB "active vs standby"]**.
  A WebSocket/TCP connection that stays idle gets a 15-minute idle timeout. Plain HTTP requests do not hold the sandbox once they complete.
- **What standby does**: snapshots the whole state "including the filesystem and running processes"; processes are **preserved and resumed**, not killed **[docs]**. External network connections do not survive.
  So a running Python script is frozen during standby and thaws on the next request.
- **Resume latency**: "under 25 ms" claimed, memory and processes restored **[docs]**. Each request through the edge wakes the sandbox. Treat as a marketing number; measure live.
- **Does a running process keep the sandbox awake?** Not by default. The docs say this explicitly: "the process can enter standby before it finishes", including for `waitForCompletion: false` **[docs: KB "Sandbox inactivity with long-running processes"]**.
  Only `keepAlive: true` holds scale-to-zero off (a counter file `/uk/libukp/scale_to_zero_disable`, incremented per keepAlive process, decremented on exit) **[source: `LIFECYCLE.md`, `blaxel.go`]**. An open HTTP request (including a streaming one) also keeps it awake while connected.
  The Worker polling the sandbox ("No API requests poll the sandbox") is the other documented way.
- **TTL / expiration**: none by default. Options: `ttl` (max age from creation), `expires` (date), `lifecycle.expirationPolicies` of type `ttl-idle`, `ttl-max-age`, `date` **[docs: Sandboxes/Expiration]**.
  Tier 0 enforces a max TTL of 7 days, Tier 1 a hard 30 days, Tier 2+ unlimited. `ttl-idle` counts only a resume or a suspend as "activity": a sandbox that runs continuously (for example kept awake by `keepAlive`) for longer than the idle TTL gets deleted.
  Cleanup runs about every 60 s. Deleted sandboxes are unrecoverable. After expiry a sandbox stays `TERMINATED` for `terminatedRetention` (default 5 m).
  Recommend setting an explicit `ttl-idle`/`ttl` at creation so abandoned user sandboxes do not pile up.
- **Archive**: separate mode that keeps only filesystem diffs, loses memory, and restarts saved processes with **new PIDs** on unarchive **[docs: Sandboxes/Archive, Overview]**. Not relevant unless we archive explicitly.
- **Idle cost**: standby bills no CPU or memory, only snapshot and volume storage. Active mode bills allocated memory (CPU bundled) **[docs]**.
  A `keepAlive` process (or an open connection) means active billing for the whole duration. Exact prices are on blaxel.ai/pricing and were not checked.

## 3. Starting a background process

`POST {base}/process`, JSON body (`ProcessRequest`) **[source: openapi.yml, `handler/process.go`]**:

| field                             | type               | notes                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                         | string, required   | Run via `$SHELL $SHELL_ARGS` (default `sh -c`). Commands >= 128 KiB are fed through fd 3 instead of argv.                                                                                                                                                 |
| `name`                            | string             | Identifier usable instead of the PID in all `/process/{identifier}` routes. If a _running_ process already has that name: 400 "already exists and is running". Reusing a name of a finished process is allowed (lookup returns the newest by start time). |
| `workingDir`                      | string             | Must exist, else 422. Plain absolute path, not URL-encoded.                                                                                                                                                                                               |
| `env`                             | map<string,string> | Merged over the daemon's environment.                                                                                                                                                                                                                     |
| `waitForCompletion`               | bool               | Blocks the HTTP call until exit. See section 5.                                                                                                                                                                                                           |
| `timeout`                         | int seconds        | See Gotchas: docs and source disagree on whether it kills non-`keepAlive` processes.                                                                                                                                                                      |
| `keepAlive`                       | bool               | Hold scale-to-zero off while running. Default auto-kill 600 s if `timeout` is absent/negative; `timeout: 0` disables auto-kill.                                                                                                                           |
| `waitForPorts`                    | int[]              | Not relevant.                                                                                                                                                                                                                                             |
| `restartOnFailure`, `maxRestarts` | bool, int          | Not wanted for exec_python.                                                                                                                                                                                                                               |
| `stdin`                           | bool               | Open a writable stdin pipe (section 7).                                                                                                                                                                                                                   |

Response (`ProcessResponse`): `pid` (string; the sandbox-api's own process ID key), `name` (random 8-char name generated if none given), `command`, `status`
(`running|completed|failed|killed|stopped`), `startedAt`/`completedAt` (RFC1123 HTTP date; `completedAt` is `""` while running), `exitCode`, `workingDir`, `logs`/`stdout`/`stderr`
(tails, see section 4), `keepAlive`, `stdin`, `restartCount`, ... Returns as soon as the process is spawned when `waitForCompletion=false`.

Survives client disconnect: yes. Output goes straight to log files on the sandbox filesystem (not pipes), and the process runs in its own process group; a client disconnect does not signal it **[docs: Processes "Long-running processes"; source: `StartProcessWithName` "Child processes write DIRECTLY to these files (no pipes). This ensures processes survive sandbox-api restarts"]**.
Caveat: it does not survive standby _progressing_ (it is frozen), and does not survive sandbox deletion or archive/unarchive-as-same-process.

Passing the code: either (a) `PUT /filesystem/%2Ftmp%2Fx%2Fmain.py`-style write (JSON `{content, permissions}`; single request capped at 5 MB, larger needs the multipart endpoints) then `python3 -u /tmp/x/main.py`, or (b) pass it in `env` and `python3 -u -c "$CODE"`
(single env string limit about 128 KiB, `MAX_ARG_STRLEN`). Use `python3 -u` (or `PYTHONUNBUFFERED=1`) so output is flushed to the log files promptly.

## 4. Output retrieval

Endpoints **[source: openapi.yml, `process.go`, `logfile.go`, `logbuffer.go`]**:

- `GET /process/{id}/logs` -> `{stdout, stderr, logs}`. Whole-output snapshot, **no offset/cursor/limit parameters**. `stdout` and `stderr` are separate; `logs` is `stdout + stderr` concatenated (explicitly not interleaved).
  Returns at most the **last 4 MiB per stream** (`maxLogsResponseBytes`, env `SANDBOX_MAX_LOGS_RESPONSE_BYTES`). Silent tail truncation; there is no "truncated" flag in this response.
- `GET /process/{id}` and `GET /process` inline only the **last 64 KiB per stream** (`MaxInlinedLogBytes`) alongside status, exit code and timestamps. Useful as a cheap "status plus tail" call.
- `GET /process/{id}/logs/stream` (the text form is also what the TS SDK `streamLogs` uses):
  - Default (`Accept` absent): `text/plain` lines prefixed `stdout:`/`stderr:`, with `[keepalive]` every 30 s. The docs warn this format has ambiguous framing; do not use it to reconstruct streams.
  - `Accept: application/x-ndjson`: one JSON object per line, `{type, data, encoding?}` with `type` in `stdout|stderr|keepalive|restart|truncated|error`; raw chunk bytes preserved (including partial lines); `encoding:"base64"` when the chunk is not valid UTF-8.
    The stream **replays the retained history from the start, then follows live output**, and **closes when the process finally exits** (there is no `result` record on this endpoint). It also closes if the client disconnects. HTTP 409 for processes created before structured logs existed.
  - There is no `offset`/`since` parameter. A reconnect always replays from the beginning.
- `POST /process` with `Accept: application/x-ndjson` (or `text/event-stream`, still NDJSON): start and stream in one request. Events: `stdout`/`stderr` chunks, `keepalive` every 5 s, `error`, and a final `result` event whose `data` is the JSON `ProcessResponse` (with exit code). `waitForCompletion` is ignored on this path (the handler always starts the process without waiting and waits on completion itself).
  If the client disconnects first, the handler only removes its log writer (`RemoveLogWriter`); the process is not killed **[source: `handleExecuteCommandStream`]**.
  An edge case: for very fast commands that finish before a chunk was streamed, output is emitted one event per line, newlines stripped.
- **Streaming and the Worker**: all of these are ordinary chunked HTTP responses. A Worker can `fetch()` and read `response.body` with a reader, then `controller.abort()` (or `reader.cancel()`) when the yield deadline hits. The abort only detaches the log writer.
  Note the daemon sends its first `keepalive` immediately after attach, so the response headers arrive promptly even for a silent process.
- **Retention and limits** **[source: `logfile.go`, `logbuffer.go`]**: the daemon keeps three files per process (stdout, stderr, combined journal) on the sandbox's **tmpfs root (RAM)**. Per-file cap 32 MiB (`SANDBOX_MAX_LOG_FILE_BYTES`), further reduced so that all processes' logs together use at most 10% of guest memory (min 256 KiB per file). Past the cap the **head is released** ("punch hole"), so old output is lost and offsets into the log shift. In-memory buffer 64 KiB with a truncation marker `[... truncated, see the process log file ...]`. Single line cap 1 MiB when replaying. NDJSON stream emits a `truncated` record when history was lost.
  No time-based expiry or pruning of finished process records was found in the files read; they appear to live as long as the sandbox/daemon. **Verify live** (and note that a sandbox-api restart/upgrade adopts processes from saved state).
- **Ranged file reads as an alternative**: `GET /filesystem/{path}` with `Accept: application/octet-stream` (or `?download=true`) is served with Go `http.ServeContent` **[source: `filesystem.go` `handleReadFile`]**, which implements standard `Range: bytes=N-M` (206, `Content-Range`) and `If-Modified-Since`.
  With the default JSON Accept, the whole file is read into memory and returned as JSON (do not use). `HEAD /filesystem/{path}` returns `Content-Length` (file size) cheaply. **Verify live** that the edge passes `Range`/206 through. The filesystem handler also lets us tail by size via HEAD then `Range: bytes=<cursor>-`.

Is a cursor possible natively? No. Three ways, in order of robustness:

1. **Own the log file** (recommended): run `sh -c` command like `python3 -u /tmp/x/main.py > /tmp/x/out.log 2>&1` (the daemon already runs commands through `sh -c`, so redirection works). Cursor = byte offset into `out.log`; new output = `GET /filesystem/%2Ftmp%2Fx%2Fout.log` with `Accept: application/octet-stream`, `Range: bytes=<cursor>-`. The file is ours: no 4 MiB/32 MiB truncation, stdout and stderr are interleaved in real order (merged by the shell), the cursor is a plain integer. Cost: stdout/stderr are no longer separable (fine for an LLM tool; or use two files with two cursors), and the file occupies RAM-backed tmpfs.
   Also have the wrapper append a sentinel? Not needed, since status and exit code come from `GET /process/{name}`.
2. **Per-stream byte counts on `GET /process/{id}/logs`**: cursor = `{stdoutBytes, stderrBytes}`; new output = `stdout.slice(cursorBytes)`. Breaks silently once a stream exceeds 4 MiB (tail returned) or 32 MiB (head released), and counts must be UTF-8 byte counts of the _returned_ string (invalid UTF-8 may be altered on JSON encoding **[inferred]**). Acceptable only with a hard output cap.
3. **NDJSON `logs/stream` with skipping**: replay from start and discard the first `cursor` bytes per source (decode base64 first). Exact (it preserves source and bytes), but replay cost grows with output size, and a `truncated` record ends cursor validity.

## 5. Waiting with a timeout

- `waitForCompletion: true` on `POST /process` blocks until exit and returns `stdout/stderr/logs/exitCode` in the response. **The platform enforces ~60 s** ("Blaxel enforces a timeout limit of 60 seconds. Don't set your timeout longer than this") **[docs: Processes]**. The edge gateway returns 504 on long-held requests (the TS SDK comments mention an "edge's ~60s origin-read timeout"; Processes docs mention a 504 cut-off at 120 s for `waitForPorts`) **[sdk: `action.ts`; docs]**.
  Our `yield_time_ms` default of 10 s is far below that.
- Source semantics of the wait (**[source: `service.go` `ExecuteProcess`]**): with `waitForCompletion=true`, the HTTP handler passes `timeout` both as the process execution deadline and as the wait limit; when the wait limit elapses the call returns an error (HTTP 422 `process timed out after N seconds`) and **the handler discards the process info**, so the caller must already know the `name`. Always set `name` ourselves.
  Therefore do not use `waitForCompletion` for exec_python; use start-then-poll/stream instead, or the streaming POST.
- **No GET-with-wait / long-poll exists.** The SDK's `process.wait(id, {maxWait, interval})` is purely client-side polling of `GET /process/{id}` until `status != running` **[sdk: `process.ts`]**.
  The closest server-side wait is holding open `GET /process/{id}/logs/stream` (NDJSON), which the server closes at final exit; detecting the close is a "process exited" signal, after which one `GET /process/{id}` returns the exit code.
- **Exit code**: `exitCode` in `GET /process/{id}` and in the streaming POST `result` event. Exit status > 0: `status:"failed"` and the real code. Killed/stopped via API: status `killed`/`stopped`, `exitCode` is the OS code (typically -1 for signal death; **[source: Go `ExitError.ExitCode()`]**). A non-zero exit does not make the HTTP call fail.
- **Process list**: `GET /process` lists running _and completed_ processes **[source: openapi.yml description]**. Records appear to persist (see retention note above), so `wait` can be answered after the script finished, as long as the sandbox still exists.

## 6. Terminate

- `DELETE /process/{id}/kill` -> SIGKILL; `DELETE /process/{id}` -> SIGTERM (graceful "stop") **[source: openapi.yml; `termination.go`]**. There is **no signal parameter** (`ProcessKillRequest` struct exists in the handler but is not wired to a route in the spec).
- Both return 200 immediately with "requested"; **poll `GET /process/{id}` until a terminal status** ("Status stays running until exit is observed").
- Children: the daemon starts each process with `Setpgid: true` and signals `-pgid` first (falls back to the single pid), so the whole group is signalled, including children of `sh -c`. Processes that `setsid`/double-fork out of the group are not covered.
- Idempotence: repeating a stop/kill on an already-terminating process returns success; on a finished one without a recorded termination request it errors ("not running"). Also, a `keepAlive` process is auto-killed (SIGKILL) at its `timeout` deadline. Status reported is `killed`.
- Sandbox-level cleanup: `DELETE /sandboxes/{name}` on the control plane.

## 7. stdin

Supported since sandbox-api 0.2.56 (SDK `@blaxel/core` 0.3.19+, Python `blaxel` 0.4.9+) **[docs: Processes "Process stdin"; source: `STDIN.md`]**.
Start with `"stdin": true`; then `POST /process/{id}/stdin` (body = raw bytes, `Content-Type: application/octet-stream`), and `DELETE /process/{id}/stdin` to send EOF (idempotent).
Errors: 404 unknown, 409 no stdin / closed / pipe lost after a sandbox-api restart, 413 over 8 MiB, 503 if the process stops reading for 10 s (after which part of the write may have gone through; restart the process).
No TTY or PTY (raw pipe, no echo). The pipe survives standby/resume. This is a pipe, not a REPL: it is only useful for scripts that read `sys.stdin`. (Not part of our two-tool surface.)

## 8. Files API

(`/filesystem/...` on the sandbox base URL.) **[source: openapi.yml; docs: Sandboxes/Filesystem]**

- Read: `GET /filesystem/{path}` (JSON with content for the default Accept; directory listing for dirs; raw/ranged via `Accept: application/octet-stream`). `HEAD` for size/mtime. Absolute paths need the leading slash encoded as `%2F` (`/filesystem/%2Ftmp%2Fx.py`); a path without a leading slash resolves against the filesystem working directory.
- Write: `PUT /filesystem/{path}` JSON `{content, permissions?, isDirectory?}` or multipart form `file=`; idempotent overwrite. Directories are created with `isDirectory:true`; parent directory creation behaviour not verified.
- Limits: a single HTTP request is capped at **5 MB** (413 at the edge); larger files go via `/filesystem-multipart/initiate/{path}` -> `PUT .../{uploadId}/part?partNumber=N` -> `POST .../complete` (SDK uses 5 MB chunks).
- Plus tree, find, search, content-search, watch (`/watch/filesystem/...`), archive export/import. Writable layer is a RAM-backed tmpfs overlay (about 50% of memory reserved), so large outputs eat memory; ENOSPC shows up as a "no space left on device" error, solved by more memory or a volume **[docs: Overview "Memory and filesystem", KB]**.

## 9. Running Python

- **Plain process** (what we want): `python3 -u script.py` through `POST /process`. Needs an image with Python (`blaxel/py-app:latest`, Python 3.12 on Debian slim). The default `blaxel/base-image` has no Python (Node 24 only) **[source: README]**.
- **Stateful kernel option**: `blaxel/jupyter-server` image (Jupyter kernel + FastAPI wrapper on port 8888), driven through `POST {sandbox_url}/port/8888/execute` with `{code, context_id, language, env_vars}`; response is a streaming NDJSON of `stdout/stderr/result/error/number_of_executions` events; plus `/contexts` CRUD and `/contexts/{id}/restart` **[sdk: `interpreter.ts` `CodeInterpreter`; source: `hub/jupyter-server/server/main.py`]**.
  It requires the exposed port 8888 (`ports: [{target: 8888}]` at creation). The SDK default is a 60 s read timeout, default lifecycle `ttl-idle: 30m`. It is **one request per execution held open for the whole run**; there is no execution-id/detach/poll API visible in `main.py` (only `/health`, `/execute`, `/contexts*`), so it does not fit "yield then continue in background" without extra plumbing. The kernel itself would keep running if the request is dropped, but we would have no way to read its remaining output. Not recommended for this gateway; mention as a future "stateful" option.

## 10. Request time limits and rate limits

- Edge gateway: long-held requests hit 504. Documented thresholds: **60 s** for `waitForCompletion`; **120 s** for `waitForPorts` ("a request that stays open that long is cut off by the gateway with a 504") **[docs: Processes]**. The SDK treats 502/503/504 as retryable "waking from standby / outran edge" **[sdk: `SandboxGatewayError`]**. Keep every held request well under ~60 s (a 10 to 30 s yield is fine).
- Idle WebSocket/TCP connections: 15-minute idle timeout (not relevant to HTTP).
- A 5-second NDJSON `keepalive` (POST path) and 30-second `[keepalive]` (log stream) exist to avoid idle cut-offs.
- Rate limits: **not documented** for either the control plane or the sandbox API (api-reference/introduction does not mention any). Quotas are tier-based (number of deployed/standby/concurrent sandboxes, volume sizes, TTL caps, memory) **[docs: Security/Quotas]**; exceeding returns `QUOTA_EXCEEDED` on create. Open question; check response headers (`Retry-After`, 429) live.
- Cloudflare Worker side: each Blaxel call is a subrequest (50 on the free plan, 1000 on paid per invocation), so a poll loop of 500 ms for 30 s costs about 60 requests; prefer the stream or a coarser interval (1 s).

## 11. Verdict and recommended mechanism

Can `exec_python` + `wait` be implemented purely over the remote API from a stateless Worker? **Yes**, with the workarounds below. Nothing in the required surface is impossible.

### Native

- Detached, named, long-lived processes that survive our disconnect; `GET /process/{name}` as an authoritative status + exit code + timestamps lookup, available after the process finished.
- NDJSON log stream that can be consumed and abandoned from a Worker; stream end == process exit.
- `DELETE /process/{name}/kill` with process-group semantics; stdin pipe.
- Ranged reads of arbitrary files (`Range`, via `http.ServeContent`).

### Needs a workaround

1. **Cursor**: no native offset anywhere. Use our own output file plus `Range` (preferred) or per-stream byte counts. The `cursor` we hand back can simply be `"<byteOffset>"` (or `"o:<n>"` for the file approach). Embed no sandbox state; recompute from the file size.
2. **Server-side wait with early return**: not native. Implement inside the Worker:
   - `wait(execution_id, yield_time_ms)`: loop up to `yield_time_ms` (capped to about 30 to 50 s, with an internal safety margin of about 5 s under the gateway limit):
     `GET /process/{id}` (status, exitCode); `HEAD` or ranged `GET` on the output file; return when status != running (then do one final read of the remaining bytes), or when output grew and the yield time has elapsed.
     Poll interval 250 to 500 ms for the first seconds then back off to 1 s. Alternatively hold one `GET /process/{id}/logs/stream` (NDJSON, ignoring the first N bytes it replays) and let the server's close signal exit; but the file-based poll is simpler and cheaper for long outputs.
   - `exec_python`: after `POST /process` (`waitForCompletion:false`), run exactly the same loop for `yield_time_ms`. Alternative: use the streaming `POST /process` (NDJSON) for the first call, which gets live output and the `result` event (exit code) without a separate start request, abort at the deadline; but then the output must still be re-derivable by file cursor for later waits, so the file approach is more uniform.
3. **Keep the script running between calls**: set `keepAlive: true` with `timeout` set to the overall maximum run time you want (for example 3600; `0` = never auto-kill). Without it, the script freezes ~15 s after our last request. This costs active-mode billing (memory) for the whole run.
   The `execution_id` should encode `{sandboxName, processName}` (and maybe the output-file path) so the gateway stays stateless; the credentials come per request, the control plane (`GET /sandboxes/{name}`) supplies `metadata.url` (optionally cache or let the client send the URL).
4. **Output merging / stderr**: using `> out 2>&1` merges streams; if separate streams matter, use `> out.stdout 2> out.stderr` and two cursors (encode as `"<so>:<se>"`).
5. **Exit code**: from `GET /process/{name}` (`exitCode`, `status`). If you wrap the command, do not mask the exit code (`exec` the final python command or let `sh` propagate it).

### Impossible / not offered

- Server-side long-poll wait with timeout (only client polling or stream-close detection).
- Offsets/cursors on `/logs` and `/logs/stream`.
- Arbitrary signals via the API (SIGTERM and SIGKILL only).
- A TTY-backed Python session across calls via the process API (stdin is a plain pipe; kernel needs the Jupyter image and its own request model).
- Holding a single request beyond ~60 s through the edge.

### Race conditions to design for

- **Finish between read and status check**: always read status first, and if terminal, do one more read of the remaining output after seeing terminal status (the daemon drains remaining output before publishing the terminal state: `waitForRun` closes `Done` and waits for the log tailer before it sets the status, so a read after seeing `completed` includes all output **[source: `termination.go`]**). The reverse order (read output, then status) can miss final bytes.
- **Output written while the file is read**: the file approach is append-only, so `Range: bytes=<cursor>-` returns a consistent prefix of what was written; advance the cursor by the _bytes actually received_, not by `Content-Length` from an earlier HEAD. Be careful with multi-byte UTF-8 split at the boundary: keep a byte cursor and decode only at a character boundary (or carry a partial-sequence tail).
- **Name reuse**: a second process with the same `name` while the first is running is rejected (400), but after the first finishes, lookups by name resolve to the _newest_ process. Use a unique name per execution (`py-<random>`) and per-execution file directory.
- **Kill vs natural exit**: kill is asynchronous; `terminate:true` should issue `DELETE .../kill` then poll for terminal status (bounded), and return `status:killed` (or the natural status if it won the race). A kill on an already-finished process returns an error if no termination was recorded; treat 4xx/"not running" as success-if-finished.
- **Standby resume lag/504s**: the first request after idle can fail with 502/503/504 while waking. Retry idempotent calls (GET, HEAD, ranged reads, status). Do **not** blindly retry `POST /process` (could create a duplicate; use unique names so a duplicate is rejected as "already exists and is running" and treat that as success).
- **tmpfs exhaustion**: scripts that write lots of output or files can OOM the guest (log files and sandbox files share RAM); consider a cap on our own output file (for example `| head -c` is wrong for long runs; better to size the sandbox and rely on the cursor consumer, or add a `truncate` guard).
- **Cursor invalidation**: in the built-in-logs fallback, a cursor beyond the retained tail (head released) must be reported as "output truncated" to the model rather than silently mis-sliced.

## 12. Gotchas and open questions to verify live

1. **Docs vs source on `timeout` for non-keepAlive processes.** Docs say the `timeout` does not kill a non-keepAlive process (it only bounds the wait). The Go `main` source arms an execution deadline (`startExecutionTimeout`, SIGKILL) for any process with `Timeout > 0` ("KeepAlive only controls the scale-to-zero hold"), and the HTTP handler forwards `timeout` for all requests. Version skew is possible. **Test**: start `sleep 100` with `timeout: 5` and no `keepAlive`; see if it is killed. Mitigation: for the start call, set `keepAlive:true, timeout: <max runtime>` (or `0`), and never set a short `timeout` on a non-`waitForCompletion` call.
2. **Is `keepAlive` available on the user's plan/sandbox?** `BL_DISABLE_KEEPALIVE` can disable it per sandbox and returns 400/422 "keepAlive is not available for this sandbox: it is not included in your current plan". Needs a fallback: keep the sandbox awake by polling (the Worker's own `wait` calls) and accept that a script is frozen between calls. Detect via the error and surface it.
3. **Standby freezing semantics**: confirm empirically that a CPU-bound Python script (for example a counter with timestamps in the output file) pauses during standby when `keepAlive` is false, and resumes afterwards without losing timers or clocks (wall-clock jumps), and that sockets opened by the script (HTTP downloads) die.
4. **Header and URL formats**: confirm `metadata.url` is populated on the `GET /sandboxes/{name}` response, that `https://sbx-{name}-{workspace}.{region}.bl.run` and `https://run.blaxel.ai/{workspace}/sandboxes/{name}` both accept `X-Blaxel-Authorization: Bearer <key>` (+ `X-Blaxel-Workspace`) and plain `Authorization: Bearer <key>`, and which works from Cloudflare Workers (HTTP/2, no special client needed; the SDK's H2 pool is an optimisation).
5. **`Range` through the edge** on `GET /filesystem/...` with `Accept: application/octet-stream`: 206 vs 200, `Accept-Ranges`, behaviour for a cursor equal to file size (416 or empty). Also whether `HEAD /filesystem/...` reports `Content-Length` accurately for a file being appended to.
6. **Live-file read consistency**: does the tmpfs overlay return bytes written by a running process (page cache) immediately? Almost certainly yes; confirm with a `print(..., flush=True)` loop. Check `python -u` flush behaviour under `> file` redirection.
7. **Finished process retention**: how long does `GET /process/{name}` keep returning completed processes? (Not found in code read; check after standby/resume, sandbox-api upgrade, archive/unarchive.) If processes get pruned, add a fallback: have the wrapper write `exit_code` to a file (for example `python3 -u main.py > out.log 2>&1; echo $? > exit.code`) and read that.
8. **Resume latency in practice** (docs claim < 25 ms) and first-request error behaviour (502/503/504 while waking), and sandbox creation time (`blaxel/py-app` cold create; the SDK allows up to 50 s creation timeout).
9. **Rate limits / 429 behaviour** on both planes; concurrent sandboxes quota per tier; maximum number of simultaneously running keepAlive processes.
10. **Python availability and permissions**: `blaxel/py-app` runs as the sandbox's workload identity (there is a "non-root user" option: Sandboxes/Non-root-user); check the writable paths (`/tmp`, `/blaxel`), `HOME=/blaxel`, and that `pip install` works (egress policy, proxy, domain filtering).
11. **Process name restrictions and log-file names**: names are sanitized to `[A-Za-z0-9._-]` for log files, so keep to that charset. Also the `Accept: text/event-stream` quirk on `POST /process` (NDJSON, not SSE).
12. **NDJSON stream details**: whether `GET /process/{id}/logs/stream` with `Accept: application/x-ndjson` returns 409 for processes created by older sandbox-api versions (sandboxes created before the structured-log feature need `sandbox.system.upgrade`).
13. **`ttl-idle` interaction with keepAlive** (docs): a sandbox continuously active for longer than `ttl-idle` is deleted; do not combine a short idle TTL with long `keepAlive` runs.
14. **Output cap policy**: decide what to do when output exceeds a limit (truncate in the Worker response; keep the cursor pointing past the truncated bytes or let the model request more).
15. **Security**: the gateway receives a user's API key per request; do not log it. Direct HTTP use also means we can scope to a workspace via the header, but there is also the session-token mechanism (`sandbox.sessions.create` -> `X-Blaxel-Preview-Token` against a session URL) which gives time-limited access to only the sandbox API: a more restricted credential type to consider supporting alongside raw API keys.

## Request sketch (for implementers; shapes taken from the OpenAPI/SDK, unverified live)

```
# control plane
POST https://api.blaxel.ai/v0/sandboxes?createIfNotExist=true
  X-Blaxel-Authorization: Bearer <key>   X-Blaxel-Workspace: <ws>
  {"metadata":{"name":"acentric-<id>"},"spec":{"region":"us-pdx-1","runtime":{"image":"blaxel/py-app:latest","memory":2048},
   "lifecycle":{"expirationPolicies":[{"type":"ttl-idle","value":"1h","action":"delete"}]}}}
GET  https://api.blaxel.ai/v0/sandboxes/<name>   -> metadata.url

# sandbox API (base = metadata.url)
PUT    {base}/filesystem/%2Ftmp%2Fx1%2Fmain.py        {"content":"<code>","permissions":"0644"}
POST   {base}/process
       {"name":"py-x1","command":"python3 -u /tmp/x1/main.py > /tmp/x1/out.log 2>&1",
        "workingDir":"/tmp/x1","keepAlive":true,"timeout":0,"waitForCompletion":false}
GET    {base}/process/py-x1                            -> status, exitCode, completedAt
GET    {base}/filesystem/%2Ftmp%2Fx1%2Fout.log   Accept: application/octet-stream   Range: bytes=<cursor>-
DELETE {base}/process/py-x1/kill                       -> then poll GET /process/py-x1
```

## Sources (all checked 2026-10-12)

- Sandboxes overview and lifecycle: https://docs.blaxel.ai/Sandboxes/Overview (raw: https://docs.blaxel.ai/Sandboxes/Overview.md)
- Process execution: https://docs.blaxel.ai/Sandboxes/Processes
- Log streaming: https://docs.blaxel.ai/Sandboxes/Log-streaming
- Filesystem: https://docs.blaxel.ai/Sandboxes/Filesystem
- Expiration policies: https://docs.blaxel.ai/Sandboxes/Expiration
- Standby control: https://docs.blaxel.ai/Sandboxes/Standby-control
- Sessions: https://docs.blaxel.ai/Sandboxes/Sessions
- Archive: https://docs.blaxel.ai/Sandboxes/Archive
- KB, active vs standby: https://docs.blaxel.ai/knowledge-base/configuration-and-operation/understanding-sandbox-active-vs-standby-states-and-billing
- KB, TTL and expiration: https://docs.blaxel.ai/knowledge-base/configuration-and-operation/understanding-sandbox-ttl-and-expiration-policies
- KB, inactivity with long-running processes: https://docs.blaxel.ai/knowledge-base/configuration-and-operation/sandbox-inactivity-with-long-running-processes
- KB, WebSocket 15-minute limit: https://docs.blaxel.ai/knowledge-base/troubleshooting/websocket-connection-timeouts-and-15-minute-limit
- Quotas: https://docs.blaxel.ai/Security/Quotas
- Images/templates and REST create examples: https://docs.blaxel.ai/Sandboxes/Templates
- Control-plane API intro (auth headers): https://docs.blaxel.ai/api-reference/introduction
- Create sandbox (API ref): https://docs.blaxel.ai/api-reference/compute/create-sandbox
- Sandbox API, execute a command (server URL format): https://docs.blaxel.ai/api-reference/process/execute-a-command
- Docs index: https://docs.blaxel.ai/llms.txt
- sandbox-api OpenAPI: https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/docs/openapi.yml
- Process handler: https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/src/handler/process.go
- Process manager (exec, wait, logs, kill): https://github.com/blaxel-ai/sandbox/tree/main/sandbox-api/src/handler/process (`process.go`, `service.go`, `termination.go`, `timeout.go`, `logfile.go`, `logbuffer.go`, `shell.go`)
- Filesystem handler (ServeContent / Range): https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/src/handler/filesystem.go
- KeepAlive doc and implementation: https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/docs/LIFECYCLE.md, https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/src/lib/blaxel/blaxel.go
- Stdin doc: https://github.com/blaxel-ai/sandbox/blob/main/sandbox-api/docs/STDIN.md
- Python image: https://github.com/blaxel-ai/sandbox/tree/main/hub/py-app ; Jupyter image: https://github.com/blaxel-ai/sandbox/tree/main/hub/jupyter-server
- TS SDK process client: https://github.com/blaxel-ai/sdk-typescript/blob/main/@blaxel/core/src/sandbox/process/process.ts
- TS SDK URL, errors, edge timeout notes: https://github.com/blaxel-ai/sdk-typescript/blob/main/@blaxel/core/src/sandbox/action.ts
- TS SDK auth headers and URLs: https://github.com/blaxel-ai/sdk-typescript/blob/main/@blaxel/core/src/common/settings.ts
- TS SDK sandbox create/get: https://github.com/blaxel-ai/sdk-typescript/blob/main/@blaxel/core/src/sandbox/sandbox.ts
- TS SDK code interpreter: https://github.com/blaxel-ai/sdk-typescript/blob/main/@blaxel/core/src/sandbox/interpreter.ts
