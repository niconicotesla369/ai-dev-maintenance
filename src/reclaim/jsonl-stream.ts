import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';

export type JsonlLine = {
  lineNumber: number;
  bytes: Buffer;
  text: string;
  hasTrailingNewline: boolean;
};

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

export async function* readJsonlLines(
  filePath: string,
  options: {
    maxLineBytes?: number;
    highWaterMark?: number;
    fileDescriptor?: number;
  } = {}
): AsyncGenerator<JsonlLine> {
  const maxLineBytes = positiveSafeInteger(
    options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    'maxLineBytes'
  );
  if (maxLineBytes > DEFAULT_MAX_LINE_BYTES) {
    throw new RangeError(`maxLineBytes must not exceed ${DEFAULT_MAX_LINE_BYTES}`);
  }
  const requestedHighWaterMark = positiveSafeInteger(
    options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
    'highWaterMark'
  );
  const highWaterMark = Math.min(requestedHighWaterMark, maxLineBytes);
  const fileDescriptor = options.fileDescriptor === undefined
    ? undefined
    : nonNegativeSafeInteger(options.fileDescriptor, 'fileDescriptor');
  const stream = createReadStream(filePath, {
    highWaterMark,
    ...(fileDescriptor === undefined
      ? {}
      : { fd: fileDescriptor, autoClose: false })
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let fragments: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 0;

  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline + 1;
        const fragment = chunk.subarray(offset, end);
        const nextLineBytes = pendingBytes + fragment.length;
        if (nextLineBytes > maxLineBytes) {
          throw jsonlError(
            'line-too-large',
            `JSONL line ${lineNumber + 1} exceeds the ${maxLineBytes} byte limit`
          );
        }

        fragments.push(fragment);
        pendingBytes = nextLineBytes;
        offset = end;

        if (newline !== -1) {
          lineNumber += 1;
          const bytes = joinFragments(fragments, pendingBytes);
          fragments = [];
          pendingBytes = 0;
          yield decodeLine(bytes, lineNumber, decoder, true);
        }
      }
    }

    if (pendingBytes > 0) {
      lineNumber += 1;
      const bytes = joinFragments(fragments, pendingBytes);
      fragments = [];
      pendingBytes = 0;
      yield decodeLine(bytes, lineNumber, decoder, false);
    }
  } finally {
    if (fileDescriptor === undefined && !stream.destroyed) stream.destroy();
  }
}

function decodeLine(
  bytes: Buffer,
  lineNumber: number,
  decoder: TextDecoder,
  hasTrailingNewline: boolean
): JsonlLine {
  try {
    return {
      lineNumber,
      bytes,
      text: decoder.decode(bytes),
      hasTrailingNewline
    };
  } catch {
    throw jsonlError('invalid-utf8', `JSONL line ${lineNumber} is not valid UTF-8`);
  }
}

function joinFragments(fragments: Buffer[], byteLength: number): Buffer {
  if (fragments.length === 1) return Buffer.from(fragments[0]);
  return Buffer.concat(fragments, byteLength);
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function jsonlError(
  code: 'line-too-large' | 'invalid-utf8',
  message: string
): Error & { code: 'line-too-large' | 'invalid-utf8' } {
  return Object.assign(new Error(message), { code });
}
