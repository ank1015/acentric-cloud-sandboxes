// Daytona: a REST control plane and the toolbox API inside each sandbox,
// reached through `toolboxProxyUrl`. Written from the docs, the OpenAPI specs,
// the v0.190.0 source and live calls (2026-10-12). See docs/research/daytona.md.

export interface DaytonaCredentials {
  /** An organization API key, sent as `Authorization: Bearer`. */
  readonly apiKey: string;
  /** The control plane, for self-hosted Daytona. Default `https://app.daytona.io/api`. */
  readonly apiUrl?: string;
}

/**
 * A process started through `POST /process/execute`, which detached itself
 * from that call.
 */
export interface DaytonaExecution {
  /** The OS process ID of the execution's supervisor. */
  readonly pid: number;
}

export interface DaytonaSpec {
  readonly credentials: DaytonaCredentials;
  readonly native: DaytonaExecution;
}
