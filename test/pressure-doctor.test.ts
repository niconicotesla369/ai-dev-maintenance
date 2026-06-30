import { describe, expect, test } from 'vitest';
import { runPressureDoctor } from '../src/pressure/doctor.js';

describe('live pressure doctor', () => {
  test('builds a redacted pressure report from command outputs', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => {
        if (command === 'ps') {
          return ok([
            '51162 50860 38.6 0.9 78816 /Applications/Codex.app/Contents/Resources/codex',
            '67718 64364 2.0 0.7 55152 claude',
            '57828 1 7.5 1.1 90000 /Applications/Cursor.app/Contents/MacOS/Cursor'
          ].join('\n'));
        }
        if (command === 'vm_stat') {
          return ok([
            'The system has 8589934592 (524288 pages with a page size of 16384).',
            'Pages free: 3876',
            'Pages purgeable: 42',
            'Swapins: 53636364',
            'Swapouts: 69710976',
            'Pages used by compressor: 158111',
            'Pageins: 292361217',
            'Pageouts: 2351220',
            'System-wide memory free percentage: 35%'
          ].join('\n'));
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 167Gi 31Gi 85% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      toolVersion: expect.any(String),
      command: 'pressure',
      status: 'ok',
      redacted: true,
      memory: {
        freePercent: 35,
        swapouts: 69710976
      },
      disk: {
        capacityPercent: 85
      },
      totals: {
        processCount: 3
      },
      pressureLevel: {
        overall: 'medium',
        cpu: 'medium',
        memory: 'ok',
        disk: 'medium',
        reasons: expect.arrayContaining(['AI CPU pressure is elevated', 'disk usage is elevated'])
      }
    });
    expect(report.processes.map((process) => process.provider)).toEqual(['codex', 'cursor', 'claude-code']);
    expect(report.totals.aiCpuPercent).toBeCloseTo(48.1);
    expect(JSON.stringify(report)).not.toContain('/Users/');
  });

  test('returns unsupported on non-macOS without running commands', async () => {
    let calls = 0;
    const report = await runPressureDoctor({
      platform: 'linux',
      run: async () => {
        calls += 1;
        return ok('');
      }
    });

    expect(calls).toBe(0);
    expect(report.status).toBe('unsupported');
    expect(report.warnings).toContain('platform is unsupported');
  });

  test('fails closed to partial when ps output is truncated', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => command === 'ps'
        ? { code: 0, stdout: '1 1 1 1 1 codex', stderr: '', stdoutTruncated: true }
        : ok('')
    });

    expect(report.status).toBe('partial');
    expect(report.warnings).toContain('ps output was truncated');
    expect(report.processes).toEqual([]);
  });
});

function ok(stdout: string) {
  return { code: 0, stdout, stderr: '' };
}
