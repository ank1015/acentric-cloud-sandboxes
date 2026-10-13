import type { Credentials, NativeExecution, Provider } from '@acentric-sandboxes/contracts';

export interface CallOptions {
  /** Aborts the provider calls. */
  readonly signal?: AbortSignal | undefined;
  /** A `fetch` to use instead of the global one, e.g. in tests. */
  readonly fetch?: typeof fetch | undefined;
}

/** A sandbox that is running, ready to take commands. */
export interface Sandbox {
  /**
   * Starts a command in the background and resolves with the first line it
   * prints. The command keeps running after that.
   */
  launch(argv: readonly string[]): Promise<string>;
  /** Runs a command to its end, at most `timeoutMs`, and resolves with its stdout. */
  run(argv: readonly string[], options: { readonly timeoutMs: number }): Promise<string>;
}

/** What each provider implements; the operations do the rest. */
export interface ProviderAdapter<P extends Provider = Provider> {
  readonly id: P;
  /** The longest one `run` may be held open, below any proxy's limit. */
  readonly maxHoldMs: number;
  /**
   * The provider has no background start, so `launch` runs a command to its
   * end; the agent's `start` then detaches itself from the call.
   */
  readonly detach: boolean;
  parseCredentials(value: unknown): Credentials<P>;
  /** Finds the sandbox and wakes it if it is stopped or paused. */
  open(credentials: Credentials<P>, sandboxId: string, options: CallOptions): Promise<Sandbox>;
  /** The provider's references to an execution, from what its supervisor recorded. */
  native(recorded: { readonly pid: number }): NativeExecution<P>;
}
