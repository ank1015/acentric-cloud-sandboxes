// The execution operations, the same on every provider: each one opens the
// sandbox through its adapter and runs one agent command in it.

import {
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_YIELD_MS,
  EXECUTIONS_DIR,
  SandboxError,
  type DeleteAllRequest,
  type DeleteAllResponse,
  type DeleteRequest,
  type DeleteResponse,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionStatus,
  type ExecutionSummary,
  type KillRequest,
  type ListRequest,
  type ListResponse,
  type Provider,
  type StartRequest,
  type StartResponse,
  type Truncation,
  type WaitRequest,
} from '@acentric-sandboxes/contracts';
import type { CallOptions, ProviderAdapter, Sandbox } from './adapter.ts';
import { AGENT_PY } from './agent.ts';
import { fromBase64, readOutput, toBase64 } from './output.ts';

/** Time allowed beyond an agent command's own work: starting Python, the round trip. */
const OVERHEAD_MS = 20_000;
/** How long `kill` waits for the end after SIGKILL, as in the agent. */
const AFTER_SIGKILL_MS = 5_000;

/** What the agent reports about one execution. */
interface AgentState {
  readonly id: string;
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly now: number;
  readonly size: number;
  readonly status: ExecutionStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly endedAt?: number;
}

interface AgentAnswer {
  readonly missing?: true;
  readonly error?: 'cursor';
  readonly state?: AgentState;
  readonly head?: string;
  readonly tail?: string;
  readonly tailStart?: number;
}

export interface Operations {
  readonly adapterFor: (provider: unknown) => ProviderAdapter;
}

function agent(...args: string[]): string[] {
  return ['python3', '-c', AGENT_PY, ...args];
}

async function open(
  adapter: ProviderAdapter,
  credentials: unknown,
  sandboxId: string,
  options: CallOptions,
): Promise<Sandbox> {
  return adapter.open(credentials as never, sandboxId, options);
}

function parseLine<T>(provider: string, sandboxId: string, text: string): T {
  const line = text.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new SandboxError('The agent in the sandbox answered with something unreadable.', {
      provider,
      sandboxId,
      kind: 'invalid_response',
      nativeError: text.slice(0, 2000),
    });
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function handleFor(
  adapter: ProviderAdapter,
  sandboxId: string,
  state: Pick<AgentState, 'id' | 'pid' | 'startedAt'>,
): ExecutionHandle {
  return {
    provider: adapter.id,
    sandboxId,
    id: state.id,
    startedAt: new Date(state.startedAt ?? 0).toISOString(),
    native: adapter.native({ pid: state.pid ?? 0 }),
  } as ExecutionHandle;
}

function ending(state: AgentState) {
  return {
    status: state.status,
    ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    ...(state.signal !== undefined ? { signal: state.signal } : {}),
    outputBytes: state.size,
    runtimeMs:
      state.startedAt === null ? 0 : Math.max(0, (state.endedAt ?? state.now) - state.startedAt),
  };
}

function result(execution: ExecutionHandle, answer: AgentAnswer, cursor: number): ExecutionResult {
  const state = answer.state!;
  const output = readOutput({
    cursor,
    size: state.size,
    head: fromBase64(answer.head ?? ''),
    tail: answer.tail === undefined ? undefined : fromBase64(answer.tail),
    tailStart: answer.tailStart,
    ended: state.status !== 'running',
  });
  const { outputBytes, runtimeMs, ...end } = ending(state);
  return {
    execution,
    ...end,
    output: output.output,
    cursor,
    nextCursor: output.nextCursor,
    omittedBytes: output.omittedBytes,
    outputBytes,
    runtimeMs,
  } as ExecutionResult;
}

function checked(
  answer: AgentAnswer,
  provider: Provider,
  execution: Pick<ExecutionHandle, 'sandboxId' | 'id'>,
  cursor: number,
): AgentAnswer {
  if (answer.missing) {
    throw new SandboxError(`Execution ${execution.id} does not exist in the sandbox.`, {
      provider,
      sandboxId: execution.sandboxId,
      executionId: execution.id,
      kind: 'not_found',
    });
  }
  if (answer.error === 'cursor') {
    throw new SandboxError(
      `cursor ${cursor} is past the end of execution ${execution.id}'s output.`,
      {
        provider,
        sandboxId: execution.sandboxId,
        executionId: execution.id,
        kind: 'invalid_request',
      },
    );
  }
  return answer;
}

export async function start(
  { adapterFor }: Operations,
  request: StartRequest,
  options: CallOptions = {},
): Promise<StartResponse> {
  const adapter = adapterFor(request.provider);
  const sandbox = await open(adapter, request.credentials, request.sandboxId, options);
  const env = request.env ? toBase64(new TextEncoder().encode(JSON.stringify(request.env))) : '';
  const line = await sandbox.launch(
    agent(
      'start',
      EXECUTIONS_DIR,
      request.id,
      toBase64(new TextEncoder().encode(request.code)),
      request.cwd ?? '',
      request.python ?? 'python3',
      request.maxRuntimeMs === undefined ? '' : String(request.maxRuntimeMs),
      env,
      adapter.detach ? '1' : '0',
    ),
  );
  const answer = parseLine<{
    startedAt?: number;
    pid?: number;
    exists?: true;
    sha256?: string | null;
    state?: AgentState | null;
  }>(adapter.id, request.sandboxId, line);
  const context = { provider: adapter.id, sandboxId: request.sandboxId, executionId: request.id };
  if (!answer.exists) {
    return {
      execution: handleFor(adapter, request.sandboxId, {
        id: request.id,
        pid: answer.pid ?? null,
        startedAt: answer.startedAt ?? null,
      }),
      created: true,
    } as StartResponse;
  }
  if (answer.sha256 !== (await sha256(request.code))) {
    throw new SandboxError(`Execution ${request.id} was already started with other code.`, {
      ...context,
      kind: 'conflict',
    });
  }
  if (!answer.state || answer.state.startedAt === null) {
    throw new SandboxError(`Execution ${request.id} is still starting; retry shortly.`, {
      ...context,
      kind: 'provider_error',
    });
  }
  return {
    execution: handleFor(adapter, request.sandboxId, answer.state),
    created: false,
  } as StartResponse;
}

export async function wait(
  { adapterFor }: Operations,
  request: WaitRequest,
  options: CallOptions = {},
): Promise<ExecutionResult> {
  const adapter = adapterFor(request.provider);
  const { execution, cursor } = request;
  const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const mode: Truncation = request.truncate ?? 'middle';
  const deadline = Date.now() + (request.yieldMs ?? DEFAULT_YIELD_MS);
  const sandbox = await open(adapter, request.credentials, execution.sandboxId, options);
  // Each command is held below the provider's limit; a longer wait takes several.
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const slice = Math.min(remaining, adapter.maxHoldMs);
    const final = slice >= remaining;
    const stdout = await sandbox.run(
      agent(
        'wait',
        EXECUTIONS_DIR,
        execution.id,
        String(cursor),
        String(slice),
        String(limit),
        mode,
        final ? '1' : '0',
      ),
      { timeoutMs: slice + OVERHEAD_MS },
    );
    const answer = checked(
      parseLine<AgentAnswer>(adapter.id, execution.sandboxId, stdout),
      adapter.id,
      execution,
      cursor,
    );
    if (answer.head !== undefined) return result(execution, answer, cursor);
  }
}

export async function kill(
  { adapterFor }: Operations,
  request: KillRequest,
  options: CallOptions = {},
): Promise<ExecutionResult> {
  const adapter = adapterFor(request.provider);
  const { execution, cursor } = request;
  const graceMs = request.graceMs ?? DEFAULT_GRACE_MS;
  const sandbox = await open(adapter, request.credentials, execution.sandboxId, options);
  const stdout = await sandbox.run(
    agent(
      'kill',
      EXECUTIONS_DIR,
      execution.id,
      String(cursor),
      String(graceMs),
      String(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
      request.truncate ?? 'middle',
    ),
    { timeoutMs: graceMs + AFTER_SIGKILL_MS + OVERHEAD_MS },
  );
  const answer = checked(
    parseLine<AgentAnswer>(adapter.id, execution.sandboxId, stdout),
    adapter.id,
    execution,
    cursor,
  );
  return result(execution, answer, cursor);
}

export async function list(
  { adapterFor }: Operations,
  request: ListRequest,
  options: CallOptions = {},
): Promise<ListResponse> {
  const adapter = adapterFor(request.provider);
  const sandbox = await open(adapter, request.credentials, request.sandboxId, options);
  const stdout = await sandbox.run(agent('list', EXECUTIONS_DIR), { timeoutMs: OVERHEAD_MS });
  const { executions } = parseLine<{ executions: AgentState[] }>(
    adapter.id,
    request.sandboxId,
    stdout,
  );
  return {
    executions: executions
      .filter((state) => state.startedAt !== null)
      .sort((a, b) => a.startedAt! - b.startedAt! || a.id.localeCompare(b.id))
      .map(
        (state) =>
          ({
            execution: handleFor(adapter, request.sandboxId, state),
            ...ending(state),
          }) as ExecutionSummary,
      ),
  } as ListResponse;
}

export async function deleteExecution(
  { adapterFor }: Operations,
  request: DeleteRequest,
  options: CallOptions = {},
): Promise<DeleteResponse> {
  const adapter = adapterFor(request.provider);
  const sandbox = await open(adapter, request.credentials, request.sandboxId, options);
  const stdout = await sandbox.run(agent('delete', EXECUTIONS_DIR, request.id), {
    timeoutMs: OVERHEAD_MS,
  });
  const { result } = parseLine<{ result: 'deleted' | 'missing' | 'running' }>(
    adapter.id,
    request.sandboxId,
    stdout,
  );
  if (result === 'running') {
    throw new SandboxError(`Execution ${request.id} is still running; kill it first.`, {
      provider: adapter.id,
      sandboxId: request.sandboxId,
      executionId: request.id,
      kind: 'conflict',
    });
  }
  return { deleted: result === 'deleted' };
}

export async function deleteAll(
  { adapterFor }: Operations,
  request: DeleteAllRequest,
  options: CallOptions = {},
): Promise<DeleteAllResponse> {
  const adapter = adapterFor(request.provider);
  const sandbox = await open(adapter, request.credentials, request.sandboxId, options);
  const stdout = await sandbox.run(agent('delete-all', EXECUTIONS_DIR), { timeoutMs: OVERHEAD_MS });
  const answer = parseLine<{ deleted: string[]; running: string[] }>(
    adapter.id,
    request.sandboxId,
    stdout,
  );
  return { deleted: answer.deleted.sort(), running: answer.running.sort() };
}
