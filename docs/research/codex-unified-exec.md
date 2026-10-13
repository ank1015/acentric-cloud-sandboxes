# Codex "unified exec": exec_command and write_stdin

Read-only research on a local checkout of the OpenAI Codex repository (Rust, under `codex-rs/`). Nothing in that repo was modified. Paths below are relative to `codex-rs/` unless absolute. Line numbers reflect the checkout at the time of reading and may drift.

Purpose: inform the design of `exec_python({code, yield_time_ms?})` and `wait({execution_id, yield_time_ms?, terminate?})`.

## Summary

- Two tools form one protocol. `exec_command` starts a process and waits up to a yield window. If the process is still alive it returns a numeric `session_id`. `write_stdin` either writes input or polls (empty `chars`) and returns only output produced since the previous drain.
- The yield window ends early only when the process exits. Output arriving does not end it. A poll therefore always blocks for the full yield unless the process finishes.
- Output is drained on read, not cursored. Each response contains only new output, and nothing is replayed. There is no offset or sequence number, and the `chunk_id` in responses is a random label that is never accepted as input.
- The model cannot kill a session. Its only levers are `\u0003` (Ctrl-C) and, under `tty=true`, arbitrary bytes. Termination is host-only (app-server RPC, TUI `/clean`, shutdown). The closest code-mode analogue, `wait`, does have `terminate: true`.
- Exit is reported only on a poll. The first poll that observes exit returns the exit code and removes the session. Later calls get "Unknown process id".
- Limits: 64 live sessions (soft cap, LRU eviction with no error to the model), 1 MiB head+tail buffer per stream, roughly 4 bytes per approximate token, default 10 s yield, 250 ms to 30 s clamp, 5 s to 300 s empty-poll window.

---

## 1. Tool schemas shown to the model

### 1.1 exec_command

Built in `core/src/tools/handlers/shell_spec.rs:24-115` (`create_exec_command_tool_with_environment_id`).

Description, non-Windows (`shell_spec.rs:103`), verbatim:

> Runs a command in a PTY, returning output or a session ID for ongoing interaction.

This text says "in a PTY", but the default is pipes. See section 2.

- `strict: false`, `required: ["cmd"]`, `additionalProperties: false` (`shell_spec.rs:106, 110, 112`).
- Declared `output_schema` is `unified_exec_output_schema()` (`shell_spec.rs:198-230`). Its fields are `chunk_id`, `wall_time_seconds`, `exit_code`, `session_id`, `original_token_count`, `output`. The schema is used for structured or code-mode results. The text the model reads is the plain-text header in section 3.

| Parameter                | Type             | Model-facing description (verbatim)                                                                                                                                               | Effective default and clamp                                                                                                          | Source                                                                             |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `cmd`                    | string, required | "Shell command to execute."                                                                                                                                                       | none                                                                                                                                 | `shell_spec.rs:37-39`                                                              |
| `workdir`                | string           | "Working directory for the command. Defaults to the turn cwd."                                                                                                                    | turn cwd; relative paths resolved against the environment cwd                                                                        | `shell_spec.rs:41-46`, `exec_command.rs:193-201`                                   |
| `tty`                    | boolean          | "True allocates a PTY for the command; false or omitted uses plain pipes."                                                                                                        | default `false` (`default_tty`). Removed from schema if `UnifiedExecTty` is off. If sent as `true` while disabled, returns an error. | `shell_spec.rs:47-53`, `unified_exec.rs:71-73`, `exec_command.rs:131-138, 243-247` |
| `yield_time_ms`          | number           | "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." (Windows variant at `shell_spec.rs:31`: "...Effective range on Windows is 10000-30000 ms.") | default 10000 (`unified_exec.rs:63-65`). Clamp `[250, 30000]` on non-Windows. On Windows the floor is 10000.                         | `shell_spec.rs:30-34, 54-57`; `mod.rs:73-74, 77, 218-225`                          |
| `max_output_tokens`      | number           | "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."                                                                                         | default 10000 (`mod.rs:79, 227-229`). Effective budget is `min(requested, model truncation policy)`.                                 | `shell_spec.rs:58-63`; `core/src/tools/context.rs:482-493`                         |
| `shell`                  | string           | "Shell binary to launch. Defaults to the user's default shell."                                                                                                                   | only in direct shell mode; rejected under local zsh-fork                                                                             | `shell_spec.rs:65-72`, `unified_exec.rs:116-127`                                   |
| `login`                  | boolean          | "True runs the shell with -l/-i semantics; false disables them. Defaults to true."                                                                                                | Code default is the config value `allow_login_shell`, not literally true. Explicit `true` errors if login is disabled by config.     | `shell_spec.rs:73-81`, `unified_exec.rs:106-114`                                   |
| `environment_id`         | string           | "Environment id from <environment_context>. Omit to use the primary environment."                                                                                                 | only in multi-environment mode                                                                                                       | `shell_spec.rs:82-90`                                                              |
| `sandbox_permissions`    | enum             | "Per-command sandbox override. Defaults to `use_default`; ..."                                                                                                                    | `use_default`, `require_escalated`, plus `with_additional_permissions` when `ExecPermissionApprovals` is on                          | `shell_spec.rs:232-266`                                                            |
| `justification`          | string           | "User-facing approval question for `require_escalated`; omit otherwise."                                                                                                          | none                                                                                                                                 | `shell_spec.rs:255-259`                                                            |
| `prefix_rule`            | array of string  | "Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`..."                                                                                     | none                                                                                                                                 | `shell_spec.rs:260-265`                                                            |
| `additional_permissions` | object           | "Sandboxed filesystem or network access for this command; ..."                                                                                                                    | only when `ExecPermissionApprovals` is on                                                                                            | `shell_spec.rs:268-275`                                                            |

Gating: `exec_command` and `write_stdin` are registered only when `Feature::UnifiedExec` is enabled (`core/src/tools/spec_plan.rs:1188-1192`). Otherwise the model gets the one-shot variant (`spec_plan.rs:1193-1198`).

One-shot variant (`exec_command.rs:478-507`): the description is replaced with "Runs a command to completion and returns its output. The process is terminated on timeout or cancellation and cannot be resumed." The `tty` and `yield_time_ms` parameters are removed. `timeout_ms` is added with "Maximum command runtime. Defaults to 10000 ms." (default from `core/src/exec.rs:63`). `session_id` is removed from the output schema.

### 1.2 write_stdin

Built in `core/src/tools/handlers/shell_spec.rs:117-159` (`create_write_stdin_tool`).

Description, verbatim (`shell_spec.rs:147-149`):

> Writes characters to an existing unified exec session and returns recent output.

- `required: ["session_id"]` (`shell_spec.rs:154`).

| Parameter           | Type             | Model-facing description (verbatim)                                                                                                | Effective default and clamp                                                                                                                                 | Source                                          |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `session_id`        | number, required | "Identifier of the running unified exec session."                                                                                  | internally `process_id`; the model-facing name is kept because "The model is trained on `session_id`" (`errors.rs:12`, `write_stdin.rs:27`)                 | `shell_spec.rs:118-124`                         |
| `chars`             | string           | "Bytes to write to stdin. Defaults to empty, which polls without writing."                                                         | default `""`                                                                                                                                                | `shell_spec.rs:125-130`, `write_stdin.rs:29-30` |
| `yield_time_ms`     | number           | "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default." | handler default 250 (`unified_exec.rs:67-69`). Non-empty clamp is described in section 4. The empty-poll effective default is 5000, not 300000 (section 4). | `shell_spec.rs:131-136`, `write_stdin.rs:31-32` |
| `max_output_tokens` | number           | "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."                                          | same as exec_command                                                                                                                                        | `shell_spec.rs:137-142`, `write_stdin.rs:33-34` |

There is no `tty`, `shell`, or `workdir` on write_stdin.

---

## 2. Execution model

### 2.1 Pipes by default, PTY only on request

- `tty` is passed through to the spawn call with `stdin_open: tty` (`core/src/unified_exec/process_manager.rs:1413-1421`). With `tty=false`, stdin is not open for the child, and the child's output is read from pipes.
- With `tty=false`, `write_stdin` accepts only the interrupt byte `INTERRUPT = "\u{3}"` (`process_manager.rs:109`). That byte calls `process.interrupt()`, which sends `PtyProcessSignal::Interrupt` (`process_manager.rs:983-988`, `core/src/unified_exec/process.rs:274-283`). Any other input returns `StdinClosed` (`process_manager.rs:989-991`). The error text is: "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open" (`errors.rs:19-22`).
- With `tty=true`, bytes are written to the PTY, and there is a 100 ms settle sleep before collection (`process_manager.rs:990-996`, with the comment "Give the remote process a brief window to react so that we are more likely to capture its output in the poll below.").

### 2.2 Output capture and buffers

- A reader task forwards each chunk from the combined stdout/stderr receiver (`core/src/unified_exec/process.rs:619-648`, `spawn_local_output_task`). Each chunk is pushed under one lock into two buffers (`process.rs:61-74`):
  - `pending`: what the model's next call receives. It is drained on every collection (`process_manager.rs:1608`, `std::mem::take(&mut guard.pending)`).
  - `transcript`: retained for the final `ExecCommandEnd` event that the UI consumes (`async_watcher.rs:327-330, 459-468`). It is not returned to the model.
- Both are `HeadTailBuffer` with capacity `UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1 MiB` (`mod.rs:80`). The buffer is split 50/50 into head and tail (`head_tail_buffer.rs:5-19`). Bytes in the middle are dropped and counted (`push_tail`, `head_tail_buffer.rs:68-91`).
- When bytes are omitted, the marker is `"... {N} bytes omitted ..."` (`mod.rs:231-233`). It is inserted between head and tail (`head_tail_buffer.rs:106-124`).
- Implication: `pending` is per interval between drains. If nobody polls, it can accumulate up to 1 MiB, after which the model sees head, marker, and tail on the next drain.

### 2.3 Streaming to the UI (separate from the model)

- `start_streaming_output` subscribes to the broadcast receiver, not to `pending` (`async_watcher.rs:57-60`). It emits `ExecCommandOutputDelta` events, capped at 8192 bytes per event (`async_watcher.rs:34-42`), and at most `MAX_EXEC_OUTPUT_DELTAS_PER_CALL = 10_000` per call (`core/src/exec.rs:85`). These events reach the UI and app-server, not the model. Model-visible output comes only from tool results.

### 2.4 Truncation and token counting

- Each response is built by `ExecCommandToolOutput::response_text` (`core/src/tools/context.rs:550-582`). The output is truncated to `model_output_policy()` (`context.rs:482-493`), which is `min(max_output_tokens or 10000, model truncation policy budget)`.
- Truncation (`utils/output-truncation/src/lib.rs:23-41`) prefixes a warning and then truncates the middle. The format is `"Warning: truncated output (original token count: N)\nTotal output lines: M\n\n..."`. When omitted bytes exist and the text fits, the marker is prepended instead (`context.rs:495-522`).
- `response_text` shrinks the policy in a loop until the whole response, header included, fits the history budget (`context.rs:550-580`).
- Token approximation: `approx_token_count` and `approx_tokens_from_byte_count` use `APPROX_BYTES_PER_TOKEN = 4` with round-up division (`utils/string/src/truncate.rs:4, 101-113`). `original_token_count` is computed from `total_bytes()`, which includes bytes omitted by the 1 MiB cap (`process_manager.rs`, around L657 for exec and around L1040 for write_stdin).

### 2.5 Spawn and ID allocation

- `allocate_process_id` picks a random ID in `[1000, 100000)` in production (`process_manager.rs:449-474`, line 464). Deterministic IDs starting at 1000 are used only in tests. Retries skip IDs already reserved. A comment in `write_stdin_inner` says a removed ID can be reused, so identity is revalidated after approval.

---

## 3. What the tool returns

### 3.1 Header format

`ExecCommandToolOutput::response_header` (`core/src/tools/context.rs:524-548`) joins these lines with `\n`, in this order:

1. `Chunk ID: <6 hex chars>`. Only if non-empty. Generated randomly by `generate_chunk_id` (`core/src/unified_exec/mod.rs:235-240`). Not a cursor.
2. `Wall time: <seconds, 4 decimals> seconds`.
3. `Process exited with code <N>`. Only if the process exited during this call.
4. `Process running with session ID <id>`. Only if still alive.
5. `Original token count: <N>`. Only if known. Always set on the exec and write paths.
6. `Output:`

The response text is the header, then `\n`, then the output (`context.rs:550-582`, `format!("{header}\n{output}")`).

### 3.2 Example, still running

```
Chunk ID: 9f0c2a
Wall time: 10.0031 seconds
Process running with session ID 4821
Original token count: 37
Output:
server listening on :8000
```

### 3.3 Example, exited during the call

```
Chunk ID: 1b7e44
Wall time: 0.0527 seconds
Process exited with code 0
Original token count: 3
Output:
done
```

### 3.4 Sandbox denial

The response has an exit code and no session ID (`exec_command.rs:442-466`). The code comment says "Sandbox denial is terminal, so there is no live process for write_stdin to resume."

### 3.5 Error responses (returned as tool errors)

- Unknown or already-removed session: `write_stdin failed: Unknown process id <N>` (`errors.rs:13-14`, `write_stdin.rs:122-133`).
- Stdin approval: `write_stdin rejected: ...` or `write_stdin approval failed: ...` (`write_stdin.rs:123-129`).
- Stdin closed (pipe mode): `write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open` (`errors.rs:19-22`).
- Other exec failures: `exec_command failed: ...`, truncated to 900 bytes (`exec_command.rs:56-57, 467-473`).
- TTY disabled: `TTY execution is disabled by config; omit \`tty\` or set it to false.` (`exec_command.rs:243-247`).
- Login disabled: `login shell is disabled by config; omit \`login\` or set it to false.` (`unified_exec.rs:107-109`).

---

## 4. Yield semantics

### 4.1 Core loop: deadline or exit, never output

`collect_output_until_deadline` (`process_manager.rs:1573-1684`) is the only waiting primitive.

- It repeatedly drains `pending`. If nothing is buffered, it waits on `output_notify`, the deadline, or the exit token (`process_manager.rs:1610-1650`).
- After pushing drained output, it checks `if Instant::now() >= deadline` and otherwise loops (`process_manager.rs:1655-1660`). New output therefore does not end the wait. The call returns only at the deadline or after the process exits.
- After exit, the loop enters a post-exit phase: it returns when the output stream closes, or after `min(remaining, POST_EXIT_CLOSE_WAIT_CAP = 50 ms)` (`process_manager.rs:1579-1580, 1625-1640`).
- The deadline is extended while an elicitation pause is active (`extend_deadlines_while_paused`, `process_manager.rs:1686-1710`).

Integration test evidence: `core/tests/suite/unified_exec.rs:2227-2304` (`unified_exec_respects_early_exit_notifications`). The command is `sleep 0.05` with `yield_time_ms: 31415`, which clamps to 30000. The test asserts no session ID, exit code 0, and `wall_time < 0.75 s`.

### 4.2 exec_command

- Yield is `clamp_yield_time(yield_time_ms)` (`process_manager.rs:631`, `mod.rs:218-225`).
- Non-Windows range `[250, 30000]`. Windows floor 10000.
- The process is stored in the session map before the wait, so an interrupt cannot drop it (`process_manager.rs:597-598`, comment "Persist live sessions before the initial yield wait so interrupting the turn cannot drop the last Arc and terminate the background process.").
- A process that has already exited before storage is never stored and returns no session ID (`process_manager.rs:598`).

### 4.3 write_stdin, non-empty input

Code at `process_manager.rs:1014-1022`:

```
let time_ms = request.yield_time_ms.max(MIN_YIELD_TIME_MS);   // 250 floor
...
} else {
    time_ms.min(MAX_YIELD_TIME_MS);                           // 30000 cap
}
```

- Default is 250 ms (handler default, `unified_exec.rs:67-69`). Maximum is 30 s.
- The comment says: "Non-empty writes keep a fixed max cap so interactive stdin remains responsive."
- The 100 ms settle sleep (section 2.1) happens before `start` is measured, so `Wall time` excludes it. The total latency is therefore about 100 ms plus the yield, unless the process exits.

### 4.4 write_stdin, empty poll

Code at `process_manager.rs:1014-1020`:

```
if request.input.is_empty() {
    time_ms.clamp(MIN_EMPTY_YIELD_TIME_MS, self.max_write_stdin_yield_time_ms)
}
```

- `MIN_EMPTY_YIELD_TIME_MS = 5000` (`mod.rs:75-76`).
- The upper bound is `max_write_stdin_yield_time_ms`, from config `background_terminal_max_timeout`, default 300000 (`config/src/config_toml.rs:341-343`, wired at `core/src/session/session.rs:1716-1718`, default at `mod.rs:78, 185-189`).
- The constructor floors this cap at 5000 (`mod.rs:176-181`).
- Effective behavior: `yield_time_ms` omitted gives 250, which is clamped up to 5000. So the default empty poll is 5 s. The maximum is the config cap, default 300 s.
- The spec text (`shell_spec.rs:134`) says "empty polls wait 5000-300000 ms by default". That is the clamp range, not the default.
- Empty polls also return early on exit, through the same loop.

### 4.5 Summary table

| Call                   | Requested default     | Effective range                           | Returns early on                            |
| ---------------------- | --------------------- | ----------------------------------------- | ------------------------------------------- |
| exec_command           | 10000 ms              | 250-30000 ms (Windows floor 10000)        | process exit (post-exit wait at most 50 ms) |
| write_stdin, non-empty | 250 ms                | 250-30000 ms, plus 100 ms settle          | process exit                                |
| write_stdin, empty     | 250 ms (then clamped) | 5000 ms to config cap (default 300000 ms) | process exit                                |

---

## 5. write_stdin: polling and cursor semantics

- Empty `chars` means no write. The call only collects output for the yield window (`process_manager.rs` around L980-983, `if !request.input.is_empty()`).
- There is no cursor. Each call drains `pending` (`process_manager.rs:1608`). A response contains only output produced since the last drain by any call. Repeated polls never replay old output.
- The `chunk_id` is decorative. It is random per response and is not accepted as input.
- Concurrency: writes and polls on one session are serialized by `interaction_lock`. Different sessions can be polled in parallel (`process_manager.rs:884-904`, comment: "reads and writes against one terminal must not overlap because they share a draining output buffer and process lifecycle."). Test: `core/tests/suite/unified_exec.rs:3949` (`write_stdin_calls_run_in_parallel_across_sessions`).
- Finished process: when a poll observes exit, `refresh_process_state` removes the entry from the store and returns `Exited` with the exit code (`process_manager.rs:1128-1151`; `ProcessStore::remove`, `mod.rs:161-167`). That response has no session ID and carries the final drained output. Test: `core/tests/suite/unified_exec.rs:2306-2480` (`write_stdin_returns_exit_metadata_and_clears_session`). A later call with the same ID gets "Unknown process id".
- If the process exits while nobody polls, its entry stays in the store, exited but not removed. It is removed on the next poll that observes it or when pruning evicts it (section 6). The model learns about the exit only from a poll, or from the initial exec_command if the exit happens inside its window. The exit watcher emits `ExecCommandEnd` to the UI (`async_watcher.rs:158-200`). That event does not reach the model.
- Ctrl-C (`\u0003`) on a pipe session interrupts without removing the session. Tests: `core/tests/suite/unified_exec.rs:2481` (`write_stdin_ctrl_c_interrupts_non_tty_session`) and `:2936` (`unified_exec_interrupt_preserves_long_running_session`).
- Stdin approval: non-empty writes can go through a guardian review, with payload size capped at `MAX_STDIN_APPROVAL_BYTES = 8000` (`process_manager.rs:108`). Oversized input is rejected, not run unreviewed (`process_manager.rs` around L900-960).
- `TerminalInteraction` events are emitted for non-empty writes or when the process is alive (`process_manager.rs` around L1120-1135). These are UI events.

---

## 6. Killing, limits, and pruning

### 6.1 Model-side termination

- Neither tool has a kill parameter (`shell_spec.rs:117-159`).
- A session ends from the model's side only when: the process exits on its own; the model sends Ctrl-C (pipe mode: interrupt, which the process may ignore); under `tty=true` the model sends control bytes such as Ctrl-D or Ctrl-C through `chars`; the session is evicted by pruning (6.3); or the session is torn down by the host (6.2).

### 6.2 Host-only termination

- `terminate_process` (`process_manager.rs:1842-1871`) is reached from:
  - app-server RPC: `app-server/src/request_processors/thread_processor.rs:2449`, via `codex_thread.rs:785` and `core/src/tasks/mod.rs:918`.
  - TUI: `clean_background_terminals` (`core/src/session/handlers.rs:64-66`, invoked at `:502`), `tui/src/chatwidget.rs:1481`, and `tui/src/chatwidget/slash_dispatch.rs:598`.
- `terminate_all_processes` (`process_manager.rs:1795-1812`) runs on shutdown (`core/src/session/handlers.rs:312`) and on clean-background-terminals.
- Turn end and interrupt do not kill a session. Tests: `core/tests/suite/unified_exec.rs:2835` (`unified_exec_keeps_long_running_session_after_turn_end`) and `:2936`. The one-shot variant is killed on interrupt (`:3378`).

### 6.3 Session cap and pruning

- `MAX_UNIFIED_EXEC_PROCESSES = 64` (`mod.rs:82`) is a soft cap. `store_process` calls `prune_processes_if_needed` before inserting (`process_manager.rs:1222-1228`). No error reaches the model. A new `exec_command` always succeeds, and an older session is evicted.
- Policy (`process_manager.rs:1722-1765` with `process_id_to_prune_from_meta` at `:1767-1793`; the function's comment says "Centralized pruning policy so we can easily swap strategies later."):
  1. If fewer than 64 entries, do nothing.
  2. Protect the 8 most recently used entries (`last_used`).
  3. Among the rest, evict the least recently used exited process if one exists. Otherwise evict the least recently used live process.
  4. Skip any candidate whose interaction lock is held. If a locked exited process is found and the next candidate is live, give up for this round so a live process is not evicted because an exited one is briefly locked. The store can then exceed 64 temporarily.
- The evicted process is `terminate()`d (`process_manager.rs:1233-1235`). A later poll gets "Unknown process id".
- `last_used` is set at start and on each prepared handle (`process_manager.rs:1167`). It is read only by pruning (`mod.rs:204`; `process_manager.rs:1730, 1773, 1781`). There is no idle timeout or TTL. A background process runs until it exits, is evicted, or is killed by the host.

### 6.4 Memory bound

Per process: up to 1 MiB in `pending` and 1 MiB in `transcript`, plus pipe buffers. Derived worst case for 64 sessions: about 128 MiB retained buffer memory, plus overflow when the soft cap is exceeded. This is my arithmetic from the constants, not measured.

---

## 7. Design rationale in the code

Explicit comments are sparse. No doc explains the specific numbers (10 s, 250 ms, 5 s, 30 s, 300 s, 64 sessions, 1 MiB). The checkout's docs contain no unified-exec design note beyond a changelog line.

Relevant comments, verbatim where quoted:

- `errors.rs:12` and `write_stdin.rs:27`: "The model is trained on `session_id`, but internally we track a `process_id`." The model-facing name is kept for compatibility with training.
- `write_stdin.rs:145-148`: "`write_stdin` is transport for an existing exec session. Empty writes are background polls, and non-empty writes continue a command that already ran PreToolUse as Bash, so do not emit a second pre hook here."
- `process_manager.rs:1014-1017`: "Empty polls use configurable background timeout bounds. Non-empty writes keep a fixed max cap so interactive stdin remains responsive."
- `process_manager.rs:886-888`: "Different terminal sessions can be polled concurrently, but reads and writes against one terminal must not overlap because they share a draining output buffer and process lifecycle."
- `process_manager.rs:993-994`: "Give the remote process a brief window to react so that we are more likely to capture its output in the poll below."
- `process_manager.rs:597-598`: "Persist live sessions before the initial yield wait so interrupting the turn cannot drop the last Arc and terminate the background process."
- `process_manager.rs:1745-1747`: "The store may temporarily exceed its soft cap while an exited process is publishing its terminal event. Do not evict a live process just because that exited process is briefly locked."
- `process_manager.rs:1749-1750`: "Do not prune processes while write_stdin or terminal event publication holds their interaction lock."
- `exec_command.rs:458-459`: "Sandbox denial is terminal, so there is no live process for write_stdin to resume."
- `mod.rs:75`: "Minimum yield time for an empty `write_stdin`."
- `config/src/config_toml.rs:342`: "Maximum poll window for background terminal output (`write_stdin`), in milliseconds. Default: `300000` (5 minutes)."
- `head_tail_buffer.rs:5-8`: head/tail split "symmetric meaning 50% of the capacity is allocated to the head and 50% is allocated to the tail", which keeps both the start of a command's output and the most recent output.
- `process.rs:61-62`: "Output pending model polling and the retained completion transcript. Append both under the same lock so cancellation cannot split an update."

---

## 8. Relevant to exec_python / wait design

### 8.1 The closest precedent is code-mode, not unified exec

Codex's code-mode runtime runs JavaScript with an `exec` tool and a `wait` tool. It is the nearest analogue to `exec_python` and `wait`.

- Yield signal text: `core/src/tools/code_mode/mod.rs:305` produces `Script running with cell ID {cell_id}`. Other statuses are `Script terminated` (`:307`), `Script completed` (`:310`), and `Script failed` (`:312`).
- Model instructions for `wait` (`code-mode-protocol/src/description.rs:48-55`):
  - "Use `wait` only after `exec` returns `Script running with cell ID ...`."
  - "`yield_time_ms` controls how long to wait for more output before yielding again. Defaults to 10000 ms."
  - "`max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens."
  - "`terminate: true` stops the running cell; false or omitted waits for output."
  - "`wait` returns only the new output since the last yield, or the final completion or termination result for that cell."
  - "If the cell has already finished, `wait` returns the completed result and closes the cell."
- `exec` description (`description.rs:31-32`): `yield_time_ms` asks `exec` to yield early if still running (default `DEFAULT_EXEC_YIELD_TIME_MS`), and `max_output_tokens` sets the budget.
- Defaults: `code-mode-protocol/src/runtime.rs:15-16` set both exec and wait yields to 10000 ms.
- Wait schema (`core/src/tools/code_mode/wait_spec.rs:6-69`): `cell_id` required; `yield_time_ms` (default 10000); `max_tokens` (default 10000); `terminate` boolean. The name `max_tokens` differs from exec_command's `max_output_tokens`.
- Wait handler (`core/src/tools/code_mode/wait_handler.rs:27-40, 127-145`): `terminate: true` calls `code_mode_service.terminate(cell_id)`. Otherwise it calls `wait` with the yield.
- Yield grace (`code-mode-runtime/src/service.rs:29-30, 201-213`): when yield is at least 10 s, 1 s of grace is added. An optional max-yield limit from the session caps this.
- Missing cell: `exec cell {cell_id} not found` (`code-mode-runtime/src/service.rs:414-420`). I found no per-runtime cell-count cap in this path, only `max_yield_time_ms`.
- `yield_control()` lets JS yield output immediately while the script keeps running (`description.rs:47`).

### 8.2 Design observations

1. Drain-on-read output with no cursor. If `wait` should return "only new output", the drain is the mechanism. Codex's chunk ID is not a cursor. A design needing resumable reads would need its own sequence numbers.
2. The yield is a timer cut short only by exit. Codex does not return early when output appears. If `wait` is meant to return on first output, that is a deliberate departure.
3. Exit is reported only on a poll. A `wait` design should make the terminal state explicit in its response, since the model may not poll after the process ends.
4. Output may be lost if a call is cancelled. `collect_output_until_deadline` moves output out of `pending` into a local buffer that is returned only on completion. If the future is dropped mid-collect, the drained bytes are dropped with it. This is inferred from code structure. I did not find a test for it.
5. Empty-poll defaults are not what the schema text implies. Omitting `yield_time_ms` on an empty poll waits 5 s, not 300 s. Non-empty writes default to 250 ms. Any design should state the effective default in the description.
6. Killing needs an explicit path. Codex's exec tools have none for the model, and host termination is RPC or TUI only. The code-mode `wait` with `terminate: true` is the precedent for model-side termination.
7. Pipes versus PTY is a real choice. Pipe mode rejects all stdin except Ctrl-C. Python REPL-style use needs a PTY, or a protocol that writes code directly rather than raw bytes.
8. Caps to copy or consciously change: 1 MiB head+tail per stream with a "... N bytes omitted ..." marker; approx 4 bytes per token; 10000-token default budget clamped by model policy; 64-session soft cap with LRU eviction that terminates the victim silently; 8-entry MRU protection.

## 9. Caveats

- All findings come from reading source. I did not build or run Codex.
- Some line numbers are approximate where marked with "around" or "~". The function and file references are exact.
- The approx 128 MiB figure in section 6.4 is arithmetic from the constants, not a measurement.
