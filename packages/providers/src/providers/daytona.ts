// Daytona. The control plane (`https://app.daytona.io/api`) finds the sandbox
// and starts a stopped or archived one; commands run through the toolbox's
// `POST /process/execute` (the daemon's shell, `zsh -c`, stdout and stderr
// merged), reached through the sandbox's `toolboxProxyUrl`. It has no
// background start, so the agent detaches itself. See docs/research/daytona.md.

import { SandboxError, type DaytonaCredentials } from '@acentric-sandboxes/contracts';
import type { CallOptions, ProviderAdapter, Sandbox } from '../adapter.ts';
import { object, only, string } from '../parse.ts';
import { quote } from '../shell.ts';
import { requestJson, sleep, statusError, type HttpAnswer } from '../transport.ts';

const PROVIDER = 'daytona';
const DEFAULT_API_URL = 'https://app.daytona.io/api';
const LOOKUP_TIMEOUT_MS = 30_000;
/** Starting an archived sandbox restores it from storage first. */
const WAKE_TIMEOUT_MS = 180_000;
/** Until the detaching agent has handed over its first line. */
const LAUNCH_TIMEOUT_MS = 60_000;

/** States that end in `started` without help, and those that need a start. */
const SETTLING = new Set([
  'creating',
  'starting',
  'restoring',
  'pending_build',
  'building_snapshot',
  'pulling_snapshot',
  'resizing',
  'stopping',
  'archiving',
  'pausing',
  'resuming',
]);
const STARTABLE = new Set(['stopped', 'archived', 'paused']);

interface SandboxInfo {
  readonly id?: string;
  readonly state?: string;
  readonly toolboxProxyUrl?: string;
  readonly errorReason?: string;
}

export const daytona: ProviderAdapter<'daytona'> = {
  id: PROVIDER,
  // The toolbox proxy closes connections idle for 70 s; a waiting agent prints nothing.
  maxHoldMs: 50_000,
  detach: true,

  parseCredentials(value): DaytonaCredentials {
    const credentials = object(value, 'credentials');
    only(credentials, 'credentials', ['apiKey', 'apiUrl']);
    return {
      apiKey: string(credentials.apiKey, 'credentials.apiKey'),
      ...(credentials.apiUrl !== undefined
        ? { apiUrl: string(credentials.apiUrl, 'credentials.apiUrl') }
        : {}),
    };
  },

  async open(credentials, sandboxId, options) {
    const api = (credentials.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    const headers = { authorization: `Bearer ${credentials.apiKey}` };
    const call = { provider: PROVIDER, sandboxId, signal: options.signal, fetch: options.fetch };
    const path = `${api}/sandbox/${encodeURIComponent(sandboxId)}`;
    const lookup = async () =>
      (await requestJson({
        ...call,
        label: 'Daytona sandbox lookup',
        url: path,
        method: 'GET',
        headers,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      })) as SandboxInfo;

    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let info = await lookup();
    let started = false;
    for (let attempt = 0; ; attempt += 1) {
      const state = info.state ?? 'unknown';
      if (state === 'started' && info.toolboxProxyUrl && info.id) {
        const toolbox = `${info.toolboxProxyUrl.replace(/\/+$/, '')}/${encodeURIComponent(info.id)}`;
        return new DaytonaSandbox(toolbox, sandboxId, headers, options);
      }
      if (STARTABLE.has(state) && !started) {
        await requestJson({
          ...call,
          label: 'Daytona sandbox start',
          url: `${path}/start`,
          method: 'POST',
          headers,
          timeoutMs: LOOKUP_TIMEOUT_MS,
        });
        started = true;
      } else if (!SETTLING.has(state) && !STARTABLE.has(state)) {
        throw new SandboxError(
          `Daytona sandbox ${sandboxId} is ${state}${info.errorReason ? `: ${info.errorReason}` : '.'}`,
          { provider: PROVIDER, sandboxId, kind: 'sandbox_unavailable' },
        );
      }
      if (Date.now() >= deadline) {
        throw new SandboxError(`Daytona sandbox ${sandboxId} did not start in time (${state}).`, {
          provider: PROVIDER,
          sandboxId,
          kind: 'sandbox_unavailable',
        });
      }
      await sleep(Math.min(500 * 2 ** attempt, 3_000), PROVIDER, options.signal);
      info = await lookup();
    }
  },

  native: ({ pid }) => ({ pid }),
};

class DaytonaSandbox implements Sandbox {
  private readonly toolbox: string;
  private readonly sandboxId: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly options: CallOptions;

  constructor(
    toolbox: string,
    sandboxId: string,
    headers: Readonly<Record<string, string>>,
    options: CallOptions,
  ) {
    this.toolbox = toolbox;
    this.sandboxId = sandboxId;
    this.headers = headers;
    this.options = options;
  }

  launch(argv: readonly string[]): Promise<string> {
    return this.execute('Daytona command start', argv, LAUNCH_TIMEOUT_MS);
  }

  run(argv: readonly string[], { timeoutMs }: { readonly timeoutMs: number }): Promise<string> {
    return this.execute('Daytona command', argv, timeoutMs);
  }

  private async execute(
    label: string,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<string> {
    const sandboxId = this.sandboxId;
    const answer = (await requestJson({
      provider: PROVIDER,
      label,
      sandboxId,
      url: `${this.toolbox}/process/execute`,
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        command: argv.map(quote).join(' '),
        timeout: Math.ceil(timeoutMs / 1000),
      }),
      timeoutMs: timeoutMs + 10_000,
      signal: this.options.signal,
      fetch: this.options.fetch,
      httpError: (http) => toolboxError(label, sandboxId, http),
    })) as { exitCode?: number; result?: string };
    const output = answer.result ?? '';
    const code = answer.exitCode ?? 0;
    if (code === 0) return output;
    const detail = output.trim().slice(-1000);
    if (code === 127 && /python3/.test(detail)) {
      throw new SandboxError(`Daytona sandbox ${sandboxId} has no python3.`, {
        provider: PROVIDER,
        sandboxId,
        kind: 'invalid_request',
      });
    }
    throw new SandboxError(`${label} failed (exit code ${code})${detail ? `: ${detail}` : '.'}`, {
      provider: PROVIDER,
      sandboxId,
      kind: 'provider_error',
      providerError: { exitCode: code, output: detail },
    });
  }
}

function toolboxError(label: string, sandboxId: string, answer: HttpAnswer): SandboxError {
  const code = (answer.body as { code?: unknown } | undefined)?.code;
  // The daemon's own deadline, which every command is given.
  if (code === 'PROCESS_EXECUTION_TIMEOUT') {
    return statusError({ provider: PROVIDER, label, sandboxId }, answer, 'timeout');
  }
  return statusError({ provider: PROVIDER, label, sandboxId }, answer);
}
