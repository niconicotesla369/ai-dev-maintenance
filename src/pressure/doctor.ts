import { runCommand, trustedCommandPath } from '../commands.js';
import type { CommandRunResult } from '../types.js';
import { TOOL_VERSION } from '../version.js';
import { classifyPressureProcesses } from './classify.js';
import { parseDfOutput, parsePsOutput, parseVmStatOutput } from './parse.js';
import type { PressureLevel, PressureReport } from './types.js';

export type PressureCommandName = 'ps' | 'vm_stat' | 'df';
type PressureCommandResult = Pick<CommandRunResult, 'code' | 'stdout' | 'stderr'> &
  Partial<Pick<CommandRunResult, 'stdoutTruncated' | 'stderrTruncated' | 'timedOut'>>;

export type PressureDoctorOptions = {
  platform?: NodeJS.Platform;
  now?: () => string;
  run?: (command: PressureCommandName) => Promise<PressureCommandResult>;
};

export async function runPressureDoctor(options: PressureDoctorOptions = {}): Promise<PressureReport> {
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return baseReport(generatedAt, 'unsupported', ['platform is unsupported'], platform);
  }

  const run = options.run ?? runSystemCommand;
  const [ps, vm, df] = await Promise.all([
    run('ps').catch((error) => failed(error)),
    run('vm_stat').catch((error) => failed(error)),
    run('df').catch((error) => failed(error))
  ]);

  const report = baseReport(generatedAt, 'ok', [], platform);

  if (!usable(ps)) {
    report.status = 'partial';
    report.warnings.push(commandWarning('ps', ps));
  } else if (ps.stdoutTruncated || ps.stderrTruncated) {
    report.status = 'partial';
    report.warnings.push('ps output was truncated');
  } else {
    report.processes = classifyPressureProcesses(parsePsOutput(ps.stdout))
      .filter((process) => process.provider !== 'other' || process.cpuPercent >= 20 || process.rssBytes >= 200 * 1024 * 1024)
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes)
      .slice(0, 25);
  }

  if (!usable(vm)) {
    report.status = 'partial';
    report.warnings.push(commandWarning('vm_stat', vm));
  } else {
    report.memory = parseVmStatOutput(vm.stdout);
  }

  if (!usable(df)) {
    report.status = 'partial';
    report.warnings.push(commandWarning('df', df));
  } else {
    report.disk = parseDfOutput(df.stdout);
  }

  report.totals = {
    aiCpuPercent: round1(report.processes.reduce((sum, process) => sum + process.cpuPercent, 0)),
    aiRssBytes: report.processes.reduce((sum, process) => sum + process.rssBytes, 0),
    processCount: report.processes.length
  };
  report.pressureLevel = pressureLevel(report);
  report.nextActions = nextActions(report);
  return report;
}

async function runSystemCommand(command: PressureCommandName) {
  if (command === 'ps') {
    const ps = await trustedCommandPath('ps');
    return runCommand(ps, ['-axo', 'pid=,ppid=,%cpu=,%mem=,rss=,command='], {
      timeoutMs: 5_000,
      maxStdoutBytes: 512_000,
      maxStderrBytes: 16_000
    });
  }
  if (command === 'vm_stat') {
    return runCommand('/usr/bin/vm_stat', [], {
      timeoutMs: 5_000,
      maxStdoutBytes: 64_000,
      maxStderrBytes: 16_000
    });
  }
  return runCommand('/bin/df', ['-h', '/System/Volumes/Data'], {
    timeoutMs: 5_000,
    maxStdoutBytes: 64_000,
    maxStderrBytes: 16_000
  });
}

function baseReport(generatedAt: string, status: PressureReport['status'], warnings: string[], platform: NodeJS.Platform): PressureReport {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt,
    command: 'pressure',
    status,
    redacted: true,
    platform,
    memory: {},
    disk: {},
    processes: [],
    totals: {
      aiCpuPercent: 0,
      aiRssBytes: 0,
      processCount: 0
    },
    pressureLevel: {
      overall: 'ok',
      cpu: 'ok',
      memory: 'ok',
      disk: 'ok',
      reasons: []
    },
    warnings,
    nextActions: []
  };
}

function usable(result: PressureCommandResult): boolean {
  return result.code === 0 && result.timedOut !== true;
}

function commandWarning(command: string, result: PressureCommandResult): string {
  if (result.timedOut) return `${command} timed out`;
  return `${command} failed`;
}

function failed(error: unknown): PressureCommandResult {
  return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function nextActions(report: PressureReport): string[] {
  const actions: string[] = [];
  if (report.pressureLevel.memory === 'high') {
    actions.push('Close idle browser tabs or AI tool windows before restarting the Mac.');
  }
  if (report.pressureLevel.cpu === 'high') actions.push('Wait for the top AI process to finish, or close that app manually if it is stuck.');
  if (report.pressureLevel.disk === 'high') actions.push('Run doctor to inspect disk buckets before deleting anything.');
  if (actions.length === 0) actions.push('No urgent pressure action detected.');
  return actions;
}

function pressureLevel(report: PressureReport) {
  const cpu = cpuLevel(report.totals.aiCpuPercent);
  const memory = memoryLevel(report);
  const disk = diskLevel(report.disk.capacityPercent);
  const reasons: string[] = [];
  if (memory === 'high') reasons.push('memory pressure is high');
  if (cpu === 'high') reasons.push('AI CPU pressure is high');
  if (disk === 'high') reasons.push('disk pressure is high');
  if (cpu === 'medium') reasons.push('AI CPU pressure is elevated');
  if (disk === 'medium') reasons.push('disk usage is elevated');
  return {
    overall: maxLevel(cpu, memory, disk),
    cpu,
    memory,
    disk,
    reasons
  };
}

function cpuLevel(cpuPercent: number): PressureLevel {
  if (cpuPercent >= 80) return 'high';
  if (cpuPercent >= 30) return 'medium';
  return 'ok';
}

function memoryLevel(report: PressureReport): PressureLevel {
  if ((report.memory.freePercent ?? 100) < 15) return 'high';
  if (report.memory.freePercent === undefined && (report.memory.freeBytes ?? Number.POSITIVE_INFINITY) < 1_073_741_824) return 'high';
  if ((report.memory.freePercent ?? 100) < 25) return 'medium';
  return 'ok';
}

function diskLevel(capacityPercent: number | undefined): PressureLevel {
  if ((capacityPercent ?? 0) >= 90) return 'high';
  if ((capacityPercent ?? 0) >= 80) return 'medium';
  return 'ok';
}

function maxLevel(...levels: PressureLevel[]): PressureLevel {
  if (levels.includes('high')) return 'high';
  if (levels.includes('medium')) return 'medium';
  return 'ok';
}
