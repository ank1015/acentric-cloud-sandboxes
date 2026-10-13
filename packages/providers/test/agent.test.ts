// Runs the agent with the local python3 against a temporary folder, the way a
// sandbox runs it.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_PY } from '../src/agent.ts';

const root = await mkdtemp(join(tmpdir(), 'acentric-agent-'));
after(() => rm(root, { recursive: true, force: true }));

const b64 = (text: string) => Buffer.from(text).toString('base64');
const bytes = (value: unknown) => Buffer.from(String(value ?? ''), 'base64').toString();

/** Starts an execution and resolves with the supervisor's first line; it keeps running. */
function start(
  id: string,
  code: string,
  { cwd = '', python = 'python3', maxMs = '', env = '', detach = '0' } = {},
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(
      'python3',
      ['-c', AGENT_PY, 'start', root, id, b64(code), cwd, python, maxMs, env, detach],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[0];
      if (out.includes('\n')) {
        child.stdout.destroy();
        child.unref();
        resolve(JSON.parse(line!));
      }
    });
    child.on('error', reject);
  });
}

function run(...args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', AGENT_PY, ...args], (error, stdout) =>
      error ? reject(error) : resolve(JSON.parse(stdout)),
    );
  });
}

const wait = (id: string, cursor = 0, yieldMs = 5000, limit = 1000, mode = 'middle', final = '1') =>
  run('wait', root, id, String(cursor), String(yieldMs), String(limit), mode, final);
const kill = (id: string, cursor = 0, graceMs = 1000) =>
  run('kill', root, id, String(cursor), String(graceMs), '1000', 'middle');

test('runs to the end and records the exit code', async () => {
  const started = await start('exit3', 'import sys\nprint("hi")\nsys.exit(3)');
  assert.equal(typeof started.startedAt, 'number');
  const done = await wait('exit3');
  assert.equal(done.state.status, 'exited');
  assert.equal(done.state.exitCode, 3);
  assert.equal(bytes(done.head), 'hi\n');
  assert.equal(done.state.size, 3);
});

test('stdout and stderr share one log, in order', async () => {
  await start('mixed', 'import sys\nprint("a")\nprint("b", file=sys.stderr)\nprint("c")');
  const done = await wait('mixed');
  assert.equal(bytes(done.head), 'a\nb\nc\n');
});

test('yields while running, then reads on from the cursor', async () => {
  await start('slow', 'import time\nprint("one")\ntime.sleep(1.5)\nprint("two")');
  const first = await wait('slow', 0, 500);
  assert.equal(first.state.status, 'running');
  assert.equal(bytes(first.head), 'one\n');
  const second = await wait('slow', 4, 5000);
  assert.equal(second.state.status, 'exited');
  assert.equal(bytes(second.head), 'two\n');
});

test('an intermediate wait returns the state only', async () => {
  await start('quiet', 'import time\ntime.sleep(2)');
  const slice = await wait('quiet', 0, 200, 1000, 'middle', '0');
  assert.equal(slice.state.status, 'running');
  assert.equal(slice.head, undefined);
  await kill('quiet');
});

test('cuts long output in the middle, or pages it from the head', async () => {
  await start('long', 'print("x" * 50 + "y" * 50)');
  const middle = await wait('long', 0, 5000, 20, 'middle');
  assert.equal(bytes(middle.head), 'x'.repeat(10));
  assert.equal(bytes(middle.tail), 'y'.repeat(9) + '\n');
  assert.equal(middle.tailStart, 91);
  const page = await wait('long', 0, 5000, 20, 'head');
  assert.equal(bytes(page.head), 'x'.repeat(20));
  assert.equal(page.tail, undefined);
});

test('a head wait returns as soon as a page is there', async () => {
  await start('pager', 'import time\nprint("z" * 30)\ntime.sleep(5)');
  const begun = Date.now();
  const page = await wait('pager', 0, 4000, 10, 'head');
  assert.ok(Date.now() - begun < 3000);
  assert.equal(page.state.status, 'running');
  assert.equal(bytes(page.head), 'z'.repeat(10));
  await kill('pager');
});

test('kill ends Python and the children in its group', async () => {
  await start(
    'tree',
    'import subprocess, time\np = subprocess.Popen(["sleep", "30"])\nprint(p.pid, flush=True)\ntime.sleep(30)',
  );
  const early = await wait('tree', 0, 1000);
  const child = Number(bytes(early.head).trim());
  assert.ok(child > 0);
  const killed = await kill('tree');
  assert.equal(killed.state.status, 'killed');
  assert.equal(killed.state.signal, 'SIGTERM');
  assert.throws(() => process.kill(child, 0));
});

test('kill escalates to SIGKILL when SIGTERM is ignored', async () => {
  await start(
    'stubborn',
    'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(30)',
  );
  await wait('stubborn', 0, 3000, 6, 'head');
  const killed = await kill('stubborn', 0, 300);
  assert.equal(killed.state.status, 'killed');
  assert.equal(killed.state.signal, 'SIGKILL');
});

test('a script that handles SIGTERM keeps its exit code', async () => {
  await start(
    'graceful',
    'import signal, sys, time\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(5))\nprint("ready", flush=True)\ntime.sleep(30)',
  );
  await wait('graceful', 0, 3000, 6, 'head');
  const killed = await kill('graceful');
  assert.equal(killed.state.status, 'killed');
  assert.equal(killed.state.exitCode, 5);
});

test('kill leaves an ended execution as it was', async () => {
  await start('finished', 'print("done")');
  await wait('finished');
  const killed = await kill('finished');
  assert.equal(killed.state.status, 'exited');
  assert.equal(killed.state.exitCode, 0);
});

test('maxRuntimeMs times out', async () => {
  await start('forever', 'import time\ntime.sleep(30)', { maxMs: '500' });
  const done = await wait('forever');
  assert.equal(done.state.status, 'timed_out');
  assert.equal(done.state.signal, 'SIGKILL');
});

test('a second start with the same ID reports the first', async () => {
  await start('twice', 'print(1)');
  const again = await start('twice', 'print(2)');
  assert.equal(again.exists, true);
  assert.equal(
    again.sha256,
    (await import('node:crypto')).createHash('sha256').update('print(1)').digest('hex'),
  );
  assert.ok(again.state.startedAt);
});

test('a missing interpreter or directory ends with 127', async () => {
  await start('nopython', 'print(1)', { python: 'no-such-python' });
  const a = await wait('nopython');
  assert.equal(a.state.exitCode, 127);
  assert.match(bytes(a.head), /cannot run no-such-python/);
  await start('nodir', 'print(1)', { cwd: '/no/such/dir' });
  const b = await wait('nodir');
  assert.equal(b.state.exitCode, 127);
  assert.match(bytes(b.head), /no such directory/);
});

test('cwd is honoured', async () => {
  await start('where', 'import os\nprint(os.getcwd())', { cwd: '/' });
  assert.equal(bytes((await wait('where')).head), '/\n');
});

test('a cursor past the end and a missing execution are reported', async () => {
  await start('short', 'print("ab")');
  await wait('short');
  assert.equal((await wait('short', 99)).error, 'cursor');
  assert.equal((await wait('nope')).missing, true);
  assert.equal((await kill('nope')).missing, true);
});

test('lists, deletes and keeps running executions', async () => {
  await start('busy', 'import time\ntime.sleep(30)');
  const listed = await run('list', root);
  const ids = listed.executions.map((e: { id: string }) => e.id);
  assert.ok(ids.includes('busy') && ids.includes('exit3'));
  assert.equal((await run('delete', root, 'busy')).result, 'running');
  assert.equal((await run('delete', root, 'exit3')).result, 'deleted');
  assert.equal((await run('delete', root, 'exit3')).result, 'missing');
  const all = await run('delete-all', root);
  assert.deepEqual(all.running, ['busy']);
  assert.ok(all.deleted.includes('mixed'));
  await kill('busy');
  assert.deepEqual((await run('delete-all', root)).deleted, ['busy']);
});

test('env reaches the code', async () => {
  await start(
    'env',
    'import os\nprint(os.environ["GREETING"], os.environ.get("HOME") is not None)',
    {
      env: b64(JSON.stringify({ GREETING: 'hi there' })),
    },
  );
  assert.equal(bytes((await wait('env')).head), 'hi there True\n');
});

test('a detached start ends the call and keeps running', async () => {
  const begun = Date.now();
  const line = await new Promise<string>((resolve, reject) =>
    execFile(
      'python3',
      [
        '-c',
        AGENT_PY,
        'start',
        root,
        'detached',
        b64('import time\ntime.sleep(1)\nprint("later")'),
        '',
        'python3',
        '',
        '',
        '1',
      ],
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.ok(Date.now() - begun < 900, 'the call did not wait for the code');
  const started = JSON.parse(line);
  assert.equal(typeof started.pid, 'number');
  const done = await wait('detached');
  assert.equal(done.state.status, 'exited');
  assert.equal(bytes(done.head), 'later\n');
  assert.equal(done.state.pid, started.pid);
});
