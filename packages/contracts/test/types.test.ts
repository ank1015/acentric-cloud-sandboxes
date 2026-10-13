// Compile-time checks, run by `pnpm check`. A fake provider is registered
// here, beside the real ones.
import { test } from 'node:test';
import type {
  DeleteAllRequest,
  ExecutionHandle,
  ExecutionResult,
  KillRequest,
  ListResponse,
  Provider,
  StartRequest,
  StartResponse,
  WaitRequest,
} from '../src/index.ts';

declare module '../src/providers.ts' {
  interface Providers {
    acme: {
      credentials: { token: string; region?: string };
      native: { jobId: string };
    };
  }
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expect<T extends true>(): T | void {}

expect<Equal<Provider, 'e2b' | 'daytona' | 'blaxel' | 'tensorlake' | 'acme'>>();

const start: StartRequest = {
  provider: 'blaxel',
  credentials: { apiKey: 'bl_test', workspace: 'team' },
  sandboxId: 'my-sandbox',
  id: 'run_1',
  code: 'print("hi")',
  env: { MODE: 'test' },
  maxRuntimeMs: 60_000,
};

const wrongCredentials: StartRequest<'blaxel'> = {
  provider: 'blaxel',
  // @ts-expect-error Blaxel needs an API key
  credentials: { workspace: 'team' },
  sandboxId: 'my-sandbox',
  id: 'run_1',
  code: 'print("hi")',
};

const started: StartResponse<'e2b'> = {
  execution: {
    provider: 'e2b',
    sandboxId: 'sbx_1',
    id: 'run_1',
    startedAt: '2026-10-12T16:40:00.123Z',
    native: { pid: 412 },
  },
  created: true,
};

const mismatched: ExecutionHandle = {
  provider: 'daytona',
  sandboxId: 'sbx_1',
  id: 'run_1',
  startedAt: '2026-10-12T16:40:00.123Z',
  // @ts-expect-error a Daytona handle holds a PID
  native: { session: 'acx-run_1' },
};

function nativeOf(handle: ExecutionHandle): string {
  switch (handle.provider) {
    case 'e2b':
      return String(handle.native.pid);
    case 'daytona':
      return String(handle.native.pid);
    case 'blaxel':
      return String(handle.native.pid);
    case 'tensorlake':
      return String(handle.native.pid);
    case 'acme':
      return handle.native.jobId;
  }
}

const cleanup: DeleteAllRequest<'acme'> = {
  provider: 'acme',
  credentials: { token: 't' },
  sandboxId: 'box',
};

const wait: WaitRequest<'e2b'> = {
  provider: 'e2b',
  credentials: { apiKey: 'e2b_test' },
  execution: started.execution,
  cursor: 0,
  yieldMs: 60_000,
  truncate: 'head',
};

const crossProvider: WaitRequest<'tensorlake'> = {
  provider: 'tensorlake',
  credentials: { apiKey: 'tl_test' },
  // @ts-expect-error an E2B handle cannot be waited on through Tensorlake
  execution: started.execution,
  cursor: 0,
};

const result: ExecutionResult<'e2b'> = {
  execution: started.execution,
  status: 'killed',
  signal: 'SIGTERM',
  output: 'step 1\n',
  cursor: 0,
  nextCursor: 7,
  omittedBytes: 0,
  outputBytes: 7,
  runtimeMs: 1_250,
};

const kill: KillRequest<'e2b'> = {
  provider: 'e2b',
  credentials: { apiKey: 'e2b_test' },
  execution: started.execution,
  cursor: 7,
  graceMs: 5_000,
};

const listed: ListResponse<'blaxel'> = {
  executions: [
    {
      execution: {
        provider: 'blaxel',
        sandboxId: 'my-sandbox',
        id: 'run_1',
        startedAt: '2026-10-12T16:40:00.123Z',
        native: { pid: 17 },
      },
      status: 'timed_out',
      signal: 'SIGKILL',
      outputBytes: 2_048,
      runtimeMs: 60_000,
    },
  ],
};

void [
  start,
  wrongCredentials,
  started,
  mismatched,
  nativeOf,
  cleanup,
  wait,
  crossProvider,
  result,
  kill,
  listed,
];

test('types compile', () => {});
