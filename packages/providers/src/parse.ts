// Request validation. A field the gateway does not know is refused, never
// ignored, so a typo cannot silently change what runs.

import {
  EXECUTION_ID_PATTERN,
  MAX_CODE_BYTES,
  MAX_GRACE_MS,
  MAX_OUTPUT_BYTES,
  MAX_YIELD_MS,
  SandboxError,
  type DeleteAllRequest,
  type DeleteRequest,
  type ExecutionHandle,
  type KillRequest,
  type ListRequest,
  type Provider,
  type StartRequest,
  type Truncation,
  type WaitRequest,
} from '@acentric-sandboxes/contracts';
import type { ProviderAdapter } from './adapter.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TRUNCATIONS: readonly Truncation[] = ['middle', 'head'];

export function invalid(message: string): SandboxError {
  return new SandboxError(message, { kind: 'invalid_request' });
}

export type Record_ = Readonly<Record<string, unknown>>;

export function object(value: unknown, name: string): Record_ {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${name} must be an object.`);
  }
  return value as Record_;
}

/** Refuses fields beyond `allowed`. */
export function only(value: Record_, name: string, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`${name} has unknown fields: ${unknown.join(', ')}.`);
}

export function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw invalid(`${name} must be a non-empty string.`);
  if (value.includes('\0')) throw invalid(`${name} must not contain NUL.`);
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !EXECUTION_ID_PATTERN.test(value)) {
    throw invalid(`${name} must match ${EXECUTION_ID_PATTERN}.`);
  }
  return value;
}

type Base<P extends Provider> = {
  readonly provider: P;
  readonly credentials: ReturnType<ProviderAdapter<P>['parseCredentials']>;
  readonly sandboxId: string;
};

function base<P extends Provider>(
  body: Record_,
  adapterFor: (provider: unknown) => ProviderAdapter<P>,
): Base<P> {
  const adapter = adapterFor(body.provider);
  return {
    provider: adapter.id,
    credentials: adapter.parseCredentials(body.credentials),
    sandboxId: string(body.sandboxId, 'sandboxId'),
  };
}

function handle(value: unknown, provider: Provider): ExecutionHandle {
  const execution = object(value, 'execution');
  only(execution, 'execution', ['provider', 'sandboxId', 'id', 'startedAt', 'native']);
  if (execution.provider !== provider) {
    throw invalid(`execution belongs to ${String(execution.provider)}, not ${provider}.`);
  }
  return {
    provider,
    sandboxId: string(execution.sandboxId, 'execution.sandboxId'),
    id: id(execution.id, 'execution.id'),
    startedAt: string(execution.startedAt, 'execution.startedAt'),
    native: object(execution.native, 'execution.native'),
  } as unknown as ExecutionHandle;
}

function output(body: Record_) {
  return {
    cursor: integer(body.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
    ...(body.maxOutputBytes !== undefined
      ? { maxOutputBytes: integer(body.maxOutputBytes, 'maxOutputBytes', 1, MAX_OUTPUT_BYTES) }
      : {}),
    ...(body.truncate !== undefined ? { truncate: truncation(body.truncate) } : {}),
  };
}

function truncation(value: unknown): Truncation {
  if (!TRUNCATIONS.includes(value as Truncation)) {
    throw invalid(`truncate must be one of ${TRUNCATIONS.join(', ')}.`);
  }
  return value as Truncation;
}

type AdapterFor = (provider: unknown) => ProviderAdapter;

export function parseStart(value: unknown, adapterFor: AdapterFor): StartRequest {
  const body = object(value, 'The request');
  only(body, 'The request', [
    'provider',
    'credentials',
    'sandboxId',
    'id',
    'code',
    'env',
    'cwd',
    'python',
    'maxRuntimeMs',
  ]);
  if (typeof body.code !== 'string') throw invalid('code must be a string.');
  const size = new TextEncoder().encode(body.code).byteLength;
  if (size > MAX_CODE_BYTES) {
    throw invalid(`code is ${size} bytes; the most is ${MAX_CODE_BYTES}.`);
  }
  let env: Record<string, string> | undefined;
  if (body.env !== undefined) {
    env = {};
    for (const [name, text] of Object.entries(object(body.env, 'env'))) {
      if (!ENV_NAME.test(name)) throw invalid(`env name ${JSON.stringify(name)} is not valid.`);
      if (typeof text !== 'string' || text.includes('\0')) {
        throw invalid(`env.${name} must be a string without NUL.`);
      }
      env[name] = text;
    }
  }
  return {
    ...base(body, adapterFor),
    id: id(body.id, 'id'),
    code: body.code,
    ...(env ? { env } : {}),
    ...(body.cwd !== undefined ? { cwd: string(body.cwd, 'cwd') } : {}),
    ...(body.python !== undefined ? { python: string(body.python, 'python') } : {}),
    ...(body.maxRuntimeMs !== undefined
      ? { maxRuntimeMs: integer(body.maxRuntimeMs, 'maxRuntimeMs', 1, Number.MAX_SAFE_INTEGER) }
      : {}),
  } as StartRequest;
}

export function parseWait(value: unknown, adapterFor: AdapterFor): WaitRequest {
  const body = object(value, 'The request');
  only(body, 'The request', [
    'provider',
    'credentials',
    'execution',
    'cursor',
    'yieldMs',
    'maxOutputBytes',
    'truncate',
  ]);
  const adapter = adapterFor(body.provider);
  return {
    provider: adapter.id,
    credentials: adapter.parseCredentials(body.credentials),
    execution: handle(body.execution, adapter.id),
    ...output(body),
    ...(body.yieldMs !== undefined
      ? { yieldMs: integer(body.yieldMs, 'yieldMs', 0, MAX_YIELD_MS) }
      : {}),
  } as WaitRequest;
}

export function parseKill(value: unknown, adapterFor: AdapterFor): KillRequest {
  const body = object(value, 'The request');
  only(body, 'The request', [
    'provider',
    'credentials',
    'execution',
    'cursor',
    'graceMs',
    'maxOutputBytes',
    'truncate',
  ]);
  const adapter = adapterFor(body.provider);
  return {
    provider: adapter.id,
    credentials: adapter.parseCredentials(body.credentials),
    execution: handle(body.execution, adapter.id),
    ...output(body),
    ...(body.graceMs !== undefined
      ? { graceMs: integer(body.graceMs, 'graceMs', 0, MAX_GRACE_MS) }
      : {}),
  } as KillRequest;
}

export function parseList(value: unknown, adapterFor: AdapterFor): ListRequest {
  const body = object(value, 'The request');
  only(body, 'The request', ['provider', 'credentials', 'sandboxId']);
  return base(body, adapterFor) as ListRequest;
}

export function parseDelete(value: unknown, adapterFor: AdapterFor): DeleteRequest {
  const body = object(value, 'The request');
  only(body, 'The request', ['provider', 'credentials', 'sandboxId', 'id']);
  return { ...base(body, adapterFor), id: id(body.id, 'id') } as DeleteRequest;
}

export function parseDeleteAll(value: unknown, adapterFor: AdapterFor): DeleteAllRequest {
  const body = object(value, 'The request');
  only(body, 'The request', ['provider', 'credentials', 'sandboxId']);
  return base(body, adapterFor) as DeleteAllRequest;
}
