import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutput, wholeLength } from '../src/index.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

test('wholeLength leaves out an unfinished character at the end', () => {
  const euro = utf8('a€'); // 61 e2 82 ac
  assert.equal(wholeLength(euro), 4);
  assert.equal(wholeLength(euro.subarray(0, 3)), 1);
  assert.equal(wholeLength(euro.subarray(0, 2)), 1);
  assert.equal(wholeLength(utf8('😀').subarray(0, 3)), 0);
  assert.equal(wholeLength(new Uint8Array([0x80, 0x80, 0x80, 0x80])), 4, 'invalid bytes are kept');
});

test('a running execution keeps a cut character for the next read', () => {
  const bytes = utf8('héllo').subarray(0, 2); // h + first byte of é
  const out = readOutput({ cursor: 10, size: 20, head: bytes, ended: false });
  assert.deepEqual(out, { output: 'h', nextCursor: 11, omittedBytes: 0 });
});

test('an ended execution decodes what is left at the end of the log', () => {
  const bytes = new Uint8Array([0x68, 0xc3]);
  const out = readOutput({ cursor: 0, size: 2, head: bytes, ended: true });
  assert.equal(out.output, 'h�');
  assert.equal(out.nextCursor, 2);
});

test('middle truncation joins head and tail at whole characters', () => {
  const log = utf8('ééééé-----ééééé'); // 10 + 5 + 10 bytes
  const head = log.subarray(0, 5); // 2.5 é
  const tail = log.subarray(log.length - 5); // half an é, then 2 é
  const out = readOutput({
    cursor: 0,
    size: log.length,
    head,
    tail,
    tailStart: log.length - 5,
    ended: true,
  });
  assert.equal(out.output, 'éé\n... 17 bytes omitted ...\néé');
  assert.equal(out.omittedBytes, 17);
  assert.equal(out.nextCursor, log.length);
});

test('head truncation pages from the cursor', () => {
  const out = readOutput({ cursor: 100, size: 1000, head: utf8('abc'), ended: true });
  assert.deepEqual(out, { output: 'abc', nextCursor: 103, omittedBytes: 0 });
});
