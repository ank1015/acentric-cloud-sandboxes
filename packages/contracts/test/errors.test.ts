import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SANDBOX_ERROR_KINDS, SandboxError, type ErrorResponse } from '../src/index.ts';

test('retryable defaults by kind and can be overridden', () => {
  assert.equal(new SandboxError('slow down', { kind: 'rate_limited' }).retryable, true);
  assert.equal(new SandboxError('waking', { kind: 'sandbox_unavailable' }).retryable, true);
  assert.equal(new SandboxError('id reused', { kind: 'conflict' }).retryable, false);
  assert.equal(
    new SandboxError('upstream 501', { kind: 'provider_error', retryable: false }).retryable,
    false,
  );
});

test('every kind has a default', () => {
  for (const kind of SANDBOX_ERROR_KINDS) {
    assert.equal(typeof new SandboxError(kind, { kind }).retryable, 'boolean');
  }
});

test('round-trips through JSON without native detail or the stack', () => {
  const error = new SandboxError('Execution run_1 was started with other code.', {
    kind: 'conflict',
    provider: 'e2b',
    sandboxId: 'sbx_1',
    executionId: 'run_1',
    nativeError: { raw: 'body' },
  });

  const body: ErrorResponse = JSON.parse(JSON.stringify({ error }));
  assert.deepEqual(body, {
    error: {
      message: 'Execution run_1 was started with other code.',
      kind: 'conflict',
      retryable: false,
      provider: 'e2b',
      sandboxId: 'sbx_1',
      executionId: 'run_1',
    },
  });

  const restored = SandboxError.fromJSON(body.error);
  assert.ok(restored instanceof SandboxError);
  assert.equal(restored.name, 'SandboxError');
  assert.equal(restored.nativeError, undefined);
  assert.deepEqual(restored.toJSON(), body.error);
});

test('absent options stay absent', () => {
  const error = new SandboxError('no sandbox', { kind: 'not_found', httpStatus: undefined });
  assert.equal(Object.hasOwn(error, 'httpStatus'), false);
  assert.deepEqual(Object.keys(error.toJSON()), ['message', 'kind', 'retryable']);
});

test('recognizes errors from another copy of the package', () => {
  const foreign = Object.assign(new Error('x'), { name: 'SandboxError', kind: 'auth' });
  assert.ok(SandboxError.is(foreign));
  assert.ok(!SandboxError.is(new Error('x')));
});
