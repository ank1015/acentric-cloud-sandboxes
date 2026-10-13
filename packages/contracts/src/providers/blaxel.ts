// Blaxel: a REST control plane (`api.blaxel.ai`) and the sandbox API inside
// each sandbox, at the sandbox's own URL. Written from the docs, the
// sandbox-api source and live calls (2026-10-12). See docs/research/blaxel.md.

export interface BlaxelCredentials {
  /** An API key, sent as `Authorization: Bearer`. */
  readonly apiKey: string;
  /**
   * The workspace, sent as `X-Blaxel-Workspace`. A key made in a workspace
   * works without it; a key that reaches several workspaces needs it.
   */
  readonly workspace?: string;
}

/**
 * A process started through `POST /process` with `keepAlive`, which holds the
 * sandbox out of standby until it ends.
 */
export interface BlaxelExecution {
  /** The OS process ID of the execution's supervisor. */
  readonly pid: number;
}

export interface BlaxelSpec {
  readonly credentials: BlaxelCredentials;
  readonly native: BlaxelExecution;
}
