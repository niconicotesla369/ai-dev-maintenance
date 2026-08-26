import os from 'node:os';
import { runCommand as defaultRunCommand, trustedCommandPath as defaultTrustedCommandPath } from '../commands.js';
import type { CommandRunResult } from '../types.js';
import { TOOL_VERSION } from '../version.js';
import { classifyPressureProcesses } from './classify.js';
import { cpuLevelForCapacityPercent, cpuLevelForPercent, diskLevelForCapacityPercent } from './levels.js';
import { parseDfOutput, parseMemoryPressureOutput, parsePsOutput, parseVmStatOutput } from './parse.js';
import type { MemoryPressureSnapshot, PressureLevel, PressureProcess, PressureReport, PressureProviderId } from './types.js';

export type PressureCommandName = 'ps' | 'vm_stat' | 'df' | 'memory_pressure';
type PressureCommandResult = Pick<CommandRunResult, 'code' | 'stdout' | 'stderr'> &
  Partial<Pick<CommandRunResult, 'stdoutTruncated' | 'stderrTruncated' | 'timedOut'>>;

export type PressureDoctorOptions = {
  platform?: NodeJS.Platform;
  now?: () => string;
  run?: (command: PressureCommandName) => Promise<PressureCommandResult>;
  runCommand?: typeof defaultRunCommand;
  resolveCommandPath?: typeof defaultTrustedCommandPath;
  logicalCpuCount?: number;
  currentPid?: number;
};

export async function runPressureDoctor(options: PressureDoctorOptions = {}): Promise<PressureReport> {
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return baseReport(generatedAt, 'unsupported', ['platform is unsupported'], platform);
  }

  const run = options.run ?? ((command) => runSystemCommand(command, {
    runCommand: options.runCommand ?? defaultRunCommand,
    resolveCommandPath: options.resolveCommandPath ?? defaultTrustedCommandPath
  }));
  const [ps, vm, memoryPressure, df] = await Promise.all([
    run('ps').catch((error) => failed(error)),
    run('vm_stat').catch((error) => failed(error)),
    run('memory_pressure').catch((error) => failed(error)),
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
    report.processes = excludeCurrentProcessTree(
      classifyPressureProcesses(parsePsOutput(ps.stdout)),
      normalizedCurrentPid(options.currentPid ?? process.pid)
    )
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

  if (!usable(memoryPressure)) {
    report.status = 'partial';
    report.warnings.push(commandWarning('memory_pressure', memoryPressure));
  } else {
    const memoryPressureSnapshot = parseMemoryPressureOutput(memoryPressure.stdout);
    report.memory = {
      ...report.memory,
      ...definedMemorySnapshot(memoryPressureSnapshot)
    };
    if (memoryPressureSnapshot.freePercent === undefined) {
      report.status = 'partial';
      report.warnings.push('memory pressure source unavailable');
    }
  }

  if (!usable(df)) {
    report.status = 'partial';
    report.warnings.push(commandWarning('df', df));
  } else {
    report.disk = parseDfOutput(df.stdout);
  }

  report.totals = pressureTotals(report.processes, normalizedLogicalCpuCount(options.logicalCpuCount ?? os.cpus().length));
  report.pressureLevel = pressureLevel(report);
  report.nextActions = nextActions(report);
  return report;
}

async function runSystemCommand(
  command: PressureCommandName,
  deps: {
    runCommand: typeof defaultRunCommand;
    resolveCommandPath: typeof defaultTrustedCommandPath;
  }
) {
  if (command === 'ps') {
    const ps = await deps.resolveCommandPath('ps');
    return deps.runCommand(ps, ['-axo', 'pid=,ppid=,%cpu=,%mem=,rss=,command='], {
      timeoutMs: 5_000,
      maxStdoutBytes: 512_000,
      maxStderrBytes: 16_000
    });
  }
  if (command === 'vm_stat') {
    const vmStat = await deps.resolveCommandPath('vm_stat');
    return deps.runCommand(vmStat, [], {
      timeoutMs: 5_000,
      maxStdoutBytes: 64_000,
      maxStderrBytes: 16_000
    });
  }
  if (command === 'memory_pressure') {
    const memoryPressure = await deps.resolveCommandPath('memory_pressure');
    return deps.runCommand(memoryPressure, ['-Q'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 64_000,
      maxStderrBytes: 16_000
    });
  }
  const df = await deps.resolveCommandPath('df');
  return deps.runCommand(df, ['-h', '/System/Volumes/Data'], {
    timeoutMs: 5_000,
    maxStdoutBytes: 64_000,
    maxStderrBytes: 16_000
  });
}

function baseReport(generatedAt: string, status: PressureReport['status'], warnings: string[], platform: NodeJS.Platform): PressureReport {
  return {
    schemaVersion: 2,
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
      aiProcessCount: 0,
      otherCpuPercent: 0,
      otherRssBytes: 0,
      otherProcessCount: 0,
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
  if (result.stderr.includes('untrusted system command')) return `${command} unavailable (untrusted path)`;
  if (command === 'memory_pressure') return 'memory pressure source unavailable';
  return `${command} failed`;
}

function failed(error: unknown): PressureCommandResult {
  return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pressureTotals(processes: PressureProcess[], logicalCpuCount?: number): PressureReport['totals'] {
  const ai = processes.filter((process) => isAiProvider(process.provider));
  const other = processes.filter((process) => !isAiProvider(process.provider));
  const aiCpuPercent = round1(ai.reduce((sum, process) => sum + process.cpuPercent, 0));
  const otherCpuPercent = round1(other.reduce((sum, process) => sum + process.cpuPercent, 0));
  return {
    ...(logicalCpuCount === undefined ? {} : {
      logicalCpuCount,
      aiCpuCapacityPercent: round1(aiCpuPercent / logicalCpuCount),
      otherCpuCapacityPercent: round1(otherCpuPercent / logicalCpuCount)
    }),
    aiCpuPercent,
    aiRssBytes: ai.reduce((sum, process) => sum + process.rssBytes, 0),
    aiProcessCount: ai.length,
    otherCpuPercent,
    otherRssBytes: other.reduce((sum, process) => sum + process.rssBytes, 0),
    otherProcessCount: other.length,
    processCount: processes.length
  };
}

function isAiProvider(provider: PressureProviderId): boolean {
  return provider === 'codex' || provider === 'claude-code' || provider === 'cursor';
}

function nextActions(report: PressureReport): string[] {
  const actions: string[] = [];
  if (report.pressureLevel.memory === 'high') {
    actions.push('Close idle browser tabs or AI tool windows before restarting the Mac.');
  }
  if (report.pressureLevel.cpu === 'high') actions.push('Wait for the top AI process to finish, or close that app manually if it is stuck.');
  if (report.pressureLevel.disk === 'high') actions.push('Run doctor to inspect disk buckets before deleting anything.');
  if (report.pressureLevel.reasons.some((reason) => reason.startsWith('non-AI process pressure'))) {
    actions.push('Check Activity Monitor for non-AI apps using high CPU.');
  }
  if (actions.length === 0) actions.push('No urgent pressure action detected.');
  return actions;
}

function pressureLevel(report: PressureReport) {
  const cpu = cpuLevelForReportCpu(report.totals.aiCpuPercent, report.totals.aiCpuCapacityPercent);
  const memory = memoryLevel(report);
  const visualDiskLevel = diskLevelForCapacityPercent(report.disk.capacityPercent);
  const disk: PressureLevel = visualDiskLevel === 'unknown' ? 'ok' : visualDiskLevel;
  const reasons: string[] = [];
  const otherCpu = cpuLevelForReportCpu(report.totals.otherCpuPercent, report.totals.otherCpuCapacityPercent);
  if (memory === 'high') reasons.push('memory pressure is high');
  if (cpu === 'high') reasons.push('AI CPU pressure is high');
  if (disk === 'high') reasons.push('disk pressure is high');
  if (cpu === 'medium') reasons.push('AI CPU pressure is elevated');
  if (disk === 'medium') reasons.push('disk usage is elevated');
  if (otherCpu === 'high') reasons.push('non-AI process pressure is high');
  if (otherCpu === 'medium') reasons.push('non-AI process pressure is elevated');
  return {
    overall: maxLevel(cpu, memory, disk),
    cpu,
    memory,
    disk,
    reasons
  };
}

function cpuLevelForReportCpu(cpuPercent: number, cpuCapacityPercent: number | undefined): PressureLevel {
  return cpuCapacityPercent === undefined
    ? cpuLevelForPercent(cpuPercent)
    : cpuLevelForCapacityPercent(cpuCapacityPercent);
}

function normalizedLogicalCpuCount(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizedCurrentPid(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function excludeCurrentProcessTree(processes: PressureProcess[], currentPid: number | undefined): PressureProcess[] {
  if (currentPid === undefined) return processes;
  return processes.filter((process) => process.pid !== currentPid && process.ppid !== currentPid);
}

function memoryLevel(report: PressureReport): PressureLevel {
  if ((report.memory.freePercent ?? 100) < 15) return 'high';
  if ((report.memory.freePercent ?? 100) < 25) return 'medium';
  return 'ok';
}

function maxLevel(...levels: PressureLevel[]): PressureLevel {
  if (levels.includes('high')) return 'high';
  if (levels.includes('medium')) return 'medium';
  return 'ok';
}

function definedMemorySnapshot(snapshot: MemoryPressureSnapshot): MemoryPressureSnapshot {
  const defined: MemoryPressureSnapshot = {};
  for (const [key, value] of Object.entries(snapshot) as Array<[keyof MemoryPressureSnapshot, number | undefined]>) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}
