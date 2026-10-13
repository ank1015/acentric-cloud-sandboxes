# Tensorlake

Provider ID `tensorlake`. Verified live on 2026-10-12 against Tensorlake
(image `tensorlake/ubuntu-minimal`: Ubuntu 24.04, Python 3.12, user
`tl-user`, free plan), through the Worker and directly: every check in
`workers/gateway/scripts/live.ts` passes. Research, with sources:
[research/tensorlake.md](../research/tensorlake.md).

## Credentials

`{ apiKey }`: a project API key, sent as `Authorization: Bearer`. The key
selects the project.

## How each call runs

1. No lookup. The sandbox's own host, `https://{id or name}.sandbox.tensorlake.ai`,
   takes the sandbox ID or name directly, and a call to a suspended sandbox
   resumes it (about 1.5 s more). The control plane is not used. A sandbox ID
   that cannot be a host name is refused before any request
   (`invalid_request`).
2. The agent runs through `POST /api/v1/processes/run` (`{ command, args,
timeout }`), which answers with server-sent events: the start, each output
   line with its stream, and the end (`{ exit_code, reason: "exited" }`, or
   `{ signal, reason: "timed_out" }` past `timeout`, read as `timeout`). The
   stream carries a comment every 15 s, so it stays open as long as needed.
3. Output arrives as lines without their newlines, and a line longer than
   16 KiB as several events of 16,384 bytes. The adapter joins a 16,384-byte
   piece to the next without a newline; the agent's answer is always one JSON
   line, so this is exact for it.
4. There is no background start that answers with output (`POST
/api/v1/processes` answers with a PID only), so `start` detaches the agent
   from a `run` call, like Daytona. That call gets no `timeout`: when one runs
   out, the daemon kills the command's whole cgroup, detached children
   included.

A call costs one request, about 1.1 s with nothing to wait for (most of it on
Tensorlake's side). A `wait` holds a request for at most 50 s; one was held
for 75 s without trouble.

## Worth knowing

- **Idle sandboxes are suspended, and their scripts with them.** A sandbox
  is suspended (named) or terminated (unnamed) after `timeout_secs` without
  traffic to it, whether or not a process is running. A script left alone
  longer than that is frozen until the next call (named sandbox) or lost with
  the sandbox (unnamed). Whoever creates the sandbox should give it a name and
  a `timeout_secs` that covers the longest script, up to the plan's limit
  (2 h on the free plan). A suspended sandbox resumes with the next call, and
  the script carries on where it stopped.
- **A free plan runs one sandbox at a time.** Suspended sandboxes do not
  count.
- **Errors.** An unknown or terminated sandbox is a 404
  `SANDBOX_NOT_FOUND` (`not_found`); a bad key a 401 `TL_UNAUTHORIZED`
  (`auth`).
- **Process records pile up.** The daemon keeps every finished process; each
  gateway call adds one.
- **Files** are in `/tmp/acentric/executions/`; the default working directory
  is `/home/tl-user`. Commands run as `tl-user`, not root.
