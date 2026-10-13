import type { Credentials, NativeExecution, Provider } from './providers.ts';

/**
 * A started execution: everything the stateless gateway needs to find it
 * again. Returned by `start`; send it back to `wait` and `kill`. Holds no
 * secrets and no cursor.
 */
export type ExecutionHandle<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly sandboxId: string;
      /** The caller's execution ID. Its files are in `<EXECUTIONS_DIR>/<id>` in the sandbox. */
      readonly id: string;
      /** When the wrapper started, as an ISO 8601 timestamp. */
      readonly startedAt: string;
      /** The provider's own references to the process. */
      readonly native: NativeExecution<P>;
    }
  : never;

/**
 * Body of `POST /v1/executions/start`. Launches the code in the background
 * and returns without waiting; `wait` collects the output. A stopped or
 * paused sandbox is woken first.
 */
export type StartRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      /** The caller's own credentials. Forwarded to the provider only; never stored or logged. */
      readonly credentials: Credentials<P>;
      /** E2B and Daytona sandbox ID, Blaxel sandbox name, Tensorlake sandbox ID or name. */
      readonly sandboxId: string;
      /**
       * Chosen by the caller, matching `EXECUTION_ID_PATTERN`; unique within
       * the sandbox. A retry with the same ID and code returns the execution
       * already started instead of running the code again; with other code it
       * is a `conflict`.
       */
      readonly id: string;
      /** Python source, at most `MAX_CODE_BYTES` as UTF-8. Sent inside the launch command. */
      readonly code: string;
      /** Added to the sandbox's environment for this execution. */
      readonly env?: Readonly<Record<string, string>>;
      /** Working directory. Default: the sandbox user's home directory. */
      readonly cwd?: string;
      /** The interpreter command. Default `python3`. */
      readonly python?: string;
      /** Kills the code after this long. Without it there is no limit beyond the sandbox's own. */
      readonly maxRuntimeMs?: number;
    }
  : never;

export type StartResponse<P extends Provider = Provider> = P extends Provider
  ? {
      readonly execution: ExecutionHandle<P>;
      /** `false` when this ID had already been started, so nothing new ran. */
      readonly created: boolean;
    }
  : never;

/**
 * How output longer than `maxOutputBytes` is cut.
 *
 * - `middle` keeps the first and last halves and skips the rest, with a line
 *   `... N bytes omitted ...` in their place; `nextCursor` moves to the end,
 *   and the skipped bytes stay readable from `cursor`.
 * - `head` keeps the first `maxOutputBytes`; `nextCursor` stops after them, for
 *   reading the whole output page by page.
 */
export type Truncation = 'middle' | 'head';

/**
 * Body of `POST /v1/executions/wait`. Waits until the execution ends or
 * `yieldMs` passes, then returns the output after `cursor`. Always safe to
 * retry: the same cursor returns the same bytes.
 */
export type WaitRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly credentials: Credentials<P>;
      readonly execution: ExecutionHandle<P>;
      /** Byte offset into the output: 0 the first time, then the last `nextCursor`. */
      readonly cursor: number;
      /**
       * How long to wait for the execution to end, at most `MAX_YIELD_MS`.
       * Default `DEFAULT_YIELD_MS`; 0 reads what is there. Returns at once
       * when the execution has ended, and, with `truncate: 'head'`, as soon as
       * `maxOutputBytes` of new output is there. New output alone does not end
       * a `middle` wait, so its tail is the latest output.
       */
      readonly yieldMs?: number;
      /** Default `DEFAULT_MAX_OUTPUT_BYTES`, at most `MAX_OUTPUT_BYTES`. */
      readonly maxOutputBytes?: number;
      /** Default `middle`. */
      readonly truncate?: Truncation;
    }
  : never;

/**
 * - `running`: still running.
 * - `exited`: Python ended by itself; see `exitCode`.
 * - `killed`: ended by `kill` or by a signal; see `signal`, or `exitCode` when
 *   it handled the signal and exited.
 * - `timed_out`: killed after `maxRuntimeMs`.
 * - `lost`: gone without a recorded end, e.g. the sandbox restarted.
 */
export type ExecutionStatus = 'running' | 'exited' | 'killed' | 'timed_out' | 'lost';

/** Answer of `wait` and `kill`: the execution's state and its output after `cursor`. */
export type ExecutionResult<P extends Provider = Provider> = P extends Provider
  ? {
      readonly execution: ExecutionHandle<P>;
      readonly status: ExecutionStatus;
      /** Set when Python ended with a code. */
      readonly exitCode?: number;
      /** Set when Python was ended by a signal, e.g. `SIGKILL`. */
      readonly signal?: string;
      /** The output from `cursor`, as UTF-8; never split inside a character. */
      readonly output: string;
      /** Where `output` starts, in bytes. */
      readonly cursor: number;
      /** The cursor for the next call. */
      readonly nextCursor: number;
      /** Bytes skipped inside `output` by `middle` truncation; 0 otherwise. */
      readonly omittedBytes: number;
      /** All output so far, in bytes. More is unread while `nextCursor < outputBytes`. */
      readonly outputBytes: number;
      /** From `startedAt` to the end of the execution, or to now while it runs. */
      readonly runtimeMs: number;
    }
  : never;

/**
 * Body of `POST /v1/executions/kill`. Sends SIGTERM to the execution's process
 * group, SIGKILL after `graceMs` if it is still running, and answers like
 * `wait` with the final output after `cursor`. An execution that has already
 * ended is left as it is, with its own status.
 */
export type KillRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly credentials: Credentials<P>;
      readonly execution: ExecutionHandle<P>;
      readonly cursor: number;
      /** Default `DEFAULT_GRACE_MS`, at most `MAX_GRACE_MS`. */
      readonly graceMs?: number;
      readonly maxOutputBytes?: number;
      readonly truncate?: Truncation;
    }
  : never;

/**
 * Body of `POST /v1/executions/list`: every execution in the sandbox whose
 * files are still there, running or not. For a caller that lost its handles.
 */
export type ListRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly credentials: Credentials<P>;
      readonly sandboxId: string;
    }
  : never;

/** One execution in a `list`: its state, without output. */
export type ExecutionSummary<P extends Provider = Provider> = P extends Provider
  ? {
      readonly execution: ExecutionHandle<P>;
      readonly status: ExecutionStatus;
      readonly exitCode?: number;
      readonly signal?: string;
      readonly outputBytes: number;
      readonly runtimeMs: number;
    }
  : never;

export type ListResponse<P extends Provider = Provider> = P extends Provider
  ? {
      /** Oldest first. */
      readonly executions: readonly ExecutionSummary<P>[];
    }
  : never;

/**
 * Body of `POST /v1/executions/delete`: removes one execution's files. An
 * execution still running is a `conflict`; kill it first.
 */
export type DeleteRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly credentials: Credentials<P>;
      readonly sandboxId: string;
      readonly id: string;
    }
  : never;

export interface DeleteResponse {
  /** `false` when there was nothing to delete. */
  readonly deleted: boolean;
}

/**
 * Body of `POST /v1/executions/delete-all`: removes the files of every
 * finished execution in the sandbox. Running executions are kept.
 */
export type DeleteAllRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly credentials: Credentials<P>;
      readonly sandboxId: string;
    }
  : never;

export interface DeleteAllResponse {
  /** IDs of the executions removed. */
  readonly deleted: readonly string[];
  /** IDs of the executions kept because they are still running. */
  readonly running: readonly string[];
}
