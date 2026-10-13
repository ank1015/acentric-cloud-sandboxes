import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXECUTION_ID_PATTERN, MAX_CODE_BYTES } from '../src/index.ts';

test('execution IDs are safe as folder names', () => {
  for (const id of ['run_1', 'A-b_9', 'x'.repeat(64)]) assert.match(id, EXECUTION_ID_PATTERN);
  for (const id of ['', 'x'.repeat(65), '../etc', 'a/b', 'a b', 'a.b', "a'b", 'é']) {
    assert.doesNotMatch(id, EXECUTION_ID_PATTERN);
  }
});

test('the largest code fits one Linux argument once base64-encoded', () => {
  const encoded = Math.ceil(MAX_CODE_BYTES / 3) * 4;
  assert.ok(encoded + 4096 < 128 * 1024, 'room left for the wrapper');
});
