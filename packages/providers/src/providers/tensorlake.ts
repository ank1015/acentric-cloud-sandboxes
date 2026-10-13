// Tensorlake. Every call goes straight to the sandbox's own host
// (`https://<id or name>.sandbox.tensorlake.ai`), which resumes a suspended
// sandbox by itself; the control plane is not needed. Commands run through
// `POST /api/v1/processes/run`, which streams the process's output lines and
// its end as server-sent events. There is no background start that answers
// with output, so the agent detaches itself. See docs/research/tensorlake.md.

import { SandboxError, type TensorlakeCredentials } from '@acentric-sandboxes/contracts';
import type { CallOptions, ProviderAdapter, Sandbox } from '../adapter.ts';
import { object, only, string } from '../parse.ts';
import { request, statusError, type HttpAnswer } from '../transport.ts';

const PROVIDER = 'tensorlake';
const SANDBOX_DOMAIN = 'sandbox.tensorlake.ai';
/** Until the detaching agent has handed over its first line. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** A sandbox ID or name, which is the first label of the sandbox's host. */
const SANDBOX_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** The daemon sends a longer line as several output events of this many bytes. */
const LINE_PIECE_BYTES = 16_384;

/** The `data` of one event of `processes/run`: its start, a line, or its end. */
interface RunEvent {
  readonly pid?: number;
  readonly line?: string;
  readonly stream?: string;
  readonly exit_code?: number | null;
  readonly signal?: number | null;
  readonly reason?: string;
}

export const tensorlake: ProviderAdapter<'tensorlake'> = {
  id: PROVIDER,
  // The proxy keeps streams open with comments every 15 s; this keeps each request short anyway.
  maxHoldMs: 50_000,
  detach: true,

  parseCredentials(value): TensorlakeCredentials {
    const credentials = object(value, 'credentials');
    only(credentials, 'credentials', ['apiKey']);
    return { apiKey: string(credentials.apiKey, 'credentials.apiKey') };
  },

  async open(credentials, sandboxId, options) {
    if (!SANDBOX_ID.test(sandboxId)) {
      throw new SandboxError(
        `${JSON.stringify(sandboxId)} is not a Tensorlake sandbox ID or name.`,
        {
          provider: PROVIDER,
          sandboxId,
          kind: 'invalid_request',
        },
      );
    }
    return new TensorlakeSandbox(
      `https://${sandboxId.toLowerCase()}.${SANDBOX_DOMAIN}`,
      sandboxId,
      { authorization: `Bearer ${credentials.apiKey}` },
      options,
    );
  },

  native: ({ pid }) => ({ pid }),
};

class TensorlakeSandbox implements Sandbox {
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
   * No `timeout`: on expiry the daemon kills the command's whole cgroup, which
   * would take the detached agent with it.
   */
  launch(argv: readonly string[]): Promise<string> {
    return this.execute('Tensorlake command start', argv, LAUNCH_TIMEOUT_MS, undefined);
  }

  run(argv: readonly string[], { timeoutMs }: { readonly timeoutMs: number }): Promise<string> {
    return this.execute('Tensorlake command', argv, timeoutMs + 10_000, timeoutMs);
  }

  /** Runs `argv` to its end and resolves with its stdout. */
  private execute(
    label: string,
    argv: readonly string[],
    timeoutMs: number,
    deadlineMs: number | undefined,
  ): Promise<string> {
    const sandboxId = this.sandboxId;
    const [command, ...args] = argv;
    return request(
      {
        provider: PROVIDER,
        label,
        sandboxId,
        url: `${this.url}/api/v1/processes/run`,
        method: 'POST',
        headers: {
          ...this.headers,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          command,
          args,
          ...(deadlineMs !== undefined ? { timeout: Math.ceil(deadlineMs / 1000) } : {}),
        }),
        timeoutMs,
        signal: this.options.signal,
        fetch: this.options.fetch,
        httpError: (answer) => tensorlakeError(label, sandboxId, command, answer),
      },
      async (response) => {
        const stdout = new Lines();
        const stderr = new Lines();
        for await (const event of events(response, label, sandboxId)) {
          if (event.line !== undefined) {
            (event.stream === 'stderr' ? stderr : stdout).add(event.line);
          } else if (event.reason !== undefined) {
            if (event.reason === 'exited' && event.exit_code === 0) return stdout.text();
            throw ended(label, sandboxId, event, stderr.text() || stdout.text());
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

/** A stream's text from its output events, rejoining lines the daemon cut into pieces. */
class Lines {
  private value = '';
  private whole = true;

  add(line: string): void {
    if (this.value && this.whole) this.value += '\n';
    this.value += line;
    this.whole = new TextEncoder().encode(line).byteLength !== LINE_PIECE_BYTES;
  }

  text(): string {
    return this.value;
  }
}

function ended(label: string, sandboxId: string, end: RunEvent, output: string): SandboxError {
  const detail = output.trim().slice(-1000);
  const how =
    end.reason === 'exited' ? `exit code ${end.exit_code}` : `${end.reason}, signal ${end.signal}`;
  return new SandboxError(`${label} failed (${how})${detail ? `: ${detail}` : '.'}`, {
    provider: PROVIDER,
    sandboxId,
    // The daemon's own deadline, which every command but the start is given.
    kind: end.reason === 'timed_out' ? 'timeout' : 'provider_error',
    providerCode: end.reason,
    providerError: { ...end, output: detail },
  });
}

function tensorlakeError(
  label: string,
  sandboxId: string,
  command: string | undefined,
  answer: HttpAnswer,
): SandboxError {
  const error = (answer.body as { error?: unknown } | undefined)?.error;
  if (
    typeof error === 'string' &&
    /^Failed to spawn process/.test(error) &&
    command === 'python3'
  ) {
    return new SandboxError(`Tensorlake sandbox ${sandboxId} has no python3.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_request',
    });
  }
  return statusError({ provider: PROVIDER, label, sandboxId }, answer);
}

const MAX_EVENT_CHARS = 1024 * 1024;

/** The JSON `data` of each server-sent event, however the bytes are split; comments are skipped. */
export async function* events(
  response: Response,
  label: string,
  sandboxId: string,
): AsyncGenerator<RunEvent> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) return;
  let buffer = '';
  let data: string[] = [];
  const unreadable = (what: string) =>
    new SandboxError(`${label} sent ${what}.`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'invalid_response',
    });
  try {
    for (;;) {
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length) {
            const text = data.join('\n');
            data = [];
            try {
              yield JSON.parse(text) as RunEvent;
            } catch {
              throw unreadable('an unreadable event');
            }
          }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line[5] === ' ' ? 6 : 5));
        }
      }
      if (buffer.length > MAX_EVENT_CHARS) throw unreadable('an event that is too long');
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
