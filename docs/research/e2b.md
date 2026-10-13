# E2B API research for a stateless Python execution gateway

Date checked: **2026-10-12**. Scope: public documentation, OpenAPI/protobuf definitions, and public SDK/daemon source only. No credentials, sandbox creation, signup, or live API validation were used.

## Verdict

**Yes, a Cloudflare Worker can implement `exec_python` and subsequent `wait` calls using outbound HTTPS fetches only, with a sandbox-side supervisor and file-backed output/status. Native process reattachment alone does not provide the requested reliable semantics.** Processes survive HTTP disconnection, but missed output is not replayed. Current daemon source retains exit events for only **30 seconds**. File downloads support HTTP `Range`, making byte cursors practical. The Code Interpreter `/execute` service explicitly interrupts the kernel on client disconnect, so it cannot directly provide yield-and-continue behavior. These are source findings, not confirmation of the versions deployed in E2B's cloud. [Process startup](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/start.go), [exit retention](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/service.go), [file download API](https://docs.e2b.dev/api-reference/filesystem/download-a-file), [interpreter disconnect handling](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/messaging.py).

Recommended design: upload a Python script plus a small supervisor; start the supervisor through native `Process/Start` without a process deadline tied to the yield interval; write append-only logs and atomic completion metadata; use bounded `Process/Connect` streams as a wait notification and HTTP byte-range reads as the authoritative output. No Worker connection remains open between tool calls.

## 1. API surface, authentication, and transport

| Surface          | Base URL / route                                                                                                                          | Transport and authentication                                                                                  | Worker suitability                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Control plane    | Current OpenAPI server: `https://api.e2b.app`; SDK derives `https://api.<domain>`                                                         | REST JSON; project key in `X-API-Key`                                                                         | Ordinary `fetch`                                                               |
| In-sandbox envd  | `https://sandbox.e2b.app`, with `E2b-Sandbox-Id` and `E2b-Sandbox-Port: 49983`; alternatively `https://49983-<sandboxID>.<sandboxDomain>` | Connect RPC for processes/filesystem metadata; `X-Access-Token: <envdAccessToken>`                            | Unary JSON and server streaming work over fetch                                |
| File content     | Same envd host, `/files?path=<URL-encoded-path>`                                                                                          | HTTP GET/POST; same sandbox access token                                                                      | Ordinary download/upload and range requests                                    |
| Code Interpreter | Same sandbox routing, port `49999`, `/execute` and `/contexts`                                                                            | HTTP JSON request and newline-delimited JSON results; traffic token when required, plus envd token on execute | Transport works; execution lifecycle does not meet detached-yield requirements |

The prompt's `api.e2b.dev` reflects another domain configuration; the **current checked spec advertises `api.e2b.app`**. The SDK recognizes both `.app` and `.dev` domains and supports custom sandbox domains. Use the configured control-plane domain and returned `sandboxDomain`, rather than mixing domains. [Control-plane OpenAPI](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/openapi.yml), [SDK URL construction](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/connectionConfig.ts).

The project API key and sandbox access token are **different credentials**. Create/connect/info responses supply `envdAccessToken`; do not put the project API key into `X-Access-Token` despite misleading `<api-key>` placeholders in some generated examples. Current v2 creation always secures envd access. Obtain sandbox details again using the caller's project key when necessary. [Create v2](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2), [Start authentication](https://docs.e2b.dev/api-reference/process/start), [secured access](https://docs.e2b.dev/sandbox/secured-access).

An optional `Authorization: Basic <base64(username + ':')>` selects the sandbox Unix user. It does not replace the sandbox access token. Current envd versions use the template default user when omitted. [SDK user header](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/envd/rpc.ts).

**Unary Connect:** POST to routes such as `/process.Process/List`, `/process.Process/SendInput`, `/process.Process/SendSignal`, or `/filesystem.Filesystem/Stat`, with `Content-Type: application/json`, `Connect-Protocol-Version: 1`, routing/auth headers, and an ordinary JSON object. These are public wire APIs, not SDK-only capabilities. [SendInput reference](https://docs.e2b.dev/api-reference/process/sendinput), [Stat reference](https://docs.e2b.dev/api-reference/filesystem/stat).

**Server streaming:** `Start`, `Connect`, and `WatchDir` use `application/connect+json`. Even the single request message must be enveloped:

```text
1 byte flags | 4 bytes unsigned payload length, big-endian | UTF-8 JSON payload
```

Use flag `0` for an uncompressed data message. Responses contain zero or more data envelopes followed by an end-stream envelope with flag `2`, whose JSON carries optional error and metadata. Flag bit `1` denotes compression; avoid requesting message compression for a minimal implementation. Streaming RPC errors can be carried in the final envelope while HTTP status is still 200. The RPC end-stream envelope is distinct from the process's own `event.end`. [Start wire reference](https://docs.e2b.dev/api-reference/process/start), [WatchDir reference](https://docs.e2b.dev/api-reference/filesystem/watchdir), [Connect protocol](https://connectrpc.com/docs/protocol/).

A minimal **request-framing** fragment, not a complete client:

```javascript
function connectFrame(message) {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

const response = await fetch('https://sandbox.e2b.app/process.Process/Start', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/connect+json',
    'Connect-Protocol-Version': '1',
    'E2b-Sandbox-Id': sandboxID,
    'E2b-Sandbox-Port': '49983',
    'X-Access-Token': envdAccessToken,
    'Keepalive-Ping-Interval': '50',
  },
  body: connectFrame({
    process: { cmd: '/usr/bin/python3', args: ['-u', scriptPath] },
    stdin: false,
    tag: uniqueExecutionTag,
  }),
  signal: abortController.signal,
});
// Read response.body incrementally, buffering partial envelope headers/payloads.
// Do not call response.json(); abort/cancel after the local yield deadline.
```

JSON protobuf `bytes` fields are base64 strings; field names use lowerCamelCase, e.g. `exitCode`. HTTP chunks have no required alignment with envelopes. Detect truncation and bound frame lengths. Server streaming with a finite request body works over HTTP/1.1 or HTTP/2; **there is no HTTP/2-only or HTTP-trailers requirement when using Connect**. Native gRPC is a different transport and is unnecessary. The E2B JS SDK itself uses the fetch-based Connect web transport with JSON serialization, including an edge-runtime redirect adjustment. This plus Workers' stream support establishes compatibility by documentation/source analysis, not a live integration test. [SDK transport](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/sandbox/index.ts), [Workers streams](https://developers.cloudflare.com/workers/runtime-apis/streams/).

`StreamInput` is a client-streaming RPC. Avoid depending on request-body streaming support or duplex behavior: unary `SendInput` is sufficient for this gateway.

## 2. Sandbox lifecycle, timeouts, persistence, and idle cost

Current control-plane endpoints:

| Operation       | HTTP request                                               | Important behavior                                                                                                        |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Create          | `POST /v2/sandboxes`                                       | Required `templateID`; `timeout` in seconds; response includes sandbox ID, envd version/access token, and routing details |
| Reattach/resume | `POST /v2/sandboxes/{sandboxID}/connect`                   | Running: 200; paused: resumes and returns 201; optional body `{"timeout": 300}`; extends TTL without shortening it        |
| Inspect         | `GET /sandboxes/{sandboxID}`                               | Inspect state/details without intentionally connecting/resuming                                                           |
| Set timeout     | `POST /sandboxes/{sandboxID}/timeout`, `{"timeout": N}`    | Sets expiration to N seconds from now; can shorten an existing TTL                                                        |
| Refresh         | `POST /sandboxes/{sandboxID}/refreshes`, `{"duration": N}` | Keep-alive extension; does not shorten TTL                                                                                |
| Pause           | `POST /sandboxes/{sandboxID}/pause`                        | Full-memory pause by default                                                                                              |
| Destroy         | `DELETE /sandboxes/{sandboxID}`                            | Permanent termination                                                                                                     |

Older `POST /sandboxes`, `/sandboxes/{id}/connect`, and `/sandboxes/{id}/resume` remain described but are deprecated. Importantly, old create/resume schemas have a **15-second** raw API default, while current v2 create/connect and the documented SDK lifecycle use **300 seconds / five minutes**. Set timeout explicitly. Refresh's request schema allows duration up to 3600 seconds; its current handler defaults/clamps to the legacy 15-second minimum. Prefer explicit v2 connect or set-timeout for predictable lease handling. [OpenAPI lifecycle operations/defaults](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/openapi.yml), [refresh handler](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/api/internal/handlers/sandbox_refresh.go), [set-timeout reference](https://docs.e2b.dev/api-reference/sandboxes/set-sandbox-timeout).

Maximum **continuous** sandbox runtime is one hour on Hobby, 24 hours on Pro, and custom on Enterprise. Extending TTL does not eliminate this plan limit. Pause/resume resets the continuous-runtime window. No connected client is required for the sandbox or native processes to run; disconnection is not an idle shutdown trigger. [Sandbox lifecycle](https://docs.e2b.dev/sandbox), [lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime).

Default timeout action is kill: processes and sandbox state are lost. Optional full-memory auto-pause freezes execution and preserves memory/filesystem for later resume; **a paused script makes no progress**. Current REST creation expresses this as `autoPause: true`, optional `autoPauseMemory: true`, and `autoResume: {"enabled": true}`. SDK `lifecycle: {onTimeout: 'pause', autoResume: true}` is translated into those fields; do not blindly send the SDK object as a REST creation body. Filesystem-only pause drops memory and reboots on resume, so it does not preserve running scripts. [SDK lifecycle translation](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/sandbox/sandboxApi.ts).

Auto-resume can be triggered by sandbox HTTP traffic or SDK operations. After auto-resume the timeout is at least five minutes or the longer original create timeout. **Traffic to a running sandbox does not reset its timeout**; explicitly extend it. Full-memory auto-resume requires memory-preserving pause. [Auto-resume documentation](https://docs.e2b.dev/sandbox/auto-resume).

An idle but running sandbox incurs ordinary per-second charges for its allocated vCPU/RAM. Paused/killed sandboxes incur no running compute charge. Paused sandboxes currently have unlimited retention and do not consume running-sandbox concurrency. Therefore configure an explicit lease large enough for uninterrupted background execution, or accept that auto-pause suspends it until the next call. A stateless Worker cannot renew leases when nobody calls it. [Billing and limits](https://docs.e2b.dev/billing), [paused sandbox FAQ](https://docs.e2b.dev/faq).

## 3. Starting a background process and PTY support

`POST /process.Process/Start` is a server-streaming RPC with decoded request:

```json
{
  "process": {
    "cmd": "/usr/bin/python3",
    "args": ["-u", "/home/user/jobs/JOB/script.py"],
    "envs": { "EXAMPLE": "value" },
    "cwd": "/home/user/jobs/JOB"
  },
  "stdin": false,
  "tag": "unique-job-tag"
}
```

Optional `pty: {"size": {"cols": 80, "rows": 24}}` creates a PTY. `stdin` enables an input pipe; omitting it preserves backward compatibility with older envd behavior, which defaults to enabled. Current SDKs explicitly default it to false. A PTY produces a single PTY output stream rather than separate stdout/stderr and supports resize through `/process.Process/Update`. [Process protobuf](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/envd/process/process.proto), [PTY docs](https://docs.e2b.dev/sandbox/pty).

The first process event is `{"event":{"start":{"pid":123}}}`. Subsequent events carry stdout/stderr/PTY bytes, keepalives, and a terminal event with `exitCode`, `exited`, `status`, and optional `error`. No persistent execution object or server-generated cursor is returned. `background: true` is an SDK return-behavior option, not a StartRequest field: it returns a handle after start instead of awaiting completion. The SDK still consumes an output stream until disconnected. [SDK background behavior](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/sandbox/commands/index.ts), [background documentation](https://docs.e2b.dev/commands/background).

**Yes, the process keeps running after Start's HTTP stream disconnects.** The daemon uses a background process context separately from the request context. However, `Connect-Timeout-Ms` on **Start** is also used as a process runtime deadline. Do not set it to `yield_time_ms`, and do not inherit the SDK's default 60-second command timeout unintentionally. Omit it for no process deadline, and use a client-side abort for yielding. If using the SDK, command `timeoutMs: 0` / Python `timeout=0` disables the command deadline. A deliberate execution runtime cap is a separate policy from a yield interval. [Daemon Start context/deadline](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/start.go), [Python SDK command options](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/python-sdk/e2b/sandbox_sync/commands/command.py).

No `nohup` or shell `&` is needed merely to survive the HTTP disconnect. Starting an unmanaged shell child unnecessarily gives up envd tracking of the actual job.

## 4. Output reattachment, replay, buffers, and file offsets

`POST /process.Process/Connect` takes `{"process":{"pid":123}}` or `{"process":{"tag":"unique-job-tag"}}`. It sends a start event identifying the PID, then current process data/end events. This is native reattachment to the live process, **not replay of earlier output**. There is no offset, sequence number, cursor, or "read output since" field in ConnectRequest. [Connect API](https://docs.e2b.dev/api-reference/process/connect), [Connect implementation](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/connect.go).

The daemon explicitly drains stdout/stderr/PTY but only publishes data when subscribers exist. The multiplex fan-out does not keep a replay history. Its internal channel buffers are transport backpressure buffers, not durable logs. Output can disappear during the gap between one request disconnecting and another reconnecting, and partially received frames also cannot be resumed. [Output readers](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/handler/handler.go), [multiplexer](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/handler/multiplex.go).

**Workaround is supported natively at the file layer:** redirect Python output into append-only files and request:

```http
GET /files?path=%2Fhome%2Fuser%2Fjobs%2FJOB%2Foutput.log
Range: bytes=1234-66569
Accept-Encoding: identity
X-Access-Token: <envdAccessToken>
E2b-Sandbox-Id: <sandboxID>
E2b-Sandbox-Port: 49983
```

`Range` is explicitly documented. The daemon uses Go `http.ServeContent`, and switches to identity encoding for range/conditional requests, giving normal partial-content behavior. `/filesystem.Filesystem/Stat` with `{"path":"..."}` returns `entry.size` and other metadata; protobuf int64 size may be serialized as a decimal string. There is no separate `offset` read RPC. [Download reference](https://docs.e2b.dev/api-reference/filesystem/download-a-file), [download handler](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/api/download.go), [filesystem protobuf](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/envd/filesystem/filesystem.proto).

Recommended cursor discipline, as gateway implementation choices:

- Track **bytes**, not characters; advance only by bytes actually returned successfully. Validate 206/`Content-Range`, and handle an unexpected 200 without treating it as a requested slice.
- Read bounded ranges from cursor `c` through `min(size - 1, c + chunkLimit - 1)`. Skip the GET if `size <= c`; an EOF range normally returns 416 rather than waiting for file growth.
- Disable intermediary caching for growing logs/status and verify no stale range responses. Stat and range GET are separate observations, so allow appends between them; never assume a range download tails the file.
- Avoid log rotation/truncation; attach a job generation/file identity to the cursor. If size falls below cursor, report/reset according to an explicit policy.
- Preserve partial UTF-8 bytes in the client-carried cursor state or return bytes/base64; decoding each arbitrary range independently can corrupt split characters.
- Separate stdout/stderr files preserve channel identity but not a single total order. A merged log is simpler; a supervisor-generated append-only event log can preserve stream labels and sequencing.

## 5. Waiting, yield deadlines, and recovering exit status

There is **no standalone process Wait/GetExitStatus RPC or yield option** in the checked process service. SDK `handle.wait()` consumes the existing stream locally. Implement bounded waiting by reading Start/Connect until process `event.end` or the gateway's local deadline, then abort the stream. Connect's RPC deadline can bound that connection; unlike Start it does not construct a new process runtime deadline. A deadline error means the wait ended, not that the process necessarily exited. [Process service definition](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/envd/process/process.proto), [SDK handle wait/disconnect](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/sandbox/commands/commandHandle.ts).

**Current source does retain exit status, but only briefly:** after termination, the live handler is removed and its terminal event is cached for 30 seconds. A late Connect by PID/tag within that window can return a retained Start+End pair. Output is not retained. Cache entries are cleared on PID/tag reuse. This is an implementation detail of the pinned infra revision, not a published stable retention guarantee; older sandbox envd versions may lack it entirely. Do not describe exit codes as retained indefinitely or categorically never retained. [Retention TTL/cache](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/service.go), [late Connect](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/connect.go).

`/process.Process/List` lists current tracked processes with config, PID, and optional tag; there is no finished-process list or exit field. Once a terminal event has expired, a missing PID does not reveal its exit code. Processes created outside the service are not automatically a full OS process listing. [List implementation](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/list.go).

For reliable later waits, have a supervisor write `status.json` via temporary file plus atomic rename after waiting for Python and completing log writes. Record code/signal and job identity. A signaled native process can have `exitCode: -1` with `exited: false` and signal information in `status`; normalize deliberately rather than assuming every termination is a positive shell-style code. Never infer success merely from a closed HTTP stream. [Native end-event construction](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/handler/handler.go).

For a wait call: read durable status first; if unfinished, open Connect to the supervisor, wait until end/deadline, close, then reread status and logs. If it exited between the status read and Connect, a not-found response requires another status read. Durable status resolves that race without depending on the 30-second cache. A polling loop is a fallback for dropped streams; bound its fetch count. A short sandbox-side wait helper with its own deadline is another option, but it is custom code, not a native server-side wait API.

## 6. Termination and child processes

Unary `POST /process.Process/SendSignal`:

```json
{ "process": { "pid": 123 }, "signal": "SIGNAL_SIGTERM" }
```

PID or tag selectors are supported. The enum permits SIGTERM (15) and SIGKILL (9); SDK `commands.kill()` uses SIGKILL. Current daemon signaling targets **the selected PID**, through `os.Process.Signal` or `syscall.Kill(pid, signal)`, not a negative process-group ID and not a recursive process-tree/cgroup kill. Do not assume children die with the parent. [Signal API](https://docs.e2b.dev/api-reference/process/sendsignal), [signal handler](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/signal.go), [PID signaling implementation](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/handler/handler.go).

A supervisor should start Python in its own session/process group and implement cancellation by signaling that child group, while the supervisor remains alive to `wait()` and persist terminal status. A SIGTERM handler on the supervisor can initiate this; alternatively upload a cancellation marker which it polls. Escalate the **child group** to SIGKILL after a bounded grace period. Sending SIGKILL to the supervisor prevents it from recording completion. Descendants that deliberately create separate sessions can escape an ordinary group kill; sandbox destruction terminates everything but also destroys the logs/status and any unrelated jobs. This group-management behavior is a proposed gateway helper, not an E2B process API guarantee.

## 7. Input to an already running process

Enable `stdin: true` at Start. Unary `POST /process.Process/SendInput` accepts PID/tag and `input.stdin` containing base64-encoded bytes; PTYs use `input.pty` instead:

```json
{ "process": { "pid": 123 }, "input": { "stdin": "aGVsbG8K" } }
```

This sends `hello\n`. Unary `/process.Process/CloseStdin` signals EOF for non-PTY processes; for a PTY, send Ctrl-D (`0x04`) through PTY input. `StreamInput` provides ordered client-streaming input, but it is unnecessary for discrete fetch calls. Concurrent unary input calls have no cross-request ordering guarantee; serialize them in the caller. A file-backed supervisor must explicitly forward input to its child if future tools need stdin. [SendInput docs](https://docs.e2b.dev/api-reference/process/sendinput), [CloseStdin docs](https://docs.e2b.dev/api-reference/process/closestdin), [daemon input handling](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/input.go).

## 8. Script upload, file reads/listing, and limits

- Upload: `POST /files?path=<encoded-path>`, with `Content-Type: application/octet-stream` and raw script bytes, or multipart/form-data parts named `file`. Parent directories are created and existing destinations are overwritten. A single-file raw upload is easiest from a Worker.
- Read: `GET /files?path=...`, including optional Range. File content is HTTP, not a protobuf read RPC.
- List: unary `POST /filesystem.Filesystem/ListDir`, `{"path":"/home/user/jobs","depth":1}`; depth 0 defaults to 1 in the current daemon. It returns metadata entries without a pagination cursor.
- Inspect/create/move/remove: `Stat`, `MakeDir`, `Move`, `Remove` RPCs. `WatchDir` is server streaming; `CreateWatcher`/`GetWatcherEvents`/`RemoveWatcher` are non-streaming watcher operations. Watchers are change notifications, not durable output offsets.

[Upload API](https://docs.e2b.dev/api-reference/filesystem/upload-a-file-and-ensure-the-parent-directories-exist-if-the-file-exists-it-will-be-overwritten), [upload implementation](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/api/upload.go), [directory implementation](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/filesystem/dir.go), [filesystem service definition](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/spec/envd/filesystem/filesystem.proto).

No general maximum file size, directory-result count, or process-output replay quota is published in the checked references. The upload handler streams bodies and reports insufficient storage; absence of a handler cap is **not proof that the cloud edge has no cap**. Published plan disk allocations are 10 GiB Hobby, 20+ GiB Pro, custom Enterprise. Bound script size, per-response output, total log size, and list depth in the gateway; verify edge upload/download limits live. [Billing resource allocations](https://docs.e2b.dev/billing).

## 9. Python Code Interpreter / Jupyter API

E2B's `code-interpreter-v1` template adds a service on port **49999**. The JS/Python code-interpreter SDKs call it over HTTP; direct Jupyter WebSocket transport is handled **inside** the sandbox through a Unix socket. The Worker can call the HTTP facade without a WebSocket or raw TCP connection. Contexts are stateful kernels, so variables/imports survive successive executions in the same context. [Interpreter SDK](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/code-interpreter-js/src/sandbox.ts), [server routes](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/main.py).

Checked routes:

| Route                                 | Behavior                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /execute`                       | JSON `{code, context_id?, language?, env_vars?}`; context and language are mutually exclusive; default is Python |
| `POST /contexts`                      | Create context using language and optional cwd                                                                   |
| `GET /contexts`                       | List contexts                                                                                                    |
| `POST /contexts/{context_id}/restart` | Restart kernel, losing its in-memory state                                                                       |
| `DELETE /contexts/{context_id}`       | Remove context/kernel                                                                                            |
| `GET /health`                         | Health check                                                                                                     |

Requests route with `E2b-Sandbox-Port: 49999`. SDK sends `E2B-Traffic-Access-Token` if configured and sends `X-Access-Token` on `/execute`; the latter also lets the service fetch sandbox environment variables. Envd's access token does not by itself protect arbitrary application ports. The documentation explicitly says the Code Interpreter URL is publicly callable by anyone who knows it when public traffic is allowed; create it with `network: {"allowPublicTraffic": false}` and supply its traffic access token. [Interpreter SDK headers](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/code-interpreter-js/src/sandbox.ts), [public-access restriction](https://docs.e2b.dev/network/restrict-public-access).

Results are **newline-delimited JSON**, not Connect envelopes and not a single JSON array despite the response class name. Events include stdout, stderr, result, error, execution count, keepalive, and `end_of_execution`. Rich result fields include text, HTML, Markdown, SVG, PNG/JPEG, PDF, LaTeX, JSON, and charts. Cell completion/errors are Jupyter semantics, not a normal OS process exit code. [Streaming serializer](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/stream.py), [rich result model](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/api/models/result.py).

**Background/timeouts/cancel:** there is no `background` request field, externally returned execution handle, output-reconnect route, cursor, or per-execution cancel route in the checked server. Executions serialize under a per-context lock. The SDK has a 60-second default execution timeout and implements it by aborting fetch; the server catches cancellation/disconnection and interrupts the kernel, with five-second keepalive writes to detect abandoned clients. An internal `in_background` implementation flag serves internal requests and is not a detached-execution API. Context restart/delete is available but affects the whole kernel. [Request schema](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/api/models/execution_request.py), [execution/cancel logic](https://github.com/e2b-dev/code-interpreter/blob/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1/template/server/messaging.py), [SDK timeout constant](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/code-interpreter-js/src/consts.ts).

Thus reattaching to a **sandbox or context** is supported; reattaching to an abandoned `/execute` output stream is not. If rich stateful executions must survive Worker yielding, install a sandbox-side adapter that holds `/execute` locally and records its events/status; the Worker would poll that adapter's durable files. That is additional infrastructure inside the sandbox, not a native Code Interpreter capability.

## 10. Request time, rate, and concurrency limits

The constraints to distinguish are Worker request lifetime, RPC deadline, sandbox TTL, and plan continuous runtime. The JS SDK currently defaults both request setup and command connection/runtime timeouts to 60 seconds; Code Interpreter also defaults execution to 60 seconds. These are SDK defaults, not evidence of a universal one-minute provider HTTP cap. [Connection defaults](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/connectionConfig.ts), [command defaults](https://github.com/e2b-dev/E2B/blob/df6c368152b067512702fc677952c0fc4e13c2f0/packages/js-sdk/src/sandbox/commands/index.ts).

E2B documents 50-second keepalive requests for SDK streams, streams normally surviving beyond an hour, and possible closure due to edge timeouts or load-balancer drains. There is no guaranteed single connection duration beyond an hour. Envd's own HTTP server sets ReadTimeout/WriteTimeout to zero. For this gateway, retain the requested default `yield_time_ms: 10000` and clamp larger values to a conservative policy maximum, e.g. 30,000 ms, well below minutes; abort before returning. A lost stream should not lose job output because files are authoritative. [Stream lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime), [envd HTTP server](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/main.go).

Published E2B limits relevant here:

| Limit                                                       | Hobby           | Pro             | Enterprise |
| ----------------------------------------------------------- | --------------- | --------------- | ---------- |
| Running sandboxes                                           | 20              | 100–1,100       | 1,100+     |
| Sandbox creation rate                                       | 1/sec           | 5/sec           | Custom     |
| Listed control-plane GET endpoints, including sandbox lists | 10 requests/sec | 20 requests/sec | Custom     |

GET limits are per project and endpoint, shared across keys/clients; 429 responses include `Retry-After` in seconds. The checked table does **not** publish a numeric envd process/file-RPC QPS limit, per-sandbox process count, or simultaneous streaming-RPC limit. Sandbox concurrency is not the same as process concurrency. These remain live/provider questions. [Billing/rate-limit table](https://docs.e2b.dev/billing).

Cloudflare currently documents no hard wall-time limit for HTTP-triggered Workers while the caller remains connected, but request work may be canceled after return/disconnect; `waitUntil` only extends it up to 30 seconds. Current subrequest limits are 50/invocation Free and default 10,000 Paid; six simultaneous connections **waiting for response headers**, with connections no longer counted after headers arrive. This is why a single bounded Connect plus a few file requests is preferable to frequent polling. These current figures differ from older Workers documentation. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## 11. Concrete recommended gateway mechanism

The following is a design inferred from the verified primitives; E2B does not provide this job protocol for you.

### Execution identity and cursor contract

A stateless server cannot remember "the last cursor" from a fixed `execution_id` alone. The proposed `wait({execution_id, ...})` signature therefore needs one of these changes:

1. Add an explicit `cursor` argument, and have callers pass the cursor returned by the previous exec/wait.
2. Return a new opaque `execution_id` on every response, encoding/signing the current cursor alongside sandbox ID, job UUID, generation, and supervisor identity. Callers must use the latest token.
3. Store a cursor file in the sandbox, accepting that it is shared mutable state and concurrent waits/retries need an atomic protocol; this is not independent per-consumer replay.

Prefer (1), or (2) if the public shape must remain unchanged. Use caller-carried authenticated metadata and caller-provided project credentials on every request; avoid placing provider secrets into visible execution IDs. Stateless replay is naturally at-least-once: retries with the same cursor repeat the same bytes. Exactly-once delivery without a client acknowledgment or durable cursor state is not achievable.

### Start

1. Create an appropriate Python-capable sandbox, or v2-connect to a supplied ID. Set an explicit lease covering the execution policy and enable full-memory auto-pause only if suspension is acceptable. Obtain current routing/token details.
2. Allocate a UUID job directory; upload `script.py` and a supervisor. Protect helper/log/status paths from accidental user-script overwrites where possible.
3. The supervisor starts `python3 -u script.py` in a separate process group, with stdout/stderr redirected to file(s), and writes an atomic ready manifest with job identity, its PID, and child identity. It waits for completion, closes/drains its log writers as applicable, records child exit/signal and final byte sizes, atomically publishes terminal status, then exits. Define whether descendant processes are terminated at main-script exit so they cannot append after terminal status.
4. Call native Start on the supervisor with a unique tag, no PTY, stdin disabled, and no yield-derived `Connect-Timeout-Ms`. Wait for the start event and supervisor readiness, then keep the Start stream only through the local yield budget. Read log bytes from offset zero, plus durable status. At yield, explicitly abort the stream and return a client-carried cursor/execution token. The supervisor continues in the sandbox.

### Wait

1. Decode/validate execution metadata; obtain token/details using the caller's provider key, extending the sandbox lease deliberately. Read terminal status first.
2. If unfinished, Connect to the supervisor by unique tag/PID and read through end or the local yield deadline. Discard streamed data as an output source if authoritative logs are used. If Connect fails/not-found/drops, reread status and use bounded fallback polling rather than reporting success.
3. Read status **before** capturing final sizes: if terminal status is present, drain through the recorded final sizes. Otherwise take a current size snapshot and read capped byte ranges. If completion occurs just after the status check, return a running result and observe completion on the next call, or recheck status and drain again before returning.
4. Return only bytes after the supplied cursor, the new cursor, and either durable exit/signal metadata or a still-running execution token. If output exceeds the response cap, preserve the unread tail for subsequent calls even when the process is already finished.

### Terminate

Request cancellation through the supervisor's control path or a guarded signal to the supervisor. Let it kill the child group and persist status, then drain logs using the same cursor protocol. A short helper command can signal the child group if necessary, but validate job identity and group membership before using numeric IDs. Return a pending termination state if completion has not been observed within the request budget.

### Why not just `nohup ... & echo $!`?

That shell form supplies detachment, which native Start already provides, but does not reliably preserve the exit code, prevent PID reuse, or kill children. A minimal shell wrapper can work if it redirects output and atomically writes an exit-status file after `wait`; a supervisor is easier to make correct for cancellation and child groups. **Never `exec` the wrapper into Python if the wrapper must record status after Python exits.** Keep the supervisor as the envd-tracked process.

| Requirement                                   | Native support / necessary addition                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Start remotely over fetch                     | Native Start with Connect envelope                                                 |
| Keep running after yield/disconnect           | Native process behavior, bounded by sandbox/runtime policies                       |
| Reattach while running                        | Native Connect by PID/tag                                                          |
| Recover output during gaps                    | File-backed log + Range; not native process replay                                 |
| Persistent exit result                        | Supervisor status file; native cache lasts only 30 seconds in checked source       |
| Wait until exit or a yield interval           | Bounded Connect plus local abort; no native Wait RPC                               |
| Kill the selected process                     | Native SIGTERM/SIGKILL                                                             |
| Kill children and preserve termination result | Supervisor group management                                                        |
| stdin                                         | Native unary SendInput, or supervisor forwarding                                   |
| Rich Jupyter output                           | Native only while `/execute` stays attached; adapter needed for detached execution |
| Progress forever with no requests             | Impossible under finite sandbox continuous-runtime/lease limits                    |
| Guaranteed recovery after sandbox destruction | Impossible with sandbox-local files alone; requires external durable storage       |

## 12. Gotchas and questions requiring live verification

1. **Deployed versions:** record `envdVersion`, template build, and interpreter version. Does the deployed daemon implement the checked 30-second late-Connect cache? Confirm before relying on even short post-exit reattachment. Pinned source is evidence of implementation, not deployment.
2. **Transport:** validate both shared-host routing and per-sandbox host, real HTTP/1.1 and HTTP/2, incremental response delivery, final error envelopes, local abort, and silent streams. Do not copy generated bare-JSON Start examples; the narrative/framed example is authoritative.
3. **Process deadlines:** demonstrate a script exceeding 60 seconds survives Start disconnect when the runtime deadline is omitted/disabled. Separately confirm Connect deadline/disconnect leaves the original process running.
4. **Replay/exit:** produce output during a disconnected gap, reconnect, and verify only new process output appears; test Connect immediately after exit and after more than 30 seconds. Confirm List excludes finished processes.
5. **File ranges:** test 206 and Content-Range through the public edge, EOF/empty-file 416, append races, identity encoding, caching, UTF-8 boundaries, and maximum transfer sizes. Test log-size caps and low-disk failures.
6. **Startup ambiguity/idempotency:** Start can execute before the Worker receives its start event. Retrying blindly can execute code twice. Tags are selectors, not documented idempotency keys or uniqueness constraints. Use a UUID plus sandbox-side exclusive claim/lock; verify uncertain starts via ready/status metadata. A lost response from sandbox creation is also a separate orphan/idempotency problem.
7. **Identity reuse:** native Start clears stale cached exits on PID/tag reuse, but an old client PID can still address a newer process. Use unique tags and persistent job generations; validate `/proc` identity for helper signals and avoid relying on stale numeric PIDs. [PID-reuse tests](https://github.com/e2b-dev/infra/blob/0e440126d88282f2d2bb59fc471b7a10ed3211ff/packages/envd/internal/services/process/pid_reuse_test.go).
8. **Cancellation correctness:** test SIGTERM handlers, SIGKILL escalation, grandchildren, children holding output FDs, escaped sessions, and supervisor death. No marker after an unexpected supervisor kill is an unknown/incomplete outcome, not exit zero.
9. **Lifecycle:** test full-memory auto-pause/resume with a running supervisor, pause at the continuous-runtime cap, token/routing changes, and the 30-second cache around pause/live upgrade. Verify account concurrency availability on resume and distinguish paused execution from lost execution.
10. **Auth:** verify v2 token acquisition, template Unix user defaults, envd access restrictions, traffic-token requirements on port 49999, and project ownership checks for execution tokens. Scripts run inside the same sandbox as helper files; file-backed records are not tamper-proof against code with the same privileges.
11. **Limits:** obtain numeric envd RPC/stream concurrency and QPS limits, request-body limits, and public-edge idle/absolute timeouts. These are not specified comprehensively in the checked API references. Honor documented 429/Retry-After and do not automatically retry non-idempotent Start/SendInput.
12. **Tool semantics:** choose merged output versus separate streams, signal-to-exit-code normalization, output truncation behavior, retry/acknowledgment rules, maximum job runtime, retention/cleanup, and how the cursor is supplied to the next wait. None can be recovered from a fixed ID and no state.

## Sources

All checked **2026-10-12**; primary sources only. Inline links above identify exact files/operations supporting individual findings.

- [E2B API reference: Process Start](https://docs.e2b.dev/api-reference/process/start), [Connect](https://docs.e2b.dev/api-reference/process/connect), [SendSignal](https://docs.e2b.dev/api-reference/process/sendsignal), [SendInput](https://docs.e2b.dev/api-reference/process/sendinput).
- [E2B file download / Range](https://docs.e2b.dev/api-reference/filesystem/download-a-file), [Stat](https://docs.e2b.dev/api-reference/filesystem/stat), [create sandbox v2](https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2).
- [E2B lifecycle](https://docs.e2b.dev/sandbox), [auto-resume](https://docs.e2b.dev/sandbox/auto-resume), [lifetime/stream FAQ](https://docs.e2b.dev/faq/sandbox-lifetime), [billing/limits](https://docs.e2b.dev/billing).
- [E2B repository, pinned revision `df6c368152b067512702fc677952c0fc4e13c2f0`](https://github.com/e2b-dev/E2B/tree/df6c368152b067512702fc677952c0fc4e13c2f0): control-plane OpenAPI, process/filesystem protobufs, JS SDK, Python SDK, interpreter SDK.
- [Infra repository, pinned revision `0e440126d88282f2d2bb59fc471b7a10ed3211ff`](https://github.com/e2b-dev/infra/tree/0e440126d88282f2d2bb59fc471b7a10ed3211ff): `packages/envd` process handlers, exit retention, output multiplexing, file handlers, control-plane refresh handler.
- [Code Interpreter repository, pinned revision `a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1`](https://github.com/e2b-dev/code-interpreter/tree/a4934a5dfc6b0763efaa867ef54d07d49bdb1fb1): HTTP routes, streaming serializer, Jupyter execution and disconnect interruption.
- [Connect protocol specification](https://connectrpc.com/docs/protocol/).
- [Cloudflare Workers streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) and [platform limits](https://developers.cloudflare.com/workers/platform/limits/).
