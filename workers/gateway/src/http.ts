import { SandboxError, type SandboxErrorKind } from '@acentric-sandboxes/contracts';

/** Code is at most 64 KiB; the rest of a request is small. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** An error the gateway raises itself, with its own HTTP status. */
export class HttpError extends SandboxError {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message, { kind: 'invalid_request' });
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Any origin may call the gateway. There are no cookies or ambient credentials:
 * the caller's own provider key is in the body, so `*` grants nothing extra.
 */
const CORS = { 'access-control-allow-origin': '*' } as const;

const STATUS_BY_KIND: Record<SandboxErrorKind, number> = {
  invalid_request: 400,
  auth: 401,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  sandbox_unavailable: 503,
  provider_error: 502,
  invalid_response: 502,
  network_error: 502,
  timeout: 504,
  cancelled: 499,
  internal_error: 500,
};

export function preflight(method: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'access-control-allow-methods': `${method}, OPTIONS`,
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': String(24 * 60 * 60),
    },
  });
}

/** Every JSON answer, errors included, is readable cross-origin and never cached. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...headers, ...CORS, 'cache-control': 'no-store' },
  });
}

/**
 * Any thrown value as an `ErrorResponse`. Unexpected errors are logged by name
 * only: messages and stacks may hold request content, which is never logged.
 */
export function errorResponse(cause: unknown): Response {
  if (!(cause instanceof SandboxError)) {
    console.error('Unexpected gateway error', cause instanceof Error ? cause.name : typeof cause);
    return json(
      {
        error: new SandboxError('The gateway failed unexpectedly.', { kind: 'internal_error' }),
      },
      500,
    );
  }
  if (cause instanceof HttpError) return json({ error: cause }, cause.status, cause.headers);
  const headers: Record<string, string> =
    cause.retryAfterMs !== undefined
      ? { 'retry-after': String(Math.ceil(cause.retryAfterMs / 1000)) }
      : {};
  return json({ error: cause }, STATUS_BY_KIND[cause.kind] ?? 500, headers);
}

/** Reads a JSON body, counting the bytes actually read rather than trusting Content-Length. */
export async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}

function tooLarge(): HttpError {
  return new HttpError(413, `The body exceeds ${MAX_REQUEST_BYTES} bytes.`);
}
