# Design

A stateless gateway that runs Python in the caller's own sandboxes, with one
shape for every provider. It backs two model-facing tools, `exec_python` and
`wait`, whose schemas live in the SDK; the gateway API carries what the model
never sees (handles, cursors). Research: [research/](research/README.md).

Providers: E2B, Daytona, Blaxel, Tensorlake. Modal is left out: its API is
native gRPC, which a Worker cannot call.

## Decisions

**D1. Stateless, caller's credentials.** Credentials come with every request
and are only forwarded. Everything needed to find an execution again is in
its handle, which the gateway returns and the caller sends back. The handle
holds no secrets.

**D2. Nothing installed in the sandbox.** Every call runs one command of a
small Python agent, sent along with it (`python3 -c`). `start` launches the
agent through the provider's own background-process API, or, where there is
none, as a command that detaches itself (fork, new session); it claims the
execution's folder (`mkdir`), writes the code, and starts Python as the leader
of a process group of its own (`start_new_session`), with stdout and stderr in
one file. The agent stays outside that group, waits for Python and records
how it ended. `wait`, `kill`, `list` and the deletes are short agent commands
that read and act on those files. Output and ending survive any disconnect,
signals are reported exactly, and providers only need to run a command. The
agent is in `packages/providers/src/agent.ts`; it needs `python3` in the
sandbox, which a Python tool has anyway.

**D3. Execution APIs only, for now.** No sandbox lifecycle APIs. A stopped or
paused sandbox is woken by any execution call that needs it.

**D4. `start` only launches; `wait` does all waiting.** `start` must not be
blindly retried (it runs code), `wait` always can be (it reads from a
cursor), so the slow part never sits in the call that matters. The SDK's
`exec_python` is `start` then `wait`.

**D5. Caller-chosen execution IDs.** `start` takes the ID. A retry with the
same ID and code returns the execution already started; other code is a
`conflict`.

**D6. Code inside the launch command.** Base64-encoded, so one request starts
an execution. That caps code at 64 KiB (`MAX_CODE_BYTES`), under Linux's
128 KiB limit for one argument; larger code would need an upload first.

**D7. Files in `/tmp/acentric/executions/<id>/`**, a path every provider has.
`delete` removes one finished execution's files, `delete-all` every finished
one; running executions are never deleted.

**D8. `maxRuntimeMs` is optional.** When set the wrapper kills Python after
it; when absent nothing limits the run but the sandbox itself.

**D9. `wait` returns at the end of the execution or of `yieldMs`.** Up to 15
minutes; the gateway holds provider requests for under a minute each and
renews them, so no single provider request outlives a proxy's limit. New
output alone does not end a `middle` wait, so its tail is the latest output; a
`head` wait returns as soon as a page of output is there.

**D10. Output is cut in the middle by default.** The first and last halves of
`maxOutputBytes` (default 40,000 bytes, about 10,000 tokens) and the count of
bytes skipped; the cursor moves to the end, and skipped bytes stay readable.
`head` pages through output instead.

**D11. Every end has its own status:** `exited` (with `exitCode`), `killed`
(by `kill` or a signal), `timed_out` (by `maxRuntimeMs`), and `lost` when an
execution vanished without a recorded end. An exit code is never made up.

**D12. `kill` is ours, not the provider's.** A provider's kill would hit the
agent, which then could not record the end, so `kill` is an agent command: a `killed` marker, SIGTERM to Python's process group, SIGKILL
after `graceMs` (default 3 s, at most 30 s). It reaches every child process
that stayed in the group, and answers like `wait`, with the final output.
`maxRuntimeMs` works the same way, with a `timed_out` marker.

**D13. `list` recovers lost handles.** Each execution's folder holds what its
handle is built from, so `list` can return every execution in a sandbox,
running or not, for a caller that lost its state; a retried `start` returns
the same handle.

**D14. One provider request at most 50 s.** `wait` splits a long yield into
agent commands of at most the adapter's `maxHoldMs`, so the provider sees only
short requests; the Worker holds the caller's request until the end.

## API

| Route                            | Request            | Response            |
| -------------------------------- | ------------------ | ------------------- |
| `POST /v1/executions/start`      | `StartRequest`     | `StartResponse`     |
| `POST /v1/executions/wait`       | `WaitRequest`      | `ExecutionResult`   |
| `POST /v1/executions/kill`       | `KillRequest`      | `ExecutionResult`   |
| `POST /v1/executions/list`       | `ListRequest`      | `ListResponse`      |
| `POST /v1/executions/delete`     | `DeleteRequest`    | `DeleteResponse`    |
| `POST /v1/executions/delete-all` | `DeleteAllRequest` | `DeleteAllResponse` |

Failures answer `{ error: SandboxErrorData }`, with the HTTP status of the
error's kind (`not_found` 404, `conflict` 409, `sandbox_unavailable` 503, ...).
Types are in `@acentric-sandboxes/contracts`.

## Packages

- `packages/contracts`: the types, limits and `SandboxError`.
- `packages/providers`: the agent, the operations, request validation and one
  adapter per provider (`open` a sandbox, `launch` and `run` a command).
- `workers/gateway`: the Cloudflare Worker; `scripts/live.ts` runs every
  check against a real sandbox of any provider.

Providers: [E2B](providers/e2b.md), [Daytona](providers/daytona.md),
[Blaxel](providers/blaxel.md), [Tensorlake](providers/tensorlake.md).
