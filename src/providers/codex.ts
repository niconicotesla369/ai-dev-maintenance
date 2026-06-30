import path from 'node:path';
import { trustedCommandPath, runCommand } from '../commands.js';
import { detectTargetState, pathExists, safeTargetStateForReport } from '../fs-safety.js';
import { defaultCodexHome, redactPath, targetTriple } from '../paths.js';
import { writeReport } from '../reports.js';
import { classifyLsofResult, deriveFixReadiness, parseKnownCodexProcess } from '../safety.js';
import { checkSqliteJsonSupport } from '../sqlite.js';
import type { MaintenanceReport } from '../types.js';
import { REPORT_SCHEMA_VERSION, TOOL_VERSION } from '../version.js';
import type { MaintenanceProvider } from './types.js';

export const codexProvider: MaintenanceProvider = {
  id: 'codex',
  displayName: 'Codex',
  defaultPathCategory: '<home>/.codex/logs_2.sqlite',
  runDoctor: runCodexDoctor
};

async function runCodexDoctor(options: Parameters<MaintenanceProvider['runDoctor']>[0]) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    const report = baseReport('doctor', options.generatedAt, 'unsupported');
    report.blockedReasons.push('platform is unsupported');
    report.nextSafeAction = 'Run this tool on macOS.';
    return { report };
  }

  const { codexHome, custom } = defaultCodexHome(options.env);
  const mainPath = path.join(codexHome, 'logs_2.sqlite');
  const state = await detectTargetState(mainPath);
  const report = baseReport('doctor', options.generatedAt, state.fixable ? 'ok' : 'partial');
  report.target.pathCategory = custom ? 'custom-codex-home' : codexProvider.defaultPathCategory;
  report.findings.targetState = redactState(state);
  report.blockedReasons.push(...state.blockers);
  if (custom) report.blockedReasons.push('custom CODEX_HOME is read-only in doctor and rejected by fix');

  const sqliteSupport = await checkSqliteJsonSupport();
  report.findings.sqliteJson = sqliteSupport;

  const lsof = await checkOpenHandles(targetTriple(mainPath));
  report.findings.openHandles = lsof;

  const knownProcess = await knownCodexProcessExists();
  report.findings.knownCodexProcessExists = knownProcess;
  report.findings.fixReadiness = deriveFixReadiness(report);

  report.findings.sqlite = {
    available: false,
    reason: 'source database inspection is skipped in v1 to avoid copying private log bytes'
  };

  const reportPath = options.persistReport === false ? undefined : await writeReport(report);
  if (options.showPaths && reportPath) report.findings.reportPath = redactPath(reportPath);
  return { report, reportPath };
}

export async function checkOpenHandles(paths: string[]) {
  try {
    const existingPaths = [];
    for (const candidate of paths) {
      if (await pathExists(candidate)) existingPaths.push(candidate);
    }
    if (existingPaths.length === 0) {
      return { usable: true, openHandles: false, reason: 'no target files exist' };
    }
    const lsof = await trustedCommandPath('lsof');
    const result = await runCommand(lsof, ['-F', 'pcn', ...existingPaths], { timeoutMs: 5_000 });
    return classifyLsofResult(result);
  } catch (error) {
    return {
      usable: false,
      openHandles: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function knownCodexProcessExists(): Promise<boolean | 'unknown'> {
  try {
    const ps = await trustedCommandPath('ps');
    const result = await runCommand(ps, ['-axo', 'pid=,comm=,command='], { timeoutMs: 5_000 });
    if (result.stdoutTruncated || result.stderrTruncated) return 'unknown';
    if (result.code !== 0) return 'unknown';
    return parseKnownCodexProcess(result.stdout);
  } catch {
    return 'unknown';
  }
}

function baseReport(command: string, generatedAt: string, status: MaintenanceReport['status']): MaintenanceReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    generatedAt,
    command,
    status,
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: codexProvider.defaultPathCategory
    },
    findings: {},
    metrics: {},
    blockedReasons: []
  };
}

function redactState(state: Awaited<ReturnType<typeof detectTargetState>>) {
  return safeTargetStateForReport(state);
}
