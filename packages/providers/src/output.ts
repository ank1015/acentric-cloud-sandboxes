// Output bytes to text. A read can stop inside a UTF-8 character; the cut is
// moved back to the last whole character, and the cursor with it, so the next
// read starts with the rest of that character.

export interface RawOutput {
  /** Where `head` starts in the log. */
  readonly cursor: number;
  /** The log's size when it was read. */
  readonly size: number;
  readonly head: Uint8Array;
  /** Present when the middle was skipped: the last bytes, from `tailStart`. */
  readonly tail?: Uint8Array | undefined;
  readonly tailStart?: number | undefined;
  /** The execution has ended, so a character cut at the end of the log stays cut. */
  readonly ended: boolean;
}

export interface Output {
  readonly output: string;
  readonly nextCursor: number;
  readonly omittedBytes: number;
}

const decoder = new TextDecoder();

export function readOutput({ cursor, size, head, tail, tailStart, ended }: RawOutput): Output {
  if (!tail || tailStart === undefined) {
    const keep = ended && cursor + head.length === size ? head.length : wholeLength(head);
    return {
      output: decoder.decode(head.subarray(0, keep)),
      nextCursor: cursor + keep,
      omittedBytes: 0,
    };
  }
  const headKeep = wholeLength(head);
  const skip = continuationBytes(tail);
  const body = tail.subarray(skip);
  const tailKeep = ended ? body.length : wholeLength(body);
  const omittedBytes = tailStart + skip - (cursor + headKeep);
  return {
    output:
      decoder.decode(head.subarray(0, headKeep)) +
      `\n... ${omittedBytes} bytes omitted ...\n` +
      decoder.decode(body.subarray(0, tailKeep)),
    nextCursor: tailStart + skip + tailKeep,
    omittedBytes,
  };
}

/** The length up to the last whole character: an unfinished one at the end is left out. */
export function wholeLength(bytes: Uint8Array): number {
  let start = bytes.length - 1;
  while (start >= 0 && bytes.length - start <= 3 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!;
  const width =
    lead < 0x80
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 1;
  return bytes.length - start < width ? start : bytes.length;
}

/** Continuation bytes at the start, the end of a character cut before them. */
function continuationBytes(bytes: Uint8Array): number {
  let count = 0;
  while (count < 3 && count < bytes.length && (bytes[count]! & 0xc0) === 0x80) count += 1;
  return count;
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
