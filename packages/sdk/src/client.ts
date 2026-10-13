import {
  ROUTES,
  SandboxError,
  type ErrorResponse,
  type Provider,
  type SandboxErrorData,
} from '@acentric-sandboxes/contracts';
import { callSignal, checkTimeout, prepare } from './prepare.ts';
import type { CallOptions, ExecutionClient, SavedCredentials } from './types.ts';

/** The gateway acentric runs. */
export const DEFAULT_BASE_URL = 'https://execution.cloud.acentric.dev';

export interface ClientOptions<K extends Provider = never> {
  /** The gateway's origin. Default `DEFAULT_BASE_URL`; e.g. `http://localhost:8787` for a local one. */
  readonly baseUrl?: string;
  /** Credentials per provider, e.g. keys a user entered once. */
  readonly credentials?: SavedCredentials<K>;
  /** A `fetch` to use instead of the global one. */
  readonly fetch?: typeof fetch;
  /** Extra headers on every gateway request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Limit for each call, covering the whole exchange. */
  readonly timeoutMs?: number;
}

/** A client of the gateway. Stateless: one HTTP request per call, never retried. */
export function createClient<K extends Provider = never>(
  options: ClientOptions<K> = {},
): ExecutionClient<K> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const saved: Partial<SavedCredentials> = options.credentials ?? {};
  checkTimeout(options.timeoutMs);

  async function send(
    route: string,
    input: { readonly provider: Provider; readonly credentials?: unknown },
    call: CallOptions = {},
  ): Promise<never> {
    const request = prepare(input, saved);
    const timeoutMs = call.timeoutMs ?? options.timeoutMs;
    checkTimeout(timeoutMs);
    const { signal, done } = callSignal(call.signal, timeoutMs);
    try {
      // Called unbound: some browsers throw "Illegal invocation" for fetch with a foreign `this`.
      const fetchFn = options.fetch ?? globalThis.fetch;
      const response = await fetchFn(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      const body = parseJson(await response.text(), response.status);
      if (!response.ok) throw gatewayError(response.status, body);
      return body as never;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (SandboxError.is(error)) throw error;
      throw new SandboxError('Could not reach the gateway.', {
        kind: 'network_error',
        nativeError: error,
      });
    } finally {
      done();
    }
  }

  return {
    start: (input, call) => send(ROUTES.start, input, call),
    wait: (input, call) => send(ROUTES.wait, input, call),
    kill: (input, call) => send(ROUTES.kill, input, call),
    list: (input, call) => send(ROUTES.list, input, call),
    delete: (input, call) => send(ROUTES.delete, input, call),
    deleteAll: (input, call) => send(ROUTES.deleteAll, input, call),
  };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SandboxError(`baseUrl must be an absolute URL: ${value}`, {
      kind: 'invalid_request',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SandboxError('baseUrl must use https, or http for local development.', {
      kind: 'invalid_request',
    });
  }
  return url.href.replace(/\/+$/, '');
}

function parseJson(text: string, status: number): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new SandboxError(`The gateway answered HTTP ${status} without JSON.`, {
      kind: 'invalid_response',
      nativeError: text.slice(0, 4096),
    });
  }
}

/** The gateway's `SandboxError`, rebuilt; anything else (a proxy's page) is an invalid response. */
function gatewayError(status: number, body: unknown): SandboxError {
  const error = (body as Partial<ErrorResponse> | undefined)?.error as
    Partial<SandboxErrorData> | undefined;
  if (typeof error?.message === 'string' && typeof error.kind === 'string') {
    return SandboxError.fromJSON({ retryable: false, ...error } as SandboxErrorData);
  }
  return new SandboxError(`The gateway answered HTTP ${status} without an error body.`, {
    kind: 'invalid_response',
    nativeError: body,
  });
}
