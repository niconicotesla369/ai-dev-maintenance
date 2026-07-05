import { runCodexDoctor as defaultRunCodexDoctor, runDoctor as defaultRunDoctor } from './doctor.js';
import { runFixSafe as defaultRunFixSafe } from './fix.js';
import { runCursorSafeCleanup as defaultRunCursorSafeCleanup } from './cursor-clean.js';
import { runPressureDoctor as defaultRunPressureDoctor } from './pressure/doctor.js';
import { renderPressureReport } from './pressure/render.js';
import { buildHistoryReport as defaultBuildHistoryReport, renderHistoryReport } from './history.js';
import { renderTrustReport, runTrust as defaultRunTrust } from './trust.js';
import {
  applyMaintenancePlan as defaultApplyMaintenancePlan,
  createMaintenancePlan as defaultCreateMaintenancePlan,
  renderApplyResult,
  renderPlanSummary
} from './plan.js';
import { runMcpSession, serveMcpStream } from './mcp/server.js';
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
import { renderPressureShareCard, renderShareCard } from './share-card.js';
import { shouldPrettyPrint } from './ui/components.js';
import { TOOL_VERSION } from './version.js';
import { pruneBackups as defaultPruneBackups, pruneReports as defaultPruneReports } from './retention.js';
import path from 'node:path';

export type CliResult = {
  exitCode: number;
  output: string;
  outputAlreadyWritten?: boolean;
};

type RunDoctorCommand = (options?: {
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ report: MaintenanceReport; reportPath?: string }>;

export type CliCommands = {
  runDoctor: RunDoctorCommand;
  runFixSafe: typeof defaultRunFixSafe;
  latestReport: typeof defaultLatestReport;
  validateRestoreBackup: typeof defaultValidateRestoreBackup;
  pruneReports: typeof defaultPruneReports;
  pruneBackups: typeof defaultPruneBackups;
  runCursorSafeCleanup: typeof defaultRunCursorSafeCleanup;
  runPressureDoctor: typeof defaultRunPressureDoctor;
  runHistory: typeof defaultBuildHistoryReport;
  runTrust: typeof defaultRunTrust;
  createPlan: typeof defaultCreateMaintenancePlan;
  applyPlan: typeof defaultApplyMaintenancePlan;
};

export type CliRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  commands?: Partial<CliCommands>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function routeCli(argv: string[], runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  if (isRootVersionRequest(argv)) return { exitCode: 0, output: `${TOOL_VERSION}\n` };
  if (isRootHelpRequest(argv)) return { exitCode: 0, output: usageText() };

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
    runHistory: defaultBuildHistoryReport,
    runTrust: defaultRunTrust,
    createPlan: defaultCreateMaintenancePlan,
    applyPlan: defaultApplyMaintenancePlan,
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
      pretty: shouldPrettyPrint({
        plain: parsed.plain,
        ci: env.CI !== undefined,
        noColor: env.NO_COLOR !== undefined || io.noColor,
        isTty: io.isOutputTty,
        columns: io.columns,
        minColumns: 80
      }),
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
      new Set(['--json', '--show-paths', '--share', '--no-banner', '--no-interactive', '--plain', '--wait-timeout']),
      'doctor'
    );
    if (flagError) return { exitCode: 2, output: flagError };
    if (parsed.share && parsed.json) return { exitCode: 2, output: `doctor --share cannot be combined with --json.\n${usageText()}` };
    const { report, reportPath } = await commands.runDoctor({
      json: parsed.json,
      showPaths: parsed.share ? false : parsed.showPaths,
      persistReport: parsed.share ? false : undefined
    });
    const outputReport = sanitizeReportForOutput(report);
    if (parsed.share) {
      return {
        exitCode: report.status === 'unsupported' ? 2 : 0,
        output: renderShareCard(outputReport)
      };
    }
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
    return {
      exitCode,
      output: parsed.json ? jsonOutput(outputReport) : renderReport(outputReport, reportPath, parsed.showPaths)
    };
  }

  if (parsed.command === 'cursor' && parsed.args[0] === 'clean' && parsed.args.includes('--safe')) {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--safe', '--yes', '--json']), 'cursor clean');
    if (flagError) return { exitCode: 2, output: flagError };
    const result = await commands.runCursorSafeCleanup({ env, yes: parsed.args.includes('--yes') });
    const exitCode = result.status === 'blocked' ? 3 : 0;
    return {
      exitCode,
      output: parsed.json ? jsonOutput(cursorCleanupJsonResult(result)) : renderCursorCleanupResult(result)
    };
  }

  if (parsed.command === 'pressure') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json', '--share', '--no-banner', '--plain']), 'pressure');
    if (flagError) return { exitCode: 2, output: flagError };
    if (parsed.share && parsed.json) return { exitCode: 2, output: `pressure --share cannot be combined with --json.\n${usageText()}` };
    const report = await commands.runPressureDoctor();
    if (parsed.share) {
      return {
        exitCode: report.status === 'unsupported' ? 2 : 0,
        output: renderPressureShareCard(report)
      };
    }
    const pretty = shouldPrettyPrint({
      json: parsed.json,
      plain: parsed.plain,
      ci: env.CI !== undefined,
      noColor: env.NO_COLOR !== undefined || io.noColor,
      isTty: io.isOutputTty,
      columns: io.columns,
      minColumns: 80
    });
    return {
      exitCode: report.status === 'unsupported' ? 2 : 0,
      output: parsed.json ? `${JSON.stringify(report, null, 2)}\n` : renderPressureReport(report, {
        pretty,
        color: pretty && parsed.plain !== true && env.NO_COLOR === undefined && io.noColor !== true,
        columns: io.columns
      })
    };
  }

  if (parsed.command === 'history') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json', '--plain']), 'history');
    if (flagError) return { exitCode: 2, output: flagError };
    const report = await commands.runHistory({ env });
    return {
      exitCode: 0,
      output: parsed.json ? jsonOutput(report) : renderHistoryReport(report)
    };
  }

  if (parsed.command === 'trust') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json']), 'trust');
    if (flagError) return { exitCode: 2, output: flagError };
    const report = await commands.runTrust();
    return {
      exitCode: report.status === 'ok' ? 0 : 3,
      output: parsed.json ? jsonOutput(report) : renderTrustReport(report)
    };
  }

  if (parsed.command === 'plan') {
    const flagError = unknownFlagError(parsed.args, new Set(['--json']), 'plan');
    if (flagError) return { exitCode: 2, output: flagError };
    const action = parsed.args.find((arg) => !arg.startsWith('-'));
    if (action !== 'codex-fix' && action !== 'cursor-clean') {
      return { exitCode: 2, output: `Unknown plan action: ${action ?? '<missing>'}\n${usageText()}` };
    }
    const summary = await commands.createPlan({ action, env });
    return {
      exitCode: summary.status === 'ready' ? 0 : 3,
      output: parsed.json ? jsonOutput(summary) : renderPlanSummary(summary)
    };
  }

  if (parsed.command === 'apply') {
    const flagError = unknownFlagError(parsed.args, new Set(['--plan', '--yes', '--json']), 'apply');
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const plan = parsed.args[parsed.args.indexOf('--plan') + 1];
    if (!plan || plan.startsWith('-')) return { exitCode: 2, output: `Missing --plan <planId>.\n${usageText()}` };
    const result = await commands.applyPlan({ planId: plan, env });
    return {
      exitCode: result.status === 'ok' ? 0 : 3,
      output: parsed.json ? jsonOutput(result) : renderApplyResult(result)
    };
  }

  if (parsed.command === 'mcp' && parsed.args[0] === 'serve') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(), 'mcp serve');
    if (flagError) return { exitCode: 2, output: flagError };
    if (io.isInputTty || io.isOutputTty) {
      return {
        exitCode: 2,
        output: 'MCP stdio server requires piped input/output. Example: aidm mcp serve\n'
      };
    }
    if (runtime.io?.input !== undefined) {
      return {
        exitCode: 0,
        output: await runMcpSession(runtime.io.input, {
          env,
          commands: {
            runDoctor: commands.runDoctor,
            runPressureDoctor: commands.runPressureDoctor,
            latestReport: commands.latestReport,
            runHistory: commands.runHistory,
            createPlan: commands.createPlan
          }
        })
      };
    }
    await serveMcpStream(process.stdin, process.stdout, {
      env,
      commands: {
        runDoctor: commands.runDoctor,
        runPressureDoctor: commands.runPressureDoctor,
        latestReport: commands.latestReport,
        runHistory: commands.runHistory,
        createPlan: commands.createPlan
      }
    });
    return {
      exitCode: 0,
      output: '',
      outputAlreadyWritten: true
    };
  }

  if (parsed.command === 'report' && parsed.args.includes('--latest')) {
    const flagError = unknownFlagError(parsed.args, new Set(['--latest', '--show-paths', '--json', '--unredacted']), 'report');
    if (flagError) return { exitCode: 2, output: flagError };
    if (parsed.args.includes('--unredacted')) {
      return { exitCode: 2, output: '--unredacted is not supported in v1.\n' };
    }
    const latest = await commands.latestReport();
    if (!latest) return { exitCode: 1, output: 'No report found.\n' };
    const includePath = parsed.args.includes('--show-paths');
    const payload = sanitizeReportForOutput(latest.report);
    if (parsed.json) {
      return {
        exitCode: 0,
        output: `${JSON.stringify({
          reportPath: includePath ? latest.path : redactPath(latest.path),
          report: payload
        }, null, 2)}\n`
      };
    }
    const pathLine = includePath ? `Report: ${latest.path}\n` : '';
    return { exitCode: 0, output: includePath ? `${pathLine}${JSON.stringify(payload, null, 2)}\n` : renderReport(latest.report, latest.path) };
  }

  if (parsed.command === 'restore' && parsed.args[0] === 'validate') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--backup', '--json']), 'restore validate');
    if (flagError) return { exitCode: 2, output: flagError };
    const backup = parsed.args[parsed.args.indexOf('--backup') + 1];
    if (!backup || backup === parsed.args[0]) return { exitCode: 2, output: 'Missing --backup <path>.\n' };
    const result = await commands.validateRestoreBackup(backup);
    return { exitCode: result.valid ? 0 : 3, output: jsonOutput(result) };
  }

  if (parsed.command === 'reports' && parsed.args[0] === 'prune') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--yes', '--json']), 'reports prune');
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const result = await commands.pruneReports(path.join(appDataHome(env), 'reports'));
    return {
      exitCode: result.warnings.length > 0 ? 3 : 0,
      output: parsed.json ? jsonOutput({ kind: 'reports', ...result }) : renderPruneResult('reports', result)
    };
  }

  if (parsed.command === 'backups' && parsed.args[0] === 'prune') {
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--yes', '--json']), 'backups prune');
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const result = await commands.pruneBackups(path.join(appDataHome(env), 'backups'));
    return {
      exitCode: result.warnings.length > 0 ? 3 : 0,
      output: parsed.json ? jsonOutput({ kind: 'backups', ...result }) : renderPruneResult('backups', result)
    };
  }

  return {
    exitCode: 2,
    output: usageText()
  };
}

function isRootVersionRequest(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version');
}

function isRootHelpRequest(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h');
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
  const allowed = new Set(['--safe', '--yes', '--json']);
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

function jsonOutput(value: unknown): string {
  return `${JSON.stringify(redactJsonValue(value), null, 2)}\n`;
}

function cursorCleanupJsonResult(result: Awaited<ReturnType<typeof defaultRunCursorSafeCleanup>>) {
  return {
    status: result.status,
    mode: result.mode,
    reclaimableBytes: result.reclaimableBytes,
    deletedBytes: result.deletedBytes,
    deletedEntries: result.deletedEntries,
    targets: result.targets.map((target) => ({
      pathCategory: target.pathCategory,
      bytes: target.bytes,
      note: target.note
    })),
    blockedReasons: result.blockedReasons,
    warnings: result.warnings
  };
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPath(value);
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry));
  if (!isPlainObject(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = redactJsonValue(child);
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
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
