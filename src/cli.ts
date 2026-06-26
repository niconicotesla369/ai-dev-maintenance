import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './doctor.js';
import { runFixSafe } from './fix.js';
import { redactPath } from './paths.js';
import { latestReport, sanitizeReportForOutput } from './reports.js';
import { validateRestoreBackup } from './restore.js';
import { TOOL_VERSION } from './version.js';

type CliResult = {
  exitCode: number;
  output: string;
};

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  const [command = 'doctor', ...args] = argv;
  const json = args.includes('--json');
  const showPaths = args.includes('--show-paths');

  if (command === 'doctor') {
    const flagError = unknownFlagError(args, new Set(['--json', '--show-paths']), 'doctor');
    if (flagError) return { exitCode: 2, output: flagError };
    const { report, reportPath } = await runDoctor({ json, showPaths });
    const outputReport = sanitizeReportForOutput(report);
    return {
      exitCode: report.status === 'unsupported' ? 2 : 0,
      output: json ? `${JSON.stringify(outputReport, null, 2)}\n` : renderReport(outputReport, reportPath, showPaths)
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

function renderReport(report: Awaited<ReturnType<typeof runDoctor>>['report'], reportPath?: string, showPaths = false): string {
  const lines = [
    `Status: ${report.status}`,
    `Safe to run fix --safe --yes: ${safeToRunFix(report) ? 'yes' : 'no'}`,
    `What changed: ${whatChanged(report)}`,
    `Target: ${report.target.pathCategory}`,
    `Blocked reasons: ${report.blockedReasons.length === 0 ? 'none' : report.blockedReasons.join('; ')}`
  ];
  if (report.metrics.reclaimedBytes !== undefined) {
    lines.push(`Reclaimed bytes: ${report.metrics.reclaimedBytes}`);
  }
  if (report.nextSafeAction) lines.push(`Next safe action: ${report.nextSafeAction}`);
  if (reportPath) {
    const reportLocation = showPaths ? redactPath(reportPath) : redactPath(reportPath);
    lines.push(`Report saved: ${reportLocation}`);
    lines.push(`Review with: npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- report --latest`);
  }
  return `${lines.join('\n')}\n`;
}

export { renderReport };

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
    '  ai-dev-maintenance doctor [--json] [--show-paths]',
    '  ai-dev-maintenance fix --safe --yes',
    '  ai-dev-maintenance report --latest [--show-paths]',
    '  ai-dev-maintenance restore validate --backup <path>'
  ].join('\n') + '\n';
}

function safeToRunFix(report: Awaited<ReturnType<typeof runDoctor>>['report']): boolean {
  if (report.command !== 'doctor') return false;
  if (report.status !== 'ok' || report.blockedReasons.length > 0) return false;
  const findings = report.findings as Record<string, unknown>;
  const openHandles = findings.openHandles as { usable?: boolean; openHandles?: boolean } | undefined;
  if (openHandles && (!openHandles.usable || openHandles.openHandles)) return false;
  if (findings.knownCodexProcessExists !== false) return false;
  return true;
}

function whatChanged(report: Awaited<ReturnType<typeof runDoctor>>['report']): string {
  if (report.command === 'doctor') return 'redacted report only';
  if (report.command === 'fix --safe' && report.status === 'ok') return 'private backup + WAL cleanup';
  if (report.command === 'fix --safe' && report.metrics.backupCreated && report.metrics.checkpointAttempted) {
    return 'private backup created + checkpoint attempted; review report';
  }
  if (report.command === 'fix --safe' && report.metrics.backupCreated) return 'private backup created; fix was blocked';
  if (report.command === 'fix --safe') return 'nothing; fix was blocked';
  return 'nothing';
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
