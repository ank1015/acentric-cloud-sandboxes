// The Blaxel adapter against a fake Blaxel: the control plane's deployment
// statuses and the sandbox API's `POST /process`, plain and streamed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blaxel } from '../src/index.ts';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: Record<string, unknown>;
}

/** A fake whose sandbox goes through `statuses`, one per lookup, and whose sandbox API answers `process`. */
function fake(statuses: string[], process: (body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const path = new URL(String(url)).pathname;
    if (path === '/v0/sandboxes/missing') {
      return Response.json({ code: 404, error: 'Sandbox not found' }, { status: 404 });
    }
    if (path.startsWith('/v0/sandboxes/')) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return Response.json({ status, metadata: { url: 'https://sbx-box-ws.us-pdx-1.bl.run' } });
    }
    return process(body);
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

/** An NDJSON body sent in 7-character pieces, so records are split anywhere. */
function ndjson(events: readonly unknown[]): Response {
  const text = events.map((e) => JSON.stringify(e) + '\n').join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
}

const credentials = { apiKey: 'bl_key' };
const done =
  (stdout: string, exitCode = 0, stderr = '') =>
  () =>
    Response.json({ status: exitCode ? 'failed' : 'completed', exitCode, stdout, stderr });

test('run waits for one quoted command and returns its stdout', async () => {
  const { sent, fetch } = fake(['DEPLOYED'], done('{"a":1}\n', 0, 'noise'));
  const sandbox = await blaxel.open({ ...credentials, workspace: 'team' }, 'box', { fetch });
  assert.equal(
    await sandbox.run(['python3', '-c', "print('x')"], { timeoutMs: 4_500 }),
    '{"a":1}\n',
  );
  const [lookup, run] = sent;
  assert.equal(lookup!.url, 'https://api.blaxel.ai/v0/sandboxes/box');
  assert.equal(lookup!.headers.authorization, 'Bearer bl_key');
  assert.equal(lookup!.headers['x-blaxel-workspace'], 'team');
  assert.equal(lookup!.headers['user-agent'], 'acentric-sandboxes');
  assert.equal(run!.url, 'https://sbx-box-ws.us-pdx-1.bl.run/process');
  assert.equal(run!.headers.authorization, 'Bearer bl_key');
  assert.deepEqual(run!.body, {
    command: `'python3' '-c' 'print('\\''x'\\'')'`,
    waitForCompletion: true,
    timeout: 5,
  });
});

test('launch keeps the sandbox awake and resolves with the first line', async () => {
  const { sent, fetch } = fake(['DEPLOYED'], () =>
    ndjson([
      { type: 'keepalive' },
      { type: 'stdout', data: '{"pid":' },
      { type: 'stdout', data: btoa('7}\nmore'), encoding: 'base64' },
      { type: 'stdout', data: 'never read\n' },
    ]),
  );
  const sandbox = await blaxel.open(credentials, 'box', { fetch });
  assert.equal(await sandbox.launch(['python3', '-c', 'x']), '{"pid":7}');
  const launch = sent[1]!;
  assert.equal(launch.headers.accept, 'application/x-ndjson');
  assert.equal(sent[0]!.headers['x-blaxel-workspace'], undefined);
  assert.deepEqual(launch.body, {
    command: `'python3' '-c' 'x'`,
    keepAlive: true,
    timeout: 0,
  });
});

test('a launch that ends before its first line is an error', async () => {
  const { fetch } = fake(['DEPLOYED'], () =>
    ndjson([
      { type: 'stderr', data: 'sh: 1: python3: not found\n' },
      {
        type: 'result',
        data: JSON.stringify({
          status: 'failed',
          exitCode: 127,
          stderr: 'sh: 1: python3: not found\n',
        }),
      },
    ]),
  );
  const sandbox = await blaxel.open(credentials, 'box', { fetch });
  await assert.rejects(sandbox.launch(['python3']), {
    kind: 'invalid_request',
    message: /has no python3/,
  });
});

test('a sandbox being deployed is waited for', async () => {
  const { sent, fetch } = fake(['DEPLOYING', 'DEPLOYED'], done(''));
  await blaxel.open(credentials, 'box', { fetch });
  assert.deepEqual(
    sent.map((s) => `${s.method} ${new URL(s.url).pathname}`),
    ['GET /v0/sandboxes/box', 'GET /v0/sandboxes/box'],
  );
});

test('unusable or unknown sandboxes are errors', async () => {
  await assert.rejects(
    blaxel.open(credentials, 'box', { fetch: fake(['FAILED'], done('')).fetch }),
    {
      kind: 'sandbox_unavailable',
    },
  );
  await assert.rejects(
    blaxel.open(credentials, 'missing', { fetch: fake(['DEPLOYED'], done('')).fetch }),
    { kind: 'not_found', message: /Sandbox not found/ },
  );
});

test('failed commands, the sandbox API deadline and platform errors', async () => {
  const failing = await blaxel.open(credentials, 'box', {
    fetch: fake(['DEPLOYED'], done('', 1, 'Traceback: boom')).fetch,
  });
  await assert.rejects(failing.run(['x'], { timeoutMs: 1000 }), {
    kind: 'provider_error',
    message: /exit code 1.*boom/,
  });

  const slow = await blaxel.open(credentials, 'box', {
    fetch: fake(['DEPLOYED'], () =>
      Response.json({ error: 'process timed out after 1 seconds' }, { status: 422 }),
    ).fetch,
  });
  await assert.rejects(slow.run(['x'], { timeoutMs: 1000 }), { kind: 'timeout' });

  const waking = await blaxel.open(credentials, 'box', {
    fetch: fake(['DEPLOYED'], () =>
      Response.json(
        { error: { code: 'WORKLOAD_UNAVAILABLE', message: 'The workload is not ready yet' } },
        { status: 503 },
      ),
    ).fetch,
  });
  await assert.rejects(waking.run(['x'], { timeoutMs: 1000 }), {
    kind: 'sandbox_unavailable',
    providerCode: 'WORKLOAD_UNAVAILABLE',
    message: /not ready yet/,
  });
});
