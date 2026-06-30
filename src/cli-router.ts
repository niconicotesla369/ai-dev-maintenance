import { runCodexDoctor as defaultRunCodexDoctor, runDoctor as defaultRunDoctor } from './doctor.js';
import { runFixSafe as defaultRunFixSafe } from './fix.js';
import { runCursorSafeCleanup as defaultRunCursorSafeCleanup } from './cursor-clean.js';
import { runPressureDoctor as defaultRunPressureDoctor } from './pressure/doctor.js';
import { renderPressureReport } from './pressure/render.js';
import { appDataHome, redactPath } from './paths.js';
import { latestReport as defaultLatestReport, sanitizeReportForOutput } from './reports.js';
import { validateRestoreBackup as defaultValidateRestoreBackup } from './restore.js';
import type { MaintenanceReport } from './types.js';
import { bannerText, shouldShowBanner } from './cli-banner.js';
import { invalidWaitTimeoutError, parseCliArgs, unknownFlagError, usageText } from './cli-args.js';
import type { CliIo } from './cli-io.js';
import { normalizeCliIo } from './cli-io.js';
import { runGuidedCli } from './cli-interactive.js';
import { renderReport } from './cli-render.js';
import { formatBytes, row } from './cli-render.js';
import { TOOL_VERSION } from './version.js';
import { pruneBackups as defaultPruneBackups, pruneReports as defaultPruneReports } from './retention.js';
import path from 'node:path';

export type CliResult = {
  exitCode: number;
  output: string;
  outputAlreadyWritten?: boolean;
};

export type CliCommands = {
  runDoctor: typeof defaultRunDoctor;
  runFixSafe: typeof defaultRunFixSafe;
  latestReport: typeof defaultLatestReport;
  validateRestoreBackup: typeof defaultValidateRestoreBackup;
  pruneReports: typeof defaultPruneReports;
  pruneBackups: typeof defaultPruneBackups;
  runCursorSafeCleanup: typeof defaultRunCursorSafeCleanup;
  runPressureDoctor: typeof defaultRunPressureDoctor;
};

export type CliRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  commands?: Partial<CliCommands>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function routeCli(argv: string[], runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  const parsed = parseCliArgs(argv);
  const commands: CliCommands = {
    runDoctor: defaultRunDoctor,
    runFixSafe: defaultRunFixSafe,
    latestReport: defaultLatestReport,
    validateRestoreBackup: defaultValidateRestoreBackup,
    pruneReports: defaultPruneReports,
    pruneBackups: defaultPruneBackups,
    runCursorSafeCleanup: defaultRunCursorSafeCleanup,
    runPressureDoctor: defaultRunPressureDoctor,
    ...runtime.commands
  };
  const io = normalizeCliIo(runtime.io);
  const env = runtime.env ?? process.env;
  const waitTimeoutError = invalidWaitTimeoutError(parsed.args);
  if (waitTimeoutError) return { exitCode: 2, output: waitTimeoutError };
  if (parsed.noCommand) {
    const flagError = unknownFlagError(
      parsed.args,
      new Set(['--wait', '--wait-timeout', '--no-interactive', '--no-banner', '--plain']),
      'doctor'
    );
    if (flagError) return { exitCode: 2, output: flagError };
  }

  if (parsed.command === 'logo') {
    const flagError = unknownFlagError(parsed.args, new Set(['--plain']), 'logo');
    if (flagError) return { exitCode: 2, output: flagError };
    return {
      exitCode: 0,
      output: bannerText({
        style: 'hero',
        columns: io.columns,
        color: parsed.plain !== true && env.NO_COLOR === undefined && io.noColor !== true
      })
    };
  }

  if (shouldUseGuidedMode(parsed, env, io)) {
    const runGuidedDoctor = runtime.commands?.runDoctor ?? defaultRunCodexDoctor;
    return runGuidedCli({
      io,
      wait: parsed.wait,
      waitTimeoutMinutes: parsed.waitTimeoutMinutes,
      banner: {
        enabled: !parsed.noBanner,
        color: parsed.plain !== true && env.NO_COLOR === undefined && io.noColor !== true,
        columns: io.columns
      },
      sleep: runtime.sleep ?? sleep,
      now: runtime.now ?? Date.now,
      commands: {
        runDoctor: async (options) => runGuidedDoctor(options),
        runFixSafe: async () => commands.runFixSafe()
      }
    });
  }

  if (parsed.command === 'doctor') {
    const flagError = unknownFlagError(
      parsed.args,
      new Set(['--json', '--show-paths', '--no-banner', '--no-interactive', '--plain', '--wait-timeout']),
      'doctor'
    );
    if (flagError) return { exitCode: 2, output: flagError };
    const { report, reportPath } = await commands.runDoctor({ json: parsed.json, showPaths: parsed.showPaths });
    const outputReport = sanitizeReportForOutput(report);
    const banner = shouldShowBanner({
      json: parsed.json,
      noBanner: parsed.noBanner,
      ci: env.CI !== undefined,
      noColor: env.NO_COLOR !== undefined,
      plain: parsed.plain,
      isTty: io.isOutputTty
    });
    return {
      exitCode: report.status === 'unsupported' ? 2 : 0,
      output: parsed.json ? `${JSON.stringify(outputReport, null, 2)}\n` : renderReport(outputReport, reportPath, parsed.showPaths, { banner })
    };
  }

  if (parsed.command === 'fix' && parsed.args.includes('--safe')) {
    const confirmationError = fixSafeConfirmationError(parsed.args);
    if (confirmationError) return { exitCode: 2, output: confirmationError };
    const { report, reportPath } = await commands.runFixSafe();
    const outputReport = sanitizeReportForOutput(report);
    const exitCode = report.status === 'ok' ? 0 : 3;
    return { exitCode, output: renderReport(outputReport, reportPath, parsed.showPaths) };
  }

  if (parsed.command === 'cursor' && parsed.args[0] === 'clean' && parsed.args.includes('--safe')) {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--safe', '--yes']), 'cursor clean');
    if (flagError) return { exitCode: 2, output: flagError };
    const result = await commands.runCursorSafeCleanup({ env, yes: parsed.args.includes('--yes') });
    const exitCode = result.status === 'blocked' ? 3 : 0;
    return { exitCode, output: renderCursorCleanupResult(result) };
  }

  if (parsed.command === 'pressure') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json', '--no-banner', '--plain']), 'pressure');
    if (flagError) return { exitCode: 2, output: flagError };
    const report = await commands.runPressureDoctor();
    return {
      exitCode: report.status === 'unsupported' ? 2 : 0,
      output: parsed.json ? `${JSON.stringify(report, null, 2)}\n` : renderPressureReport(report)
    };
  }

  if (parsed.command === 'report' && parsed.args.includes('--latest')) {
    const flagError = unknownFlagError(parsed.args, new Set(['--latest', '--show-paths', '--unredacted']), 'report');
    if (flagError) return { exitCode: 2, output: flagError };
    if (parsed.args.includes('--unredacted')) {
      return { exitCode: 2, output: '--unredacted is not supported in v1.\n' };
    }
    const latest = await commands.latestReport();
    if (!latest) return { exitCode: 1, output: 'No report found.\n' };
    const includePath = parsed.args.includes('--show-paths');
    const payload = latest.report;
    const pathLine = includePath ? `Report: ${latest.path}\n` : '';
    return { exitCode: 0, output: includePath ? `${pathLine}${JSON.stringify(payload, null, 2)}\n` : renderReport(latest.report, latest.path) };
  }

  if (parsed.command === 'restore' && parsed.args[0] === 'validate') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--backup']), 'restore validate');
    if (flagError) return { exitCode: 2, output: flagError };
    const backup = parsed.args[parsed.args.indexOf('--backup') + 1];
    if (!backup || backup === parsed.args[0]) return { exitCode: 2, output: 'Missing --backup <path>.\n' };
    const result = await commands.validateRestoreBackup(backup);
    return { exitCode: result.valid ? 0 : 3, output: `${JSON.stringify(result, null, 2)}\n` };
  }

  if (parsed.command === 'reports' && parsed.args[0] === 'prune') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--yes']), 'reports prune');
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const result = await commands.pruneReports(path.join(appDataHome(), 'reports'));
    return { exitCode: result.warnings.length > 0 ? 3 : 0, output: renderPruneResult('reports', result) };
  }

  if (parsed.command === 'backups' && parsed.args[0] === 'prune') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--yes']), 'backups prune');
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const result = await commands.pruneBackups(path.join(appDataHome(), 'backups'));
    return { exitCode: result.warnings.length > 0 ? 3 : 0, output: renderPruneResult('backups', result) };
  }

  return {
    exitCode: 2,
    output: usageText()
  };
}

function renderCursorCleanupResult(result: Awaited<ReturnType<typeof defaultRunCursorSafeCleanup>>): string {
  const lines = [
    row('Cursor cleanup', result.status),
    row('Mode', result.mode === 'dry-run' ? 'dry run' : 'cleanup'),
    row(result.mode === 'cleanup' ? 'Reclaimed' : 'Reclaimable', formatBytes(result.mode === 'cleanup' ? result.deletedBytes : result.reclaimableBytes)),
    row('Targets', String(result.targets.length)),
    row('Changed', result.mode === 'cleanup' ? 'Cursor cache/log contents removed' : 'nothing; dry run only')
  ];
  for (const reason of result.blockedReasons) lines.push(row('Reason', reason));
  for (const warning of result.warnings) lines.push(row('Warning', warning));
  if (result.mode === 'dry-run' && result.status === 'ready' && result.reclaimableBytes > 0) {
    lines.push(row('Next', 'ai-dev-maintenance cursor clean --safe --yes'));
  }
  return `${lines.join('\n')}\n`;
}

function renderPruneResult(kind: 'reports' | 'backups', result: { deleted: number; warnings: string[] }): string {
  const label = kind === 'reports' ? 'Deleted reports' : 'Deleted backups';
  const lines = [`${label.padEnd(17, ' ')}${result.deleted}`];
  for (const warning of result.warnings) lines.push(`Warning          ${warning}`);
  return `${lines.join('\n')}\n`;
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

function shouldUseGuidedMode(
  parsed: ReturnType<typeof parseCliArgs>,
  env: NodeJS.ProcessEnv,
  io: ReturnType<typeof normalizeCliIo>
): boolean {
  return (
    parsed.noCommand &&
    !parsed.noInteractive &&
    !parsed.json &&
    env.CI === undefined &&
    io.isInputTty &&
    io.isOutputTty
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { MaintenanceReport };
