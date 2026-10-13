// E2B. The control plane (`https://api.<domain>`) finds the sandbox, wakes a
// paused one and hands out its envd access token; commands run through envd's
// `Process/Start`, a Connect server-streaming RPC (JSON messages in 5-byte
// envelopes over plain HTTP). See docs/research/e2b.md.

import { SandboxError, type E2bCredentials } from '@acentric-sandboxes/contracts';
import type { CallOptions, ProviderAdapter, Sandbox } from '../adapter.ts';
import { object, only, string } from '../parse.ts';
import { fromBase64 } from '../output.ts';
import { request, requestJson, statusError, type HttpAnswer } from '../transport.ts';

const PROVIDER = 'e2b';
const DEFAULT_DOMAIN = 'e2b.app';
const ENVD_PORT = 49983;
const LOOKUP_TIMEOUT_MS = 30_000;
/** Resuming a paused sandbox restores its memory; it can take a while. */
const RESUME_TIMEOUT_MS = 120_000;
/** Until the started command prints its first line. */
const LAUNCH_TIMEOUT_MS = 60_000;

interface SandboxInfo {
  readonly state?: string;
  readonly envdAccessToken?: string;
}

export const e2b: ProviderAdapter<'e2b'> = {
  id: PROVIDER,
  // envd streams stay open for long; this keeps each request short anyway.
  maxHoldMs: 50_000,
  detach: false,

  parseCredentials(value): E2bCredentials {
    const credentials = object(value, 'credentials');
    only(credentials, 'credentials', ['apiKey', 'domain']);
    return {
      apiKey: string(credentials.apiKey, 'credentials.apiKey'),
      ...(credentials.domain !== undefined
        ? { domain: string(credentials.domain, 'credentials.domain') }
        : {}),
    };
  },

  async open(credentials, sandboxId, options) {
    const domain = credentials.domain ?? DEFAULT_DOMAIN;
    const api = `https://api.${domain}`;
    const path = encodeURIComponent(sandboxId);
    const headers = { 'x-api-key': credentials.apiKey };
    const call = { provider: PROVIDER, sandboxId, signal: options.signal, fetch: options.fetch };
    const info = (await requestJson({
      ...call,
      label: 'E2B sandbox lookup',
      url: `${api}/sandboxes/${path}`,
      method: 'GET',
      headers,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      httpError: (answer) => controlPlaneError('E2B sandbox lookup', sandboxId, answer),
    })) as SandboxInfo;
    let token = info.envdAccessToken;
    if (info.state === 'paused') {
      // Connecting resumes it, and never shortens its timeout.
      const resumed = (await requestJson({
        ...call,
        label: 'E2B sandbox resume',
        url: `${api}/v2/sandboxes/${path}/connect`,
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
        timeoutMs: RESUME_TIMEOUT_MS,
        httpError: (answer) => controlPlaneError('E2B sandbox resume', sandboxId, answer),
      })) as SandboxInfo;
      token = resumed.envdAccessToken ?? token;
    } else if (info.state !== 'running') {
      throw new SandboxError(
        `E2B sandbox ${sandboxId} is ${info.state ?? 'in an unknown state'}.`,
        {
          provider: PROVIDER,
          sandboxId,
          kind: 'sandbox_unavailable',
        },
      );
    }
    return new E2bSandbox(`https://${ENVD_PORT}-${sandboxId}.${domain}`, sandboxId, token, options);
  },

  native: ({ pid }) => ({ pid }),
};

/** A malformed sandbox ID is a 400, an unknown or inaccessible one a 404. */
function controlPlaneError(label: string, sandboxId: string, answer: HttpAnswer): SandboxError {
  return statusError({ provider: PROVIDER, label, sandboxId }, answer);
}

/** Connect error codes, as envd sends them in an end-of-stream message or an error body. */
const KIND_BY_CODE = {
  canceled: 'cancelled',
  invalid_argument: 'invalid_request',
  deadline_exceeded: 'timeout',
  not_found: 'not_found',
  permission_denied: 'auth',
  unauthenticated: 'auth',
  resource_exhausted: 'rate_limited',
  unavailable: 'sandbox_unavailable',
} as const;

interface ProcessEvent {
  readonly start?: { readonly pid?: number };
  readonly data?: { readonly stdout?: string; readonly stderr?: string };
  readonly end?: {
    readonly exitCode?: number;
    readonly exited?: boolean;
    readonly status?: string;
    readonly error?: string;
  };
}

class E2bSandbox implements Sandbox {
  private readonly envd: string;
  private readonly sandboxId: string;
  private readonly token: string | undefined;
  private readonly options: CallOptions;

  constructor(envd: string, sandboxId: string, token: string | undefined, options: CallOptions) {
    this.envd = envd;
    this.sandboxId = sandboxId;
    this.token = token;
    this.options = options;
  }

  launch(argv: readonly string[]) {
    return this.process('E2B command start', argv, LAUNCH_TIMEOUT_MS, undefined, true);
  }

  run(argv: readonly string[], { timeoutMs }: { readonly timeoutMs: number }) {
    return this.process('E2B command', argv, timeoutMs, timeoutMs, false);
  }

  /** Starts `argv`; resolves with its first line (`firstLine`) or, once it ends, its stdout. */
  private process(
    label: string,
    argv: readonly string[],
    timeoutMs: number,
    deadlineMs: number | undefined,
    firstLine: boolean,
  ): Promise<string> {
    const sandboxId = this.sandboxId;
    const message = {
      process: { cmd: '/usr/bin/env', args: argv },
      stdin: false,
    };
    return request(
      {
        provider: PROVIDER,
        label,
        sandboxId,
        url: `${this.envd}/process.Process/Start`,
        method: 'POST',
        headers: {
          'content-type': 'application/connect+json',
          'connect-protocol-version': '1',
          'keepalive-ping-interval': '30',
          ...(this.token ? { 'x-access-token': this.token } : {}),
          // A deadline on Start also limits the process, so only commands that must end get one.
          ...(deadlineMs !== undefined ? { 'connect-timeout-ms': String(deadlineMs) } : {}),
        },
        body: envelope(message),
        timeoutMs: timeoutMs + 5_000,
        signal: this.options.signal,
        fetch: this.options.fetch,
        httpError: (answer) => envdError(label, sandboxId, answer),
      },
      async (response) => {
        let stdout = '';
        let stderr = '';
        const decoder = new TextDecoder();
        const errDecoder = new TextDecoder();
        for await (const { flags, data } of envelopes(response, label, sandboxId)) {
          if (flags & 2) {
            const error = (data as { error?: { code?: string; message?: string } }).error;
            if (error) throw connectError(label, sandboxId, error);
            break;
          }
          const event = (data as { event?: ProcessEvent }).event;
          if (event?.data?.stdout) {
            stdout += decoder.decode(fromBase64(event.data.stdout), { stream: true });
            if (firstLine && stdout.includes('\n')) return stdout.slice(0, stdout.indexOf('\n'));
          }
          if (event?.data?.stderr)
            stderr += errDecoder.decode(fromBase64(event.data.stderr), { stream: true });
          if (event?.end) {
            const code = event.end.exitCode ?? 0;
            if (code !== 0 || event.end.error || firstLine) {
              throw commandFailed(label, sandboxId, code, event.end, stderr || stdout);
            }
            return stdout + decoder.decode();
          }
        }
        throw new SandboxError(`${label} ended without a result.`, {
          provider: PROVIDER,
          sandboxId,
          kind: 'invalid_response',
        });
      },
    );
  }
}

function commandFailed(
  label: string,
  sandboxId: string,
  code: number,
  end: NonNullable<ProcessEvent['end']>,
  output: string,
): SandboxError {
  const detail = output.trim().slice(-1000);
  if (code === 127 && /python3/.test(detail)) {
    return new SandboxError(`E2B sandbox ${sandboxId} has no python3.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_request',
    });
  }
  return new SandboxError(
    `${label} failed (${end.error ?? end.status ?? `exit code ${code}`})${detail ? `: ${detail}` : '.'}`,
    {
      provider: PROVIDER,
      sandboxId,
      kind: 'provider_error',
      providerError: { ...end, output: detail },
    },
  );
}

function connectError(
  label: string,
  sandboxId: string,
  error: { code?: string; message?: string },
): SandboxError {
  const kind = KIND_BY_CODE[error.code as keyof typeof KIND_BY_CODE] ?? 'provider_error';
  return new SandboxError(`${label} failed: ${error.message ?? error.code ?? 'unknown error'}`, {
    provider: PROVIDER,
    sandboxId,
    kind,
    providerCode: error.code,
    providerError: error,
  });
}

function envdError(label: string, sandboxId: string, answer: HttpAnswer): SandboxError {
  const body = answer.body as { code?: unknown } | undefined;
  if (
    body &&
    typeof body === 'object' &&
    typeof body.code === 'string' &&
    body.code in KIND_BY_CODE
  ) {
    return statusError(
      { provider: PROVIDER, label, sandboxId },
      answer,
      KIND_BY_CODE[body.code as keyof typeof KIND_BY_CODE],
    );
  }
  return statusError({ provider: PROVIDER, label, sandboxId }, answer);
}

/** One Connect message: a flags byte, a big-endian length, the JSON. */
export function envelope(message: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

/** The Connect messages of a streaming response, however the bytes are split. */
export async function* envelopes(
  response: Response,
  label: string,
  sandboxId: string,
): AsyncGenerator<{ flags: number; data: unknown }> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      while (buffer.byteLength >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1, false);
        if (length > MAX_ENVELOPE_BYTES) {
          throw new SandboxError(`${label} sent a message of ${length} bytes.`, {
            provider: PROVIDER,
            sandboxId,
            kind: 'invalid_response',
          });
        }
        if (buffer.byteLength < 5 + length) break;
        const flags = buffer[0]!;
        const text = new TextDecoder().decode(buffer.subarray(5, 5 + length));
        buffer = buffer.slice(5 + length);
        yield { flags, data: text ? JSON.parse(text) : {} };
      }
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.byteLength) {
          throw new SandboxError(`${label} ended inside a message.`, {
            provider: PROVIDER,
            sandboxId,
            kind: 'invalid_response',
          });
        }
        return;
      }
      const joined = new Uint8Array(buffer.byteLength + value.byteLength);
      joined.set(buffer);
      joined.set(value, buffer.byteLength);
      buffer = joined;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
