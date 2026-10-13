import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CODE_BYTES, SandboxError } from '@acentric-sandboxes/contracts';
import { adapterFor, parseKill, parseStart, parseWait } from '../src/index.ts';

const credentials = { apiKey: 'e2b_test' };
const execution = {
  provider: 'e2b',
  sandboxId: 'sbx',
  id: 'run_1',
  startedAt: '2026-10-12T00:00:00.000Z',
  native: { pid: 7 },
};

function refused(run: () => unknown, pattern: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(SandboxError.is(error));
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, pattern);
    return true;
  });
}

test('a start request is read as sent', () => {
  const body = {
    provider: 'e2b',
    credentials: { apiKey: 'k', domain: 'e2b.dev' },
    sandboxId: 'sbx',
    id: 'run-1_A',
    code: 'print(1)',
    env: { MODE: 'x', _A1: '' },
    cwd: '/work',
    python: '/venv/bin/python',
    maxRuntimeMs: 1000,
  };
  assert.deepEqual(parseStart(body, adapterFor), body);
});

test('a start request is refused rather than guessed at', () => {
  const base = { provider: 'e2b', credentials, sandboxId: 'sbx', id: 'run', code: 'print(1)' };
  refused(
    () => parseStart({ ...base, provider: 'modal' }, adapterFor),
    /provider must be one of e2b, daytona, blaxel, tensorlake/,
  );
  refused(() => parseStart({ ...base, timeout: 5 }, adapterFor), /unknown fields: timeout/);
  refused(
    () => parseStart({ ...base, credentials: { apiKey: 'k', extra: 1 } }, adapterFor),
    /unknown fields: extra/,
  );
  refused(() => parseStart({ ...base, credentials: {} }, adapterFor), /credentials.apiKey/);
  refused(() => parseStart({ ...base, id: '../x' }, adapterFor), /id must match/);
  refused(
    () => parseStart({ ...base, code: 'x'.repeat(MAX_CODE_BYTES + 1) }, adapterFor),
    /the most is 65536/,
  );
  refused(() => parseStart({ ...base, env: { 'A-B': 'x' } }, adapterFor), /env name/);
  refused(() => parseStart({ ...base, env: { A: 1 } }, adapterFor), /env.A/);
  refused(() => parseStart({ ...base, maxRuntimeMs: 0 }, adapterFor), /maxRuntimeMs/);
  refused(() => parseStart({ ...base, cwd: '' }, adapterFor), /cwd/);
});

test('wait and kill check the handle, cursor and limits', () => {
  const base = { provider: 'e2b', credentials, execution, cursor: 0 };
  assert.deepEqual(
    parseWait({ ...base, yieldMs: 0, truncate: 'head', maxOutputBytes: 10 }, adapterFor),
    {
      ...base,
      yieldMs: 0,
      truncate: 'head',
      maxOutputBytes: 10,
    },
  );
  refused(() => parseWait({ ...base, yieldMs: 15 * 60_000 + 1 }, adapterFor), /yieldMs/);
  refused(() => parseWait({ ...base, cursor: -1 }, adapterFor), /cursor/);
  refused(() => parseWait({ ...base, cursor: 1.5 }, adapterFor), /cursor/);
  refused(() => parseWait({ ...base, truncate: 'tail' }, adapterFor), /truncate/);
  refused(() => parseWait({ ...base, maxOutputBytes: 0 }, adapterFor), /maxOutputBytes/);
  refused(
    () => parseWait({ ...base, execution: { ...execution, provider: 'daytona' } }, adapterFor),
    /belongs to daytona/,
  );
  refused(
    () => parseWait({ ...base, execution: { ...execution, extra: 1 } }, adapterFor),
    /unknown fields/,
  );
  refused(() => parseKill({ ...base, graceMs: 30_001 }, adapterFor), /graceMs/);
  refused(() => parseKill({ ...base, yieldMs: 5 }, adapterFor), /unknown fields: yieldMs/);
});
