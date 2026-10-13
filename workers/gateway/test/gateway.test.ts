import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ROUTES } from '@acentric-sandboxes/contracts';
import worker from '../src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(route: string, body: unknown, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`https://gateway.test${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    }),
  );
}

const start = {
  provider: 'e2b',
  credentials: { apiKey: 'e2b_key' },
  sandboxId: 'sbx',
  id: 'run_1',
  code: 'print(1)',
};

test('every route takes POST and answers CORS preflights', async () => {
  for (const route of Object.values(ROUTES)) {
    const options = await worker.fetch(
      new Request(`https://gateway.test${route}`, { method: 'OPTIONS' }),
    );
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');
    const get = await worker.fetch(new Request(`https://gateway.test${route}`));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
  }
  assert.equal((await post('/v1/nope', {})).status, 404);
});

test('invalid requests are 400 with a typed error', async () => {
  const bad = await post(ROUTES.start, { ...start, id: 'a/b' });
  assert.equal(bad.status, 400);
  const { error } = (await bad.json()) as { error: Record<string, unknown> };
  assert.equal(error.kind, 'invalid_request');
  assert.equal(error.retryable, false);
  assert.equal((await post(ROUTES.start, '{nope')).status, 400);
  assert.equal((await post(ROUTES.start, 'x'.repeat(1024 * 1024 + 1))).status, 413);
});

test('provider errors keep their kind and context', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { code: 404, message: 'sandbox "sbx" not found' },
      { status: 404 },
    )) as typeof fetch;
  const answer = await post(ROUTES.start, start);
  assert.equal(answer.status, 404);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  const { error } = (await answer.json()) as { error: Record<string, unknown> };
  assert.equal(error.kind, 'not_found');
  assert.equal(error.provider, 'e2b');
  assert.equal(error.sandboxId, 'sbx');
  assert.equal(JSON.stringify(error).includes('e2b_key'), false, 'credentials never echo back');
});

test('rate limits carry Retry-After', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { message: 'slow down' },
      { status: 429, headers: { 'retry-after': '3' } },
    )) as typeof fetch;
  const answer = await post(ROUTES.list, {
    provider: 'e2b',
    credentials: { apiKey: 'k' },
    sandboxId: 's',
  });
  assert.equal(answer.status, 429);
  assert.equal(answer.headers.get('retry-after'), '3');
});
