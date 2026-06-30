import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';

describe('guided interactive CLI', () => {
  test('starts guided mode for no-arg TTY use and pauses safely when Codex is open', async () => {
    let fixCalls = 0;
    const result = await runCli([], {
      env: {},
      io: memoryIo('4\n', true),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: true },
              knownCodexProcessExists: true
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => {
          fixCalls += 1;
          return { report: makeFixReport('ok'), reportPath: '/tmp/fix.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).toContain('AI Dev Maintenance');
    expect(result.output).toContain('SAFE MAINTENANCE CHECK');
    expect(result.output).toContain('Codex is using the log database. Cleanup is paused.');
    expect(result.output).toContain('Paused for safety');
    expect(result.output).toContain('Codex is still open, so AIDM will not clean anything yet.');
    expect(result.output).toContain('Nothing was changed except a redacted local report.');
    expect(result.output).toContain('What do you want to do?');
    expect(result.output).toContain('[1] Wait');
    expect(result.output).toContain('[2] Re-check');
    expect(result.output).toContain('[3] Report');
    expect(result.output).toContain('[4] Quit');
    expect(fixCalls).toBe(0);
  });

  test('runs fix only after ready diagnosis and explicit yes response', async () => {
    let fixCalls = 0;
    const result = await runCli([], {
      env: {},
      io: memoryIo('y\n', true),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              targetState: {
                main: { size: 48_930_816 },
                wal: { size: 5_242_880 },
                shm: { size: 32_768 }
              },
              openHandles: { usable: true, openHandles: false },
              knownCodexProcessExists: false
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => {
          fixCalls += 1;
          return {
            report: makeFixReport('ok', {
              beforeWalBytes: 5_242_880,
              afterWalBytes: 0,
              reclaimedBytes: 5_242_880
            }),
            reportPath: '/tmp/fix.json'
          };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('READY TO CLEAN');
    expect(result.output).toContain('Ready to clean');
    expect(result.output).toContain('Expected cleanup: WAL checkpoint/truncate only.');
    expect(result.output).toContain('Clean now? [y/N]');
    expect(result.output).toContain('Before WAL      5.0 MiB');
    expect(result.output).toContain('After WAL       0.0 MiB');
    expect(result.output).toContain('Reclaimed       5.0 MiB');
    expect(fixCalls).toBe(1);
  });

  test('does not run fix when ready diagnosis is declined', async () => {
    let fixCalls = 0;
    const result = await runCli([], {
      env: {},
      io: memoryIo('\n', true),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: false },
              knownCodexProcessExists: false
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => {
          fixCalls += 1;
          return { report: makeFixReport('ok'), reportPath: '/tmp/fix.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No cleanup was run.');
    expect(fixCalls).toBe(0);
  });

  test('no-arg non-TTY use falls back to static doctor output', async () => {
    const result = await runCli([], {
      env: {},
      io: memoryIo('', false),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: false },
              knownCodexProcessExists: false
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Fix readiness   ready');
    expect(result.output).not.toContain('Clean now?');
  });

  test('no-interactive flag keeps no-arg TTY use on static doctor output', async () => {
    const result = await runCli(['--no-interactive'], {
      env: {},
      io: memoryIo('y\n', true),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: false },
              knownCodexProcessExists: false
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Fix readiness   ready');
    expect(result.output).not.toContain('Clean now?');
  });

  test('no-banner suppresses guided banner without disabling interaction', async () => {
    const result = await runCli(['--no-banner'], {
      env: {},
      io: memoryIo('4\n', true, 100),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: true },
              knownCodexProcessExists: true
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('AAAAA   III  DDDD');
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).toContain('What do you want to do?');
  });

  test('plain mode disables ANSI color in guided banner', async () => {
    const result = await runCli(['--plain'], {
      env: {},
      io: memoryIo('4\n', true, 100),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: true },
              knownCodexProcessExists: true
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).not.toContain('\u001b[');
    expect(result.output).toContain('Status          Paused for safety');
    expect(result.output).toContain('1. Wait');
    expect(result.output).not.toContain('SAFE MAINTENANCE CHECK');
  });

  test('logo command is display-only and does not run doctor or fix', async () => {
    let doctorCalls = 0;
    let fixCalls = 0;
    const result = await runCli(['logo'], {
      env: {},
      io: memoryIo('', true, 100),
      commands: {
        runDoctor: async () => {
          doctorCalls += 1;
          return { report: makeDoctorReport({}), reportPath: '/tmp/report.json' };
        },
        runFixSafe: async () => {
          fixCalls += 1;
          return { report: makeFixReport('ok'), reportPath: '/tmp/fix.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).toContain('AI Dev Maintenance');
    expect(doctorCalls).toBe(0);
    expect(fixCalls).toBe(0);
  });

  test('leading plain flag still routes to logo without running doctor', async () => {
    let doctorCalls = 0;
    const result = await runCli(['--plain', 'logo'], {
      env: {},
      io: memoryIo('', true, 100),
      commands: {
        runDoctor: async () => {
          doctorCalls += 1;
          return { report: makeDoctorReport({}), reportPath: '/tmp/report.json' };
        },
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).not.toContain('\u001b[');
    expect(doctorCalls).toBe(0);
  });

  test('wait mode polls until the database is released before asking for cleanup', async () => {
    let doctorCalls = 0;
    let fixCalls = 0;
    const persistValues: Array<boolean | undefined> = [];
    const result = await runCli(['--wait', '--wait-timeout', '1'], {
      env: {},
      io: memoryIo('y\n', true),
      sleep: async () => undefined,
      now: (() => {
        let tick = 0;
        return () => tick++ * 1_000;
      })(),
      commands: {
        runDoctor: async (options?: { persistReport?: boolean }) => {
          persistValues.push(options?.persistReport);
          doctorCalls += 1;
          return {
            report:
              doctorCalls === 1
                ? makeDoctorReport({
                    findings: {
                      openHandles: { usable: true, openHandles: true },
                      knownCodexProcessExists: true
                    }
                  })
                : makeDoctorReport({
                    findings: {
                      openHandles: { usable: true, openHandles: false },
                      knownCodexProcessExists: false
                    }
                  }),
            reportPath: '/tmp/report.json'
          };
        },
        runFixSafe: async () => {
          fixCalls += 1;
          return { report: makeFixReport('ok'), reportPath: '/tmp/fix.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Waiting for Codex to close safely');
    expect(result.output).toContain('Ready to clean');
    expect(doctorCalls).toBeGreaterThanOrEqual(2);
    expect(persistValues[0]).not.toBe(false);
    expect(persistValues.slice(1)).toContain(false);
    expect(fixCalls).toBe(1);
  });

  test('wait timeout offers a safe exit without running fix', async () => {
    let fixCalls = 0;
    const result = await runCli(['--wait', '--wait-timeout', '0.01'], {
      env: {},
      io: memoryIo('2\n', true),
      sleep: async () => undefined,
      now: (() => {
        let tick = 0;
        return () => tick++ * 1_000;
      })(),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: true },
              knownCodexProcessExists: true
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => {
          fixCalls += 1;
          return { report: makeFixReport('ok'), reportPath: '/tmp/fix.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Wait timed out. Nothing was changed.');
    expect(result.output).toContain('[1] Re-check');
    expect(result.output).toContain('[2] Quit');
    expect(result.output).toContain('No cleanup was run.');
    expect(fixCalls).toBe(0);
  });

  test('json output never enters guided mode', async () => {
    const result = await runCli(['doctor', '--json'], {
      env: {},
      io: memoryIo('y\n', true),
      commands: {
        runDoctor: async () => ({
          report: makeDoctorReport({
            findings: {
              openHandles: { usable: true, openHandles: false },
              knownCodexProcessExists: false
            }
          }),
          reportPath: '/tmp/report.json'
        }),
        runFixSafe: async () => ({ report: makeFixReport('ok'), reportPath: '/tmp/fix.json' })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^\{/);
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).not.toContain('Clean now?');
  });
});

function memoryIo(input: string, isTty: boolean, columns = 80) {
  return {
    input,
    isInputTty: isTty,
    isOutputTty: isTty,
    columns
  };
}

function makeDoctorReport(overrides: Partial<MaintenanceReport>): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.2.4',
    generatedAt: '2026-01-01T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics: {},
    blockedReasons: [],
    ...overrides
  };
}

function makeFixReport(status: MaintenanceReport['status'], metrics: MaintenanceReport['metrics'] = {}): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.2.4',
    generatedAt: '2026-01-01T00:00:00.000Z',
    command: 'fix --safe',
    status,
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics,
    blockedReasons: []
  };
}
