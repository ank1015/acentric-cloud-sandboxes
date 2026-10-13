// E2B: a REST control plane (`api.<domain>`) and the `envd` daemon inside each
// sandbox (Connect RPC and `/files`). Written from the API reference and the
// E2B and infra sources (2026-10-12). See docs/research/e2b.md.

export interface E2bCredentials {
  /** A project API key, sent as `X-API-Key` to the control plane. */
  readonly apiKey: string;
  /** The E2B domain, for self-hosted or regional deployments. Default `e2b.app`. */
  readonly domain?: string;
}

/** A process started through envd's `Process/Start`. */
export interface E2bExecution {
  /** The OS process ID of the execution's supervisor. */
  readonly pid: number;
}

export interface E2bSpec {
  readonly credentials: E2bCredentials;
  readonly native: E2bExecution;
}
