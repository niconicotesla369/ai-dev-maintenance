import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fsSpies = vi.hoisted(() => ({
  readFile: vi.fn(() => {
    throw new Error('readFile must not be used by the JSONL iterator');
  })
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFile: fsSpies.readFile };
});

import { type JsonlLine, readJsonlLines } from '../src/reclaim/jsonl-stream.js';

afterEach(() => {
  fsSpies.readFile.mockClear();
});

describe('readJsonlLines', () => {
  test('preserves LF and CRLF bytes when chunks split every byte', async () => {
    const fixture = await makeFixture('{"emoji":"😀"}\n{"value":2}\r\n');
    try {
      const lines = await collect(fixture.file, { highWaterMark: 1 });

      expect(lines.map((line) => line.lineNumber)).toEqual([1, 2]);
      expect(lines.map((line) => line.bytes.toString('utf8'))).toEqual([
        '{"emoji":"😀"}\n',
        '{"value":2}\r\n'
      ]);
      expect(lines.map((line) => line.text)).toEqual([
        '{"emoji":"😀"}\n',
        '{"value":2}\r\n'
      ]);
      expect(lines.map((line) => line.hasTrailingNewline)).toEqual([true, true]);
      expect(fsSpies.readFile).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  test('yields one final line without a newline', async () => {
    const fixture = await makeFixture('{"first":1}\n{"last":2}');
    try {
      const lines = await collect(fixture.file, { highWaterMark: 3 });

      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({
        lineNumber: 2,
        text: '{"last":2}',
        hasTrailingNewline: false
      });
      expect(lines[1].bytes.equals(Buffer.from('{"last":2}'))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('yields real blank lines but no synthetic line after a final LF', async () => {
    const fixture = await makeFixture('\n{"value":1}\n');
    try {
      const lines = await collect(fixture.file, { highWaterMark: 2 });

      expect(lines.map((line) => line.text)).toEqual(['\n', '{"value":1}\n']);
      expect(lines.map((line) => line.hasTrailingNewline)).toEqual([true, true]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('yields no lines for an empty file', async () => {
    const fixture = await makeFixture('');
    try {
      expect(await collect(fixture.file)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('decodes a multibyte UTF-8 character split across chunks', async () => {
    const fixture = await makeFixture('あ\n');
    try {
      const lines = await collect(fixture.file, { highWaterMark: 1 });

      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe('あ\n');
      expect(lines[0].bytes.equals(Buffer.from('あ\n'))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('fails closed on invalid UTF-8 without exposing bytes', async () => {
    const fixture = await makeFixture(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    try {
      await expect(collect(fixture.file, { highWaterMark: 1 })).rejects.toMatchObject({
        code: 'invalid-utf8',
        message: 'JSONL line 1 is not valid UTF-8'
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('allows a line exactly at the injected byte limit', async () => {
    const fixture = await makeFixture('abc\n');
    try {
      const lines = await collect(fixture.file, { maxLineBytes: 4, highWaterMark: 64 });

      expect(lines).toHaveLength(1);
      expect(lines[0].bytes).toHaveLength(4);
    } finally {
      await fixture.cleanup();
    }
  });

  test('fails before yielding a line one byte over the injected limit', async () => {
    const fixture = await makeFixture('abcd\n');
    try {
      await expect(
        collect(fixture.file, { maxLineBytes: 4, highWaterMark: 64 })
      ).rejects.toMatchObject({
        code: 'line-too-large',
        message: 'JSONL line 1 exceeds the 4 byte limit'
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('bounds a modest line assembled from many chunks without readFile', async () => {
    const text = `${'x'.repeat(32)}\n`;
    const fixture = await makeFixture(text);
    try {
      const lines = await collect(fixture.file, { maxLineBytes: 33, highWaterMark: 1 });

      expect(lines).toHaveLength(1);
      expect(lines[0].bytes).toHaveLength(33);
      expect(lines[0].text).toBe(text);
      expect(fsSpies.readFile).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  test('does not allow callers to raise the production 64 MiB line cap', async () => {
    const fixture = await makeFixture('small\n');
    try {
      await expect(
        collect(fixture.file, { maxLineBytes: 64 * 1024 * 1024 + 1 })
      ).rejects.toThrow('maxLineBytes must not exceed 67108864');
    } finally {
      await fixture.cleanup();
    }
  });

  test('streams from the supplied open descriptor when the path is replaced', async () => {
    const fixture = await makeFixture('{"source":"original"}\n');
    const movedOriginal = `${fixture.file}.original`;
    const replacement = `${fixture.file}.replacement`;
    const handle = await open(fixture.file, 'r');
    try {
      await writeFile(replacement, '{"source":"replacement"}\n');
      await rename(fixture.file, movedOriginal);
      await rename(replacement, fixture.file);

      const lines = await collect(fixture.file, { fileDescriptor: handle.fd });

      expect(lines.map((line) => line.text)).toEqual(['{"source":"original"}\n']);
    } finally {
      await handle.close();
      await fixture.cleanup();
    }
  });
});

async function collect(
  file: string,
  options?: { maxLineBytes?: number; highWaterMark?: number; fileDescriptor?: number }
): Promise<JsonlLine[]> {
  const lines: JsonlLine[] = [];
  for await (const line of readJsonlLines(file, options)) lines.push(line);
  return lines;
}

async function makeFixture(data: string | Buffer): Promise<{
  file: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aidm-jsonl-stream-'));
  const file = path.join(dir, 'fixture.jsonl');
  await writeFile(file, data);
  return {
    file,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}
