# Daytona

Provider ID `daytona`. Verified live on 2026-10-12 against Daytona Cloud
(default snapshot `daytonaio/sandbox:0.8.0`: Debian 13, Python 3.14, user
`daytona`, container class), through the Worker and directly: every check in
`workers/gateway/scripts/live.ts` passes. Research, with sources:
[research/daytona.md](../research/daytona.md).

## Credentials

`{ apiKey, apiUrl? }`. The organization API key goes as `Authorization:
Bearer` to the control plane (`apiUrl`, default `https://app.daytona.io/api`)
and to the toolbox proxy.

## How each call runs

1. `GET /sandbox/{idOrName}` gives the state and `toolboxProxyUrl`. A
   `stopped`, `archived` or `paused` sandbox is started (`POST
/sandbox/{id}/start`) and polled until `started`, for up to three minutes;
   states on their way (`starting`, `restoring`, `stopping`, ...) are waited
   out; `error`, `build_failed` and `destroyed` are `sandbox_unavailable`.
2. The agent runs through the toolbox's `POST {toolboxProxyUrl}/{id}/process/execute`,
   a plain JSON call that returns when the command ends: `{ exitCode, result }`,
   stdout and stderr merged. The daemon runs the command with `zsh -c`, so
   every argument is single-quoted. Its `timeout` (seconds) is the command's
   deadline; going past it is a 408 `PROCESS_EXECUTION_TIMEOUT`, read as
   `timeout`.
3. There is no background start, so `start` detaches the agent from the call:
   it forks, the child starts a session of its own (out of the reach of the
   daemon's process-group kill on timeout) and lets go of the call's pipes,
   and the parent prints the child's first line and exits.

A call costs one lookup and one command, about 0.6 to 0.8 s with nothing to
wait for. A `wait` holds a command for at most 50 s: the proxy closes
connections that send nothing for 70 s.

## Worth knowing

- **Auto-stop kills running scripts.** A sandbox stops after
  `autoStopInterval` minutes without toolbox calls (default 15), and stopping
  kills every process. Every call through the gateway counts as activity, but
  a script left alone longer than that is lost. Whoever creates the sandbox
  should set `autoStopInterval` to `0` (with `autoDeleteInterval` or a TTL as
  a safety net) or high enough.
- **A stopped sandbox comes back, its runs do not.** The next call starts it
  (about 4 s for a container), files survive, and a run that was going is
  reported `lost`, with the output it wrote before.
- **Errors.** An unknown ID or name is a 404 (`not_found`), malformed or not;
  a bad key a 401 (`auth`).
- **Files** are in `/tmp/acentric/executions/`; the default working directory
  is `/home/daytona`.
