import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { CliRuntimeOptions } from '../src/cli-router.js';
import type { MaintenanceReport, ProviderReport, StateEntry } from '../src/types.js';
import type { VisualReportModel } from '../src/visual-report/model.js';
import type { VisualReportCloseReason } from '../src/visual-report/server.js';

const LEAK = ['/Users', 'example', 'private', 'AIDM_VISUAL_LEAK_SENTINEL'].join('/');
const HTML_INCOMPATIBILITY = '--html cannot be combined with --json, --share, --show-paths, --plain, or --no-banner.\n';
const GRACEFUL_OUTPUT = 'Visual report closed. No HTML file was saved.\n';
const INTERRUPTED_OUTPUT = 'Visual report interrupted. No HTML file was saved.\n';
const FAILURE_OUTPUT = 'Visual report could not be opened safely. No HTML file was saved.\n';

describe('visual report CLI routing', () => {
  test('doctor --html diagnoses once, opens the strict visual projection, and waits for close', async () => {
    const calls: string[] = [];
    let doctorOptions: Parameters<NonNullable<NonNullable<CliRuntimeOptions['commands']>['runDoctor']>>[0];
    let openedModel: VisualReportModel | undefined;

    const result = await runCli(['doctor', '--html'], runtime({
      runDoctor: async (options) => {
        calls.push('runDoctor');
        doctorOptions = options;
        return { report: aggregateReport() };
      },
      openVisualReport: async (model) => {
        calls.push('openVisualReport');
        openedModel = model;
        return 'page-close';
      }
    }));

    expect(calls).toEqual(['runDoctor', 'openVisualReport']);
    expect(doctorOptions?.persistReport).toBeUndefined();
    expect(openedModel).toMatchObject({
      reportStatus: 'ok',
      coverage: 'complete',
      totals: { trackedBytes: 100, safeBytes: 40, reviewBytes: 30, protectedBytes: 30 }
    });
    expect(openedModel?.providers[0]).not.toHaveProperty('pathCategory');
    expect(JSON.stringify(openedModel)).not.toContain(LEAK);
    expect(result).toEqual({ exitCode: 0, output: GRACEFUL_OUTPUT });
  });

  test('report --latest --html opens the latest sanitized report without diagnosing or writing', async () => {
    const calls: string[] = [];
    let openedModel: VisualReportModel | undefined;

    const result = await runCli(['report', '--latest', '--html'], runtime({
      runDoctor: async () => {
        calls.push('runDoctor');
        throw new Error('report --latest --html must not diagnose');
      },
      latestReport: async () => {
        calls.push('latestReport');
        return { path: LEAK, report: aggregateReport() };
      },
      openVisualReport: async (model) => {
        calls.push('openVisualReport');
        openedModel = model;
        return 'idle-timeout';
      }
    }));

    expect(calls).toEqual(['latestReport', 'openVisualReport']);
    expect(JSON.stringify(openedModel)).not.toContain(LEAK);
    expect(result).toEqual({ exitCode: 0, output: GRACEFUL_OUTPUT });
  });

  test('report --latest --html projects the latest reclaim run without reasons', async () => {
    let openedModel: VisualReportModel | undefined;
    const reason = `blocked near ${LEAK}`;

    await runCli(['report', '--latest', '--html'], runtime({
      latestReclaimRun: async () => ({
        schemaVersion: 1,
        toolVersion: '0.6.0',
        command: 'reclaim-run',
        runId: '2026-09-28T14-13-32-347Z-1a2b3c4d',
        startedAt: '2026-09-28T14:13:32.347Z',
        finishedAt: '2026-09-28T14:13:34.001Z',
        status: 'partial',
        units: 'bytes',
        items: [{
          action: 'cursor-clean',
          outcome: 'partial',
          estimateBytes: 620_000,
          target: { beforeBytes: 620_000, afterBytes: 70_000, deltaBytes: -550_000 },
          reasons: [reason]
        }],
        totals: { appliedItems: 1, excludedItems: 0, appliedTargetDeltaBytes: -550_000 },
        managedState: { beforeBytes: 621_000, afterBytes: 71_500, deltaBytes: -549_500 },
        volume: { beforeBytes: 10, afterBytes: 20, deltaBytes: 10, attributedToAidm: false }
      }),
      openVisualReport: async (model) => {
        openedModel = model;
        return 'page-close';
      }
    }));

    expect(openedModel?.lastReclaim).toEqual({
      finishedAt: '2026-09-28T14:13:34.001Z',
      status: 'partial',
      items: [{ action: 'cursor-clean', outcome: 'partial', targetDeltaBytes: -550_000 }],
      appliedTargetDeltaBytes: -550_000,
      managedStateDeltaBytes: -549_500,
      volumeDeltaBytes: 10
    });
    expect(JSON.stringify(openedModel)).not.toContain(LEAK);
  });

  test('doctor --html marks an unreadable reclaim record as unavailable instead of failing or hiding it', async () => {
    let openedModel: VisualReportModel | undefined;

    const result = await runCli(['doctor', '--html'], runtime({
      latestReclaimRun: async () => {
        throw new Error(`unsafe reclaim run record at ${LEAK}`);
      },
      openVisualReport: async (model) => {
        openedModel = model;
        return 'page-close';
      }
    }));

    expect(result.exitCode).toBe(0);
    expect(openedModel?.lastReclaim).toBe('unavailable');
    expect(JSON.stringify(openedModel)).not.toContain(LEAK);
  });

  test('report --latest --html preserves the no-report result without opening a browser', async () => {
    const calls: string[] = [];
    const result = await runCli(['report', '--latest', '--html'], runtime({
      latestReport: async () => {
        calls.push('latestReport');
        return null;
      },
      openVisualReport: async () => {
        calls.push('openVisualReport');
        return 'page-close';
      }
    }));

    expect(result).toEqual({ exitCode: 1, output: 'No report found.\n', stream: 'stderr' });
    expect(calls).toEqual(['latestReport']);
  });

  test('keeps the CLI in the foreground until the visual session closes', async () => {
    let closeSession!: (reason: VisualReportCloseReason) => void;
    let routeSettled = false;
    const closed = new Promise<VisualReportCloseReason>((resolve) => {
      closeSession = resolve;
    });
    const routed = runCli(['doctor', '--html'], runtime({
      openVisualReport: async () => await closed
    })).then((result) => {
      routeSettled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(routeSettled).toBe(false);

    closeSession('page-close');
    await expect(routed).resolves.toEqual({ exitCode: 0, output: GRACEFUL_OUTPUT });
  });

  test.each(['--json', '--share', '--show-paths', '--plain', '--no-banner'])(
    'doctor --html rejects %s before diagnosis or launch',
    async (flag) => {
      const calls: string[] = [];
      const argv = ['doctor', '--html', flag];
      const result = await runCli(argv, commandsThatMustNotRun(calls));

      expectIncompatibility(result, argv);
      expect(calls).toEqual([]);
    }
  );

  test.each(['--json', '--share', '--show-paths', '--plain', '--no-banner'])(
    'report --latest --html rejects %s before report loading or launch',
    async (flag) => {
      const calls: string[] = [];
      const argv = ['report', '--latest', '--html', flag];
      const result = await runCli(argv, commandsThatMustNotRun(calls));

      expectIncompatibility(result, argv);
      expect(calls).toEqual([]);
    }
  );

  test('the fixed HTML diagnostic wins when a named conflict and an unrelated flag coexist', async () => {
    const calls: string[] = [];
    const argv = ['report', '--latest', '--html', '--json', '--browser'];
    const result = await runCli(argv, commandsThatMustNotRun(calls));

    expectIncompatibility(result, argv);
    expect(calls).toEqual([]);
  });

  test.each([
    ['doctor', ['doctor', '--html', '--json', '--wait-timeout', '0']],
    ['report', ['report', '--latest', '--html', '--json', '--wait-timeout', '0']]
  ])('the fixed %s HTML diagnostic wins over common argument validation', async (_command, argv) => {
    const calls: string[] = [];
    const result = await runCli(argv, commandsThatMustNotRun(calls));

    expectIncompatibility(result, argv);
    expect(calls).toEqual([]);
  });

  test('unrelated report flags still use the existing unknown-flag path', async () => {
    const calls: string[] = [];
    const result = await runCli(
      ['report', '--latest', '--html', '--browser'],
      commandsThatMustNotRun(calls)
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown report flag: --browser');
    expect(result.output).not.toContain(HTML_INCOMPATIBILITY.trim());
    expect(calls).toEqual([]);
  });

  test.each<VisualReportCloseReason>(['page-close', 'idle-timeout', 'hard-timeout'])(
    'graceful %s preserves an unsupported doctor exit code with a limited view',
    async (reason) => {
      let openedModel: VisualReportModel | undefined;
      const result = await runCli(['doctor', '--html'], runtime({
        runDoctor: async () => ({ report: legacyReport('unsupported') }),
        openVisualReport: async (model) => {
          openedModel = model;
          return reason;
        }
      }));

      expect(openedModel).toMatchObject({
        reportStatus: 'unsupported',
        coverage: 'unavailable',
        volume: { diskLevel: 'unknown' },
        providers: [],
        availablePlans: []
      });
      expect(result).toEqual({ exitCode: 2, output: GRACEFUL_OUTPUT, stream: 'stderr' });
    }
  );

  test('a schema-v1 latest report opens only the limited view and keeps report exit code zero', async () => {
    let openedModel: VisualReportModel | undefined;
    const result = await runCli(['report', '--latest', '--html'], runtime({
      latestReport: async () => ({ path: LEAK, report: legacyReport('ok') }),
      openVisualReport: async (model) => {
        openedModel = model;
        return 'hard-timeout';
      }
    }));

    expect(openedModel).toMatchObject({
      reportStatus: 'partial',
      coverage: 'unavailable',
      totals: { trackedBytes: 0, safeBytes: 0, reviewBytes: 0, protectedBytes: 0 }
    });
    expect(result).toEqual({ exitCode: 0, output: GRACEFUL_OUTPUT });
  });

  test('signal teardown maps to 130 without printing a URL or token', async () => {
    const result = await runCli(['doctor', '--html'], runtime({
      openVisualReport: async () => 'signal'
    }));

    expect(result).toEqual({ exitCode: 130, output: INTERRUPTED_OUTPUT });
    expect(result.output).not.toMatch(/https?:\/\//u);
    expect(result.output).not.toContain(LEAK);
  });

  test.each<VisualReportCloseReason>(['launch-failed', 'first-view-timeout', 'server-error'])(
    '%s maps to stable redacted infrastructure failure output',
    async (reason) => {
      const result = await runCli(['doctor', '--html'], runtime({
        openVisualReport: async () => reason
      }));

      expect(result).toEqual({ exitCode: 3, output: FAILURE_OUTPUT });
      expect(result.output).not.toMatch(/https?:\/\/|token|127\.0\.0\.1/iu);
      expect(result.output).not.toContain(reason);
    }
  );

  test('redacts an unexpected visual-report launch rejection', async () => {
    const result = await runCli(['doctor', '--html'], runtime({
      openVisualReport: async () => {
        throw new Error(`launch rejected at http://127.0.0.1/token/${LEAK}`);
      }
    }));

    expect(result).toEqual({ exitCode: 3, output: FAILURE_OUTPUT });
  });
});

function runtime(
  commands: NonNullable<CliRuntimeOptions['commands']> = {}
): CliRuntimeOptions {
  return {
    env: {},
    io: {
      isInputTty: true,
      isOutputTty: true,
      columns: 120
    },
    commands: {
      runDoctor: async () => ({ report: aggregateReport() }),
      latestReport: async () => ({ path: LEAK, report: aggregateReport() }),
      latestReclaimRun: async () => null,
      ...commands
    }
  };
}

// --json callers get the JSON error contract; everyone else gets the fixed text on stderr.
function expectIncompatibility(result: { exitCode: number; output: string; stream?: string }, argv: string[]): void {
  if (argv.includes('--json')) {
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: 1,
      status: 'error',
      exitCode: 2,
      error: 'usage',
      message: HTML_INCOMPATIBILITY.trim()
    });
    return;
  }
  expect(result).toEqual({ exitCode: 2, output: HTML_INCOMPATIBILITY, stream: 'stderr' });
}

function commandsThatMustNotRun(calls: string[]): CliRuntimeOptions {
  return runtime({
    runDoctor: async () => {
      calls.push('runDoctor');
      throw new Error('runDoctor must not run for invalid HTML flags');
    },
    latestReport: async () => {
      calls.push('latestReport');
      throw new Error('latestReport must not run for invalid HTML flags');
    },
    openVisualReport: async () => {
      calls.push('openVisualReport');
      throw new Error('openVisualReport must not run for invalid HTML flags');
    }
  });
}

function aggregateReport(): MaintenanceReport {
  const entries: StateEntry[] = [
    {
      category: 'cache',
      pathCategory: `${LEAK}/cache`,
      bytes: 40,
      reclaimability: 'safe'
    },
    {
      category: 'log',
      pathCategory: `${LEAK}/log`,
      bytes: 30,
      reclaimability: 'confirm'
    },
    {
      category: 'session',
      pathCategory: `${LEAK}/session`,
      bytes: 30,
      reclaimability: 'never'
    }
  ];
  const provider: ProviderReport = {
    id: 'codex',
    displayName: LEAK,
    present: true,
    totalBytes: 100,
    buckets: {
      safeReclaimableBytes: 40,
      confirmBytes: 30,
      privateBytes: 30
    },
    entries,
    advisories: []
  };
  return {
    schemaVersion: 2,
    toolVersion: LEAK,
    generatedAt: '2026-08-26T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: { kind: 'aggregate-ai-tools', pathCategory: LEAK },
    findings: {
      coverage: { complete: true, trackedStateIsLowerBound: false, warnings: [] }
    },
    metrics: {
      volume: {
        totalBytes: 1_000,
        usedBytes: 900,
        availableBytes: 100,
        capacityPercent: 90
      }
    },
    blockedReasons: [],
    providers: [provider],
    totals: {
      totalBytes: 100,
      safeReclaimableBytes: 40,
      confirmBytes: 30,
      privateBytes: 30
    }
  };
}

function legacyReport(status: MaintenanceReport['status']): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: LEAK,
    generatedAt: '2026-08-26T00:00:00.000Z',
    command: 'doctor',
    status,
    redacted: true,
    target: { kind: 'unknown', pathCategory: LEAK },
    findings: { leaked: LEAK },
    metrics: { leaked: LEAK },
    blockedReasons: [LEAK]
  };
}
