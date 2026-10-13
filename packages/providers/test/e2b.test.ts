// The E2B adapter against a fake E2B: the control plane, and envd's Connect
// streams split at awkward places.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '@acentric-sandboxes/contracts';
import { e2b } from '../src/index.ts';
import { envelope } from '../src/providers/e2b.ts';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

/** A Connect stream of `events`, cut into 3-byte chunks. */
function stream(events: unknown[], trailer: unknown = {}): Response {
  const bytes = Buffer.concat([
    ...events.map((event) => envelope({ event })),
    envelope(trailer, 2),
  ]);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 3)));
        offset += 3;
      },
    }),
    { headers: { 'content-type': 'application/connect+json' } },
  );
}

function fake(state: string, envd: () => Response) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body:
        body instanceof Uint8Array
          ? JSON.parse(Buffer.from(body.subarray(5)).toString())
          : body
            ? JSON.parse(String(body))
            : undefined,
    });
    if (String(url).endsWith('/sandboxes/missing')) {
      return Response.json({ code: 404, message: 'sandbox "missing" not found' }, { status: 404 });
    }
    if (
      new URL(String(url)).hostname.startsWith('api.') &&
      String(url).includes('/sandboxes/') &&
      !String(url).endsWith('/connect')
    ) {
      return Response.json({ state, envdAccessToken: 'envd-token' });
    }
    if (String(url).endsWith('/connect'))
      return Response.json({ envdAccessToken: 'resumed-token' });
    return envd();
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

const credentials = { apiKey: 'e2b_key' };

test('launch resolves with the first line and leaves the command running', async () => {
  const { sent, fetch } = fake('running', () =>
    stream([
      { start: { pid: 41 } },
      { data: { stdout: b64('{"startedAt":1') } },
      { data: { stdout: b64('}\nmore') } },
    ]),
  );
  const sandbox = await e2b.open(credentials, 'sbx', { fetch });
  const line = await sandbox.launch(['python3', '-c', 'x']);
  assert.equal(line, '{"startedAt":1}');
  const [lookup, start] = sent;
  assert.equal(lookup!.url, 'https://api.e2b.app/sandboxes/sbx');
  assert.equal(lookup!.headers['x-api-key'], 'e2b_key');
  assert.equal(start!.url, 'https://49983-sbx.e2b.app/process.Process/Start');
  assert.equal(start!.headers['x-access-token'], 'envd-token');
  assert.equal(start!.headers['x-api-key'], undefined, 'the API key stays with the control plane');
  assert.equal(
    start!.headers['connect-timeout-ms'],
    undefined,
    'a launched command gets no deadline',
  );
  assert.deepEqual(start!.body, {
    process: { cmd: '/usr/bin/env', args: ['python3', '-c', 'x'] },
    stdin: false,
  });
});

test('run collects stdout until the command ends', async () => {
  const { sent, fetch } = fake('running', () =>
    stream([
      { start: { pid: 42 } },
      { data: { stdout: b64('hello ') } },
      { data: { stderr: b64('noise') } },
      { data: { stdout: b64('world\n') } },
      { end: { exited: true, status: 'exit status 0' } },
    ]),
  );
  const sandbox = await e2b.open(credentials, 'sbx', { fetch });
  assert.equal(await sandbox.run(['true'], { timeoutMs: 1000 }), 'hello world\n');
  assert.equal(sent[1]!.headers['connect-timeout-ms'], '1000');
});

test('a failed command or stream is an error', async () => {
  const failing = fake('running', () =>
    stream([
      { data: { stderr: b64('Traceback: boom') } },
      { end: { exitCode: 1, exited: true, status: 'exit status 1' } },
    ]),
  );
  const sandbox = await e2b.open(credentials, 'sbx', { fetch: failing.fetch });
  await assert.rejects(sandbox.run(['x'], { timeoutMs: 1000 }), (error: SandboxError) => {
    assert.equal(error.kind, 'provider_error');
    assert.match(error.message, /exit status 1.*Traceback: boom/);
    return true;
  });

  const noPython = fake('running', () =>
    stream([
      { data: { stderr: b64('/usr/bin/env: python3: No such file') } },
      { end: { exitCode: 127 } },
    ]),
  );
  const bare = await e2b.open(credentials, 'sbx', { fetch: noPython.fetch });
  await assert.rejects(bare.run(['x'], { timeoutMs: 1000 }), {
    kind: 'invalid_request',
    message: /has no python3/,
  });

  const deadline = fake('running', () =>
    stream([], { error: { code: 'deadline_exceeded', message: 'too slow' } }),
  );
  const slow = await e2b.open(credentials, 'sbx', { fetch: deadline.fetch });
  await assert.rejects(slow.run(['x'], { timeoutMs: 1000 }), {
    kind: 'timeout',
    providerCode: 'deadline_exceeded',
  });

  const denied = fake('running', () =>
    Response.json({ code: 'unauthenticated', message: 'bad token' }, { status: 401 }),
  );
  const locked = await e2b.open(credentials, 'sbx', { fetch: denied.fetch });
  await assert.rejects(locked.run(['x'], { timeoutMs: 1000 }), { kind: 'auth' });
});

test('a paused sandbox is resumed; a missing one is not_found', async () => {
  const paused = fake('paused', () => stream([{ end: {} }]));
  const sandbox = await e2b.open(credentials, 'sbx', { fetch: paused.fetch });
  await sandbox.run(['true'], { timeoutMs: 1000 });
  assert.equal(paused.sent[1]!.url, 'https://api.e2b.app/v2/sandboxes/sbx/connect');
  assert.equal(paused.sent[2]!.headers['x-access-token'], 'resumed-token');

  await assert.rejects(e2b.open(credentials, 'missing', { fetch: paused.fetch }), {
    kind: 'not_found',
    sandboxId: 'missing',
  });
  const killed = fake('killed', () => stream([]));
  await assert.rejects(e2b.open(credentials, 'sbx', { fetch: killed.fetch }), {
    kind: 'sandbox_unavailable',
  });
});

test('a custom domain reaches its own control plane and envd', async () => {
  const { sent, fetch } = fake('running', () => stream([{ end: {} }]));
  const sandbox = await e2b.open({ apiKey: 'k', domain: 'e2b.example.com' }, 'sbx', { fetch });
  await sandbox.run(['true'], { timeoutMs: 1000 });
  assert.equal(sent[1]!.url, 'https://49983-sbx.e2b.example.com/process.Process/Start');
});
