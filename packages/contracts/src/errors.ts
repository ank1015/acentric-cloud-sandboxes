/** Whether each kind is worth retrying when the error does not say otherwise. */
const RETRYABLE_BY_DEFAULT = {
  /** The gateway or the provider refused the request. */
  invalid_request: false,
  /** Credentials missing, invalid or not permitted. */
  auth: false,
  /** No such sandbox or execution. */
  not_found: false,
  /**
   * The request clashes with what is already in the sandbox: an execution ID
   * reused for different code, or a delete of an execution still running.
   */
  conflict: false,
  /** Throttled; see `retryAfterMs`. */
  rate_limited: true,
  /** Out of credits, or over a plan limit such as concurrent sandboxes. */
  quota_exceeded: false,
  /** The sandbox could not be woken or reached, e.g. still starting, archived or failed. */
  sandbox_unavailable: true,
  /** Any other provider failure. */
  provider_error: true,
  /** The provider answered with something that cannot be read. */
  invalid_response: false,
  /** The provider or the gateway could not be reached. */
  network_error: true,
  /** The call took longer than allowed. */
  timeout: true,
  /** The caller aborted. */
  cancelled: false,
  /** A gateway bug. */
  internal_error: false,
} as const satisfies Record<string, boolean>;

export type SandboxErrorKind = keyof typeof RETRYABLE_BY_DEFAULT;

export const SANDBOX_ERROR_KINDS = Object.keys(RETRYABLE_BY_DEFAULT) as readonly SandboxErrorKind[];

/** The JSON form of a `SandboxError`, shared by the gateway and the SDK. */
export interface SandboxErrorData {
  readonly message: string;
  readonly kind: SandboxErrorKind;
  /** Whether retrying the same request may succeed. */
  readonly retryable: boolean;
  /** Absent for errors raised before a provider was chosen. */
  readonly provider?: string;
  readonly sandboxId?: string;
  readonly executionId?: string;
  readonly providerCode?: string;
  /** The provider's error object as received, or its text body, truncated. */
  readonly providerError?: unknown;
  /** The provider's HTTP status, not the gateway's. */
  readonly httpStatus?: number;
  /** The provider's requested delay before retrying. */
  readonly retryAfterMs?: number;
  /** The provider's request ID, for its support. */
  readonly requestId?: string;
}

type OptionalField = Exclude<keyof SandboxErrorData, 'message' | 'kind' | 'retryable'>;

/** Constructor options. An `undefined` value counts as absent. */
export type SandboxErrorOptions = {
  readonly [K in OptionalField]?: SandboxErrorData[K] | undefined;
} & {
  readonly kind: SandboxErrorKind;
  /** Defaults by kind. */
  readonly retryable?: boolean | undefined;
  /** Raw detail for local diagnostics. Never serialized. */
  readonly nativeError?: unknown;
};

const OPTIONAL_FIELDS = [
  'provider',
  'sandboxId',
  'executionId',
  'providerCode',
  'providerError',
  'httpStatus',
  'retryAfterMs',
  'requestId',
] as const satisfies readonly OptionalField[];

/** Every failure, from the gateway, the SDK or a provider. Retry policy is the caller's. */
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  readonly kind: SandboxErrorKind;
  readonly retryable: boolean;
  // `declare` keeps absent fields absent at runtime instead of own `undefined` properties.
  declare readonly provider?: string;
  declare readonly sandboxId?: string;
  declare readonly executionId?: string;
  declare readonly providerCode?: string;
  declare readonly providerError?: unknown;
  declare readonly httpStatus?: number;
  declare readonly retryAfterMs?: number;
  declare readonly requestId?: string;
  declare readonly nativeError?: unknown;

  constructor(message: string, options: SandboxErrorOptions) {
    super(message);
    this.kind = options.kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[options.kind] ?? false;
    for (const key of [...OPTIONAL_FIELDS, 'nativeError'] as const) {
      if (options[key] !== undefined) {
        Object.defineProperty(this, key, { value: options[key], enumerable: true });
      }
    }
  }

  /** The JSON form, without `nativeError` or the stack. */
  toJSON(): SandboxErrorData {
    const data: Record<string, unknown> = {
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
    };
    for (const key of OPTIONAL_FIELDS) if (this[key] !== undefined) data[key] = this[key];
    return data as unknown as SandboxErrorData;
  }

  static fromJSON({ message, ...options }: SandboxErrorData): SandboxError {
    return new SandboxError(message, options);
  }

  /** True for a `SandboxError` from any copy of this package. */
  static is(value: unknown): value is SandboxError {
    return (
      value instanceof SandboxError ||
      (value instanceof Error &&
        value.name === 'SandboxError' &&
        typeof (value as { kind?: unknown }).kind === 'string')
    );
  }
}
