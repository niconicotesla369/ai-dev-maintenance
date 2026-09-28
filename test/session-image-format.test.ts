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
const LARGE_PAYLOAD = Buffer.alloc(900, 7).toString('base64');
const EXPECTED_PLACEHOLDER_PAYLOAD =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAHnRFWHRDb21tZW50AGFpZG0tc3RyaXBwZWQtaW1hZ2UtdjEFNd5PAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const EXPECTED_PLACEHOLDER_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAHnRFWHRDb21tZW50AGFpZG0tc3RyaXBwZWQtaW1hZ2UtdjEFNd5PAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const IMAGE_VALUE_PREFIX = '{"type":"input_image","image_url":"';

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
  test('replaces a data URL that is the entire JSON string value', () => {
    const url = `data:image/png;base64,${SMALL_PAYLOAD}`;
    const analysis = analyzeSessionImageLine(imageValue(url), SMALL_PAYLOAD.length);

    expect(analysis).toEqual({
      blocked: false,
      occurrences: [{
        kind: 'replace',
        start: IMAGE_VALUE_PREFIX.length,
        end: IMAGE_VALUE_PREFIX.length + url.length,
        payloadChars: SMALL_PAYLOAD.length,
        mime: 'png'
      }]
    });
  });

  test.each([
    ['tool output CSS', rolloutToolOutput(`$ cat app.css\n.logo{background:url(data:image/png;base64,${LARGE_PAYLOAD})}\n`)],
    ['pasted markdown', rolloutUserText(`fix this: ![x](data:image/png;base64,${LARGE_PAYLOAD}) please`)],
    ['single-quoted HTML', rolloutToolOutput(`<img src='data:image/png;base64,${LARGE_PAYLOAD}'>`)],
    ['prose', rolloutUserText(`data:image/png;base64,${LARGE_PAYLOAD} is the logo`)],
    ['quoted inside text', rolloutUserText(`say "data:image/png;base64,${LARGE_PAYLOAD}" now`)]
  ])('ignores a data URL embedded in %s', (_name, line) => {
    expect(analyzeSessionImageLine(line)).toEqual({ occurrences: [], blocked: false });
  });

  test('does not treat an object key as an image', () => {
    const line = JSON.stringify({ [`data:image/png;base64,${LARGE_PAYLOAD}`]: 'x' });

    expect(analyzeSessionImageLine(line)).toEqual({ occurrences: [], blocked: false });
  });

  test('replaces only the standalone value when text and image share a line', () => {
    const line = rolloutUserContent([
      { type: 'input_text', text: `css: url(data:image/png;base64,${LARGE_PAYLOAD})` },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${LARGE_PAYLOAD}` }
    ]);
    const analysis = analyzeSessionImageLine(line);

    expect(analysis.blocked).toBe(false);
    expect(analysis.occurrences).toEqual([
      expect.objectContaining({ kind: 'replace', mime: 'jpeg', payloadChars: LARGE_PAYLOAD.length })
    ]);
  });

  test('skips the exact versioned placeholder before applying the size threshold', () => {
    expect(analyzeSessionImageLine(imageValue(SESSION_IMAGE_PLACEHOLDER_URL))).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'skip', reason: 'known-placeholder' }]
    });
  });

  test('skips a canonical payload below the configured minimum', () => {
    const line = imageValue(`data:image/png;base64,${SMALL_PAYLOAD}`);

    expect(analyzeSessionImageLine(line, SMALL_PAYLOAD.length + 1)).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'skip', reason: 'below-min-payload' }]
    });
  });

  test.each([
    ['invalid-length', 'QUF'],
    ['invalid-padding', 'QU=F'],
    ['non-canonical-base64', 'Zh==']
  ])('blocks a standalone value with %s', (reason, payload) => {
    expect(analyzeSessionImageLine(imageValue(`data:image/png;base64,${payload}`), 1)).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason }]
    });
  });

  test.each([
    ['URL-safe alphabet', `data:image/png;base64,${SMALL_PAYLOAD}_`],
    ['non-base64 encoding', 'data:image/svg+xml;utf8,<svg/>'],
    ['empty MIME', `data:image/;base64,${SMALL_PAYLOAD}`],
    ['base32 marker', `data:image/png;base32,${SMALL_PAYLOAD}`],
    ['33-character MIME', `data:image/${'a'.repeat(33)};base64,${SMALL_PAYLOAD}`]
  ])('ignores a value that is not a base64 image data URL: %s', (_name, url) => {
    expect(analyzeSessionImageLine(imageValue(url), 1)).toEqual({ occurrences: [], blocked: false });
  });

  test('accepts a 32-character MIME', () => {
    const mime = 'a'.repeat(32);

    expect(analyzeSessionImageLine(imageValue(`data:image/${mime};base64,${SMALL_PAYLOAD}`), 4)).toMatchObject({
      blocked: false,
      occurrences: [{ kind: 'replace', mime }]
    });
  });

  test.each([
    ['escaped slash', '{"image_url":"data:image/png;base64,QUFB\\/QUFB"}'],
    ['unicode-escaped marker', '{"image_url":"\\u0064ata:image/png;base64,QUFB"}']
  ])('blocks a standalone image value hidden by a JSON %s', (_name, line) => {
    const analysis = analyzeSessionImageLine(line, 1);

    expect(analysis.blocked).toBe(true);
    expect(analysis.occurrences).toContainEqual(expect.objectContaining({
      kind: 'blocked',
      reason: 'unverifiable-context'
    }));
  });

  test('blocks a line with an image marker that cannot be parsed as JSON', () => {
    expect(analyzeSessionImageLine(`not json "data:image/png;base64,${SMALL_PAYLOAD}"`, 1)).toMatchObject({
      blocked: true,
      occurrences: [{ kind: 'blocked', reason: 'unverifiable-context' }]
    });
  });

  test('finds multiple standalone images in document order', () => {
    const line = rolloutUserContent([
      { type: 'input_image', image_url: `data:image/png;base64,${SMALL_PAYLOAD}` },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QkJC' }
    ]);
    const analysis = analyzeSessionImageLine(line, SMALL_PAYLOAD.length);

    expect(analysis.blocked).toBe(false);
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
});

describe('rewriteSessionImageLine', () => {
  test('replaces the standalone value and keeps the line valid JSON', () => {
    const line = rolloutUserContent([
      { type: 'input_image', image_url: `data:image/png;base64,${LARGE_PAYLOAD}` }
    ]);
    const rewritten = rewriteSessionImageLine(line, analyzeSessionImageLine(line));

    expect(rewritten).toEqual({
      output: rolloutUserContent([{ type: 'input_image', image_url: SESSION_IMAGE_PLACEHOLDER_URL }]),
      imagesStripped: 1,
      knownPlaceholders: 0,
      skippedSmall: 0
    });
    expect(() => JSON.parse(rewritten.output)).not.toThrow();
  });

  test('leaves text-embedded data URLs byte-identical while replacing a standalone image', () => {
    const text = `$ cat logo.css\n.logo{background:url(data:image/png;base64,${LARGE_PAYLOAD})}`;
    const line = rolloutUserContent([
      { type: 'input_text', text },
      { type: 'input_image', image_url: `data:image/png;base64,${LARGE_PAYLOAD}` }
    ]);

    expect(rewriteSessionImageLine(line, analyzeSessionImageLine(line)).output).toBe(rolloutUserContent([
      { type: 'input_text', text },
      { type: 'input_image', image_url: SESSION_IMAGE_PLACEHOLDER_URL }
    ]));
  });

  test('does not rewrite any span when one standalone occurrence is blocked', () => {
    const line = rolloutUserContent([
      { type: 'input_image', image_url: `data:image/png;base64,${SMALL_PAYLOAD}` },
      { type: 'input_image', image_url: 'data:image/png;base64,QU=F' }
    ]);
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
    const line = rolloutUserContent([
      { type: 'input_image', image_url: SESSION_IMAGE_PLACEHOLDER_URL },
      { type: 'input_image', image_url: `data:image/png;base64,${SMALL_PAYLOAD}` }
    ]);
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
    const source = imageValue(`data:image/png;base64,${SMALL_PAYLOAD}`);
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
      imageValue(`data:image/png;base64,${SMALL_PAYLOAD}`),
      SMALL_PAYLOAD.length
    );

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.occurrences)).toBe(true);
    expect(analysis.occurrences.every((occurrence) => Object.isFrozen(occurrence))).toBe(true);
  });
});

// Rollout-shaped synthetic fixtures; field names mirror Codex response items but are not captured data.
function imageValue(url: string): string {
  return JSON.stringify({ type: 'input_image', image_url: url });
}

function rolloutUserContent(content: Array<Record<string, string>>): string {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content } });
}

function rolloutUserText(text: string): string {
  return rolloutUserContent([{ type: 'input_text', text }]);
}

function rolloutToolOutput(output: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call-1', output }
  });
}

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
