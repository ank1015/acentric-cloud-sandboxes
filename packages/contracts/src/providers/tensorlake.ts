// Tensorlake: a REST control plane (`api.tensorlake.ai`) and a REST and SSE
// API inside each sandbox (`<sandbox>.sandbox.tensorlake.ai`). Written from
// the docs, the SDK source and live calls (2026-10-12); the daemon is not open
// source. See docs/research/tensorlake.md.

export interface TensorlakeCredentials {
  /** A project API key, sent as `Authorization: Bearer`. */
  readonly apiKey: string;
}

/**
 * A process started through `POST /api/v1/processes/run`, which detached
 * itself from that call.
 */
export interface TensorlakeExecution {
  /** The OS process ID of the execution's supervisor. */
  readonly pid: number;
}

export interface TensorlakeSpec {
  readonly credentials: TensorlakeCredentials;
  readonly native: TensorlakeExecution;
}
