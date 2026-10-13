# Sandbox research: `exec_python` and `wait`

Checked 2026-10-12, from docs and source only (no credentials, nothing run
live). One note per provider, plus how Codex does the same thing:

- [codex-unified-exec.md](codex-unified-exec.md): Codex's `exec_command` /
  `write_stdin`, and its code-mode `wait`
- [e2b.md](e2b.md), [daytona.md](daytona.md), [blaxel.md](blaxel.md),
  [tensorlake.md](tensorlake.md), [modal.md](modal.md)

The question: can a stateless gateway (a Cloudflare Worker, `fetch` only,
caller-supplied credentials) give agents these two tools on top of each
provider's API?

```ts
exec_python({ code: string, yield_time_ms?: number }) // default 10000
wait({ execution_id: string, yield_time_ms?: number, terminate?: boolean })
```

## Short answer

Yes for E2B, Daytona, Blaxel and Tensorlake, directly over their HTTP APIs.
Modal only with a small bridge service, since its API is native gRPC.

No provider gives all of it natively. Every one lacks at least one of: output
that is kept while nobody is listening, a read offset, a wait with a timeout,
a kill that reaches child processes, an exit code kept after exit. They lack
different ones. What they all have is "start a command in the background",
"run a short command and get its output" and "write a file". So the portable
design is to put the job logic in a small runner script of our own inside the
sandbox, and use each provider only for those three things.

## Providers compared

|                                                | E2B                                                                             | Daytona                                                  | Blaxel                                                  | Tensorlake                                                | Modal                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Callable from a Worker                         | yes: REST + Connect (JSON over HTTP)                                            | yes: REST                                                | yes: REST                                               | yes: REST + SSE                                           | **no**: native gRPC only; needs a bridge           |
| Background process survives our disconnect     | yes                                                                             | yes (async session command)                              | yes                                                     | yes                                                       | yes                                                |
| Output kept while nobody listens               | **no**: dropped                                                                 | yes: full log                                            | yes: last 4 MiB                                         | yes: replayed (retention undocumented)                    | yes: 10 min after exit                             |
| Read output from an offset                     | no                                                                              | no                                                       | no                                                      | no                                                        | private protocol only                              |
| Server-side wait with timeout                  | no                                                                              | no                                                       | no (`waitForCompletion` ≤ 60 s)                         | no                                                        | no (current SDK)                                   |
| Exit code after exit                           | 30 s only                                                                       | while the session exists                                 | yes                                                     | yes                                                       | ≥ 10 min (undocumented)                            |
| Kill reaches children                          | no (PID only)                                                                   | yes (session delete, process tree)                       | yes (process group)                                     | undocumented                                              | no per-process kill at all                         |
| Ranged file reads                              | yes (`Range`)                                                                   | likely (unverified through proxy)                        | likely (`ServeContent`)                                 | no                                                        | no                                                 |
| Stateful Python that can run in the background | no: interpreter is interrupted on disconnect                                    | no: WebSocket only, drops output                         | no: Jupyter image, one held request                     | none                                                      | none (example only)                                |
| What idle does to a running script             | runs until the sandbox timeout (calls don't extend it; 1 h Hobby, 24 h Pro max) | **killed** at auto-stop (15 min default; calls reset it) | **frozen** ~15 s after the last call unless `keepAlive` | stopped at idle timeout (600 s default, by proxy traffic) | runs until sandbox timeout (300 s default, ≤ 24 h) |

Each provider note has the citations, the exact endpoints, and a list of
things to verify live.

## Recommended design

### A runner inside the sandbox

A small Python script we upload once per sandbox (Python is always there: it
is a Python tool). It owns everything the providers disagree on:

- `start <id>`: writes the user's code to `/tmp/acx/<id>/main.py`, starts
  `python -u main.py` in its own process group with stdout and stderr going to
  `out.log`, waits for it, then writes `exit.json` atomically (code or
  signal). It stays alive as the parent, so the exit is always recorded.
- `wait <id> --cursor N --yield-ms T --max-bytes M`: waits inside the sandbox
  until the process exits or `T` passes, then prints JSON with the status, the
  exit code if any, the bytes from `N` (capped at `M`) and the next cursor.
  Reads `exit.json` before the log, so a finished status means the output read
  is complete.
- `kill <id>`: SIGTERM to the process group, SIGKILL after a grace period;
  the parent still records the result.

### What each provider adapter has to do

1. Make sure the sandbox is running and will stay running: create, resume,
   and set the keep-alive (E2B timeout, Daytona `autoStopInterval`, Blaxel
   `keepAlive`, Tensorlake `timeout_secs`, Modal `timeout`).
2. Write a file.
3. Start `python runner.py start <id>` in the background.
4. Run `python runner.py wait|kill ...` and return its output, with a request
   timeout a little above the yield time.

That is four small methods per provider, and the tools behave the same
everywhere. Native features stay optional speed-ups: E2B's `Range` reads,
Tensorlake's SSE replay, Daytona and Blaxel's process-tree kill.

Modal needs a bridge for steps 1 to 4 (a small service using its SDK), or a
runner that serves HTTP inside the sandbox, reached with a Connect Token.
Either way something other than the Worker has to create the sandbox. It is
the odd one out.

### The cursor

The gateway keeps nothing between calls, so `wait({ execution_id })` cannot
know where the last call stopped. Options:

1. **The runner remembers what it has delivered** (like Codex, which hands
   over everything since the last call). The tool shape stays as sketched.
   A retried or lost response can lose output, unless the gateway also
   accepts an explicit cursor.
2. **An explicit `cursor` on `wait`.** Retries are safe, but the model has to
   carry one more value.
3. **A new `execution_id` on every response** with the cursor inside.
   Retries are safe, but the model must always use the latest ID.

Suggested: option 1 for the model-facing tool, with the gateway's HTTP API
also taking an optional `cursor` so a harness can retry exactly. The runner
stores the delivered offset, and an explicit cursor overrides it.

### Limits to pick

- **Yield cap.** Provider edges cut held requests at about 60 s (Blaxel) and
  70 s (Daytona idle). Codex caps `exec_command` at 30 s. Cap `yield_time_ms`
  at about 30 s per request; a longer `wait` can loop inside the Worker.
- **Output cap.** Codex caps each response at `max_output_tokens` (default
  10,000, about 4 bytes a token), keeps the head and tail, and notes how much
  was cut. We need the same; whatever is not returned stays readable through
  the cursor.
- **Exit codes.** Normalise signals: Modal's SDK uses 128 + signal, E2B
  reports −1.

### Things the gateway must guard against

- **Running code twice.** A start that times out may still have run. Use an
  ID generated before the start, and have the runner refuse a second start
  with the same ID.
- **Sandboxes that stop while a job runs** (Daytona auto-stop, Blaxel
  standby, Tensorlake idle, E2B/Modal timeouts). Report "sandbox stopped,
  execution lost" rather than a fake exit code.
- **PID reuse.** Identify runs by our own ID, never by a bare PID.
- **Split UTF-8.** A byte cursor can cut a character in half; carry the
  partial bytes or cut at a character boundary.

## Open decisions

1. **Fresh process or persistent interpreter?** Each `exec_python` as its own
   process, which is what makes background running, waiting and killing
   simple. Or a persistent interpreter where variables survive between
   calls, as in Codex's code mode and the providers' code interpreters. None
   of the providers' interpreters can run in the background, so it would be
   our own kernel inside the sandbox, and killing a stuck cell would mean
   restarting it and losing its state.
2. **The cursor** (above).
3. **Which sandbox an execution runs in**: one per conversation, passed in by
   the caller, or created by the gateway. `execution_id` has to carry the
   provider and sandbox ID either way; credentials never go in it.
4. **Whether Modal is in scope** given that it needs a bridge.
5. **stdout and stderr** merged in one stream (simplest, keeps the order) or
   separate.
