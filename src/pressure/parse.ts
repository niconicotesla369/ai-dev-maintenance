import type { DiskPressureSnapshot, MemoryPressureSnapshot } from './types.js';

export type RawProcessRow = {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryPercent: number;
  rssBytes: number;
  command: string;
};

export function parsePsOutput(stdout: string): RawProcessRow[] {
  const rows: RawProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, cpu, mem, rssKb, command] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuPercent: Number(cpu),
      memoryPercent: Number(mem),
      rssBytes: Number(rssKb) * 1024,
      command
    });
  }
  return rows.filter((row) =>
    Number.isFinite(row.pid) &&
    Number.isFinite(row.ppid) &&
    Number.isFinite(row.cpuPercent) &&
    Number.isFinite(row.memoryPercent) &&
    Number.isFinite(row.rssBytes)
  );
}

export function parseVmStatOutput(stdout: string): MemoryPressureSnapshot {
  const pageSizeBytes = firstNumber(stdout, /page size(?: of)?\s+(\d+)(?:\s+bytes)?/i);
  const pagesFree = firstNumber(stdout, /Pages free:\s*(\d+)/);
  return {
    totalBytes: firstNumber(stdout, /has\s+(\d+)\s+\(/),
    pageSizeBytes,
    freeBytes: pageSizeBytes !== undefined && pagesFree !== undefined ? pageSizeBytes * pagesFree : undefined,
    freePercent: firstNumber(stdout, /System-wide memory free percentage:\s*(\d+)%/),
    pagesFree,
    pagesPurgeable: firstNumber(stdout, /Pages purgeable:\s*(\d+)/),
    pagesUsedByCompressor: firstNumber(stdout, /Pages (?:used by|occupied by) compressor:\s*(\d+)/),
    swapins: firstNumber(stdout, /Swapins:\s*(\d+)/),
    swapouts: firstNumber(stdout, /Swapouts:\s*(\d+)/),
    pageins: firstNumber(stdout, /Pageins:\s*(\d+)/),
    pageouts: firstNumber(stdout, /Pageouts:\s*(\d+)/)
  };
}

export function parseDfOutput(stdout: string): DiskPressureSnapshot {
  const dataLine = stdout.split('\n').find((line) => line.includes('/System/Volumes/Data'));
  if (!dataLine) return {};
  const parts = dataLine.trim().split(/\s+/);
  return {
    availableBytes: parseHumanBytes(parts[3]),
    capacityPercent: parts[4]?.endsWith('%') ? Number(parts[4].slice(0, -1)) : undefined
  };
}

function firstNumber(stdout: string, pattern: RegExp): number | undefined {
  const match = stdout.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function parseHumanBytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^([0-9.]+)([KMGTP]i?)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const multiplier = {
    '': 1,
    K: 1024,
    Ki: 1024,
    M: 1024 ** 2,
    Mi: 1024 ** 2,
    G: 1024 ** 3,
    Gi: 1024 ** 3,
    T: 1024 ** 4,
    Ti: 1024 ** 4,
    P: 1024 ** 5,
    Pi: 1024 ** 5
  }[unit];
  return multiplier === undefined ? undefined : Math.round(amount * multiplier);
}
