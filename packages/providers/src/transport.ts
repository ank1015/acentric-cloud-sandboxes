import { SandboxError, type SandboxErrorKind } from '@acentric-sandboxes/contracts';

/** Error bodies are cut to this before reaching callers. */
const MAX_ERROR_CHARS = 4096;
/** Workers' `fetch` sends none, and Blaxel's edge refuses requests without one. */
const USER_AGENT = 'acentric-sandboxes';

export interface HttpRequest {
  readonly provider: string;
  /** Names the call in messages, e.g. `E2B sandbox lookup`. */
  readonly label: string;
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Context for errors. */
  readonly sandboxId?: string | undefined;
  /** Reads a non-2xx answer's body into an error; `statusError` by default. */
  readonly httpError?: ((answer: HttpAnswer) => SandboxError) | undefined;
}

export interface HttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON body, or the text body cut to a few KiB. */
  readonly body: unknown;
}

/**
 * One HTTP attempt, never retried. `use` reads the 2xx response; the call is
 * aborted once it returns, so a stream it leaves unread is closed. Every
 * failure becomes a `SandboxError`.
 */
export async function request<T>(
  call: HttpRequest,
  use: (response: Response) => Promise<T>,
): Promise<T> {
  const { provider, label, signal, sandboxId } = call;
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(new SandboxError(`${label} was cancelled.`, { provider, kind: 'cancelled' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new SandboxError(`${label} timed out.`, { provider, sandboxId, kind: 'timeout' }),
      ),
    call.timeoutMs,
  );
  try {
    controller.signal.throwIfAborted();
    // Called unbound: some runtimes throw "Illegal invocation" for fetch with a foreign `this`.
    const fetchFn = call.fetch ?? globalThis.fetch;
    const response = await fetchFn(call.url, {
      method: call.method,
      headers: { 'user-agent': USER_AGENT, ...call.headers },
      ...(call.body !== undefined ? { body: call.body as BodyInit } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      const text = await response.text();
      const answer = { status: response.status, headers: response.headers, body: parseBody(text) };
      throw (call.httpError ?? ((a: HttpAnswer) => statusError(call, a)))(answer);
    }
    return await use(response);
  } catch (error) {
    if (controller.signal.aborted && SandboxError.is(controller.signal.reason)) {
      throw controller.signal.reason;
    }
    if (SandboxError.is(error)) throw error;
    throw new SandboxError(`${label} could not be reached.`, {
      provider,
      sandboxId,
      kind: 'network_error',
      nativeError: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** A JSON request answered with JSON. */
export function requestJson(call: HttpRequest): Promise<unknown> {
  return request(call, async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new SandboxError(`${call.label} returned invalid JSON.`, {
        provider: call.provider,
        sandboxId: call.sandboxId,
        kind: 'invalid_response',
        httpStatus: response.status,
        nativeError: text.slice(0, MAX_ERROR_CHARS),
      });
    }
  });
}

const KIND_BY_STATUS: Readonly<Record<number, SandboxErrorKind>> = {
  400: 'invalid_request',
  401: 'auth',
  402: 'quota_exceeded',
  403: 'auth',
  404: 'not_found',
  408: 'timeout',
  409: 'conflict',
  422: 'invalid_request',
  429: 'rate_limited',
  502: 'sandbox_unavailable',
  503: 'sandbox_unavailable',
  504: 'timeout',
};

/** An error for a provider's non-2xx answer, from its status and message. */
export function statusError(
  call: Pick<HttpRequest, 'provider' | 'label' | 'sandboxId'>,
  { status, headers, body }: HttpAnswer,
  kind: SandboxErrorKind = KIND_BY_STATUS[status] ??
    (status >= 500 ? 'provider_error' : 'invalid_request'),
): SandboxError {
  const detail = messageOf(body);
  return new SandboxError(`${call.label} failed (${status})${detail ? `: ${detail}` : '.'}`, {
    provider: call.provider,
    sandboxId: call.sandboxId,
    kind,
    httpStatus: status,
    providerError: body,
    providerCode: codeOf(body),
    retryAfterMs: retryAfter(headers),
    requestId: headers.get('x-request-id') ?? undefined,
  });
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_ERROR_CHARS);
  }
}

function messageOf(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim().slice(0, 500) || undefined;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value) return value;
      if (value && typeof value === 'object') {
        const nested = messageOf(value);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

/** `code`, or `error.code` when the error is an object. */
function codeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { code, error } = body as Record<string, unknown>;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return error && typeof error === 'object' ? codeOf(error) : undefined;
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Waits `ms`; a cancelled call ends the wait with a `cancelled` error. */
export function sleep(
  ms: number,
  provider: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SandboxError('The call was cancelled.', { provider, kind: 'cancelled' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new SandboxError('The call was cancelled.', { provider, kind: 'cancelled' }));
      },
      { once: true },
    );
  });
}
