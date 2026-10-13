# Tensorlake Sandboxes: research for `exec_python` / `wait`

Date checked: 2026-10-12. Method: docs and SDK source only (no credentials, no live calls). Everything below is tagged by evidence level where it matters:

- **[doc]** stated in the published docs / API reference.
- **[src]** read from the public SDK source (`tensorlakeai/tensorlake`, HEAD `39ba09f`, 2026-10-10). Note the sandbox daemon itself is NOT in that repo; a code comment says the daemon "keeps a byte-identical copy [of name validation] in its own repo", so the daemon is separate and I found no public source for it.
- **[unknown]** not documented anywhere I could find. Verify live.

## 0. TL;DR

Yes, `exec_python` + `wait` can be built purely over Tensorlake's remote API from a stateless Worker, using plain `fetch`. Native building blocks exist for almost everything:

- Start a background process (`POST /api/v1/processes`, returns `pid`, process runs independently of our connection).
- Read all buffered output (`GET .../output`) or replay-then-stream it over SSE (`GET .../output/follow`).
- Poll status/exit code (`GET /api/v1/processes/{pid}`), signal (`POST .../signal`), kill (`DELETE .../{pid}`), stdin (`POST .../stdin`).

Gaps: no output offset/cursor and no server-side "wait for exit with timeout". Both are bridged by a client-side cursor (count of lines already returned) plus an SSE read that the Worker drops after `yield_time_ms`. The unknowns that matter most are output-buffer retention/size, partial-line behaviour, child-process kill semantics, and idle-timeout interplay (section 12).

## 1. API surface and transport

Two hosts, one credential:

| Plane                                            | Base URL                                                                   | Used for                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Control plane (REST/JSON)                        | `https://api.tensorlake.ai`                                                | create / get / list / suspend / resume / terminate sandboxes, snapshots, persisted logs |
| Sandbox data plane (REST/JSON + SSE + WebSocket) | `https://<sandbox-id-or-name>.sandbox.tensorlake.ai` (daemon on port 9501) | processes, files, PTY, tunnels                                                          |

- Data-plane host: sandboxes also report `ingress_endpoint` and `sandbox_url` in the create/get response. Docs say "prefer `ingress_endpoint` over building `*.sandbox.tensorlake.ai` hostnames yourself" [doc: create]. The SDK refuses to derive a proxy URL and uses the server-provided `sandbox_url` [src: `select_sandbox_proxy_url`]. A Worker that wants to be region-safe should either carry the host in `execution_id` or re-`GET /sandboxes/{id}` per call.
- Per-sandbox URL: `<port>-<sandbox-id-or-name>.sandbox.tensorlake.ai` reaches user ports listed in `exposed_ports` (only 9501, the management API, is routable by default) [doc: networking].
- Auth: `Authorization: Bearer <project-scoped API key>` (keys look like `tl_apiKey_...`). "The key selects the project, so no organization or project headers are needed" [doc: networking, authentication]. The same key works on both hosts. SDK tests assert the proxy request carries only the bearer, no `X-Forwarded-Organization-Id`/`X-Forwarded-Project-Id` [src: `client.rs` test `api_key_bearer_is_preserved_for_proxy_without_implicit_scope_headers`].
- Transport: REST/JSON; SSE for `processes/run` and `*/follow`; WebSocket for PTY (`/pty/<session>/ws?token=...`) and tunnels. The proxy also forwards gRPC over HTTP/2 for user ports [doc: networking]. No SDK-only functionality was found for the process/file path: the Rust core that backs the Python and Node SDKs is just `reqwest` against the REST routes listed here [src: `crates/cloud-sdk/src/sandboxes/mod.rs`].
- Cloudflare Worker feasibility: yes. All needed calls are ordinary HTTPS `fetch` (JSON, octet-stream, SSE response bodies read with a stream reader). No raw TCP, no gRPC needed. The two SDKs (Python/TS) are not usable in a Worker as-is (the Python one wraps a Rust native extension), so the gateway must speak REST directly.
- No published OpenAPI for the sandbox APIs in the SDK repo (`openapi.yaml` there is Document AI only). The per-endpoint reference pages under `docs.tensorlake.ai/api-reference/v2/` are the contract. A machine-readable index is at `https://docs.tensorlake.ai/llms.txt`, and every docs page has a `.md` twin.

## 2. Sandbox lifecycle

- **Create**: `POST https://api.tensorlake.ai/sandboxes` [doc: sandboxes/create]. Body (all optional): `name`, `image`, `resources{cpus,memory_mb,disk_mb,gpus}`, `snapshot_id`, `secret_names`, `timeout_secs`, `entrypoint`, `network{allow_internet_access,allow_out,deny_out}`, `exposed_ports`, `allow_unauthenticated_access`, `wait` (default true), `max_pending_secs`, `file_systems`, `template_id`.
  - `200`: `{sandbox_id, status, pending_reason?, ingress_endpoint}`. `wait:false` returns `202` with `state: pending`; then poll `GET /sandboxes/{id}`.
  - Defaults: 1 vCPU, 1024 MB, 10 GiB disk, `timeout_secs` 600 [doc: lifecycle]. Boot is "a few hundred milliseconds" for `tensorlake/ubuntu-minimal` [doc: introduction]. Default runtime is Ubuntu 24.04.
  - Gotcha: create returns `sandbox_id`, GET returns `id` [doc: create vs get].
- **Get**: `GET /sandboxes/{id-or-name}` returns `SandboxInfo` including `status` (`pending|running|snapshotting|suspending|suspended|terminated`), `timeout_secs`, `ingress_endpoint`, `sandbox_url`, `termination_reason`, etc. [doc: sandboxes/get]. List: `GET /sandboxes`.
- **Types**: _Ephemeral_ (no `name`): cannot be suspended, referenced by ID, terminated on timeout. _Named_: supports suspend/resume, ID or name, suspended on timeout [doc: lifecycle].
- **Timeout semantics**: `timeout_secs` is an **idle threshold, not a lifetime**. The sandbox stays up while there is "proxied traffic: SSH sessions, WebSocket PTYs, requests to exposed user ports, or SDK/CLI calls". After `timeout_secs` with no proxied traffic it suspends (named) or terminates (ephemeral). `timeout_secs=0` asks for the plan maximum; plan caps: Free 2 h, Usage Credits 24 h, Pro/Enterprise unlimited [doc: lifecycle, pricing FAQ]. Create docs list slightly different numbers (free unverified 3600, free verified 7200, on-demand 86400) [doc: create]; treat as ceilings that may be enforced differently.
- **Important consequence**: idleness is judged by _proxied traffic_, not by whether a process is running. A Python job computing quietly for longer than `timeout_secs` with nobody calling the sandbox will be killed (ephemeral: sandbox terminated) or frozen (named: suspended). [doc: lifecycle states this; the "background job keeps it alive" case is not mentioned anywhere, so assume it does not.]
- **Suspend / resume**: `POST /sandboxes/{id-or-name}/suspend` and `/resume`. Suspend "pauses a named sandbox in place. Filesystem, memory, and running processes are preserved"; resume returns it to Running, "where it left off" [doc: lifecycle]. Suspended sandboxes consume no compute. Ephemeral sandboxes error on suspend. Marketing claims resume in under a second [web: product pages, unverified].
- **Does a data-plane request auto-resume a suspended sandbox?** Docs only say the proxy "can auto-resume" for _exposed user ports_ [doc: networking]. The Python SDK docstring says `Sandbox.connect` "does **not** auto-resume a suspended sandbox — call `sandbox.resume()` explicitly" and that "Rare transient proxy errors may still occur immediately after resume" [src: `sandbox.py`]. Assume a request to port 9501 on a suspended sandbox fails, and the gateway must `GET` status then `POST /resume` and poll.
- **Terminate**: `DELETE /sandboxes/{id-or-name}`. A terminated sandbox can be restarted within 48 h under the same ID/name (`POST .../restart`; restores most recent snapshot if any) [doc: lifecycle].
- **Snapshots**: filesystem-only (cold boot restore) or memory snapshots (filesystem + VM memory + running processes, warm restore). `POST /sandboxes/{id}/snapshot`, restore via `POST /sandboxes` with `snapshot_id`; `POST /sandboxes/{id}/copy?times=N` [doc: snapshots].
- **Idle cost**: billed per second while running. Usage Credits: $0.07/core-hour, $0.015/GB-h RAM, $0.0002/GB-h disk; Pro $0.042 / $0.009 / $0.0001 plus $250/mo. Suspended: no CPU/RAM/disk charge, state billed as snapshot storage ($0.07/GB-month) [doc: pricing FAQ]. The FAQ does not describe a running-but-idle sandbox separately; it is metered as running. CPU is "based on active execution when available, otherwise allocated vCPU time" [doc]. Free tier: 1 concurrent sandbox. Concurrency caps: Free 1, Usage Credits 100, Pro 1,000.

## 3. Starting a background process

`POST https://<sandbox>.sandbox.tensorlake.ai/api/v1/processes` [doc: processes/start]

```json
{
  "command": "python3",
  "args": ["-u", "-c", "print('hi')"],
  "env": {},
  "working_dir": "/tmp",
  "user": "tl-user",
  "stdin_mode": "closed|pipe",
  "stdout_mode": "capture|discard",
  "stderr_mode": "capture|discard"
}
```

- Defaults: `stdin_mode=closed`, `stdout_mode=capture`, `stderr_mode=capture`, `user=tl-user`.
- Returns `201` with `{handle, pid, status, exit_code, signal, stdin_writable, command, args, started_at, ended_at}`. `handle` is daemon-local; **routes use `pid`** [doc]. `status` in `running|exited|signaled|oom_killed`. SDK also models `oom_killed` and optional `managed` info [src].
- Optional "managed process" fields: `name`, `restart{policy,max_restarts,initial_backoff_ms,max_backoff_ms}`, `health_check` (HTTP/TCP). Routes accept either pid or a managed name (all-digit names are reserved for pids) [doc: commands; src: `ProcessRef`]. Using a `name` could give a stable, human-friendly id instead of a pid; I did not verify what else naming changes (supervision/restart defaults are `never`).
- Survives disconnect: yes by design. The start call returns 201 immediately and the daemon owns the process; the process is tracked independently of any HTTP connection [doc: commands "Background Processes"]. Not explicitly stated as "survives client disconnect", but nothing ties it to the request, unlike `processes/run`.
- No PTY on the plain process API (pipes only). PTY is a separate API: `POST /api/v1/pty` returns `session_id` and `token`, then a WebSocket attach [doc: commands, pty/introduction]. The docs do not say whether a PTY session survives WebSocket disconnect [doc: unknown].
- There is also a one-shot `POST /api/v1/processes/run`: SSE stream of `started` (`handle,pid,started_at`), `output` (`line,timestamp,stream`), then `exited` (`exit_code|signal`, `oom_killed`). Stdin always closed, stdout/stderr always captured, optional `timeout` (seconds; server kills the process on expiry) [doc: processes/run]. If the client disconnects, whether the process continues is [unknown]; do not use `run` for the background path.

## 4. Output retrieval

All process output is **daemon-side buffered, line-oriented**, regardless of whether anyone is connected.

| Endpoint                                     | Behaviour                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/processes/{pid}/output`         | `{pid, lines:[string], line_count}`, combined stdout+stderr, "does not include per-line stream tags" [doc]        |
| `GET .../stdout`, `.../stderr`               | same shape, one stream [doc: commands]                                                                            |
| `GET .../output/follow`                      | SSE: replays existing captured output first, then streams live; events `output` `{line, timestamp, stream: stdout | stderr}`; final `eof` `{}` when the process exits and output closes [doc: follow-output] |
| `GET .../stdout/follow`, `.../stderr/follow` | per-stream SSE [doc: commands; src]                                                                               |

- **No offset / cursor / since / tail parameters** are documented on any of these (Output and Follow list none; SDK sends none [src: `get_output`, `follow_stream_cb`]). So the only cursor available is one we invent: the number of lines already delivered. `follow` replays from the start every time, so a client-side skip of N events is required; `GET /output` returns the whole buffer every time.
- `Last-Event-ID`/reconnect semantics, ordering guarantees between stdout and stderr, what a missing PID returns on follow: [doc: explicitly unspecified].
- Retention and size limits of the in-daemon buffer, and how long an exited process's output remains readable: [unknown]. The docs say nothing (Commands, Get, Output pages all explicitly lack this).
- Partial lines (output with no trailing newline, e.g. `print(..., end="")` or a progress prompt): whether `lines`/SSE emit them before a newline arrives or at exit is [unknown]. Always run Python with `-u` and test this.
- SSE keep-alive: the SDK's SSE reader skips non-output events/"heartbeats" and has a test for keep-alive comments resetting its idle timer, which implies the server sends SSE comments [src: `sse.rs`, `follow_stream_cb`]. Not in the docs.
- Persisted logs (separate system): `GET https://api.tensorlake.ai/v1/namespaces/{projectId}/sandboxes/{sandboxId}/logs` with `tail`, `level`, `processId`, `body`, `nextToken`; retention "according to the log retention policy for your environment" (duration unstated); "very recent output can take a short time to appear" [doc: process-logs]. Needs the project ID in the path, so it is awkward from a key-only gateway and not suitable as the primary cursor source. It is a possible fallback for output the daemon no longer holds.
- **File-redirect workaround** (robust, unbounded by daemon buffers): start `bash -c 'exec python3 -u /tmp/x/run.py > /tmp/x/out.log 2>&1'` (or set `stdout_mode`/`stderr_mode: discard`). Then:
  - Read whole file: `GET /api/v1/files?path=...` returns raw bytes. **No Range support is documented** (Read File page explicitly lacks it).
  - Ranged/tail read: `POST /api/v1/processes/run` with `tail -c +<byteoffset+1> /tmp/x/out.log` (or `dd`/`python3 -c`). Output arrives as line events, so binary-exact/trailing-newline fidelity needs care (e.g. base64 it).
  - This gives a true byte-offset cursor and survives any daemon buffer limit, at the cost of one extra `run` call and loss of the stdout/stderr tag (merged by `2>&1`).

## 5. Waiting with a timeout, exit code, list

- No server-side "wait for exit" endpoint, and no `wait`/`wait_for_exit` in the SDKs; the docs' own TypeScript example polls `getProcess` every ~100 ms until status is no longer `running` [doc: commands; sdk-reference states there is no wait method].
- What does exist:
  1. `GET .../output/follow`: stays open until `eof` (process exit). Reading it with a deadline and then cancelling the reader _is_ a server-assisted timed wait (returns early on exit, because `eof` arrives).
  2. `POST .../processes/run` with a `timeout`, usable for a shell-side wait loop (see section 11 alt).
  3. Poll `GET /api/v1/processes/{pid}` for `status`, `exit_code`, `signal`, `ended_at`.
- Exit code retrieval after finish: `GET /api/v1/processes/{pid}` returns `exit_code` (null while running) and `signal` (set if killed by a signal; `oom_killed` appears as status and `signal: 9` in `run` events). `404` if the daemon does not know the pid [doc: processes/get].
- Retention of exited processes: [unknown]. The Get page says nothing about purge time.
- List: `GET /api/v1/processes` returns `{processes:[ProcessInfo]}`, no pagination or filters; whether exited processes are included is not stated (the status enum suggests so) [doc: processes/list].

## 6. Terminate

- Graceful: `POST /api/v1/processes/{pid}/signal` body `{"signal": 15}` -> `200 {"success": true}`; `400` if the signal is invalid or the process is not running; `404` if unknown [doc: processes/signal].
- Force: `DELETE /api/v1/processes/{pid}` -> `204`, documented as SIGKILL. `404` if not found [doc: processes/kill].
- Children / process group: **not documented** for either endpoint. Plan for orphaned children: run Python under `setsid` and `kill -- -<pgid>` through `processes/run`, or `pkill -P <pid>`, as a best-effort second step. Verify live.
- Killing a whole sandbox is also an option (`DELETE /sandboxes/{id}`), which obviously kills everything.

## 7. stdin

Supported. Start with `stdin_mode: "pipe"` (so `stdin_writable: true`), then `POST /api/v1/processes/{pid}/stdin` with `Content-Type: application/octet-stream` and raw bytes -> `204` (`400` if not opened in pipe mode); `POST .../stdin/close` sends EOF [doc: processes/stdin, commands]. No documented size limit. Not needed for the two target tools, but it enables `python3 -` fed from stdin or an interactive `python3 -i` if you ever add `write_stdin`.

## 8. Files API

On the data plane [doc: file-operations, sandbox-files; src: `read_file`/`write_file`]:

- `PUT /api/v1/files?path=<p>`, body raw `application/octet-stream`, `204`; parent dirs auto-created; `..` in path gives `403`. The SDK streams uploads with a `Content-Length` header.
- `GET /api/v1/files?path=<p>` returns raw bytes (`application/octet-stream`); `400` if a directory; `404` missing.
- `GET /api/v1/files/list?path=<p>`, `DELETE /api/v1/files?path=<p>`.
- No mkdir/mv endpoints (use `processes/run`).
- Size limits: not documented. Range reads: not documented. There is also `POST /api/v1/blob/sign` in the SDK [src], undocumented here and not investigated.
- Paths are relative to the process cwd or absolute; prefer absolute `/tmp/...`.

## 9. Running Python

- No code-interpreter or stateful-kernel API. The docs' own "Tool Calls" guide runs `sandbox.run("python", ["-c", code])` and says explicitly "Each `run_code` call starts a new Python process, so variables and imports must be redefined" while filesystem and installed packages persist for the sandbox's life [doc: tool-calls]. (A third-party article titled "Building a Stateful Code Interpreter with Tensorlake Sandboxes" exists; that is user-built, not a product feature.)
- Default image `tensorlake/ubuntu-minimal` has a "system Python installation managed according to PEP 668"; version and preinstalled packages are not documented. Use `python3`; `pip install` needs `--break-system-packages` (or a venv) [doc: tensorlake-images, tool-calls]. Verify `python3 --version` and whether `python` (no 3) exists. Internet egress is on by default.
- For long-running scripts: `python3 -u` (unbuffered) is essential so output arrives line-by-line.

## 10. Request time limits, rate limits

- Data-plane per-request limits (max request duration, SSE max lifetime, idle timeout of the proxy, max body size): [doc: explicitly not covered] in the networking, commands, and follow-output pages.
- API rate limits / quotas: not documented ("Rate limits: Not specified" in the create page; pricing FAQ is silent). The SDK treats `429, 502, 503, 504` as retryable with 3 retries and 0.5 s backoff [src: `_defaults.py`], which suggests those can occur and that the gateway should retry idempotent GETs similarly. SDK default HTTP timeout 300 s [src].
- `processes/run` has a server-enforced `timeout` field; the SDK default for streams is client-enforced idle timeouts [src].
- Cloudflare side: a `fetch` to the sandbox host that streams an SSE body for `yield_time_ms` (default 10 s) is well within normal Worker behaviour, but subrequest-count limits per invocation (50 free / 1000 paid) and any per-request wall-time policy are Cloudflare matters not researched here. Prefer one SSE read to a poll loop to conserve subrequests.

## 11. Verdict and recommended mechanism

**Verdict: feasible with native primitives plus a client-side cursor.** Nothing is impossible. Two things need workarounds: (a) no offset/cursor on output, (b) no server-side timed wait. Both are solved without any persistent connection or state in the Worker, because the daemon holds the state (process table + buffered output) and the cursor travels inside `execution_id`/`cursor`.

### Identifiers

- `execution_id` = opaque, URL-safe encoding of `{sandbox_id (or name), pid, started_at, ingress host?}`. `started_at` guards against pid reuse after a sandbox restart/restore. The user's API key is supplied on each request, as the task requires; nothing is stored.
- `cursor` = opaque integer: count of output lines (events) already returned. (Byte offset if you choose the file-redirect variant.)

### `exec_python({code, yield_time_ms})`

1. Obtain a sandbox: use a sandbox id/name if the caller provides one, else `POST api.tensorlake.ai/sandboxes` (set `timeout_secs` generously, see gotchas; use a `name` if you want suspend semantics). Keep `sandbox_id` and `ingress_endpoint`/`sandbox_url`.
2. Start: `POST /api/v1/processes` with `command:"python3"`, `args:["-u","-c",code]` (code <= ~100 KB; otherwise `PUT /api/v1/files?path=/tmp/tl/<uuid>.py` first and run `python3 -u /tmp/tl/<uuid>.py`). Capture stdout and stderr. Take `pid`.
3. Collect/wait: `GET /api/v1/processes/{pid}/output/follow` (`Accept: text/event-stream`), read events until `eof` OR `yield_time_ms` elapsed, then cancel the reader. Lines read = new cursor.
4. If `eof` arrived: `GET /api/v1/processes/{pid}` for `exit_code`/`signal`/`status`. If `exit_code` and `signal` are both null, re-poll briefly (it may lag `eof`; see races). Return output + exit code.
5. Else return `{output so far, execution_id, cursor}`; process keeps running in the sandbox.

### `wait({execution_id, cursor, yield_time_ms, terminate})`

- Not terminating: same follow-SSE, but **discard the first `cursor` events**, then collect new ones until `eof` or the deadline; return new lines, new cursor, and `exit_code` if finished. The Worker connection is dropped after the yield time; the process is unaffected.
- Terminate: `POST .../signal {15}`, then after a short grace `DELETE .../{pid}` (SIGKILL), then best-effort child cleanup (`pkill`) via `processes/run`; read the final status and remaining output.
- Cheaper variant for a quick status/no-wait read: `GET .../output` (take `lines[cursor:]`) plus `GET .../{pid}`.

### Alternative if buffer retention proves lossy (verify live)

Wrap the script: `bash -c 'exec python3 -u /tmp/tl/<id>.py > /tmp/tl/<id>.log 2>&1'` with cursor = byte offset. Timed wait and ranged read in one server-side call: `POST /processes/run` with `bash -c 'while kill -0 PID 2>/dev/null && [ $(stat -c%s LOG) -le OFF ]; do sleep 0.2; done; tail -c +$((OFF+1)) LOG'` and `timeout` = yield time. This avoids replaying the whole buffer each time and removes dependence on in-daemon retention, at the cost of shell-script complexity, loss of stdout/stderr distinction, and the process-exit race (exit status still read from `GET /processes/{pid}`).

### What works natively / needs workaround / impossible

- Native: start background process, pid, survives our disconnect, full output read, live SSE with replay, status + exit code, SIGTERM/SIGKILL, stdin, file upload/read, list.
- Workaround: cursor (client-side line count, or byte offset via file redirect), bounded wait (SSE with client deadline, or shell wait loop), child cleanup, auto-resume of suspended sandbox, keepalive against idle timeout.
- Impossible/undocumented: ranged reads on the Files API, a pagination/offset on process output, a server-side wait endpoint, a Python REPL/kernel session (each exec is a fresh process).

### Race conditions to handle

1. **`eof` vs exit code**: `eof` is sent "when the process exits and its output stream closes"; the process record may not yet show `exit_code`. Re-poll `GET /processes/{pid}` a few times (e.g. 3 x 100 ms) before returning "finished, code unknown".
2. **Cursor skew on concurrent `wait` calls** (agent issues two at once): both return overlapping or duplicate ranges because each is independent. Make the cursor monotonic and let callers resume from the highest one; the line-count scheme is idempotent for identical cursors.
3. **Replay while writing**: following from the start while the process is still writing should be consistent, but ordering of interleaved stdout/stderr lines inside the combined stream is not specified.
4. **Cancel mid-line**: cancelling the SSE read can leave a partially received event; only count fully parsed `output` events toward the cursor.
5. **Process exits between start and follow**: replay covers this, assuming exited-process output stays readable (retention unknown). Treat `404` as "execution expired".
6. **Idle timeout fires while Python is running quietly** (see gotchas) and **suspend/resume transients** after the gateway resumes the sandbox.
7. **PID reuse** after a memory-snapshot restore or sandbox restart; check `started_at` against the one in `execution_id`.

## 12. Gotchas, maturity, open questions

**Maturity**: Sandboxes look young and fast-moving. The only dated announcement I found is a "Product Update" newsletter from May 2026 (https://tensorlake.beehiiv.com/p/tensorlake-sandboxes-from-fast-startup-to-full-agent-infrastructure); Tensorlake itself (Document AI, Applications) is older. The SDK package is at ~0.5.x (a pre-1.0 PyPI release line, `tensorlake 0.5.95` observed in a search result), the public repo snapshot is a single vendored commit, and the docs ship an `llms.txt`. Docs have inconsistencies: create says `sandbox_id` and get says `id`; free-tier limits differ between pages (create vs. pricing FAQ vs. pricing page); several pages say "not specified". The sandbox daemon source is not public. Expect API drift; pin to the documented v2 routes (`/api/v1/...` on the data plane) and keep unit tests that hit them.

**Gotchas**

- Idle timeout is traffic-based, not process-based: a silent long job outlives neither an ephemeral sandbox's timeout nor stays running in a named one (it gets suspended: frozen, not killed). Set `timeout_secs` as high as the plan allows, or document that `wait` must be called at least every `timeout_secs`. Each Worker data-plane call counts as activity.
- Named sandbox suspended -> data-plane calls likely fail until `POST /resume` (and a short settle period). Ephemeral sandboxes are simply gone after timeout. Surface "sandbox suspended/terminated" as a distinct error.
- Default user is `tl-user` (not root) for `start`; the SDK `run` defaults to the image user, falling back to root [src]. Pass `user` explicitly if you rely on pip installs or root-owned paths.
- `pip install` requires `--break-system-packages` (PEP 668).
- `timestamp` is documented as epoch ms integer but a SDK test uses a float [src]; parse as a number.
- `status` has four values; killed processes show `signaled` (not `exited`) with `exit_code: null`. Report signal N as 128+N or as `signal`.
- Process names that are all digits are reserved (pid addressing).
- Free tier is 1 concurrent sandbox, so per-call sandbox creation will hit limits quickly; reuse sandboxes or terminate when done. A gateway that creates sandboxes should also tear them down or set a short timeout, since cost keeps accruing while running.
- Wildcard host `*.sandbox.tensorlake.ai`: confirm there are no Worker-side restrictions (should be fine, it is a normal public hostname).

**Open questions to verify live (highest value first)**

1. Output buffer: max lines/bytes, ring or unbounded, how long after exit it stays readable, whether `/output` and `/output/follow` always agree on line numbering.
2. Are lines emitted before a trailing newline? How are `\r` progress bars and very long lines handled?
3. Does a follow SSE client disconnect have any effect on the process? (Expect none.) Is there a max SSE lifetime or idle cutoff (keep-alive frequency)?
4. Does `follow` for an already-exited process replay and then immediately send `eof`? What does the stream do for a nonexistent pid?
5. Does `DELETE /processes/{pid}` or `signal` reach children? Does the daemon start each process in its own process group?
6. Do data-plane requests auto-resume a suspended named sandbox, and what error shape and latency appear if not?
7. Is `exit_code` populated at the moment `eof` fires?
8. Rate limits (429 behaviour) on `api.tensorlake.ai` and the sandbox proxy, and per-request body/duration limits on the proxy.
9. Python version / `python` vs `python3` in `tensorlake/ubuntu-minimal`, and `PYTHONUNBUFFERED` defaults.
10. Does `processes/run` keep the process alive if the client disconnects mid-stream (affects whether it can substitute for start + follow)?
11. Process logs API: can it be called with only the API key and a sandbox id (project id in path)? If so it is a durable fallback for output the daemon forgot.

## Sources (all checked 2026-10-12)

Docs (each page also available as `.md`):

- https://docs.tensorlake.ai/llms.txt (index)
- https://docs.tensorlake.ai/sandboxes/introduction
- https://docs.tensorlake.ai/sandboxes/lifecycle
- https://docs.tensorlake.ai/sandboxes/commands
- https://docs.tensorlake.ai/sandboxes/processes
- https://docs.tensorlake.ai/sandboxes/process-logs
- https://docs.tensorlake.ai/sandboxes/file-operations
- https://docs.tensorlake.ai/sandboxes/sdk-reference
- https://docs.tensorlake.ai/sandboxes/snapshots
- https://docs.tensorlake.ai/sandboxes/networking
- https://docs.tensorlake.ai/sandboxes/tool-calls
- https://docs.tensorlake.ai/sandboxes/images
- https://docs.tensorlake.ai/sandboxes/tensorlake-images
- https://docs.tensorlake.ai/platform/authentication
- https://docs.tensorlake.ai/faqs/pricing-limits-faq
- https://docs.tensorlake.ai/faqs/sandboxes-faq
- https://docs.tensorlake.ai/api-reference/v2/introduction
- https://docs.tensorlake.ai/api-reference/v2/sandboxes/create
- https://docs.tensorlake.ai/api-reference/v2/sandboxes/get
- https://docs.tensorlake.ai/api-reference/v2/processes/introduction
- https://docs.tensorlake.ai/api-reference/v2/processes/start
- https://docs.tensorlake.ai/api-reference/v2/processes/run
- https://docs.tensorlake.ai/api-reference/v2/processes/get
- https://docs.tensorlake.ai/api-reference/v2/processes/list
- https://docs.tensorlake.ai/api-reference/v2/processes/output
- https://docs.tensorlake.ai/api-reference/v2/processes/follow-output
- https://docs.tensorlake.ai/api-reference/v2/processes/signal
- https://docs.tensorlake.ai/api-reference/v2/processes/kill
- https://docs.tensorlake.ai/api-reference/v2/processes/stdin
- https://docs.tensorlake.ai/api-reference/v2/sandbox-files/introduction
- https://docs.tensorlake.ai/api-reference/v2/sandbox-files/read
- https://docs.tensorlake.ai/api-reference/v2/sandbox-files/write
- https://docs.tensorlake.ai/api-reference/v2/pty/introduction

Source code (public, the daemon is not included):

- https://github.com/tensorlakeai/tensorlake (HEAD 39ba09f, 2026-10-10): `crates/cloud-sdk/src/sandboxes/mod.rs` (REST routes, `SandboxProxyClient`, `ProcessRef`), `crates/cloud-sdk/src/sandboxes/models.rs` (`ProcessInfo`, `OutputResponse`, `OutputEvent`, `RunProcessEvent`), `crates/cloud-sdk/src/client.rs` (auth headers), `crates/cloud-sdk/src/sse.rs`, `src/tensorlake/sandbox/_defaults.py` (retry/timeouts, API URLs), `src/tensorlake/sandbox/sandbox.py`
- https://github.com/tensorlakeai (org listing)

Other:

- https://tensorlake.beehiiv.com/p/tensorlake-sandboxes-from-fast-startup-to-full-agent-infrastructure (May 2026 product update)
- Web search snippets for marketing claims (resume latency, live migration) were not independently verified.
