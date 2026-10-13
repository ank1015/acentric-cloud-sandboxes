// End-to-end checks on a real sandbox, through a running gateway or the
// operations directly. Creates its own sandbox and deletes it at the end.
//
//   PROVIDER=e2b E2B_API_KEY=... GATEWAY_URL=http://localhost:8787 node --conditions=source scripts/live.ts
//   PROVIDER=daytona DAYTONA_API_KEY=... node --conditions=source scripts/live.ts
//   PROVIDER=blaxel BLAXEL_API_KEY=... [BLAXEL_WORKSPACE=...] node --conditions=source scripts/live.ts
//   PROVIDER=tensorlake TENSORLAKE_API_KEY=... node --conditions=source scripts/live.ts
//
// Takes about three minutes. Keys are read from the environment and never printed.

import assert from 'node:assert/strict';
import {
  ROUTES,
  SandboxError,
  type ExecutionHandle,
  type ExecutionResult,
  type ListResponse,
  type SandboxErrorKind,
  type StartResponse,
} from '@acentric-sandboxes/contracts';
import * as operations from '@acentric-sandboxes/providers';

/** What differs per provider: the sandbox itself, and how it can be interrupted. */
interface Setup {
  readonly credentials: Readonly<Record<string, string>>;
  readonly badCredentials: Readonly<Record<string, string>>;
  /** The sandbox user's home, the default working directory. */
  readonly home: string;
  readonly unknownSandboxId: string;
  readonly malformedSandboxId: { readonly id: string; readonly kind: SandboxErrorKind };
  create(): Promise<string>;
  remove(sandboxId: string): Promise<void>;
  /** Takes the sandbox away mid-run and checks what the next call does. */
  readonly interrupt: {
    readonly name: string;
    run(sandboxId: string, execution: ExecutionHandle, cursor: number): Promise<object>;
  };
}

function key(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

async function api(url: string, headers: Record<string, string>, method = 'GET', body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SETUPS: Record<string, () => Setup> = {
  e2b() {
    const apiKey = key('E2B_API_KEY');
    const e2bApi = (method: string, path: string, body?: unknown) =>
      api(`https://api.e2b.app${path}`, { 'x-api-key': apiKey }, method, body);
    return {
      credentials: { apiKey },
      badCredentials: { apiKey: 'e2b_0000000000000000000000000000000000000000' },
      home: '/home/user',
      unknownSandboxId: 'i0000000000000000000a',
      malformedSandboxId: { id: 'not a sandbox', kind: 'invalid_request' },
      create: async () =>
        (await e2bApi('POST', '/v2/sandboxes', { templateID: 'base', timeout: 1800 })).sandboxID,
      remove: async (sandboxId) => void (await e2bApi('DELETE', `/sandboxes/${sandboxId}`)),
      interrupt: {
        name: 'a paused sandbox is resumed, and the script carries on',
        async run(sandboxId, execution, cursor) {
          await e2bApi('POST', `/sandboxes/${sandboxId}/pause`);
          const state = (await e2bApi('GET', `/sandboxes/${sandboxId}`)).state;
          assert.equal(state, 'paused');
          const done = await wait(execution, cursor, { yieldMs: 30_000 });
          assert.equal(done.status, 'exited');
          assert.equal(done.output, '2\n3\n4\n5\n6\n7\n8\n9\n');
          return { stateWhilePaused: state, done: brief(done) };
        },
      },
    };
  },
  daytona() {
    const apiKey = key('DAYTONA_API_KEY');
    const daytonaApi = (method: string, path: string, body?: unknown) =>
      api(`https://app.daytona.io/api${path}`, { authorization: `Bearer ${apiKey}` }, method, body);
    const until = async (sandboxId: string, state: string) => {
      for (let i = 0; i < 120; i += 1) {
        const info = await daytonaApi('GET', `/sandbox/${sandboxId}`);
        if (info.state === state) return;
        await sleep(1000);
      }
      throw new Error(`sandbox never reached ${state}`);
    };
    return {
      credentials: { apiKey },
      badCredentials: { apiKey: 'dtn_0000' },
      home: '/home/daytona',
      unknownSandboxId: '00000000-0000-0000-0000-000000000000',
      malformedSandboxId: { id: 'not a sandbox', kind: 'not_found' },
      async create() {
        const { id } = await daytonaApi('POST', '/sandbox', {
          autoStopInterval: 0,
          autoDeleteInterval: 60,
          labels: { purpose: 'acentric-live' },
        });
        await until(id, 'started');
        return id;
      },
      remove: async (sandboxId) => void (await daytonaApi('DELETE', `/sandbox/${sandboxId}`)),
      interrupt: {
        name: 'a stopped sandbox is started again; its run is lost',
        async run(sandboxId, execution, cursor) {
          await daytonaApi('POST', `/sandbox/${sandboxId}/stop`);
          await until(sandboxId, 'stopped');
          const begun = Date.now();
          const after = await wait(execution, cursor, { yieldMs: 5_000 });
          assert.equal(after.status, 'lost', 'stopping kills the processes');
          const { execution: fresh } = await start('print("running again")');
          assert.equal((await wait(fresh)).output, 'running again\n');
          return { startMs: Date.now() - begun, after: brief(after) };
        },
      },
    };
  },
  blaxel() {
    const apiKey = key('BLAXEL_API_KEY');
    const workspace = process.env.BLAXEL_WORKSPACE;
    const blaxelApi = (method: string, path: string, body?: unknown) =>
      api(
        `https://api.blaxel.ai/v0${path}`,
        {
          authorization: `Bearer ${apiKey}`,
          ...(workspace ? { 'x-blaxel-workspace': workspace } : {}),
        },
        method,
        body,
      );
    return {
      credentials: { apiKey, ...(workspace ? { workspace } : {}) },
      badCredentials: { apiKey: 'bl_0000' },
      home: '/blaxel',
      unknownSandboxId: 'acx-no-such-sandbox',
      malformedSandboxId: { id: 'not a sandbox', kind: 'not_found' },
      async create() {
        const name = `acx-live-${Date.now().toString(36)}`;
        await blaxelApi('POST', '/sandboxes', {
          metadata: { name, labels: { purpose: 'acentric-live' } },
          spec: {
            runtime: { image: 'blaxel/py-app:latest', memory: 2048 },
            lifecycle: {
              expirationPolicies: [{ type: 'ttl-max-age', value: '2h', action: 'delete' }],
            },
          },
        });
        for (let i = 0; i < 120; i += 1) {
          if ((await blaxelApi('GET', `/sandboxes/${name}`)).status === 'DEPLOYED') return name;
          await sleep(1000);
        }
        throw new Error('sandbox never deployed');
      },
      remove: async (sandboxId) => void (await blaxelApi('DELETE', `/sandboxes/${sandboxId}`)),
      interrupt: {
        name: 'a script left alone keeps running; a sandbox in standby wakes',
        async run(_sandboxId, execution, cursor) {
          assert.equal((await wait(execution, cursor, { yieldMs: 15_000 })).status, 'exited');
          const { execution: ticking } = await start(
            'import time\nfor _ in range(30):\n    print(time.time(), flush=True)\n    time.sleep(1)',
          );
          // Past the script's end and the ~15 s Blaxel waits before standby.
          await sleep(50_000);
          const begun = Date.now();
          const done = await wait(ticking, 0, { yieldMs: 5_000 });
          const wakeMs = Date.now() - begun;
          assert.equal(done.status, 'exited');
          const ticks = done.output.trim().split('\n').map(Number);
          const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!);
          assert.equal(ticks.length, 30);
          assert.ok(Math.max(...gaps) < 3, `a gap of ${Math.max(...gaps)} s: frozen in standby`);
          return { wakeMs, maxGapS: Math.max(...gaps), runtimeMs: done.runtimeMs };
        },
      },
    };
  },
  tensorlake() {
    const apiKey = key('TENSORLAKE_API_KEY');
    const tensorlakeApi = (method: string, path: string, body?: unknown) =>
      api(`https://api.tensorlake.ai${path}`, { authorization: `Bearer ${apiKey}` }, method, body);
    const until = async (sandboxId: string, status: string) => {
      for (let i = 0; i < 120; i += 1) {
        if ((await tensorlakeApi('GET', `/sandboxes/${sandboxId}`)).status === status) return;
        await sleep(1000);
      }
      throw new Error(`sandbox never reached ${status}`);
    };
    return {
      credentials: { apiKey },
      badCredentials: { apiKey: 'tl_apiKey_0000_0000' },
      home: '/home/tl-user',
      unknownSandboxId: 'acx-no-such-sandbox',
      malformedSandboxId: { id: 'not a sandbox', kind: 'invalid_request' },
      async create() {
        const { sandbox_id: id } = await tensorlakeApi('POST', '/sandboxes', {
          name: `acx-live-${Date.now().toString(36)}`,
          timeout_secs: 1800,
        });
        await until(id, 'running');
        return id;
      },
      remove: async (sandboxId) => void (await tensorlakeApi('DELETE', `/sandboxes/${sandboxId}`)),
      interrupt: {
        name: 'a suspended sandbox is resumed by the next call, and the script carries on',
        async run(sandboxId, execution, cursor) {
          await tensorlakeApi('POST', `/sandboxes/${sandboxId}/suspend`);
          await until(sandboxId, 'suspended');
          await sleep(3000);
          const done = await wait(execution, cursor, { yieldMs: 30_000 });
          assert.equal(done.status, 'exited');
          assert.equal(done.output, '2\n3\n4\n5\n6\n7\n8\n9\n');
          return { done: brief(done) };
        },
      },
    };
  },
};

const provider = process.env.PROVIDER ?? 'e2b';
const setup = SETUPS[provider]?.();
if (!setup) throw new Error(`PROVIDER must be one of ${Object.keys(SETUPS).join(', ')}.`);
const { credentials } = setup;
const secrets = Object.values(credentials);
const gateway = process.env.GATEWAY_URL;

const DIRECT: Record<string, (body: never) => Promise<unknown>> = {
  [ROUTES.start]: operations.start,
  [ROUTES.wait]: operations.wait,
  [ROUTES.kill]: operations.kill,
  [ROUTES.list]: operations.list,
  [ROUTES.delete]: operations.deleteExecution,
  [ROUTES.deleteAll]: operations.deleteAll,
};

async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
  const full = { provider, credentials, ...body };
  if (!gateway) return (await DIRECT[route]!(full as never)) as T;
  const response = await fetch(gateway + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(full),
  });
  const answer = (await response.json()) as { error?: unknown };
  if (answer.error) {
    throw Object.assign(SandboxError.fromJSON(answer.error as never), { status: response.status });
  }
  return answer as T;
}

async function failure(run: () => Promise<unknown>): Promise<SandboxError & { status?: number }> {
  try {
    await run();
  } catch (error) {
    assert.ok(SandboxError.is(error), `a SandboxError, not ${String(error)}`);
    return error;
  }
  assert.fail('expected an error');
}

const sandboxId: string = await setup.create();
const run = Date.now().toString(36);
let serial = 0;
const nextId = (name: string) => `${name}-${run}-${(serial += 1)}`;

const start = (code: string, extra: Record<string, unknown> = {}) =>
  call<StartResponse>(ROUTES.start, { sandboxId, id: nextId('x'), code, ...extra });
const wait = (execution: ExecutionHandle, cursor = 0, extra: Record<string, unknown> = {}) =>
  call<ExecutionResult>(ROUTES.wait, { execution, cursor, ...extra });
const kill = (execution: ExecutionHandle, cursor = 0, extra: Record<string, unknown> = {}) =>
  call<ExecutionResult>(ROUTES.kill, { execution, cursor, ...extra });

const results: [string, 'ok' | 'FAIL', unknown][] = [];
async function check(name: string, body: () => Promise<unknown>) {
  const begun = Date.now();
  try {
    const detail = await body();
    results.push([name, 'ok', { ms: Date.now() - begun, ...(detail as object) }]);
  } catch (error) {
    results.push([name, 'FAIL', SandboxError.is(error) ? error.toJSON() : String(error)]);
  }
  const [, status] = results.at(-1)!;
  console.log(`[${status}] ${name}`);
}

function brief(result: ExecutionResult) {
  const { execution: _e, ...rest } = result;
  return {
    ...rest,
    output: rest.output.length > 120 ? `${rest.output.slice(0, 120)}…` : rest.output,
  };
}

try {
  await check('a quick script: exit code, output and UTF-8', async () => {
    const { execution, created: fresh } = await start('print("héllo, wörld 😀")');
    assert.equal(fresh, true);
    assert.equal(typeof (execution.native as { pid?: unknown }).pid, 'number');
    const done = await wait(execution);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 0);
    assert.equal(done.output, 'héllo, wörld 😀\n');
    assert.equal(done.nextCursor, done.outputBytes);
    return brief(done);
  });

  await check('yields while running; the cursor returns only new output', async () => {
    const { execution } = await start(
      'import time\nfor i in range(4):\n    print("step", i, flush=True)\n    time.sleep(2)',
    );
    const first = await wait(execution, 0, { yieldMs: 1000 });
    assert.equal(first.status, 'running');
    assert.match(first.output, /^step 0\n/);
    assert.doesNotMatch(first.output, /step 3/);
    const second = await wait(execution, first.nextCursor, { yieldMs: 15_000 });
    assert.equal(second.status, 'exited');
    assert.equal(first.output + second.output, 'step 0\nstep 1\nstep 2\nstep 3\n');
    const again = await wait(execution, first.nextCursor, { yieldMs: 0 });
    assert.equal(
      again.output,
      second.output,
      'a retry with the same cursor repeats the same bytes',
    );
    return { first: brief(first), second: brief(second) };
  });

  await check('stderr joins stdout in order; a failing exit code', async () => {
    const { execution } = await start(
      'import sys\nprint("out", flush=True)\nprint("err", file=sys.stderr, flush=True)\nraise SystemExit(7)',
    );
    const done = await wait(execution);
    assert.equal(done.status, 'exited');
    assert.equal(done.exitCode, 7);
    assert.equal(done.output, 'out\nerr\n');
    return brief(done);
  });

  await check('an uncaught exception: traceback and exit code 1', async () => {
    const { execution } = await start('def f():\n    1 / 0\nf()');
    const done = await wait(execution);
    assert.equal(done.exitCode, 1);
    assert.match(done.output, /ZeroDivisionError/);
    return brief(done);
  });

  await check('env, cwd and interpreter', async () => {
    const { execution } = await start(
      'import os, sys\nprint(os.environ["GREETING"], os.getcwd(), sys.version_info[0])',
      { env: { GREETING: 'hi there' }, cwd: '/tmp', python: 'python3' },
    );
    const done = await wait(execution);
    assert.equal(done.output, 'hi there /tmp 3\n');
    const { execution: home } = await start('import os\nprint(os.getcwd())');
    assert.equal((await wait(home)).output, `${setup.home}\n`);
    return brief(done);
  });

  await check('a missing interpreter or directory ends with 127', async () => {
    const { execution } = await start('print(1)', { python: 'no-such-python' });
    const done = await wait(execution);
    assert.equal(done.exitCode, 127);
    assert.match(done.output, /cannot run no-such-python/);
    const { execution: nodir } = await start('print(1)', { cwd: '/no/such/dir' });
    assert.match((await wait(nodir)).output, /no such directory/);
    return brief(done);
  });

  await check('a retried start returns the same execution; other code conflicts', async () => {
    const id = nextId('retry');
    const code = 'import time\nprint("once", flush=True)\ntime.sleep(2)';
    const first = await call<StartResponse>(ROUTES.start, { sandboxId, id, code });
    const second = await call<StartResponse>(ROUTES.start, { sandboxId, id, code });
    assert.equal(second.created, false);
    assert.deepEqual(second.execution, first.execution);
    const conflict = await failure(() =>
      call(ROUTES.start, { sandboxId, id, code: 'print("twice")' }),
    );
    assert.equal(conflict.kind, 'conflict');
    const done = await wait(first.execution);
    assert.equal(done.output, 'once\n', 'the code ran once');
    return { conflict: conflict.message, status: conflict.status };
  });

  await check('long output: cut in the middle, or paged from the head', async () => {
    const { execution } = await start('for i in range(20000):\n    print("line %05d" % i)');
    const middle = await wait(execution, 0, { maxOutputBytes: 1000 });
    assert.equal(middle.status, 'exited');
    assert.equal(middle.outputBytes, 220_000);
    assert.equal(middle.nextCursor, 220_000);
    assert.equal(middle.omittedBytes, 219_000);
    assert.match(
      middle.output,
      /^line 00000\n[\s\S]*\n\.\.\. 219000 bytes omitted \.\.\.\n[\s\S]*line 19999\n$/,
    );
    const page = await wait(execution, 0, { maxOutputBytes: 1100, truncate: 'head' });
    assert.equal(page.nextCursor, 1100);
    assert.equal(
      page.output,
      Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(5, '0')}\n`).join(''),
    );
    const next = await wait(execution, page.nextCursor, { maxOutputBytes: 11, truncate: 'head' });
    assert.equal(next.output, 'line 00100\n');
    return { middle: brief(middle), page: page.nextCursor };
  });

  await check('the largest output a wait returns: 1 MiB, byte for byte', async () => {
    const { execution } = await start('for i in range(100000):\n    print("line %06d" % i)');
    const page = await wait(execution, 0, { maxOutputBytes: 1_048_576, truncate: 'head' });
    const expected = Array.from(
      { length: 100_000 },
      (_, i) => `line ${String(i).padStart(6, '0')}\n`,
    )
      .join('')
      .slice(0, 1_048_576);
    // A head wait returns once a full page is there, maybe before the script ends.
    assert.ok(page.outputBytes >= 1_048_576);
    assert.equal(page.nextCursor, 1_048_576);
    assert.ok(page.output === expected, 'the page is the first 1 MiB exactly');
    return { nextCursor: page.nextCursor };
  });

  await check('a head wait returns as soon as a page is there', async () => {
    const { execution } = await start('import time\nprint("x" * 5000, flush=True)\ntime.sleep(60)');
    const begun = Date.now();
    const page = await wait(execution, 0, {
      yieldMs: 30_000,
      maxOutputBytes: 1000,
      truncate: 'head',
    });
    assert.ok(Date.now() - begun < 15_000, 'returned early');
    assert.equal(page.status, 'running');
    assert.equal(page.output, 'x'.repeat(1000));
    const killed = await kill(execution, page.nextCursor, { maxOutputBytes: 10 });
    assert.equal(killed.status, 'killed');
    return { page: brief(page), killed: brief(killed) };
  });

  await check('kill ends Python and the children it started', async () => {
    const { execution } = await start(
      'import subprocess, time\nsubprocess.Popen(["sleep", "301"])\nprint("started", flush=True)\ntime.sleep(300)',
    );
    const early = await wait(execution, 0, { yieldMs: 2000 });
    assert.equal(early.status, 'running');
    const killed = await kill(execution, early.nextCursor);
    assert.equal(killed.status, 'killed');
    assert.equal(killed.signal, 'SIGTERM');
    const { execution: ps } = await start(
      'import subprocess\nprint(subprocess.run(["sh", "-c", "ps -eo args | grep -c \'^sleep 301\' || true"], capture_output=True, text=True).stdout.strip())',
    );
    assert.equal((await wait(ps)).output, '0\n', 'no sleep 301 left');
    return brief(killed);
  });

  await check('kill escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { execution } = await start(
      'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(300)',
    );
    await wait(execution, 0, { yieldMs: 2000 });
    const begun = Date.now();
    const killed = await kill(execution, 0, { graceMs: 1000 });
    assert.equal(killed.status, 'killed');
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(killed.output, 'ready\n');
    return { ...brief(killed), killMs: Date.now() - begun };
  });

  await check('a script that handles SIGTERM keeps its exit code', async () => {
    const { execution } = await start(
      'import signal, sys, time\ndef stop(*_):\n    print("cleaning up", flush=True)\n    sys.exit(4)\nsignal.signal(signal.SIGTERM, stop)\nprint("ready", flush=True)\ntime.sleep(300)',
    );
    await wait(execution, 0, { yieldMs: 2000 });
    const killed = await kill(execution);
    assert.equal(killed.status, 'killed');
    assert.equal(killed.exitCode, 4);
    assert.equal(killed.output, 'ready\ncleaning up\n');
    const again = await kill(execution);
    assert.equal(again.status, 'killed', 'a second kill changes nothing');
    return brief(killed);
  });

  await check('maxRuntimeMs times out', async () => {
    const { execution } = await start('import time\nprint("begin", flush=True)\ntime.sleep(60)', {
      maxRuntimeMs: 1500,
    });
    const done = await wait(execution, 0, { yieldMs: 20_000 });
    assert.equal(done.status, 'timed_out');
    assert.equal(done.signal, 'SIGKILL');
    assert.ok(done.runtimeMs >= 1500 && done.runtimeMs < 5000);
    return brief(done);
  });

  await check('code near the 64 KiB limit runs', async () => {
    const code = `# ${'x'.repeat(65_000)}\nprint("big")`;
    const { execution } = await start(code);
    assert.equal((await wait(execution)).output, 'big\n');
    return { bytes: code.length };
  });

  await check('a wait longer than one provider request returns when the script ends', async () => {
    const { execution } = await start('import time\ntime.sleep(58)\nprint("done")');
    const begun = Date.now();
    const done = await wait(execution, 0, { yieldMs: 120_000 });
    const ms = Date.now() - begun;
    assert.equal(done.status, 'exited');
    assert.equal(done.output, 'done\n');
    assert.ok(ms > 50_000 && ms < 70_000, `took ${ms} ms`);
    return { waitedMs: ms, runtimeMs: done.runtimeMs };
  });

  await check(setup.interrupt.name, async () => {
    const { execution } = await start(
      'import time\nfor i in range(10):\n    print(i, flush=True)\n    time.sleep(1)',
    );
    const early = await wait(execution, 0, { yieldMs: 1500, maxOutputBytes: 4, truncate: 'head' });
    assert.equal(early.output, '0\n1\n');
    return setup.interrupt.run(sandboxId, execution, early.nextCursor);
  });

  await check('list, delete and delete-all', async () => {
    const { execution: busy } = await start('import time\ntime.sleep(300)');
    const listed = await call<ListResponse>(ROUTES.list, { sandboxId });
    const ids = listed.executions.map((e) => e.execution.id);
    assert.ok(ids.includes(busy.id));
    const running = listed.executions.find((e) => e.execution.id === busy.id)!;
    assert.equal(running.status, 'running');
    assert.deepEqual(running.execution, busy);
    const stillRunning = await failure(() => call(ROUTES.delete, { sandboxId, id: busy.id }));
    assert.equal(stillRunning.kind, 'conflict');
    const finished = listed.executions.find((e) => e.status === 'exited')!;
    assert.deepEqual(await call(ROUTES.delete, { sandboxId, id: finished.execution.id }), {
      deleted: true,
    });
    assert.deepEqual(await call(ROUTES.delete, { sandboxId, id: finished.execution.id }), {
      deleted: false,
    });
    const all = await call<{ deleted: string[]; running: string[] }>(ROUTES.deleteAll, {
      sandboxId,
    });
    assert.deepEqual(all.running, [busy.id]);
    await kill(busy);
    const rest = await call<ListResponse>(ROUTES.list, { sandboxId });
    assert.deepEqual(
      rest.executions.map((e) => e.execution.id),
      [busy.id],
    );
    return { listed: ids.length, deleted: all.deleted.length, running: all.running };
  });

  await check('errors: unknown sandbox, bad key, bad cursor, missing execution', async () => {
    const { execution } = await start('print("ab")');
    await wait(execution);
    const noSandbox = await failure(() => call(ROUTES.list, { sandboxId: setup.unknownSandboxId }));
    const malformed = await failure(() =>
      call(ROUTES.list, { sandboxId: setup.malformedSandboxId.id }),
    );
    const badKey = await failure(() =>
      call(ROUTES.list, { sandboxId, credentials: setup.badCredentials }),
    );
    const cursor = await failure(() => wait(execution, 999));
    const missing = await failure(() => wait({ ...execution, id: 'never-started' }));
    assert.equal(noSandbox.kind, 'not_found');
    assert.equal(malformed.kind, setup.malformedSandboxId.kind);
    assert.equal(badKey.kind, 'auth');
    assert.equal(cursor.kind, 'invalid_request');
    assert.equal(missing.kind, 'not_found');
    return Object.fromEntries(
      Object.entries({ noSandbox, malformed, badKey, cursor, missing }).map(([name, error]) => [
        name,
        { kind: error.kind, status: error.status, message: error.message },
      ]),
    );
  });
} finally {
  await setup.remove(sandboxId).catch((error) => console.error(String(error)));
}

console.log(
  `\n${provider}, ${gateway ? `gateway ${gateway}` : 'direct'}, sandbox ${sandboxId} (deleted)`,
);
for (const [name, status, detail] of results) {
  console.log(`\n[${status}] ${name}`);
  let text = JSON.stringify(detail, null, 1);
  for (const secret of secrets) text = text.replaceAll(secret, '<key>');
  console.log(text);
}
process.exitCode = results.some(([, status]) => status === 'FAIL') ? 1 : 0;
