import { describe, expect, test } from 'vitest';
import { renderPressureReport } from '../src/pressure/render.js';
import type { PressureReport } from '../src/pressure/types.js';

describe('pressure human renderer', () => {
  test('renders CPU, memory, disk, and next actions in a compact card', () => {
    const output = renderPressureReport(report());

    expect(output).toContain('Live pressure   ok');
    expect(output).toContain('Memory free     35%');
    expect(output).toContain('Pressure level  ok');
    expect(output).toContain('Disk used       85%');
    expect(output).toContain('AI CPU          48.1%');
    expect(output).toContain('AI RSS          218.7 MiB');
    expect(output).toContain('Top CPU');
    expect(output).toContain('Codex');
    expect(output).toContain('Next            No urgent pressure action detected.');
    expect(output).not.toContain('/Users/');
  });

  test('uses free memory bytes when vm_stat has no percentage line', () => {
    const input = report();
    input.memory = { pageSizeBytes: 16384, pagesFree: 4396, freeBytes: 72_024_064 };

    expect(renderPressureReport(input)).toContain('Memory free     68.7 MiB');
  });

  test('renders readable process names instead of provider-only other rows', () => {
    const input = report();
    input.processes = [
      {
        pid: 20,
        ppid: 1,
        provider: 'other',
        category: 'build-tool',
        displayName: 'node/vitest',
        cpuPercent: 90,
        memoryPercent: 1,
        rssBytes: 200 * 1024 * 1024,
        commandSummary: 'node vitest'
      }
    ];
    input.totals = {
      aiCpuPercent: 90,
      aiRssBytes: 200 * 1024 * 1024,
      processCount: 1
    };

    const output = renderPressureReport(input);

    expect(output).toContain('node/vitest');
    expect(output).toContain('90.0% build-tool pid=20');
    expect(output).not.toContain('other           90.0%');
  });

  test('renders pressure level reasons when the machine is under pressure', () => {
    const input = report();
    input.pressureLevel = {
      overall: 'high',
      cpu: 'high',
      memory: 'high',
      disk: 'medium',
      reasons: ['memory pressure is high', 'AI CPU pressure is high']
    };

    const output = renderPressureReport(input);

    expect(output).toContain('Pressure level  high');
    expect(output).toContain('Reason          memory pressure is high');
    expect(output).toContain('Reason          AI CPU pressure is high');
  });
});

function report(): PressureReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.2.3',
    generatedAt: '2026-06-30T00:00:00.000Z',
    command: 'pressure',
    status: 'ok',
    redacted: true,
    platform: 'darwin',
    memory: { freePercent: 35, freeBytes: 2 * 1024 * 1024 * 1024, swapouts: 10, pagesUsedByCompressor: 20 },
    disk: { capacityPercent: 85 },
    processes: [
      {
        pid: 1,
        ppid: 0,
        provider: 'codex',
        category: 'app',
        displayName: 'Codex',
        cpuPercent: 38.6,
        memoryPercent: 0.9,
        rssBytes: 78816 * 1024,
        commandSummary: '/Applications/Codex.app/Contents/Resources/codex'
      },
      {
        pid: 2,
        ppid: 0,
        provider: 'cursor',
        category: 'app',
        displayName: 'Cursor',
        cpuPercent: 7.5,
        memoryPercent: 1.1,
        rssBytes: 90000 * 1024,
        commandSummary: '/Applications/Cursor.app/Contents/MacOS/Cursor'
      },
      {
        pid: 3,
        ppid: 0,
        provider: 'claude-code',
        category: 'app',
        displayName: 'Claude',
        cpuPercent: 2.0,
        memoryPercent: 0.7,
        rssBytes: 55152 * 1024,
        commandSummary: 'claude'
      }
    ],
    totals: {
      aiCpuPercent: 48.1,
      aiRssBytes: (78816 + 90000 + 55152) * 1024,
      processCount: 3
    },
    pressureLevel: {
      overall: 'ok',
      cpu: 'ok',
      memory: 'ok',
      disk: 'medium',
      reasons: []
    },
    warnings: [],
    nextActions: ['No urgent pressure action detected.']
  };
}
