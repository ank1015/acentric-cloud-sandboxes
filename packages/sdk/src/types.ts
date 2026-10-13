import type {
  Credentials,
  DeleteAllRequest,
  DeleteAllResponse,
  DeleteRequest,
  DeleteResponse,
  ExecutionResult,
  KillRequest,
  ListRequest,
  ListResponse,
  Provider,
  StartRequest,
  StartResponse,
  WaitRequest,
} from '@acentric-sandboxes/contracts';

/** Credentials saved on a client, for the providers in `K`. */
export type SavedCredentials<K extends Provider = Provider> = { readonly [P in K]: Credentials<P> };

/** A request whose `credentials` may be left out for providers whose credentials the client holds. */
export type Input<R, K extends Provider = never> = R extends {
  readonly provider: infer P extends Provider;
}
  ? Omit<R, 'credentials'> &
      ([P] extends [K]
        ? { readonly credentials?: Credentials<P> }
        : { readonly credentials: Credentials<P> })
  : never;

export type StartInput<K extends Provider = never> = Input<StartRequest, K>;
export type WaitInput<K extends Provider = never> = Input<WaitRequest, K>;
export type KillInput<K extends Provider = never> = Input<KillRequest, K>;
export type ListInput<K extends Provider = never> = Input<ListRequest, K>;
export type DeleteInput<K extends Provider = never> = Input<DeleteRequest, K>;
export type DeleteAllInput<K extends Provider = never> = Input<DeleteAllRequest, K>;

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Limit for this call, covering the whole exchange. A `wait` lasts up to its `yieldMs`. */
  readonly timeoutMs?: number;
}

/** The same client whether it calls the gateway or the providers directly. Never retries. */
export interface ExecutionClient<K extends Provider = never> {
  /** Starts Python in the sandbox and returns at once; `wait` collects the output. */
  start<const I extends StartInput<K>>(
    input: I,
    options?: CallOptions,
  ): Promise<StartResponse<I['provider']>>;
  /** Output from `cursor` on, once the execution ends or `yieldMs` passes. */
  wait<const I extends WaitInput<K>>(
    input: I,
    options?: CallOptions,
  ): Promise<ExecutionResult<I['provider']>>;
  /** Ends the execution (SIGTERM, then SIGKILL after `graceMs`) and returns its last output. */
  kill<const I extends KillInput<K>>(
    input: I,
    options?: CallOptions,
  ): Promise<ExecutionResult<I['provider']>>;
  /** Every execution the sandbox holds, oldest first. */
  list<const I extends ListInput<K>>(
    input: I,
    options?: CallOptions,
  ): Promise<ListResponse<I['provider']>>;
  /** Deletes a finished execution's files. */
  delete(input: DeleteInput<K>, options?: CallOptions): Promise<DeleteResponse>;
  /** Deletes the files of every finished execution in the sandbox. */
  deleteAll(input: DeleteAllInput<K>, options?: CallOptions): Promise<DeleteAllResponse>;
}
