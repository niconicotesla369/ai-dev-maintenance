import { describe, expect, test } from 'vitest';
import { runPressureDoctor } from '../src/pressure/doctor.js';

describe('live pressure doctor', () => {
  test('builds a redacted pressure report from command outputs', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
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
            'Pages free: 3876',
            'Pages purgeable: 42',
            'Swapins: 53636364',
            'Swapouts: 69710976',
            'Pages used by compressor: 158111',
            'Pageins: 292361217',
            'Pageouts: 2351220'
          ].join('\n'));
        }
        if (command === 'memory_pressure') {
          return ok([
            'The system has 8589934592 (524288 pages with a page size of 16384).',
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
      schemaVersion: 2,
      toolVersion: expect.any(String),
      command: 'pressure',
      status: 'ok',
      redacted: true,
      memory: {
        freePercent: 35,
        pagesFree: 3876,
        swapouts: 69710976
      },
      disk: {
        capacityPercent: 85
      },
      totals: {
        aiCpuPercent: 48.1,
        logicalCpuCount: 8,
        aiCpuCapacityPercent: 6,
        aiRssBytes: (78816 + 90000 + 55152) * 1024,
        aiProcessCount: 3,
        otherCpuPercent: 0,
        otherCpuCapacityPercent: 0,
        otherRssBytes: 0,
        otherProcessCount: 0,
        processCount: 3
      },
      pressureLevel: {
        overall: 'medium',
        cpu: 'ok',
        memory: 'ok',
        disk: 'medium',
        reasons: ['disk usage is elevated']
      }
    });
    expect(report.processes.map((process) => process.provider)).toEqual(['codex', 'cursor', 'claude-code']);
    expect(report.totals.aiCpuPercent).toBeCloseTo(48.1);
    expect(JSON.stringify(report)).not.toContain('/Users/');
  });

  test('separates AI totals from non-AI pressure noise and bumps pressure schema to v2', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
      run: async (command) => {
        if (command === 'ps') {
          return ok([
            '101 1 5.0 0.5 50000 /Applications/Codex.app/Contents/MacOS/Codex',
            '102 1 7.5 0.8 80000 /Applications/Cursor.app/Contents/MacOS/Cursor',
            '201 1 95.0 1.2 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper',
            '202 1 65.0 0.7 120000 /System/Library/CoreServices/WindowServer'
          ].join('\n'));
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.schemaVersion).toBe(2);
    expect(report.totals).toMatchObject({
      aiCpuPercent: 12.5,
      logicalCpuCount: 8,
      aiCpuCapacityPercent: 1.6,
      aiRssBytes: (50000 + 80000) * 1024,
      aiProcessCount: 2,
      otherCpuPercent: 160,
      otherCpuCapacityPercent: 20,
      otherRssBytes: (250000 + 120000) * 1024,
      otherProcessCount: 2,
      processCount: 4
    });
    expect(report.pressureLevel.cpu).toBe('ok');
    expect(report.pressureLevel.overall).toBe('ok');
    expect(report.pressureLevel.reasons).not.toContain('non-AI process pressure is high');
    expect(report.pressureLevel.reasons).not.toContain('non-AI process pressure is elevated');
    expect(report.pressureLevel.reasons).not.toContain('AI CPU pressure is high');
  });

  test('uses CPU capacity percent for pressure levels while preserving per-core CPU totals', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
      run: async (command) => {
        if (command === 'ps') {
          return ok([
            '101 1 10.0 0.5 50000 /Applications/Codex.app/Contents/MacOS/Codex',
            '201 1 95.0 1.2 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper',
            '202 1 65.6 0.7 120000 /System/Library/CoreServices/WindowServer'
          ].join('\n'));
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.totals).toMatchObject({
      logicalCpuCount: 8,
      aiCpuPercent: 10,
      aiCpuCapacityPercent: 1.3,
      otherCpuPercent: 160.6,
      otherCpuCapacityPercent: 20.1
    });
    expect(report.pressureLevel.cpu).toBe('ok');
    expect(report.pressureLevel.overall).toBe('ok');
    expect(report.pressureLevel.reasons).not.toContain('non-AI process pressure is high');
    expect(report.pressureLevel.reasons).not.toContain('non-AI process pressure is elevated');
  });

  test('falls back to per-core CPU level when logical CPU count is unavailable', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 0,
      run: async (command) => {
        if (command === 'ps') {
          return ok('201 1 160.6 1.2 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper');
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.totals.logicalCpuCount).toBeUndefined();
    expect(report.totals.otherCpuCapacityPercent).toBeUndefined();
    expect(report.pressureLevel.reasons).toContain('non-AI process pressure is high');
  });

  test('classifies high AI CPU capacity as high pressure', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
      run: async (command) => {
        if (command === 'ps') {
          return ok('101 1 480.0 0.5 50000 /Applications/Codex.app/Contents/MacOS/Codex');
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.totals.aiCpuPercent).toBe(480);
    expect(report.totals.aiCpuCapacityPercent).toBe(60);
    expect(report.pressureLevel.cpu).toBe('high');
    expect(report.pressureLevel.overall).toBe('high');
    expect(report.pressureLevel.reasons).toContain('AI CPU pressure is high');
  });

  test('excludes the current AIDM process and direct children from pressure totals', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
      currentPid: 9000,
      run: async (command) => {
        if (command === 'ps') {
          return ok([
            '9000 8000 90.0 0.5 50000 node /tmp/aidm/dist/cli.js pressure',
            '9001 9000 40.0 0.3 30000 /bin/ps -axo pid,ppid,%cpu,%mem,rss,command',
            '101 1 10.0 0.5 50000 /Applications/Codex.app/Contents/MacOS/Codex',
            '201 1 30.0 1.2 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper'
          ].join('\n'));
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.processes.map((process) => process.pid)).toEqual([201, 101]);
    expect(report.totals).toMatchObject({
      aiCpuPercent: 10,
      otherCpuPercent: 30,
      processCount: 2
    });
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

  test('marks pressure report partial when a trusted command path cannot be resolved', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      resolveCommandPath: async (command) => {
        if (command === 'vm_stat') throw new Error('untrusted system command: vm_stat');
        return command === 'ps' ? '/bin/ps' : '/bin/df';
      },
      runCommand: async (command) => {
        if (command === '/bin/ps') {
          return ok('51162 50860 2.0 0.9 78816 /Applications/Codex.app/Contents/Resources/codex');
        }
        if (command === '/bin/df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 167Gi 31Gi 85% /System/Volumes/Data');
        }
        throw new Error(`unexpected command path ${command}`);
      }
    });

    expect(report.status).toBe('partial');
    expect(report.warnings).toContain('vm_stat unavailable (untrusted path)');
    expect(report.disk.capacityPercent).toBe(85);
    expect(report.processes).toHaveLength(1);
  });

  test('does not infer high memory pressure from low vm_stat free bytes when memory_pressure is unavailable', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => {
        if (command === 'ps') return ok('');
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        if (command === 'vm_stat') {
          return ok([
            'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
            'Pages free: 4071.',
            'Pages occupied by compressor: 170725.'
          ].join('\n'));
        }
        if (command === 'memory_pressure') {
          return { code: 1, stdout: '', stderr: 'memory_pressure unavailable' };
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.status).toBe('partial');
    expect(report.memory.freeBytes).toBe(66_699_264);
    expect(report.memory.freePercent).toBeUndefined();
    expect(report.pressureLevel.memory).toBe('ok');
    expect(report.pressureLevel.reasons).not.toContain('memory pressure is high');
    expect(report.warnings).toContain('memory pressure source unavailable');
  });

  test('classifies low memory_pressure free percent as high pressure', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => {
        if (command === 'ps') return ok('');
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        if (command === 'vm_stat') {
          return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        }
        if (command === 'memory_pressure') {
          return ok([
            'The system has 8589934592 (524288 pages with a page size of 16384).',
            'System-wide memory free percentage: 8%'
          ].join('\n'));
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.status).toBe('ok');
    expect(report.memory.freePercent).toBe(8);
    expect(report.pressureLevel.memory).toBe('high');
    expect(report.pressureLevel.reasons).toContain('memory pressure is high');
  });

  test('does not clobber vm_stat fields when memory_pressure omits them', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => {
        if (command === 'ps') return ok('');
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        if (command === 'vm_stat') {
          return ok([
            'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
            'Pages free: 4071.',
            'Pages occupied by compressor: 170725.'
          ].join('\n'));
        }
        if (command === 'memory_pressure') {
          return ok('System-wide memory free percentage: 33%');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.status).toBe('ok');
    expect(report.memory.pageSizeBytes).toBe(16_384);
    expect(report.memory.pagesFree).toBe(4_071);
    expect(report.memory.freeBytes).toBe(66_699_264);
    expect(report.memory.freePercent).toBe(33);
  });

  test('warns when memory_pressure succeeds but does not expose free percentage', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      run: async (command) => {
        if (command === 'ps') return ok('');
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        if (command === 'vm_stat') {
          return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        }
        if (command === 'memory_pressure') {
          return ok('No free percentage in this macOS output');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.status).toBe('partial');
    expect(report.memory.pageSizeBytes).toBe(16_384);
    expect(report.memory.freePercent).toBeUndefined();
    expect(report.warnings).toContain('memory pressure source unavailable');
  });

  test('suggests Activity Monitor when non-AI processes dominate CPU pressure', async () => {
    const report = await runPressureDoctor({
      platform: 'darwin',
      logicalCpuCount: 8,
      run: async (command) => {
        if (command === 'ps') {
          return ok([
            '101 1 5.0 0.5 50000 /Applications/Codex.app/Contents/MacOS/Codex',
            '201 1 480.0 1.2 250000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper'
          ].join('\n'));
        }
        if (command === 'vm_stat') return ok('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4071.');
        if (command === 'memory_pressure') {
          return ok('The system has 8589934592 (524288 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%');
        }
        if (command === 'df') {
          return ok('Filesystem Size Used Avail Capacity Mounted on\n/dev/disk3s5 228Gi 100Gi 128Gi 45% /System/Volumes/Data');
        }
        throw new Error(`unexpected command ${command}`);
      }
    });

    expect(report.pressureLevel.overall).toBe('ok');
    expect(report.pressureLevel.reasons).toContain('non-AI process pressure is high');
    expect(report.nextActions).toContain('Check Activity Monitor for non-AI apps using high CPU.');
  });
});

function ok(stdout: string) {
  return { code: 0, stdout, stderr: '' };
}
