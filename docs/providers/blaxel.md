# Blaxel

Provider ID `blaxel`. Verified live on 2026-10-12 against Blaxel (image
`blaxel/py-app:latest`: Debian, Python 3.12, user `root`, region `us-pdx-1`),
through the Worker and directly: every check in
`workers/gateway/scripts/live.ts` passes. Research, with sources:
[research/blaxel.md](../research/blaxel.md).

## Credentials

`{ apiKey, workspace? }`. The API key goes as `Authorization: Bearer` to the
control plane (`https://api.blaxel.ai/v0`) and to the sandbox API. `workspace`
is sent as `X-Blaxel-Workspace` when given: a key made in a workspace works
without it, and a key that reaches several workspaces needs it. A workspace
the key cannot reach is a 403 (`auth`).

## How each call runs

1. `GET /sandboxes/{name}` gives the deployment `status` and the sandbox's
   URL (`metadata.url`, `https://sbx-{name}-{workspace id}.{region}.bl.run`;
   it cannot be built without the lookup). `DEPLOYED` is ready, whether the
   sandbox is active or in standby: any request wakes it. `CREATED`,
   `UPLOADING`, `BUILDING` and `DEPLOYING` are polled for up to two minutes;
   anything else (`FAILED`, `TERMINATED`, `DELETING`, ...) is
   `sandbox_unavailable`.
2. The agent runs through the sandbox API's `POST {url}/process`, which runs
   the command with `sh -c`, so every argument is single-quoted.
   - `start` asks for the NDJSON stream of the new process
     (`Accept: application/x-ndjson`), takes the first line of stdout and
     closes the stream; the process keeps running. It is started with
     `keepAlive: true`, which holds the sandbox out of standby until the
     process ends, and `timeout: 0`, which turns off the 600 s auto-kill that
     otherwise comes with `keepAlive`.
   - Every other command uses `waitForCompletion: true` with `timeout` as its
     deadline, and gets `{ status, exitCode, stdout, stderr }` back. Going
     past the deadline is a 422 `process timed out after N seconds`, read as
     `timeout`.

A call costs one lookup and one command, about 0.5 to 1 s with nothing to
wait for, and about 1.5 s when it wakes a sandbox from standby. A `wait`
holds a command for at most 50 s; the edge was seen holding requests for
75 s.

## Worth knowing

- **Standby freezes scripts that are not kept alive.** About 15 s after the
  last request a sandbox goes to standby, and its processes stop until the
  next request. The supervisor of each execution is started with `keepAlive`,
  so the sandbox stays active while Python runs (verified: no calls for 50 s,
  no gap in the script's output) and goes to standby once it ends. Active time
  is billed. On a plan without `keepAlive` the sandbox API should refuse the
  start (from the source; not seen live).
- **Command output is slow to come back.** The sandbox API captures output at
  roughly 110 KB/s: a `wait` with the default 40,000-byte limit adds about
  0.4 s, one with the 1 MiB limit about 13 s.
- **Every command leaves a process record.** The sandbox API keeps each
  finished process and its logs for the sandbox's life, and has no call to
  remove one, so each gateway call adds one. Their logs share a cap of 10% of
  the sandbox's memory.
- **A User-Agent is required.** The control plane's edge (CloudFront) refuses
  requests without one with an HTML 403; the gateway sends
  `acentric-sandboxes` on every request.
- **Errors.** An unknown sandbox name is a 404 (`not_found`), malformed or
  not; a bad key a 401 (`auth`).
- **Files** are in `/tmp/acentric/executions/`; the default working directory
  is `/blaxel`. The root filesystem is RAM-backed, so output and files use the
  sandbox's memory.
