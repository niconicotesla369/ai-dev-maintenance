import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { PressureReport } from '../src/pressure/types.js';

describe('pressure CLI command', () => {
  test('renders a pretty pressure dashboard for TTY users', async () => {
    const result = await runCli(['pressure'], {
      env: {},
      commands: {
        runPressureDoctor: async () => makePressureReport()
      },
      io: {
        isInputTty: true,
        isOutputTty: true,
        columns: 120
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AIDM SYSTEM PULSE');
    expect(result.output).toContain('AIDM check: OK');
    expect(result.output).toContain('Pressure: OK');
    expect(result.output).toContain('What is using CPU?');
    expect(result.output).toContain('#  Process');
    expect(result.output).toContain('CPU');
    expect(result.output).toContain('RAM');
    expect(result.output).toContain('Type');
    expect(result.output).toContain('PID');
    expect(result.output).toContain('What should I do next?');
    expect(result.output).toContain('▰');
    expect(result.output).not.toContain('Live pressure: OK');
    expect(result.output).not.toContain('Reason:');
  });

  test('renders the legacy summary for non-TTY output', async () => {
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

  test('plain pressure output keeps the legacy row format even on TTY', async () => {
    const result = await runCli(['pressure', '--plain'], {
      commands: {
        runPressureDoctor: async () => makePressureReport()
      },
      io: {
        isInputTty: true,
        isOutputTty: true,
        columns: 120
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Live pressure   ok');
    expect(result.output).toContain('AI CPU          10.0%');
    expect(result.output).not.toContain('AIDM SYSTEM PULSE');
    expect(result.output).not.toContain('\u001b[');
  });

  test('NO_COLOR, CI, and narrow terminals keep pressure output script-safe', async () => {
    for (const runtime of [
      { env: { NO_COLOR: '1' }, columns: 120 },
      { env: { CI: '1' }, columns: 120 },
      { env: {}, columns: 72 }
    ]) {
      const result = await runCli(['pressure'], {
        env: runtime.env,
        commands: {
          runPressureDoctor: async () => makePressureReport()
        },
        io: {
          isInputTty: true,
          isOutputTty: true,
          columns: runtime.columns
        }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Live pressure   ok');
      expect(result.output).not.toContain('AIDM SYSTEM PULSE');
      expect(result.output).not.toContain('\u001b[');
    }
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
    toolVersion: '0.2.6',
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
    pressureLevel: {
      overall: 'ok',
      cpu: 'ok',
      memory: 'ok',
      disk: 'medium',
      reasons: []
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
        displayName: 'Codex',
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
