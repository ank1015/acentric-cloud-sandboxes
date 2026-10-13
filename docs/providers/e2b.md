# E2B

Provider ID `e2b`. Verified live on 2026-10-12 against E2B Cloud (envd
0.9.0, `base` template: Debian 12, Python 3.11, user `user`), through the
Worker and directly: every check in `workers/gateway/scripts/live.ts`
passes. Research, with sources: [research/e2b.md](../research/e2b.md).

## Credentials

`{ apiKey, domain? }`. The project API key goes only to the control plane
(`https://api.<domain>`, header `X-API-Key`); `domain` defaults to `e2b.app`.
The sandbox's envd token, which commands need, is looked up on every call and
never leaves the gateway.

## How each call runs

1. `GET /sandboxes/{id}` gives the sandbox's state and envd access token. A
   `paused` sandbox is resumed with `POST /v2/sandboxes/{id}/connect` (body
   `{}`, which never shortens its timeout); any other state than `running` is
   `sandbox_unavailable`.
2. The agent runs through envd's `Process/Start` at
   `https://49983-<id>.<domain>`, a Connect server stream: JSON messages in
   5-byte envelopes over plain HTTP, which a Worker reads with `fetch`.
   - `start` reads until the agent's first line, then disconnects; envd keeps
     the process running. It gets no `Connect-Timeout-Ms`, which on `Start`
     would also limit the process.
   - Other commands are read to their end, with `Connect-Timeout-Ms` as a
     deadline. A `wait` holds one for at most 50 s.

A call costs one lookup and one command, about 0.7 to 1 s with nothing to
wait for.

## Worth knowing

- **The sandbox's timeout is the caller's business.** E2B kills (or pauses,
  if so configured) a sandbox when its timeout runs out, whatever is running,
  and calls do not extend it. A resumed sandbox gets at least five minutes.
- **Pause freezes the script**, and resuming continues it where it was: a
  script paused mid-run finished with all its output.
- **Errors.** A malformed sandbox ID is a 400 (`invalid_request`), an unknown
  or inaccessible one a 404 (`not_found`), a bad key a 401 (`auth`).
- **Files** are in `/tmp/acentric/executions/`; the default working directory
  is `/home/user`.
