import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parseDfOutput, parseMemoryPressureOutput, parsePsOutput, parseVmStatOutput } from '../src/pressure/parse.js';

describe('pressure parsers', () => {
  test('parses ps output into numeric process rows', () => {
    const ps = [
      '  51162 50860 38.6 0.9 78816 /Applications/Codex.app/Contents/Resources/codex',
      '  67718 64364  2.0 0.7 55152 claude',
      '  57828     1  7.5 1.1 90000 /Applications/Cursor.app/Contents/MacOS/Cursor'
    ].join('\n');

    expect(parsePsOutput(ps)).toEqual([
      {
        pid: 51162,
        ppid: 50860,
        cpuPercent: 38.6,
        memoryPercent: 0.9,
        rssBytes: 78816 * 1024,
        command: '/Applications/Codex.app/Contents/Resources/codex'
      },
      {
        pid: 67718,
        ppid: 64364,
        cpuPercent: 2.0,
        memoryPercent: 0.7,
        rssBytes: 55152 * 1024,
        command: 'claude'
      },
      {
        pid: 57828,
        ppid: 1,
        cpuPercent: 7.5,
        memoryPercent: 1.1,
        rssBytes: 90000 * 1024,
        command: '/Applications/Cursor.app/Contents/MacOS/Cursor'
      }
    ]);
  });

  test('ignores malformed ps lines without throwing', () => {
    expect(parsePsOutput('bad line\n 1 2 x y z bad')).toEqual([]);
  });

  test('parses memory_pressure -Q fields separately from vm_stat fields', () => {
    const memoryPressure = [
      'The system has 8589934592 (524288 pages with a page size of 16384).',
      'System-wide memory free percentage: 35%'
    ].join('\n');

    expect(parseMemoryPressureOutput(memoryPressure)).toEqual({
      totalBytes: 8589934592,
      pageSizeBytes: 16384,
      freePercent: 35
    });
  });

  test('parses vm_stat page and swap fields without memory_pressure percentage fields', () => {
    const vm = [
      'Pages free: 3876',
      'Pages purgeable: 42',
      'Swapins: 53636364',
      'Swapouts: 69710976',
      'Pages used by compressor: 158111',
      'Pageins: 292361217',
      'Pageouts: 2351220'
    ].join('\n');

    expect(parseVmStatOutput(vm)).toEqual({
      totalBytes: undefined,
      pageSizeBytes: undefined,
      freeBytes: undefined,
      freePercent: undefined,
      pagesFree: 3876,
      pagesPurgeable: 42,
      pagesUsedByCompressor: 158111,
      swapins: 53636364,
      swapouts: 69710976,
      pageins: 292361217,
      pageouts: 2351220
    });
  });

  test('derives free bytes from current macOS vm_stat shape', () => {
    const vm = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     4396.',
      'Pages purgeable:                                  74.',
      'Pages occupied by compressor:                 170725.'
    ].join('\n');

    expect(parseVmStatOutput(vm)).toMatchObject({
      pageSizeBytes: 16384,
      pagesFree: 4396,
      pagesUsedByCompressor: 170725,
      freeBytes: 72_024_064
    });
  });

  test('parses df capacity and available bytes', () => {
    const df = [
      'Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on',
      '/dev/disk3s5   228Gi   167Gi    31Gi    85%    1.9M  322M    1%   /System/Volumes/Data'
    ].join('\n');

    expect(parseDfOutput(df)).toEqual({
      capacityPercent: 85,
      availableBytes: 31 * 1024 * 1024 * 1024
    });
  });

  test('parses captured memory_pressure -Q fixture without shelling out', async () => {
    const fixture = await readFixture('memory-pressure-Q.txt');

    expect(parseMemoryPressureOutput(fixture)).toMatchObject({
      totalBytes: 8589934592,
      pageSizeBytes: 16384,
      freePercent: 31
    });
  });

  test('parses captured vm_stat fixture without requiring memory_pressure fields', async () => {
    const fixture = await readFixture('vm-stat.txt');

    expect(parseVmStatOutput(fixture)).toMatchObject({
      pageSizeBytes: 16384,
      pagesFree: 4396,
      pagesPurgeable: 74,
      pagesUsedByCompressor: 170725,
      freeBytes: 72_024_064
    });
  });

  test('parses captured df fixture for data volume capacity', async () => {
    const fixture = await readFixture('df-data-volume.txt');

    expect(parseDfOutput(fixture)).toEqual({
      capacityPercent: 89,
      availableBytes: 26 * 1024 * 1024 * 1024
    });
  });

  test('parses synthetic ps fixture without storing real machine output', async () => {
    const fixture = await readFixture('ps-synthetic.txt');
    const rows = parsePsOutput(fixture);

    expect(rows).toEqual([
      {
        pid: 71147,
        ppid: 1,
        cpuPercent: 267.9,
        memoryPercent: 1.4,
        rssBytes: 104000 * 1024,
        command: '/Applications/Codex.app/Contents/MacOS/Codex'
      },
      {
        pid: 25365,
        ppid: 1,
        cpuPercent: 4.8,
        memoryPercent: 0.8,
        rssBytes: 82000 * 1024,
        command: '/Applications/Cursor.app/Contents/MacOS/Cursor Helper (Renderer)'
      },
      {
        pid: 34323,
        ppid: 1,
        cpuPercent: 2.4,
        memoryPercent: 0.6,
        rssBytes: 58000 * 1024,
        command: 'claude'
      }
    ]);
    expect(fixture).not.toContain('/Users/');
  });
});

function readFixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/pressure/${name}`, import.meta.url), 'utf8');
}
