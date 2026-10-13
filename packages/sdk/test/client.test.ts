import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, SandboxError, type ExecutionHandle } from '../src/index.ts';
import { createDirectClient } from '../src/direct.ts';
import * as core from '../src/core.ts';

/** A fetch answering every call with `body`, recording what was sent. */
function fakeFetch(body: unknown, status = 200) {
  const sent: { url: string; body: any }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

const execution: ExecutionHandle<'e2b'> = {
  provider: 'e2b',
  sandboxId: 'sbx',
  id: 'run-1',
  startedAt: '2026-10-12T16:40:00.000Z',
  native: { pid: 7 },
};

test('the gateway client sends saved credentials to each route', async () => {
  const { fetch, sent } = fakeFetch({ execution, created: true });
  const client = createClient({
    baseUrl: 'https://execution.example.com/',
    credentials: { e2b: { apiKey: 'e2b_key' } },
    fetch,
  });
  const started = await client.start({
    provider: 'e2b',
    sandboxId: 'sbx',
    id: 'run-1',
    code: 'print(1)',
  });
  assert.equal(started.execution.native.pid, 7);
  await client.wait({ provider: 'e2b', execution, cursor: 0, yieldMs: 1000 });
  await client.list({ provider: 'e2b', sandboxId: 'sbx', credentials: { apiKey: 'other' } });
  assert.deepEqual(
    sent.map((s) => s.url),
    [
      'https://execution.example.com/v1/executions/start',
      'https://execution.example.com/v1/executions/wait',
      'https://execution.example.com/v1/executions/list',
    ],
  );
  assert.deepEqual(sent[0]!.body.credentials, { apiKey: 'e2b_key' });
  assert.equal(sent[1]!.body.yieldMs, 1000);
  assert.deepEqual(sent[2]!.body.credentials, { apiKey: 'other' }, 'the request wins');
});

test('credentials are required for providers the client does not hold', async () => {
  const client = createClient({ baseUrl: 'http://localhost:8787', fetch: fakeFetch({}).fetch });
  // @ts-expect-error no saved credentials for daytona
  await assert.rejects(client.list({ provider: 'daytona', sandboxId: 'sbx' }), {
    kind: 'invalid_request',
    message: /No credentials for daytona/,
  });
});

test('the gateway client rebuilds the gateway error', async () => {
  const { fetch } = fakeFetch(
    { error: { message: 'Execution x does not exist.', kind: 'not_found', retryable: false } },
    404,
  );
  const client = createClient({
    baseUrl: 'http://localhost:8787',
    credentials: { e2b: { apiKey: 'k' } },
    fetch,
  });
  const error = await client.kill({ provider: 'e2b', execution, cursor: 0 }).catch((e) => e);
  assert.ok(SandboxError.is(error));
  assert.equal(error.kind, 'not_found');
  assert.equal(error.message, 'Execution x does not exist.');

  const html = createClient({
    baseUrl: 'http://localhost:8787',
    credentials: { e2b: { apiKey: 'k' } },
    fetch: fakeFetch('<html>bad gateway</html>', 502).fetch,
  });
  await assert.rejects(html.list({ provider: 'e2b', sandboxId: 'sbx' }), {
    kind: 'invalid_response',
  });
});

test('a call timeout and a bad base URL', async () => {
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
    )) as typeof fetch;
  const client = createClient({
    baseUrl: 'http://localhost:8787',
    credentials: { e2b: { apiKey: 'k' } },
    fetch: hanging,
  });
  await assert.rejects(client.wait({ provider: 'e2b', execution, cursor: 0 }, { timeoutMs: 20 }), {
    kind: 'timeout',
  });
  assert.throws(() => createClient({ baseUrl: 'ftp://x' }), { kind: 'invalid_request' });
});

test('the direct client checks requests as the gateway does, before any provider call', async () => {
  const { fetch, sent } = fakeFetch({});
  const client = createDirectClient({ credentials: { e2b: { apiKey: 'k' } }, fetch });
  await assert.rejects(
    client.start({ provider: 'e2b', sandboxId: 'sbx', id: 'bad id!', code: 'print(1)' }),
    { kind: 'invalid_request', message: /id/ },
  );
  assert.equal(sent.length, 0);
});

test('the direct client runs the operation against the provider', async () => {
  const { fetch, sent } = fakeFetch({ code: 404, message: 'sandbox not found' }, 404);
  const client = createDirectClient({ credentials: { e2b: { apiKey: 'k' } }, fetch });
  await assert.rejects(client.list({ provider: 'e2b', sandboxId: 'sbx' }), { kind: 'not_found' });
  assert.equal(sent[0]!.url, 'https://api.e2b.app/sandboxes/sbx');
});

test('the gateway client defaults to the gateway acentric runs', async () => {
  const { fetch, sent } = fakeFetch({ executions: [] });
  await createClient({ credentials: { e2b: { apiKey: 'k' } }, fetch }).list({
    provider: 'e2b',
    sandboxId: 'sbx',
  });
  assert.equal(sent[0]!.url, 'https://execution.cloud.acentric.dev/v1/executions/list');
});

test('the core entry has the contracts and no client', () => {
  assert.equal(typeof core.SandboxError, 'function');
  assert.equal(typeof core.MAX_YIELD_MS, 'number');
  assert.equal('createClient' in core, false);
});
