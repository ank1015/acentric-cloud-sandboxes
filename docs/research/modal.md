# Modal Sandboxes: stateless HTTP gateway research

Checked **2026-10-12**. Documentation and public SDK/source research only; no credentials, account creation, sandbox execution, or authenticated transport tests. The conclusions below distinguish documented interfaces, implementation evidence, and proposed gateway behavior.

**Verdict:** Modal supports background execution and resumable output at the protocol level, but there is **no documented, supported fetch-only sandbox control plane**. Its official clients use native gRPC, including the current worker command router. A Cloudflare Worker under the stated constraints needs an SDK-capable HTTP bridge, or a pre-provisioned sandbox with a custom HTTP supervisor. Sandbox Connect Tokens provide authenticated HTTPS to that supervisor; they do not provide a REST replacement for sandbox creation or Modal exec RPCs. Public SDK process reattachment and per-process termination are also missing, and native exec output expires 10 minutes after completion. [SDK contract][client-ref], [JS transport][js-client], [router transport][js-router], [HTTP connections][networking], [output retention][commands].

## 1. API surface, transport, and authentication

### Supported surface versus underlying protocol

The supported interface is the Python SDK plus JS/TypeScript and Go SDKs. Modal publishes protobuf service definitions, rather than a documented sandbox REST/OpenAPI contract. The JS reference explicitly describes the gRPC API as non-public and changeable without warning. Finding a protobuf RPC does not establish that it is a supported third-party API. [Client reference][client-ref], [protobuf service][api-proto].

Current JS uses `nice-grpc` with native gRPC channels. Go uses `google.golang.org/grpc`. Neither implementation uses a Fetch transport, gRPC-web, or Connect. The newer task command router also uses native gRPC over TLS, despite having an HTTPS URL. The archived `libmodal` repository uses the same native gRPC libraries; its SDKs migrated into `modal-client`. Node/Deno/Bun support is not evidence of Workers compatibility. [JS client][js-client], [Go client][go-client], [worker router][js-router], [archived SDK and migration][libmodal].

Source examined at `modal-client` commit `3f0a03838890a2d4856fac1cb774f46e9ebb4c47`, dated 2026-10-12; archived `libmodal` commit `eac52a9a7f6aae3e4e29e91378eb2cbbcc177728`. Some source on `main` can precede a package release. Current docs list Python 1.6.1; important backend changes arrived in 1.6.0 on 2026-09-28. [Python releases][releases], [source tree][client-repo].

### Authentication

Users supply a Modal **token ID and token secret**, normally configured as `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or explicit SDK constructor parameters. The JS client sends `x-modal-token-id` and `x-modal-token-secret`, client/version/host metadata, and obtains an additional short-lived auth token through `AuthTokenGet`, sent as `x-modal-auth-token`. Its default control-plane URL is `https://api.modal.com:443`. Worker-router access uses a separately minted JWT and router URL from the control plane; SDK code refreshes that JWT. Reimplementing only two credential headers would omit part of the current client behavior. [JS authentication][js-client], [configuration][js-config], [auth-token manager][js-auth], [router access][py-router].

The SDK also supports OAuth credentials, but these are unnecessary for the stated user-supplied ID/secret flow. A sandbox connect token is a separate bearer capability for HTTP access, not a substitute for workspace credentials. [Client parameters][client-ref], [networking][networking].

### Can a Worker call it with fetch?

**No supported direct mechanism was found.** Native gRPC carries framed protobuf messages over HTTP/2 and reports its final status in HTTP trailers, including when HTTP status is 200. Workers' documented Fetch `Response` interface exposes headers and body, but no trailer API. Given the question's fetch-only constraint, the official clients cannot be used as native gRPC clients. Handcrafting a POST and decoding body frames would still miss final RPC status and server-directed retry metadata; HTTP 200 or a partial body is insufficient evidence of success. [gRPC wire protocol][grpc-http2], [Workers Response][cf-response], [JS transport][js-client].

**gRPC-web/Connect support is unverified, not proven absent.** No documented server endpoint or client implementation accepting these protocols was found in the examined primary sources. gRPC-web puts trailers into body frames, so an actual supported gRPC-web endpoint could change this verdict; an ordinary native-gRPC endpoint does not automatically accept gRPC-web. “Sandbox Connect Tokens” is an HTTP proxy feature and is unrelated to the Connect RPC protocol. No unauthenticated protocol probes were performed. [gRPC-web protocol][grpc-web], [Modal HTTP connections][networking].

### Minimal workarounds

| Mechanism                                                         | What it solves                                                                                  | Remaining requirement                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Small Node/Python/Go HTTP bridge using the official SDK           | Creation, lookup, exec, filesystem, token minting, termination from Worker `fetch`              | Process continuation/kill needs private protocol integration or an in-sandbox wrapper/supervisor |
| HTTP supervisor inside sandbox, reached with a Connect Token      | Start, bounded output reads, waits, stdin, individual process-group kill through ordinary HTTPS | SDK/gRPC bootstrap must create sandbox and mint token; alternatively user pre-provisions it      |
| Same supervisor through an encrypted-port tunnel                  | HTTP data path without connect-token proxy                                                      | SDK bootstrap obtains tunnel URL; application must authenticate requests                         |
| User-deployed Modal Web Function exposing selected SDK operations | An HTTP bridge hosted on Modal itself                                                           | User deployment/setup; endpoint credentials/authentication and short per-request handling        |

For the supervisor path, `create_connect_token(port=8080)` returns an HTTPS URL and token. Send `Authorization: Bearer <token>` to reach a server on that container port; token creation can select another port and does not require declaring an encrypted tunnel. Modal also supports the token in a query parameter or cookie. Authenticated user metadata is forwarded in `X-Verified-User-Data`; serialized metadata must be under 512 characters and is embedded in the token, so it must not contain secrets. These are proxy credentials, not a provider-managed exec endpoint. [Connect-token guide][networking].

Encrypted-port tunnels ordinarily provide HTTP/1.1 over TLS; `h2_ports` provides HTTP/2 over TLS to an appropriate server in the sandbox. Neither enables trailer access in Workers or changes Modal's control-plane protocol. An HTTPS supervisor needs no HTTP/2-specific capability. [Port forwarding][networking], [tunnel behavior][tunnels-guide].

The bootstrap dependency is essential: tunnels and token URLs do not let a fresh Worker create its first sandbox solely from a workspace token ID/secret. [Connect token/tunnel examples][networking], [Web Functions][webhooks].

## 2. Sandbox lifecycle, timeout, snapshots, and idle cost

- **Create:** `Sandbox.create`, associated with an App when called outside a Modal container, and an image containing Python. App lookup can create a named App if missing. Sandbox ID is `object_id` in Python and `sandboxId` in JS. [Sandbox guide][sandboxes].
- **Lookup:** `Sandbox.from_id` reconstructs a sandbox handle. `Sandbox.from_name(app_name, name, environment_name=...)` finds a running named sandbox; names are unique within an App. These reconstruct the sandbox, not an individual exec handle. [Sandbox reference][sandbox-ref].
- **Creation readiness:** Python 1.6.0 changed CPU sandbox creation to wait for scheduling, despite older/general guide wording about asynchronous creation. Scheduling does not imply the application server is ready; configure a readiness probe. Current source permits **21 minutes** for scheduling. Prebuild images and enforce a separate gateway creation budget. [Releases][releases], [creation source][py-sandbox], [JS creation][js-sandbox].
- **Lifetime:** default **300 seconds**, configurable up to **24 hours**. Separate `idle_timeout` is optional, default unset. Timeout/idle timeout finishes the sandbox: no subsequent exec is possible, and resident processes cannot outlive their container. Treat this as termination, not pausing. [Lifecycle guide][sandboxes], [sandbox settings][sandbox-ref].
- **Activity for idle timeout:** a running Modal exec, writes to sandbox stdin, or an open tunnel TCP connection counts as activity. The entrypoint simply remaining alive is not listed as activity. A custom supervisor's child processes are not automatically equivalent to Modal-tracked execs: disable Modal idle timeout for that design, implement supervisor idle expiry, or verify the actual behavior live. [Idle definition][sandboxes].
- **Termination:** sandbox-wide `terminate()` kills the container, documented with SIGKILL/137. Sandbox timeout is mapped to 124 in client source; process exit status is a separate result and should not be synthesized from sandbox return code. [Sandbox guide][sandboxes], [result mapping][py-common].

Filesystem snapshots preserve files, not a running Python process; restoring creates a new sandbox. Directory snapshots preserve selected paths. Both have a default 30-day TTL, configurable or disabled. Memory snapshots are experimental/Alpha, expire after seven days, currently terminate the original sandbox and close TCP connections. They cannot be taken with a running `Sandbox.exec`, and background descendants started by exec do not restore correctly. Thus they cannot pause/resume an outstanding `exec_python` job. [Snapshot guide][snapshots].

**A live idle sandbox costs money.** Billing is per second at the greater of resource request and actual usage. Current sandbox-specific prices are $0.00003942/physical-core-second and $0.00000667/GiB-second; do not substitute the lower Function prices shown elsewhere on the same page. At 0.125 cores and 128 MiB requested, the arithmetic floor is approximately **$0.02074/hour**, before greater actual use, region premiums, or other charges. A supervisor retaining completed logs keeps the sandbox billable until it stops. [Resource billing][sandbox-resources], [prices][pricing].

## 3. Starting a background process, identifiers, and PTY

`Sandbox.exec` starts a command and returns a `ContainerProcess`, without waiting for the command to finish. It exposes stdout, stderr, stdin and wait/poll behavior. Current Python process timeout defaults to `None`; JS documents no timeout by default. The process remains bounded by sandbox lifetime. `yield_time_ms` must be implemented by the gateway: **do not set exec timeout to yield time**, since exec timeout kills the command. [Process reference][process-ref], [exec implementation][py-sandbox], [JS exec options][js-sandbox].

There are two relevant protocol generations:

| Generation                  | Start and identity                                                                                            | Relationship to current SDK                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Legacy control-plane RPCs   | `ContainerExec` takes task ID and command; response contains `exec_id`                                        | Still present in `api.proto`; older Python SDK used these                                       |
| Current task command router | Client generates UUID `exec_id`; `TaskExecStart` takes task ID, that UUID and command; empty success response | Current Python and JS sandbox exec implementations use this path; ID provides start idempotency |

The task ID identifies the sandbox's execution container/worker task; exec ID identifies one command. Python stores both privately; JS stores exec/task IDs in private fields. There is no documented public `ContainerProcess.object_id` or `ContainerProcess.from_id`. Save a gateway-generated execution ID independently if using the public SDK. [Legacy protobuf][api-proto], [new exec protocol][router-proto], [Python process][py-process], [JS process][js-sandbox].

**Disconnect behavior:** ordinary non-PTY execution is decoupled from output reads; SDK streams are lazy and can close/reopen with offsets. Sandbox detach explicitly leaves the sandbox running. This is strong implementation evidence for background jobs surviving a client disconnect, but no indefinite durability promise: timeout, termination, failure and retention still apply. Do not have a bridge finally-block terminate a sandbox when returning a yielded response. [JS detach/process implementation][js-sandbox], [resumable router reads][py-router], [command guide][commands].

**PTY exists** (`pty=True` / `{pty:true}`), merging stdout/stderr into stdout. However, the legacy `ContainerExec` protobuf warns that PTY interactive exec terminates without periodic stdin messages, currently after 40 seconds. Current router PTY fields do not establish that the old heartbeat rule is gone. Use non-PTY `python -u` for this gateway and verify PTY behavior separately. [PTY SDK options][js-sandbox], [legacy PTY contract][api-proto].

## 4. Output, reattachment, cursors, replay, retention, and files

### Native output

The legacy `ContainerExecGetOutput` request includes exec ID, stream selector, timeout, `last_batch_index`, and raw-byte mode; responses carry `batch_index`. The Python v1.2.0 reader actually sends its last index on reconnection. This is replay/resume evidence, not a destructive “consume once” queue. A gateway must advance a batch cursor only after including **every item in that batch**; an intra-batch response cap needs a second cursor component or retained remainder. [Legacy output reader][old-streams].

The current `TaskExecStdioRead` is more convenient: task ID, exec ID, stdout/stderr selector, and a **uint64 byte offset**. The SDK reconnects at the accumulated byte count, and its internal reader accepts a starting offset. Keep independent stdout and stderr cursors; the two streams do not provide a total interleaving order. Return bytes/base64 or retain UTF-8 decoder state when cutting arbitrary byte boundaries. [Router schema][router-proto], [offset tracking][py-router].

**Can a different client read later?** At the wire level, the requests contain the identifiers and cursor rather than a connection-local handle. A new authorized client can reconstruct router access and issue them in principle, within retention and sandbox/task availability. But the public SDK has no documented exec-by-ID reattachment method or public reader offset parameter. `Sandbox.from_id` does not recover its exec processes. A native adapter therefore requires private SDK/protocol integration and live validation, including ownership checks and post-sandbox-termination behavior. [Process API][process-ref], [process source][py-process], [router access/reads][py-router].

Modal explicitly documents **output readability for up to 10 minutes after exec completion**; then output is discarded and later reads fail. `StreamReader.read()` waits until EOF, so it is unsuitable by itself for returning a partial result at ten seconds. Use cancellable chunk iteration while separately monitoring completion. No documented numerical server-side stdout/stderr buffer cap, truncation policy, or retention guarantee after task destruction was found. The guide calls streams memory-buffered, while current filesystem-client comments describe completed output as server-side disk-backed: neither establishes a public size guarantee. [Command guide][commands], [StreamReader][streams-ref], [filesystem implementation][js-fs].

`SandboxGetLogs` has a separate entry cursor (`last_entry_id`), but sandbox entrypoint logs **exclude exec command logs**. Plan-level dashboard log retention therefore must not be confused with exec-output replay retention. [Sandbox log implementation][py-sandbox].

### File-redirection alternative

Proposed adapter: write each script to `/runs/<random-id>/script.py`; launch a trusted wrapper that runs `python -u`, appends output to files, and atomically writes launch metadata and a terminal status record. Later requests reconstruct the sandbox by ID and fetch only bytes after each cursor. This avoids needing Modal's private exec handle, decouples output retention from the native 10-minute window, and stores process state remotely rather than in the Worker.

Current supported `sandbox.filesystem.read_bytes/read_text` read **whole files** and expose no range/offset argument. For bounded incremental reads, use a short helper exec that opens the log, seeks to a caller-provided byte offset, and reads a capped number of bytes; or expose the same operation through a supervisor HTTP endpoint. Re-reading the entire log each wait is quadratic and unsuitable for noisy jobs. These helpers still need SDK/gRPC through a bridge. [Current filesystem implementation][py-fs], [read-command shape][js-fs-utils].

The old FileIO interface really did support `seek` and `read(n)` through `ContainerFilesystemExec`; the proto remains. **Do not base a new implementation on it:** the replacement filesystem API superseded `Sandbox.open`, and the new backend does not support deprecated FileIO operations. [Migration/release notes][releases], [legacy FileIO source][old-files].

## 5. Waiting with a timeout and exit-code retention

Legacy `ContainerExecWait` takes exec ID plus float timeout, and returns completion flag plus optional exit code. Old Python `poll()` uses timeout zero; its wait loop uses ten-second RPC waits. That is a genuine server-side bounded wait, distinct from command lifetime. [Legacy wait implementation][old-process].

Current `TaskExecWait` has task ID and exec ID, **no timeout field**. Set an RPC deadline/cancellation budget, or use `TaskExecPoll`. The current Python adapter retries wait RPCs with 60-second deadlines until exit; it can retry indefinitely if no execution deadline is set. `TaskExecPoll` leaves exit status unset while running; wait/poll report either exit code or terminating signal, mapped by SDKs to `128 + signal`. [Router wait schema][router-proto], [wait retries][py-router], [Python process mapping][py-process].

Gateway `wait(yield_time_ms)` should run output readers and completion observation concurrently, stop only its observation when the yield deadline expires, and return a continuation. Cancellation of a read/wait is **not** process termination. After observing completion, drain output to EOF before claiming that final output has been delivered. If a response-size cap intervenes, return terminal process status plus a cursor indicating more output remains.

Exit codes can be retrieved after normal completion while the result remains addressable. No separate documented TTL for exec exit-status records was found; the ten-minute documented guarantee concerns output, not necessarily exit status. Do not promise arbitrary-late status retrieval after sandbox/task termination. Current Python also caches `-1` for some local exec-deadline failures, so this is not always the actual POSIX child exit code. A supervisor-written status file offers explicit retention while its storage survives. [Process source][py-process], [retention documentation][commands].

## 6. Terminating one process, signals, and process groups

**No public individual-exec kill/signal API was found.** Neither `ContainerProcess` API nor the current `TaskCommandRouter` service defines an exec terminate/signal RPC. `SandboxTerminate` kills the entire sandbox, and `TaskContainerTerminate` targets a container, not one exec. The JS filesystem uploader even contains a TODO noting that it cannot kill an exec that remains alive after upload failure. Do not interpret stdin EOF or RPC cancellation as kill. [Process reference][process-ref], [router RPC list][router-proto], [uploader TODO][js-fs].

Practical proposed implementations:

1. **One execution per sandbox:** implement terminate by terminating that sandbox. This uses a supported API, also kills descendants, but prevents further work in that sandbox and risks losing unread output/files. Return a gateway cancellation result, and capture logs before teardown where possible.
2. **Shared sandbox:** use a trusted supervisor/wrapper that starts each child in a new session/process group, records identity, and handles SIGTERM followed by SIGKILL after a grace period. Control it through HTTPS, or a second short SDK exec. An exec ID is not a Linux PID: never pass it to `kill`.

Process-group handling is gateway code, not a Modal feature. Handle “already exited” as an idempotent outcome, guard against PID reuse, and account for descendants escaping the group by starting their own session. Killing a wrapper before it publishes exit status can leave the status record missing; supervisor-controlled termination should publish terminal state itself. Stronger complete-descendant cleanup may require an OS containment mechanism or sandbox-wide kill, tested against the chosen runtime.

## 7. Stdin to an existing execution

Supported SDK stdin is a `StreamWriter`: `write`, `drain` to flush, and `write_eof` plus drain to close. This works while the process is running. The legacy RPC uses indexed input messages; current router stdin writes use task/exec IDs, byte offset, bytes, and EOF. That gives resumable writes; current protocol additionally has stdin-status and streaming upload RPCs. [StreamWriter reference][streams-ref], [current stdin schema][router-proto].

Current Python source caps the router writer's **client-side pending buffer at 16 MiB**; the legacy/control-plane writer uses 2 MiB. These are stdin staging limits, **not stdout-retention limits**. Streaming uploads use 256 KiB chunks. New clients must preserve the acknowledged stdin offset; rebuilding a writer at offset zero is incorrect after previous input. `TaskExecStdinStatus` evicts an in-flight streaming stdin writer, so it is not harmless observability when another writer is active. Serialize writers per execution. [Writer limits][py-streams], [streaming implementation][js-router], [stdin service comments][router-proto].

For script execution, upload the script before launch or write to `python -u -` and send EOF. File upload provides cleaner retry/idempotency behavior than partially transmitting source over stdin. The requested tools have no stdin argument, so expose stdin only if the gateway contract is expanded.

## 8. Files API, ranges, and limits

The supported replacement API offers text/byte read/write, streamed local copies, directory listing/creation/removal, stat, and watch. Upload script content with `write_text` or `write_bytes`; remote paths must be absolute, and writes overwrite existing files and create parents. Current SDK implements these operations by exec'ing `/__modal/.bin/modal-sandbox-fs-tools`, with transfers over exec stdio. It is **not an independent REST file service**. Images, Volumes, or CloudBucketMounts are alternatives for larger/shared data. [Files guide][files-guide], [Python implementation][py-fs], [JS filesystem helpers][js-fs-utils].

| Limit/range issue         | Finding                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Current read ranges       | No public range/offset parameter on `read_bytes/read_text`; helper exec or custom HTTP endpoint required                                |
| Current file read ceiling | API can raise `SandboxFilesystemFileTooLargeError`; numerical current server ceiling is not documented in examined sources              |
| Current transfers         | Streamed stdin/stdout; do not equate 100 MiB gRPC **message** configuration with total file size                                        |
| Sandbox disk              | Per-container quota ordinarily 512 GiB, also constrained by host space; sandbox disk cannot be increased; VM root fixed at 512 GiB      |
| Command arguments         | Client validation uses 65,536 total CMD-argument length; large source should be uploaded, not passed with `python -c`                   |
| Historical FileIO only    | v1.2.0 read requests capped at 100 MiB; writes at 1 GiB with 16 MiB chunks; seek supported; these are not current filesystem guarantees |

Sources: [current reads][js-fs], [channel settings][js-client], [sandbox disk][sandbox-resources], [argument validation][py-common], [legacy FileIO limits][old-files].

File redirection requires a disk/output quota and explicit retention policy. Ephemeral files survive ordinary exec completion but are not an archive after sandbox termination. A Volume, external object store, or deliberate snapshot can retain files longer; status/output must be fully written before declaring them durable. Long output files should be read in bounded chunks, even when using an HTTP agent.

## 9. Python execution and stateful interpreter

Use a Python-containing image and normal `Sandbox.exec("python", "-u", script_path)`. Multiple execs share filesystem/container state but separate Python OS processes do not share globals.

Modal has an official **stateful code-interpreter example**: a custom Python driver receives JSON on stdin, executes code against a retained globals dictionary, and emits JSON on stdout. It is an example application built in a sandbox, not a hosted code-execution REST API. Its shown StringIO redirection buffers output until the code returns; arbitrary code can interfere with the driver, block, or terminate it. A production async exec/wait interface needs a supervisor and bounded output capture rather than assuming the example already implements yield/kill semantics. [Interpreter example][interpreter].

If persistent interpreter state is required, keep a dedicated interpreter process in the sandbox and serialize submissions. Killing a stuck execution in that interpreter usually means restarting the interpreter and losing in-memory state; the stated script-oriented contract does not require this tradeoff.

## 10. Request budgets, rate limits, and concurrency

- Legacy readers poll in 55-second streams; legacy process waits use ten-second waits. Current router wait uses 60-second RPC deadlines with repeated retries, and stream reads can remain open until output/EOF. These are **SDK choices**, not a uniform public HTTP long-poll limit. Always impose the gateway's own monotonic end-to-end deadline and bounded retries. [Old reader][old-streams], [old wait][old-process], [current wait][py-router].
- Creation can spend up to 21 minutes scheduling in current source, plus image preparation. A default SDK creation call can exceed the gateway budget. Use prebuilt images and a short creation deadline with recoverable/idempotent creation state, or require pre-provisioning. [Creation source][js-sandbox].
- A Modal **Web Function bridge** has a documented 150-second HTTP request limit and may return 303 result redirects for long operations. Keep tool calls below it, handle redirects intentionally, and do not mistake redirect polling for process execution identity. This limit is documented for Web Functions; it is not established for connect-token/tunnel requests. No numerical connect-proxy request/idle timeout was found. [Web Function timeout][web-timeouts].
- Modal documents a new-workspace baseline of 200 Function calls/HTTP requests per second with a five-second burst multiplier and 429 responses. That is not proof that every Sandbox RPC has the same quota. Sandbox exec/read/wait rate limits, simultaneous waiters and per-sandbox process limits were not numerically documented in sources examined. Current SDK has server-directed throttle retries that must be bounded for this gateway. [Web Function limits][webhooks], [SDK retry logic][js-client].
- Pricing lists 100/5,000/custom container limits for Starter/Team/Enterprise and 10/50/custom GPU concurrency. The sandbox engineering article describes 50,000 concurrent sandboxes per customer and a million-sandbox demonstration; these are capacity statements, not a guaranteed entitlement for a supplied credential. Backend 1.6 changes further complicate applying older limits. Verify actual workspace sandbox quotas rather than assuming plan container rows or marketing numbers map directly to them. [Plan table][pricing], [scaling article][scaling], [backend release][releases].
- Workers HTTP requests have no fixed wall-clock duration while the caller remains connected, but work may be cancelled when it disconnects/response completes; `waitUntil` extends only up to 30 seconds. Therefore it cannot own the background Python job. Current limits include 128 MB memory and six simultaneous connections waiting for response headers; consume or cancel subrequest bodies. Ten-second bounded long polls fit the model. [Workers limits][cf-limits].

## 11. Recommended mechanism and exact feasibility

### Capability matrix

| Requirement                                      | Modal-native ability                            | Gap for the specified Worker                                                        |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Create/lookup sandbox from workspace credentials | Supported SDK/gRPC                              | HTTP bridge or external provisioning required                                       |
| Run beyond gateway response                      | Non-PTY sandbox exec                            | Keep sandbox alive; separate exec lifetime from yield time                          |
| Return output at yield deadline                  | Chunk streams exist                             | Gateway must cancel observation and track cursor                                    |
| Resume through another request                   | Protocol replay/byte offsets exist              | No supported public exec reattach; bridge needs private adapter or supervisor/files |
| Bounded wait                                     | Legacy wait timeout; current poll/RPC deadline  | Bound retries; current exec-wait message has no timeout field                       |
| Kill just this execution                         | No public exec kill RPC                         | Supervisor/process-group helper; or entire sandbox per run                          |
| Retain output for arbitrary later wait           | Native output only ten minutes after completion | Explicit file/external retention                                                    |
| Fetch-only data path after setup                 | Connect-token URL or encrypted tunnel           | Custom server inside sandbox; still needs control-plane bootstrap                   |
| Pause outstanding exec by snapshot               | Not supported                                   | Cannot implement by current memory snapshots                                        |

### Recommended supported building blocks

**For an open-source gateway that accepts only workspace token ID/secret, ship a small SDK-capable HTTP bridge plus an in-sandbox supervisor.** The bridge can itself be request-scoped/stateless: durable run state and execution live inside the sandbox, and identifiers travel in the client's continuation. It must avoid global credentials or request contexts shared between tenants.

Proposed request flow:

1. Worker sends supplied credentials and an idempotency key to the HTTP bridge. Bridge uses the official SDK to create/retrieve a sandbox from a **prebuilt supervisor image**, with explicit sandbox lifetime and suitable resource limits. Startup is bounded separately from script yield. Do not return a running execution until it is actually accepted.
2. Bridge mints a sandbox Connect Token for the supervisor port and returns sandbox ID plus connection credentials. Keep workspace token secrets outside the untrusted sandbox. Tokens/URLs may be returned as an encrypted continuation; treat them as capabilities, validate destination hosts, and never put secrets in token user metadata.
3. Worker `fetch`es supervisor `POST /executions` with Python source, client-generated run ID and a script lifetime. The supervisor persists the request identity, starts a child process group, spools output, and immediately supports later requests. Process ownership remains with the supervisor after HTTP disconnect.
4. Supervisor `GET /executions/<run>/output?cursor=...&wait_ms=...` returns capped output, next cursor and terminal status, waiting up to the requested yield deadline and waking on completion. Worker returns a continuation before its own request budget expires. `POST /executions/<run>/terminate` performs idempotent group termination and records status. These routes are **proposed custom routes**, not Modal endpoints.
5. When native idle tracking cannot see supervisor children, use supervisor-managed idle cleanup and explicit overall sandbox lifetime. Retain completed log/status data for a declared interval before stopping the sandbox or exporting it. Renew connect tokens through the bridge if required; token lifetime/revocation remains a live-verification question.

This uses documented transport and SDK primitives without relying on private Modal exec reattachment. The supervisor does the stateful work remotely, which is consistent with a stateless Worker. [Documented HTTPS primitive][networking], [SDK lifecycle][sandbox-ref].

**Smaller initial implementation:** retain the bridge for every tool call and use supported SDK exec plus a wrapper's log/status files. Later calls reconstruct `Sandbox.from_id` and use short helper execs to read file ranges or signal recorded process groups. This avoids deploying an HTTP server inside each sandbox, but adds SDK RPC/helper-exec overhead and more launch/status races. Native byte-offset reads through a private bridge adapter are possible as an optimization, but should not be the compatibility baseline.

**No additional bridge at all:** feasible only if users provide an already-running supervisor URL and connect token (or self-authenticated tunnel). That changes setup/credential requirements. There is no demonstrated supported “fresh token ID/secret -> create -> exec -> wait” path using only the Worker and Modal's existing HTTP API.

### Cursor contract must change or carry remote state

The requested `wait({execution_id, yield_time_ms, terminate})` omits the cursor returned by the previous call. An immutable execution ID plus a stateless gateway cannot infer “output since the last cursor.” Choose one explicitly:

- Add `cursor` to wait arguments; execution ID stays stable. Recommended for replayable reads and concurrent callers.
- Encode the cursor in an opaque, authenticated **continuation execution_id**, returning a new one every response; callers must use the latest ID.
- Keep per-consumer cursor state in the supervisor/sandbox, with serialized consumption and request IDs. This preserves the apparent signature but needs remote acknowledgement/retry logic.

An explicit cursor gives at-least-once delivery on network retry: the same cursor may replay the same bytes. Exactly-once delivery cannot be promised when a response is lost without a client acknowledgement protocol. All continuation values must bind sandbox/run identity, credentials/tenant and expiry; omit plaintext provider secrets.

### Races to design for

- **Start accepted, response lost:** retrying a newly generated exec/run ID duplicates execution. Current private protocol has client-generated idempotent exec IDs; a public-SDK supervisor adapter needs its own persistent idempotency key.
- **Yield races with exit:** obtain exit status and drain remaining bytes independently; EOF/output delivery can lag process exit. Preserve unfinished output even in terminal responses.
- **Legacy cursor inside batch:** do not skip unreturned items by advancing to a whole batch index. Current byte cursors avoid this but must match delivered bytes exactly.
- **Two waits from the same cursor:** replay can duplicate output; use caller cursor ownership or remote serialization. Two stdin writers similarly need sequencing.
- **Terminate races with launch/exit:** a supervisor must accept cancellation during launch, avoid signalling a reused PID, and publish one terminal result. Timeout of an observer is not cancellation of the child.
- **Sandbox lifetime expires before logs are read:** ephemeral file data and worker-router access can vanish. Retention longer than lifetime needs external storage and a completion/export protocol.
- **Network/router JWT expires:** refresh by authorized lookup; do not cache router URL/JWT indefinitely. Bound retries and distinguish unavailable sandbox from execution failure.
- **Custom supervisor exposed to arbitrary Python:** same-container code may modify logs/status or attack the supervisor. Bind identity and validate status; consider a separate trusted sidecar/control service if integrity against hostile code is a requirement. Merely sandboxing the container does not protect processes inside it from one another.

## 12. Gotchas and questions requiring live verification

These remain unresolved by docs/source and were **not tested**:

1. Does Modal offer a supported gRPC-web/Connect endpoint for the control plane **and** task router, including error/trailer handling and auth? If so, obtain its documented URL and compatibility commitment before claiming direct Worker support.
2. Confirm cross-client exec replay at offset zero/nonzero, multiple readers, and result access after normal exit, sandbox timeout, explicit termination and worker loss. Public exec reattachment remains unavailable even if internal replay works.
3. Measure stdout/stderr disk or memory caps, truncation/backpressure behavior, large-line behavior, and what error follows the documented ten-minute expiry. Determine exit-status TTL independently.
4. Verify non-PTY execution through disconnects and cancelled output/wait RPCs; separately verify whether current router PTY still requires the legacy 40-second heartbeat.
5. Establish Connect Token lifetime, refresh/revocation, supported path routing, request/idle timeouts, payload limits and error behavior during sandbox shutdown. Test tunnel/HTTP activity against idle timeout, especially custom supervisor children.
6. Confirm actual workspace create/exec/read/wait quotas and concurrent waiter/process limits, backend-specific plan entitlements, and whether server-directed throttling can exhaust the gateway budget.
7. Determine the current filesystem read-size ceiling; validate bounded helper seeks, UTF-8 boundaries, concurrent append reads, atomic status publication and full-disk behavior. Deprecated FileIO ceilings are not sufficient.
8. Test SIGTERM/SIGKILL and descendant cleanup under the selected gVisor/VM runtime, including escaped process groups, PID reuse and cancellation before launch completes.
9. Verify creation idempotency/recovery when a short HTTP creation budget expires after the sandbox has been accepted; do not leak orphaned billable sandboxes. Prebuild dependencies and avoid arbitrary image builds in the first tool request.
10. Test supervisor crash, arbitrary code that exits the interpreter, sandbox OOM and post-exit retrieval. Define explicit expired/unavailable/cancelled states instead of manufacturing successful exit codes.

## Sources

Primary sources checked **2026-10-12**. Source links are pinned where implementation details matter; the historical v1.2.0 files are explicitly historical.

- Modal guides: [Sandboxes][sandboxes], [commands][commands], [files][files-guide], [networking/connect tokens][networking], [snapshots][snapshots], [resources/pricing][sandbox-resources], [tunnels][tunnels-guide].
- Modal references: [Sandbox][sandbox-ref], [ContainerProcess][process-ref], [StreamReader/Writer][streams-ref], [JS client/private gRPC warning][client-ref], [Python releases][releases].
- Current SDK/protocol: [API proto][api-proto], [task-router proto][router-proto], [JS client][js-client], [Go client][go-client], [Python sandbox][py-sandbox], [Python process][py-process], [Python router][py-router], [JS router][js-router], [Python streams][py-streams], [Python filesystem][py-fs], [JS filesystem][js-fs].
- Historical/migration: [archived libmodal][libmodal], [v1.2.0 output reader][old-streams], [v1.2.0 process wait][old-process], [v1.2.0 FileIO][old-files].
- Other Modal primary sources: [stateful interpreter example][interpreter], [Web Functions/limits][webhooks], [HTTP request timeouts][web-timeouts], [prices/plan limits][pricing], [sandbox scaling engineering article][scaling].
- Transport/runtime: [native gRPC protocol][grpc-http2], [gRPC-web protocol][grpc-web], [Cloudflare Response][cf-response], [Cloudflare Workers limits][cf-limits].

[sandboxes]: https://modal.com/docs/guide/sandboxes
[commands]: https://modal.com/docs/guide/sandbox-spawn
[files-guide]: https://modal.com/docs/guide/sandbox-files
[networking]: https://modal.com/docs/guide/sandbox-networking
[snapshots]: https://modal.com/docs/guide/sandbox-snapshots
[sandbox-resources]: https://modal.com/docs/guide/sandbox-resources
[tunnels-guide]: https://modal.com/docs/guide/tunnels
[sandbox-ref]: https://modal.com/docs/sdk/py/latest/Sandbox
[process-ref]: https://modal.com/docs/sdk/py/latest/container_process
[streams-ref]: https://modal.com/docs/sdk/py/latest/io_streams
[client-ref]: https://modal.com/docs/sdk/js/latest/ModalClient
[releases]: https://modal.com/docs/sdk/py/releases
[client-repo]: https://github.com/modal-labs/modal-client/tree/3f0a03838890a2d4856fac1cb774f46e9ebb4c47
[api-proto]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/modal_proto/api.proto
[router-proto]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/modal_proto/task_command_router.proto
[js-client]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/client.ts
[go-client]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/go/client.go
[js-config]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/config.ts
[js-auth]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/auth_token_manager.ts
[js-sandbox]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/sandbox.ts
[js-router]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/task_command_router_client.ts
[py-sandbox]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/sandbox/_sandbox.py
[py-common]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/sandbox/_common.py
[py-process]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/container_process.py
[py-router]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/sandbox/_task_command_router_client.py
[py-streams]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/io_streams.py
[py-fs]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/py/modal/sandbox/_filesystem.py
[js-fs]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/sandbox_fs.ts
[js-fs-utils]: https://github.com/modal-labs/modal-client/blob/3f0a03838890a2d4856fac1cb774f46e9ebb4c47/js/src/sandbox_fs_utils.ts
[libmodal]: https://github.com/modal-labs/libmodal/tree/eac52a9a7f6aae3e4e29e91378eb2cbbcc177728
[old-streams]: https://github.com/modal-labs/modal-client/blob/v1.2.0/modal/io_streams.py
[old-process]: https://github.com/modal-labs/modal-client/blob/v1.2.0/modal/container_process.py
[old-files]: https://github.com/modal-labs/modal-client/blob/v1.2.0/modal/file_io.py
[interpreter]: https://modal.com/docs/examples/simple_code_interpreter
[webhooks]: https://modal.com/docs/guide/webhooks
[web-timeouts]: https://modal.com/docs/guide/webhook-timeouts
[pricing]: https://modal.com/pricing
[scaling]: https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds
[grpc-http2]: https://raw.githubusercontent.com/grpc/grpc/master/doc/PROTOCOL-HTTP2.md
[grpc-web]: https://raw.githubusercontent.com/grpc/grpc/master/doc/PROTOCOL-WEB.md
[cf-response]: https://developers.cloudflare.com/workers/runtime-apis/response/
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
