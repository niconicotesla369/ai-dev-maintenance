import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { PressureReport } from '../src/pressure/types.js';

describe('pressure CLI command', () => {
  test('renders a human live pressure summary', async () => {
    const result = await runCli(['pressure'], {
      commands: {
        runPressureDoctor: async () => makePressureReport()
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Live pressure   ok');
    expect(result.output).toContain('AI CPU          10.0%');
    expect(result.output).toContain('Top CPU');
  });

  test('prints JSON without banner or human labels', async () => {
    const result = await runCli(['pressure', '--json'], {
      commands: {
        runPressureDoctor: async () => makePressureReport()
      },
      io: {
        isInputTty: true,
        isOutputTty: true,
        columns: 100
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).not.toContain('Live pressure   ok');
    expect(JSON.parse(result.output)).toMatchObject({
      command: 'pressure',
      status: 'ok',
      totals: {
        aiCpuPercent: 10
      }
    });
  });

  test('rejects unknown pressure flags', async () => {
    const result = await runCli(['pressure', '--kill'], {
      commands: {
        runPressureDoctor: async () => makePressureReport()
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown pressure flag: --kill');
  });
});

function makePressureReport(): PressureReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.2.2',
    generatedAt: '2026-06-30T00:00:00.000Z',
    command: 'pressure',
    status: 'ok',
    redacted: true,
    platform: 'darwin',
    totals: {
      aiCpuPercent: 10,
      aiRssBytes: 128 * 1024 * 1024,
      processCount: 1
    },
    memory: {
      freePercent: 25,
      pagesFree: 524288,
      swapouts: 0
    },
    disk: {
      availableBytes: 45 * 1024 * 1024 * 1024,
      capacityPercent: 82
    },
    processes: [
      {
        pid: 123,
        ppid: 1,
        provider: 'codex',
        category: 'app',
        cpuPercent: 10,
        memoryPercent: 4,
        rssBytes: 128 * 1024 * 1024,
        commandSummary: 'Codex.app'
      }
    ],
    warnings: [],
    nextActions: ['No immediate action needed.']
  };
}
