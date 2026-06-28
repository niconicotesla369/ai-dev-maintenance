import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './doctor.js';
import { runFixSafe } from './fix.js';
import { redactPath } from './paths.js';
import { latestReport, sanitizeReportForOutput } from './reports.js';
import { validateRestoreBackup } from './restore.js';
import { deriveFixReadiness } from './safety.js';
import type { MaintenanceReport } from './types.js';
import { TOOL_VERSION } from './version.js';

type CliResult = {
  exitCode: number;
  output: string;
};

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  const [command = 'doctor', ...args] = argv;
  const json = args.includes('--json');
  const showPaths = args.includes('--show-paths');
  const noBanner = args.includes('--no-banner');

  if (command === 'doctor') {
    const flagError = unknownFlagError(args, new Set(['--json', '--show-paths', '--no-banner']), 'doctor');
    if (flagError) return { exitCode: 2, output: flagError };
    const { report, reportPath } = await runDoctor({ json, showPaths });
    const outputReport = sanitizeReportForOutput(report);
    const banner = shouldShowBanner({
      json,
      noBanner,
      ci: process.env.CI !== undefined,
      noColor: process.env.NO_COLOR !== undefined,
      isTty: process.stdout.isTTY === true
    });
    return {
      exitCode: report.status === 'unsupported' ? 2 : 0,
      output: json ? `${JSON.stringify(outputReport, null, 2)}\n` : renderReport(outputReport, reportPath, showPaths, { banner })
    };
  }

  if (command === 'fix' && args.includes('--safe')) {
    const confirmationError = fixSafeConfirmationError(args);
    if (confirmationError) return { exitCode: 2, output: confirmationError };
    const { report, reportPath } = await runFixSafe();
    const outputReport = sanitizeReportForOutput(report);
    const exitCode = report.status === 'ok' ? 0 : 3;
    return { exitCode, output: renderReport(outputReport, reportPath, showPaths) };
  }

  if (command === 'report' && args.includes('--latest')) {
    const flagError = unknownFlagError(args, new Set(['--latest', '--show-paths', '--unredacted']), 'report');
    if (flagError) return { exitCode: 2, output: flagError };
    if (args.includes('--unredacted')) {
      return { exitCode: 2, output: '--unredacted is not supported in v1.\n' };
    }
    const latest = await latestReport();
    if (!latest) return { exitCode: 1, output: 'No report found.\n' };
    const includePath = args.includes('--show-paths');
    const payload = latest.report;
    const pathLine = includePath ? `Report: ${redactPath(latest.path)}\n` : '';
    return { exitCode: 0, output: includePath ? `${pathLine}${JSON.stringify(payload, null, 2)}\n` : renderReport(latest.report, latest.path) };
  }

  if (command === 'restore' && args[0] === 'validate') {
    const flagError = unknownFlagError(args.slice(1), new Set(['--backup']), 'restore validate');
    if (flagError) return { exitCode: 2, output: flagError };
    const backup = args[args.indexOf('--backup') + 1];
    if (!backup || backup === args[0]) return { exitCode: 2, output: 'Missing --backup <path>.\n' };
    const result = await validateRestoreBackup(backup);
    return { exitCode: result.valid ? 0 : 3, output: `${JSON.stringify(result, null, 2)}\n` };
  }

  return {
    exitCode: 2,
    output: usageText()
  };
}

type RenderReportOptions = {
  banner?: boolean;
};

type BannerOptions = {
  json: boolean;
  noBanner: boolean;
  ci: boolean;
  noColor: boolean;
  isTty: boolean;
};

function renderReport(report: MaintenanceReport, reportPath?: string, showPaths = false, options: RenderReportOptions = {}): string {
  const readiness = report.command === 'doctor' ? deriveFixReadiness(report) : undefined;
  const lines: string[] = [];
  if (options.banner) {
    lines.push('AI DEV MAINTENANCE', 'Codex log doctor', '');
  }
  lines.push(row('Diagnosis', diagnosisLabel(report)));
  if (readiness) {
    lines.push(row('Fix readiness', readiness.safe ? 'ready' : 'blocked'));
    if (!readiness.safe) lines.push(row('Reason', readiness.reasons.join('; ') || 'not safe to run fix'));
  } else if (report.blockedReasons.length > 0) {
    lines.push(row('Reason', report.blockedReasons.join('; ')));
  }
  lines.push(row('Target', report.target.pathCategory));
  lines.push(...targetSizeRows(report));
  lines.push(...metricRows(report));
  lines.push(row('Changed', whatChanged(report)));
  if (reportPath) {
    const reportLocation = showPaths ? redactPath(reportPath) : redactPath(reportPath);
    lines.push(row('Report', reportLocation));
    lines.push(row('Review', `npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- report --latest`));
  }
  const next = nextAction(report, readiness?.safe === true);
  if (next) lines.push(row('Next', next));
  return `${lines.join('\n')}\n`;
}

export { renderReport };
export function shouldShowBanner(options: BannerOptions): boolean {
  return !options.json && !options.noBanner && !options.ci && !options.noColor && options.isTty;
}

export function fixSafeConfirmationError(args: string[]): string | undefined {
  const allowed = new Set(['--safe', '--yes']);
  const unknown = args.filter((arg) => arg.startsWith('-') && !allowed.has(arg));
  if (unknown.length > 0) return `Unknown fix flag: ${unknown.join(', ')}\n${usageText()}`;
  if (args.includes('--yes')) return undefined;
  return [
    'Missing required confirmation: --yes',
    'This creates a private local backup that may contain Codex log data, then cleans SQLite WAL storage.',
    'It will not upload data, print log contents, delete logs, or rewrite session history.',
    'Run again only after reviewing doctor output:',
    `npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- fix --safe --yes`
  ].join('\n') + '\n';
}

function unknownFlagError(args: string[], allowed: Set<string>, command: string): string | undefined {
  const unknown = args.filter((arg) => arg.startsWith('-') && !allowed.has(arg));
  return unknown.length > 0 ? `Unknown ${command} flag: ${unknown.join(', ')}\n${usageText()}` : undefined;
}

function usageText(): string {
  return [
    'Usage:',
    '  ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]',
    '  ai-dev-maintenance fix --safe --yes',
    '  ai-dev-maintenance report --latest [--show-paths]',
    '  ai-dev-maintenance restore validate --backup <path>'
  ].join('\n') + '\n';
}

function whatChanged(report: MaintenanceReport): string {
  if (report.command === 'doctor') return 'redacted report only';
  if (report.command === 'fix --safe' && report.status === 'ok') return 'private backup + WAL cleanup';
  if (report.command === 'fix --safe' && report.metrics.backupCreated && report.metrics.checkpointAttempted) {
    return 'private backup created + checkpoint attempted; review report';
  }
  if (report.command === 'fix --safe' && report.metrics.backupCreated) return 'private backup created; fix was blocked';
  if (report.command === 'fix --safe') return 'nothing; fix was blocked';
  return 'nothing';
}

function row(label: string, value: string): string {
  return `${label.padEnd(16, ' ')}${value}`;
}

function diagnosisLabel(report: MaintenanceReport): string {
  if (report.command === 'doctor' && report.status === 'ok') return 'complete';
  return report.status;
}

function targetSizeRows(report: MaintenanceReport): string[] {
  const targetState = (report.findings as Record<string, unknown>).targetState as Record<string, unknown> | undefined;
  return [
    sizeRow('Main DB', targetState?.main),
    sizeRow('WAL', targetState?.wal),
    sizeRow('SHM', targetState?.shm)
  ].filter((line): line is string => Boolean(line));
}

function sizeRow(label: string, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const size = value.size;
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined;
  return row(label, formatMiB(size));
}

function metricRows(report: MaintenanceReport): string[] {
  const rows: string[] = [];
  for (const [key, label] of [
    ['beforeWalBytes', 'Before WAL'],
    ['afterWalBytes', 'After WAL'],
    ['reclaimedBytes', 'Reclaimed']
  ] as const) {
    const value = report.metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) rows.push(row(label, formatMiB(value)));
  }
  return rows;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function nextAction(report: MaintenanceReport, ready: boolean): string | undefined {
  if (report.nextSafeAction) return report.nextSafeAction;
  if (report.command !== 'doctor') return undefined;
  if (ready) return `npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- fix --safe --yes`;
  return 'Close AI coding tools, then run doctor again.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isDirectCliInvocation(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  runCli()
    .then((result) => {
      process.stdout.write(result.output);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(formatCliError(error));
      process.exitCode = 1;
    });
}

export function formatCliError(error: unknown): string {
  return `${redactPath(error instanceof Error ? error.message : String(error))}\n`;
}
