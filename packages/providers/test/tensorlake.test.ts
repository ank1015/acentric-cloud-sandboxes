// The Tensorlake adapter against a fake sandbox host: `processes/run`
// answered as server-sent events.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tensorlake } from '../src/index.ts';

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fake(answer: (body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    return answer(body);
  }) as typeof fetch;
  return { sent, fetch: fetchFn };
}

/** A stream of events with comments between them, sent in 5-character pieces. */
function sse(events: readonly unknown[]): Response {
  const text = events.map((e) => `: keep-alive\n\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const credentials = { apiKey: 'tl_apiKey_x_y' };
const started = { handle: 1, pid: 40, started_at: 1 };
const line = (text: string, stream = 'stdout') => ({ line: text, timestamp: 2, stream });

test('run sends the command with a deadline and returns its stdout', async () => {
  const { sent, fetch } = fake(() =>
    sse([
      started,
      line('{"a":'),
      line('noise', 'stderr'),
      line('1}'),
      { exit_code: 0, reason: 'exited' },
    ]),
  );
  const sandbox = await tensorlake.open(credentials, 'My-Box', { fetch });
  assert.equal(await sandbox.run(['python3', '-c', 'x'], { timeoutMs: 4_500 }), '{"a":\n1}');
  const [run] = sent;
  assert.equal(run!.url, 'https://my-box.sandbox.tensorlake.ai/api/v1/processes/run');
  assert.equal(run!.headers.authorization, 'Bearer tl_apiKey_x_y');
  assert.deepEqual(run!.body, { command: 'python3', args: ['-c', 'x'], timeout: 5 });
});

test('a long line cut into 16 KiB pieces is joined again', async () => {
  const whole = 'y'.repeat(40_000);
  const { fetch } = fake(() =>
    sse([
      started,
      line(whole.slice(0, 16_384)),
      line(whole.slice(16_384, 32_768)),
      line(whole.slice(32_768)),
      line('next'),
      { exit_code: 0, reason: 'exited' },
    ]),
  );
  const sandbox = await tensorlake.open(credentials, 'box', { fetch });
  assert.equal(await sandbox.run(['x'], { timeoutMs: 1000 }), `${whole}\nnext`);
});

test('launch has no deadline, so the detached agent outlives the call', async () => {
  const { sent, fetch } = fake(() =>
    sse([started, line('{"pid":41}'), { exit_code: 0, reason: 'exited' }]),
  );
  const sandbox = await tensorlake.open(credentials, 'box', { fetch });
  assert.equal(await sandbox.launch(['python3', '-c', 'x']), '{"pid":41}');
  assert.deepEqual(sent[0]!.body, { command: 'python3', args: ['-c', 'x'] });
});

test('a malformed sandbox ID never reaches the network', async () => {
  const { sent, fetch } = fake(() => sse([]));
  await assert.rejects(tensorlake.open(credentials, 'not a sandbox', { fetch }), {
    kind: 'invalid_request',
  });
  assert.equal(sent.length, 0);
});

test('failures: exit codes, the deadline, no python3, unknown sandboxes', async () => {
  const run = async (answer: () => Response) =>
    (await tensorlake.open(credentials, 'box', { fetch: fake(answer).fetch })).run(['python3'], {
      timeoutMs: 1000,
    });
  await assert.rejects(
    run(() => sse([started, line('boom', 'stderr'), { exit_code: 1, reason: 'exited' }])),
    { kind: 'provider_error', message: /exit code 1.*boom/ },
  );
  await assert.rejects(
    run(() => sse([started, { signal: 9, reason: 'timed_out' }])),
    {
      kind: 'timeout',
    },
  );
  await assert.rejects(
    run(() =>
      Response.json(
        {
          error:
            'Failed to spawn process: spawn process: spawn failed: No such file or directory (os error 2)',
        },
        { status: 500 },
      ),
    ),
    { kind: 'invalid_request', message: /has no python3/ },
  );
  await assert.rejects(
    run(() =>
      Response.json(
        { error: "Sandbox 'box' not found. Verify the sandbox exists.", code: 'SANDBOX_NOT_FOUND' },
        { status: 404 },
      ),
    ),
    { kind: 'not_found', providerCode: 'SANDBOX_NOT_FOUND' },
  );
});
