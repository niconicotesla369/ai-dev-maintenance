import { describe, expect, test } from 'vitest';
import {
  MIN_SESSION_IMAGE_PAYLOAD_CHARS,
  SESSION_IMAGE_PLACEHOLDER_PAYLOAD,
  SESSION_IMAGE_PLACEHOLDER_URL,
  type SessionImageLineAnalysis,
  analyzeSessionImageLine,
  rewriteSessionImageLine
} from '../src/reclaim/session-image-format.js';

const SMALL_PAYLOAD = 'QUFB';
const EXPECTED_PLACEHOLDER_PAYLOAD =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAHnRFWHRDb21tZW50AGFpZG0tc3RyaXBwZWQtaW1hZ2UtdjEFNd5PAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const EXPECTED_PLACEHOLDER_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAHnRFWHRDb21tZW50AGFpZG0tc3RyaXBwZWQtaW1hZ2UtdjEFNd5PAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

describe('session image placeholder', () => {
  test('is the exact identifiable v1 transparent PNG', () => {
    const png = Buffer.from(SESSION_IMAGE_PLACEHOLDER_PAYLOAD, 'base64');
    const chunks = parsePngChunks(png);

    expect(SESSION_IMAGE_PLACEHOLDER_PAYLOAD).toBe(EXPECTED_PLACEHOLDER_PAYLOAD);
    expect(SESSION_IMAGE_PLACEHOLDER_URL).toBe(EXPECTED_PLACEHOLDER_URL);
    expect(SESSION_IMAGE_PLACEHOLDER_PAYLOAD).toHaveLength(148);
    expect(SESSION_IMAGE_PLACEHOLDER_PAYLOAD.length % 4).toBe(0);
    expect(png).toHaveLength(110);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.includes(Buffer.from('Comment\0aidm-stripped-image-v1'))).toBe(true);
    expect(png.toString('base64')).toBe(SESSION_IMAGE_PLACEHOLDER_PAYLOAD);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(chunks.find((chunk) => chunk.type === 'IHDR')?.data).toHaveLength(13);
    expect(chunks.find((chunk) => chunk.type === 'tEXt')?.data.toString()).toBe(
      'Comment\0aidm-stripped-image-v1'
    );
    expect(chunks.find((chunk) => chunk.type === 'IEND')?.data).toHaveLength(0);
    expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
  });

  test('uses the approved default minimum payload size', () => {
    expect(MIN_SESSION_IMAGE_PAYLOAD_CHARS).toBe(1024);
  });
});

describe('analyzeSessionImageLine', () => {
  test('blocks a self-closing slash consumed by a greedy base64 candidate', () => {
    const line = '<img src=data:image/png;base64,QUFBQQ==/>';
    const analysis = analyzeSessionImageLine(line);

    expect(analysis.blocked).toBe(true);
    expect(analysis.occurrences).toContainEqual(expect.objectContaining({
      kind: 'blocked',
      reason: 'invalid-padding'
    }));
  });

  test('skips the exact versioned placeholder before applying the size threshold', () => {
    const analysis = analyzeSessionImageLine(SESSION_IMAGE_PLACEHOLDER_URL);

    expect(analysis).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'skip', reason: 'known-placeholder' }]
    });
  });

  test('keeps exact-placeholder precedence before unsupported escaping checks', () => {
    const analysis = analyzeSessionImageLine(`${SESSION_IMAGE_PLACEHOLDER_URL}\\/`);

    expect(analysis).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'skip', reason: 'known-placeholder' }]
    });
  });

  test.each([
    ['double quote', '"'],
    ['single quote', "'"],
    ['escaped quote backslash', '\\'],
    ['right parenthesis', ')'],
    ['space', ' '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['period', '.'],
    ['ellipsis', '…']
  ])('accepts the approved %s terminator', (_name, terminator) => {
    const line = `before:data:image/jpeg;base64,${SMALL_PAYLOAD}${terminator}after`;
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(analysis).toEqual({
      blocked: false,
      occurrences: [{
        kind: 'replace',
        start: 'before:'.length,
        end: 'before:'.length + `data:image/jpeg;base64,${SMALL_PAYLOAD}`.length,
        payloadChars: SMALL_PAYLOAD.length,
        mime: 'jpeg'
      }]
    });
  });

  test('blocks a missing terminator for a non-placeholder payload', () => {
    const analysis = analyzeSessionImageLine(
      `data:image/png;base64,${SMALL_PAYLOAD}`,
      SMALL_PAYLOAD.length
    );

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'missing-terminator' }]
    });
  });

  test('blocks a payload whose length is not divisible by four', () => {
    const analysis = analyzeSessionImageLine('data:image/png;base64,QUF"', 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-length' }]
    });
  });

  test('blocks padding before the end of a payload', () => {
    const analysis = analyzeSessionImageLine('data:image/png;base64,QU=F"', 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-padding' }]
    });
  });

  test('blocks non-canonical base64 decoding', () => {
    const analysis = analyzeSessionImageLine('data:image/png;base64,Zh=="', 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'non-canonical-base64' }]
    });
  });

  test('blocks a URL-safe base64 alphabet character', () => {
    const analysis = analyzeSessionImageLine('data:image/png;base64,QUFB_"', 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-alphabet' }]
    });
  });

  test('blocks unsupported escaped slashes in a payload', () => {
    const analysis = analyzeSessionImageLine('data:image/png;base64,QUFB\\/"', 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-alphabet' }]
    });
  });

  test('blocks a valid payload followed by an unsafe terminator', () => {
    const analysis = analyzeSessionImageLine(`data:image/png;base64,${SMALL_PAYLOAD}>`, 1);

    expect(analysis).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'unsafe-terminator' }]
    });
  });

  test('skips a canonical payload below the configured minimum', () => {
    const analysis = analyzeSessionImageLine(
      `data:image/png;base64,${SMALL_PAYLOAD}"`,
      SMALL_PAYLOAD.length + 1
    );

    expect(analysis).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'skip', reason: 'below-min-payload' }]
    });
  });

  test('finds multiple images in occurrence order', () => {
    const line = [
      `a:data:image/png;base64,${SMALL_PAYLOAD}"`,
      `b:data:image/jpeg;base64,QkJC'`
    ].join('|');
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(analysis.blocked).toBe(false);
    expect(analysis.occurrences).toHaveLength(2);
    expect(analysis.occurrences).toEqual([
      expect.objectContaining({ kind: 'replace', mime: 'png', payloadChars: 4 }),
      expect.objectContaining({ kind: 'replace', mime: 'jpeg', payloadChars: 4 })
    ]);
  });

  test('returns no occurrences when no image marker exists', () => {
    expect(analyzeSessionImageLine('{"message":"plain text"}')).toEqual({
      occurrences: [],
      blocked: false
    });
  });

  test('accepts a 32-character MIME and blocks a longer MIME', () => {
    const boundedMime = 'a'.repeat(32);
    const tooLongMime = 'a'.repeat(33);

    expect(
      analyzeSessionImageLine(`data:image/${boundedMime};base64,${SMALL_PAYLOAD}"`, 4)
    ).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'replace', mime: boundedMime }]
    });
    expect(
      analyzeSessionImageLine(`data:image/${tooLongMime};base64,${SMALL_PAYLOAD}"`, 4)
    ).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-alphabet' }]
    });
  });

  test.each([
    'data:image/;base64,QUFB"',
    'data:image/png_svg;base64,QUFB"',
    'data:image/png;base32,QUFB"'
  ])('blocks a malformed image prefix: %s', (line) => {
    expect(analyzeSessionImageLine(line, 4)).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'invalid-alphabet' }]
    });
  });
});

describe('rewriteSessionImageLine', () => {
  test('preserves all surrounding text and approved terminators', () => {
    const line = `前:data:image/jpeg;base64,${SMALL_PAYLOAD}'後`;
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(rewriteSessionImageLine(line, analysis)).toEqual({
      output: `前:${SESSION_IMAGE_PLACEHOLDER_URL}'後`,
      imagesStripped: 1,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('rewrites multiple approved spans without changing text between them', () => {
    const line = [
      `a:data:image/png;base64,${SMALL_PAYLOAD}"`,
      `b:data:image/jpeg;base64,QkJC'`
    ].join('|');
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(rewriteSessionImageLine(line, analysis)).toEqual({
      output: `a:${SESSION_IMAGE_PLACEHOLDER_URL}"|b:${SESSION_IMAGE_PLACEHOLDER_URL}'`,
      imagesStripped: 2,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('does not rewrite any span when one occurrence is blocked', () => {
    const line = [
      `ok:data:image/png;base64,${SMALL_PAYLOAD}"`,
      'bad:data:image/png;base64,QUFBQQ==/>'
    ].join('|');
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(analysis.occurrences).toEqual([
      expect.objectContaining({ kind: 'replace' }),
      expect.objectContaining({ kind: 'blocked', reason: 'invalid-padding' })
    ]);
    expect(rewriteSessionImageLine(line, analysis)).toEqual({
      output: line,
      imagesStripped: 0,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('reports known and below-minimum skips without changing the line', () => {
    const line = `${SESSION_IMAGE_PLACEHOLDER_URL}|data:image/png;base64,${SMALL_PAYLOAD}"`;
    const analysis = analyzeSessionImageLine(line, 8);

    expect(rewriteSessionImageLine(line, analysis)).toEqual({
      output: line,
      imagesStripped: 0,
      knownPlaceholders: 1,
      skippedSmall: 1
    });
  });

  test('returns an unchanged no-image line with zero counters', () => {
    const line = '{"message":"plain text"}\n';

    expect(rewriteSessionImageLine(line, analyzeSessionImageLine(line))).toEqual({
      output: line,
      imagesStripped: 0,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('rejects a forged analysis instead of deleting arbitrary spans', () => {
    const line = 'private text that must remain';
    const forged: SessionImageLineAnalysis = {
      blocked: false,
      occurrences: [{
        kind: 'replace',
        start: 0,
        end: line.length,
        payloadChars: line.length,
        mime: 'png'
      }]
    };

    expect(rewriteSessionImageLine(line, forged)).toEqual({
      output: line,
      imagesStripped: 0,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('rejects an authentic analysis when it is used with a different line', () => {
    const source = `data:image/png;base64,${SMALL_PAYLOAD}"`;
    const analysis = analyzeSessionImageLine(source, SMALL_PAYLOAD.length);
    const differentLine = 'different private text';

    expect(rewriteSessionImageLine(differentLine, analysis)).toEqual({
      output: differentLine,
      imagesStripped: 0,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
  });

  test('returns immutable analyzer-owned results', () => {
    const analysis = analyzeSessionImageLine(
      `data:image/png;base64,${SMALL_PAYLOAD}"`,
      SMALL_PAYLOAD.length
    );

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.occurrences)).toBe(true);
    expect(analysis.occurrences.every((occurrence) => Object.isFrozen(occurrence))).toBe(true);
  });
});

function parsePngChunks(png: Buffer): Array<{ type: string; data: Buffer; crcValid: boolean }> {
  const chunks: Array<{ type: string; data: Buffer; crcValid: boolean }> = [];
  let offset = 8;
  while (offset < png.length) {
    const dataLength = png.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcOffset = dataStart + dataLength;
    const end = crcOffset + 4;
    if (end > png.length) throw new Error('PNG chunk exceeds placeholder bytes');

    const type = png.subarray(typeStart, dataStart).toString('ascii');
    const data = png.subarray(dataStart, crcOffset);
    const expectedCrc = png.readUInt32BE(crcOffset);
    const actualCrc = crc32(png.subarray(typeStart, crcOffset));
    chunks.push({ type, data, crcValid: actualCrc === expectedCrc });
    offset = end;
  }
  if (offset !== png.length) throw new Error('PNG chunk parsing did not consume placeholder bytes');
  return chunks;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
