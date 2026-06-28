import { runDoctor as defaultRunDoctor } from './doctor.js';
import { runFixSafe as defaultRunFixSafe } from './fix.js';
import { redactPath } from './paths.js';
import { latestReport as defaultLatestReport, sanitizeReportForOutput } from './reports.js';
import { validateRestoreBackup as defaultValidateRestoreBackup } from './restore.js';
import type { MaintenanceReport } from './types.js';
import { shouldShowBanner } from './cli-banner.js';
import { invalidWaitTimeoutError, parseCliArgs, unknownFlagError, usageText } from './cli-args.js';
import type { CliIo } from './cli-io.js';
import { normalizeCliIo } from './cli-io.js';
import { runGuidedCli } from './cli-interactive.js';
import { renderReport } from './cli-render.js';
import { TOOL_VERSION } from './version.js';

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
    ...runtime.commands
  };
  const io = normalizeCliIo(runtime.io);
  const env = runtime.env ?? process.env;
  const waitTimeoutError = invalidWaitTimeoutError(parsed.args);
  if (waitTimeoutError) return { exitCode: 2, output: waitTimeoutError };

  if (shouldUseGuidedMode(parsed, env, io)) {
    return runGuidedCli({
      io,
      wait: parsed.wait,
      waitTimeoutMinutes: parsed.waitTimeoutMinutes,
      sleep: runtime.sleep ?? sleep,
      now: runtime.now ?? Date.now,
      commands: {
        runDoctor: async () => commands.runDoctor(),
        runFixSafe: async () => commands.runFixSafe()
      }
    });
  }

  if (parsed.command === 'doctor') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json', '--show-paths', '--no-banner', '--no-interactive']), 'doctor');
    if (flagError) return { exitCode: 2, output: flagError };
    const { report, reportPath } = await commands.runDoctor({ json: parsed.json, showPaths: parsed.showPaths });
    const outputReport = sanitizeReportForOutput(report);
    const banner = shouldShowBanner({
      json: parsed.json,
      noBanner: parsed.noBanner,
      ci: env.CI !== undefined,
      noColor: env.NO_COLOR !== undefined,
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
    const pathLine = includePath ? `Report: ${redactPath(latest.path)}\n` : '';
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

  return {
    exitCode: 2,
    output: usageText()
  };
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
