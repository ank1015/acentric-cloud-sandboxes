// The Daytona adapter against a fake Daytona: the control plane's states and
// the toolbox's execute call.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { daytona } from '../src/index.ts';
import { quote } from '../src/shell.ts';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: Record<string, unknown>;
}

/** A fake whose sandbox goes through `states`, one per lookup, and whose toolbox answers `execute`. */
function fake(states: string[], execute: (body: Record<string, unknown>) => Response) {
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
    if (path === '/api/sandbox/missing') {
      return Response.json(
        { statusCode: 404, message: 'Sandbox with ID or name missing not found' },
        { status: 404 },
      );
    }
    if (path.endsWith('/start')) return Response.json({});
    if (path.startsWith('/api/sandbox/')) {
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return Response.json({ id: 'sbx-id', state, toolboxProxyUrl: 'https://proxy.test/toolbox' });
    }
    return execute(body);
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

const credentials = { apiKey: 'dtn_key' };
const ok =
  (result: string, exitCode = 0) =>
  () =>
    Response.json({ exitCode, result });

test('quoting keeps every argument whole for the daemon shell', () => {
  const args = ["it's", 'a b', '$HOME', '`x`', '"q"', 'line\nbreak', ''];
  const line = args.map(quote).join(' ');
  const echoed = execFileSync('sh', ['-c', `printf '%s\\0' ${line}`])
    .toString()
    .split('\0');
  assert.deepEqual(echoed.slice(0, -1), args);
});

test('run sends one quoted command with a deadline and returns its output', async () => {
  const { sent, fetch } = fake(['started'], ok('{"a":1}\n'));
  const sandbox = await daytona.open(credentials, 'my-sandbox', { fetch });
  assert.equal(
    await sandbox.run(['python3', '-c', "print('x')"], { timeoutMs: 4_500 }),
    '{"a":1}\n',
  );
  const [lookup, execute] = sent;
  assert.equal(lookup!.url, 'https://app.daytona.io/api/sandbox/my-sandbox');
  assert.equal(lookup!.headers.authorization, 'Bearer dtn_key');
  assert.equal(execute!.url, 'https://proxy.test/toolbox/sbx-id/process/execute');
  assert.equal(execute!.headers.authorization, 'Bearer dtn_key');
  assert.deepEqual(execute!.body, { command: `'python3' '-c' 'print('\\''x'\\'')'`, timeout: 5 });
});

test('a stopped sandbox is started and waited for', async () => {
  const { sent, fetch } = fake(['stopped', 'starting', 'started'], ok(''));
  await daytona.open(credentials, 'sbx', { fetch });
  assert.deepEqual(
    sent.map((s) => `${s.method} ${new URL(s.url).pathname}`),
    [
      'GET /api/sandbox/sbx',
      'POST /api/sandbox/sbx/start',
      'GET /api/sandbox/sbx',
      'GET /api/sandbox/sbx',
    ],
  );
});

test('unusable or unknown sandboxes are errors', async () => {
  await assert.rejects(daytona.open(credentials, 'sbx', { fetch: fake(['error'], ok('')).fetch }), {
    kind: 'sandbox_unavailable',
  });
  await assert.rejects(
    daytona.open(credentials, 'missing', { fetch: fake(['started'], ok('')).fetch }),
    {
      kind: 'not_found',
    },
  );
});

test('failed commands, a missing python3 and the daemon deadline', async () => {
  const failing = await daytona.open(credentials, 'sbx', {
    fetch: fake(['started'], ok('Traceback: boom', 1)).fetch,
  });
  await assert.rejects(failing.run(['x'], { timeoutMs: 1000 }), {
    kind: 'provider_error',
    message: /exit code 1.*boom/,
  });

  const bare = await daytona.open(credentials, 'sbx', {
    fetch: fake(['started'], ok('zsh:1: command not found: python3', 127)).fetch,
  });
  await assert.rejects(bare.run(['python3'], { timeoutMs: 1000 }), {
    kind: 'invalid_request',
    message: /has no python3/,
  });

  const slow = await daytona.open(credentials, 'sbx', {
    fetch: fake(['started'], () =>
      Response.json(
        {
          statusCode: 408,
          message: 'command execution timeout',
          code: 'PROCESS_EXECUTION_TIMEOUT',
        },
        { status: 408 },
      ),
    ).fetch,
  });
  await assert.rejects(slow.run(['x'], { timeoutMs: 1000 }), { kind: 'timeout' });
});
