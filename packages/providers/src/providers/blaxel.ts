// Blaxel. The control plane (`https://api.blaxel.ai/v0`) finds the sandbox and
// its URL; commands run through the sandbox API's `POST /process` (`sh -c`).
// A sandbox in standby wakes on any request. Without `keepAlive` a process is
// frozen with the sandbox about 15 s after the last request, so the agent's
// `start` runs with it and holds the sandbox awake until Python ends.
// See docs/research/blaxel.md.

import { SandboxError, type BlaxelCredentials } from '@acentric-sandboxes/contracts';
import type { CallOptions, ProviderAdapter, Sandbox } from '../adapter.ts';
import { fromBase64 } from '../output.ts';
import { object, only, string } from '../parse.ts';
import { quote } from '../shell.ts';
import { request, requestJson, sleep, statusError, type HttpAnswer } from '../transport.ts';

const PROVIDER = 'blaxel';
const API_URL = 'https://api.blaxel.ai/v0';
const LOOKUP_TIMEOUT_MS = 30_000;
/** A sandbox that is still being deployed. */
const DEPLOY_TIMEOUT_MS = 120_000;
/** Until the started command prints its first line. */
const LAUNCH_TIMEOUT_MS = 60_000;

/** Deployment statuses that end in `DEPLOYED` without help. */
const SETTLING = new Set(['CREATED', 'UPLOADING', 'BUILDING', 'DEPLOYING']);

interface SandboxInfo {
  readonly status?: string;
  readonly metadata?: { readonly url?: string };
}

/** What `POST /process` answers once a command has ended. */
interface ProcessInfo {
  readonly status?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** One record of the NDJSON stream of `POST /process`. */
interface StreamEvent {
  readonly type?: string;
  readonly data?: string;
  readonly encoding?: string;
}

export const blaxel: ProviderAdapter<'blaxel'> = {
  id: PROVIDER,
  // The edge holds requests past 60 s; this keeps each one short anyway.
  maxHoldMs: 50_000,
  detach: false,

  parseCredentials(value): BlaxelCredentials {
    const credentials = object(value, 'credentials');
    only(credentials, 'credentials', ['apiKey', 'workspace']);
    return {
      apiKey: string(credentials.apiKey, 'credentials.apiKey'),
      ...(credentials.workspace !== undefined
        ? { workspace: string(credentials.workspace, 'credentials.workspace') }
        : {}),
    };
  },

  async open(credentials, sandboxId, options) {
    const headers = {
      authorization: `Bearer ${credentials.apiKey}`,
      ...(credentials.workspace ? { 'x-blaxel-workspace': credentials.workspace } : {}),
    };
    const lookup = async () =>
      (await requestJson({
        provider: PROVIDER,
        label: 'Blaxel sandbox lookup',
        sandboxId,
        url: `${API_URL}/sandboxes/${encodeURIComponent(sandboxId)}`,
        method: 'GET',
        headers,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        signal: options.signal,
        fetch: options.fetch,
        httpError: (answer) => blaxelError('Blaxel sandbox lookup', sandboxId, answer),
      })) as SandboxInfo;

    const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      const info = await lookup();
      const status = info.status ?? 'unknown';
      const url = info.metadata?.url;
      if (status === 'DEPLOYED' && url) {
        return new BlaxelSandbox(url.replace(/\/+$/, ''), sandboxId, headers, options);
      }
      if (!SETTLING.has(status)) {
        throw new SandboxError(`Blaxel sandbox ${sandboxId} is ${status}.`, {
          provider: PROVIDER,
          sandboxId,
          kind: 'sandbox_unavailable',
        });
      }
      if (Date.now() >= deadline) {
        throw new SandboxError(
          `Blaxel sandbox ${sandboxId} was not deployed in time (${status}).`,
          {
            provider: PROVIDER,
            sandboxId,
            kind: 'sandbox_unavailable',
          },
        );
      }
      await sleep(Math.min(500 * 2 ** attempt, 3_000), PROVIDER, options.signal);
    }
  },

  native: ({ pid }) => ({ pid }),
};

class BlaxelSandbox implements Sandbox {
  private readonly url: string;
  private readonly sandboxId: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly options: CallOptions;

  constructor(
    url: string,
    sandboxId: string,
    headers: Readonly<Record<string, string>>,
    options: CallOptions,
  ) {
    this.url = url;
    this.sandboxId = sandboxId;
    this.headers = headers;
    this.options = options;
  }

  /**
   * Streams the process's events and resolves with its first line. `keepAlive`
   * holds the sandbox out of standby while the process runs; `timeout: 0`
   * turns off the auto-kill that otherwise comes with it.
   */
  launch(argv: readonly string[]): Promise<string> {
    const label = 'Blaxel command start';
    const sandboxId = this.sandboxId;
    return request(
      {
        ...this.call(label, LAUNCH_TIMEOUT_MS),
        headers: {
          ...this.headers,
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
        },
        body: JSON.stringify({ command: command(argv), keepAlive: true, timeout: 0 }),
      },
      async (response) => {
        let stdout = '';
        const decoder = new TextDecoder();
        for await (const event of records(response, label, sandboxId)) {
          if (event.type === 'stdout' && event.data) {
            stdout +=
              event.encoding === 'base64'
                ? decoder.decode(fromBase64(event.data), { stream: true })
                : event.data;
            if (stdout.includes('\n')) return stdout.slice(0, stdout.indexOf('\n'));
          } else if (event.type === 'error') {
            throw new SandboxError(`${label} failed: ${event.data ?? 'unknown error'}`, {
              provider: PROVIDER,
              sandboxId,
              kind: 'provider_error',
            });
          } else if (event.type === 'result') {
            throw failed(label, sandboxId, parseResult(event.data, label, sandboxId));
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

  /** Runs the command to its end; the sandbox API kills it at `timeout`. */
  async run(
    argv: readonly string[],
    { timeoutMs }: { readonly timeoutMs: number },
  ): Promise<string> {
    const label = 'Blaxel command';
    const answer = (await requestJson({
      ...this.call(label, timeoutMs + 10_000),
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        command: command(argv),
        waitForCompletion: true,
        timeout: Math.ceil(timeoutMs / 1000),
      }),
    })) as ProcessInfo;
    if ((answer.exitCode ?? 0) === 0 && answer.status === 'completed') return answer.stdout ?? '';
    throw failed(label, this.sandboxId, answer);
  }

  private call(label: string, timeoutMs: number) {
    const sandboxId = this.sandboxId;
    return {
      provider: PROVIDER,
      label,
      sandboxId,
      url: `${this.url}/process`,
      method: 'POST' as const,
      timeoutMs,
      signal: this.options.signal,
      fetch: this.options.fetch,
      httpError: (answer: HttpAnswer) => blaxelError(label, sandboxId, answer),
    };
  }
}

/** The command line for the sandbox API's `sh -c`. */
function command(argv: readonly string[]): string {
  return argv.map(quote).join(' ');
}

function parseResult(data: string | undefined, label: string, sandboxId: string): ProcessInfo {
  try {
    return JSON.parse(data ?? '') as ProcessInfo;
  } catch {
    throw new SandboxError(`${label} sent an unreadable result.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_response',
    });
  }
}

function failed(label: string, sandboxId: string, info: ProcessInfo): SandboxError {
  const code = info.exitCode ?? -1;
  const detail = (info.stderr || info.stdout || '').trim().slice(-1000);
  if (code === 127 && /python3/.test(detail)) {
    return new SandboxError(`Blaxel sandbox ${sandboxId} has no python3.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_request',
    });
  }
  return new SandboxError(
    `${label} failed (${info.status ?? 'unknown'}, exit code ${code})${detail ? `: ${detail}` : '.'}`,
    {
      provider: PROVIDER,
      sandboxId,
      kind: 'provider_error',
      providerError: { status: info.status, exitCode: code, output: detail },
    },
  );
}

/** Platform errors come as `{error: {code, message}}`, the sandbox API's as `{error}`. */
function blaxelError(label: string, sandboxId: string, answer: HttpAnswer): SandboxError {
  const body = answer.body as { error?: unknown } | undefined;
  const call = { provider: PROVIDER, label, sandboxId };
  if ((body?.error as { code?: unknown } | undefined)?.code === 'WORKLOAD_UNAVAILABLE') {
    return statusError(call, answer, 'sandbox_unavailable');
  }
  // The sandbox API's own deadline, which every command is given.
  if (typeof body?.error === 'string' && /^process timed out/.test(body.error)) {
    return statusError(call, answer, 'timeout');
  }
  return statusError(call, answer);
}

const MAX_RECORD_CHARS = 16 * 1024 * 1024;

/** The records of an NDJSON response, however the bytes are split. */
export async function* records(
  response: Response,
  label: string,
  sandboxId: string,
): AsyncGenerator<StreamEvent> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) return;
  let buffer = '';
  try {
    for (;;) {
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield record(line, label, sandboxId);
      }
      if (buffer.length > MAX_RECORD_CHARS) {
        throw new SandboxError(`${label} sent a record of over ${MAX_RECORD_CHARS} characters.`, {
          provider: PROVIDER,
          sandboxId,
          kind: 'invalid_response',
        });
      }
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) yield record(buffer, label, sandboxId);
        return;
      }
      buffer += value;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function record(line: string, label: string, sandboxId: string): StreamEvent {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    throw new SandboxError(`${label} sent an unreadable record.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_response',
    });
  }
}
