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
  renderPlanSummary,
  type ApplyPlanResult,
  type MaintenancePlanAction,
  type MaintenancePlanActionOptions,
  type MaintenancePlanSummary
} from './plan.js';
import {
  scanCodexSessionImages as defaultScanCodexSessionImages,
  publicCodexSessionImageScanResult,
  type PublicCodexSessionImageScanResult
} from './reclaim/codex-session-images.js';
import {
  inspectCodexNativeCompression as defaultInspectCodexNativeCompression,
  type CodexNativeCompressionStatus
} from './reclaim/codex-native.js';
import {
  measureCodexSessionState as defaultMeasureCodexSessionState,
  type CodexSessionMonitorResult
} from './monitor/codex-sessions.js';
import {
  sendCodexSessionMonitorNotification as defaultSendCodexSessionMonitorNotification
} from './monitor/launchd.js';
import { runMcpSession, serveMcpStream } from './mcp/server.js';
import { appDataHome, redactPath } from './paths.js';
import { latestReport as defaultLatestReport, sanitizeReportForOutput } from './reports.js';
import { validateRestoreBackup as defaultValidateRestoreBackup } from './restore.js';
import type { MaintenanceReport } from './types.js';
import { bannerText, shouldShowBanner } from './cli-banner.js';
import {
  invalidWaitTimeoutError,
  parseCliArgs,
  positionalArgsExcludingFlagValues,
  readIntegerFlag,
  unknownFlagError,
  usageText
} from './cli-args.js';
import type { CliIo } from './cli-io.js';
import { normalizeCliIo } from './cli-io.js';
import { runGuidedCli } from './cli-interactive.js';
import {
  createReclaimMeasurer as defaultCreateReclaimMeasurer,
  latestReclaimRunRecord as defaultLatestReclaimRunRecord,
  writeReclaimRunRecord as defaultWriteReclaimRunRecord,
  type ReclaimRunRecord
} from './reclaim-run.js';
import { renderReport } from './cli-render.js';
import { formatBytes, row } from './cli-render.js';
import { renderPressureShareCard, renderShareCard } from './share-card.js';
import { shouldPrettyPrint } from './ui/components.js';
import { TOOL_VERSION } from './version.js';
import { pruneBackups as defaultPruneBackups, pruneReports as defaultPruneReports } from './retention.js';
import { buildVisualReportModel } from './visual-report/model.js';
import {
  openVisualReport as defaultOpenVisualReport,
  type VisualReportCloseReason
} from './visual-report/server.js';
import path from 'node:path';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DEFAULT_IMAGE_OLDER_THAN_DAYS = 30;
const DEFAULT_IMAGE_MIN_FILE_SIZE_MIB = 50;
const DEFAULT_MONITOR_THRESHOLD_GIB = 8;
const DEFAULT_MONITOR_GROWTH_GIB = 5;
const MAX_IMAGE_OLDER_THAN_DAYS = 3650;
const MAX_IMAGE_MIN_FILE_SIZE_MIB = 1_048_576;
const MAX_MONITOR_THRESHOLD_GIB = 1024;
const MAX_MONITOR_THRESHOLD_BYTES = MAX_MONITOR_THRESHOLD_GIB * GIB;
const IMAGE_VALUE_FLAGS = new Set(['--older-than-days', '--min-file-size-mb']);
const MONITOR_PLAN_VALUE_FLAGS = new Set(['--threshold-gib', '--growth-gib']);
const SCHEDULED_MONITOR_VALUE_FLAGS = new Set([
  '--threshold-bytes',
  '--growth-threshold-bytes'
]);
const PUBLIC_PLAN_ACTIONS = new Set<MaintenancePlanAction>([
  'codex-fix',
  'cursor-clean',
  'codex-sparkle-clean',
  'codex-session-image-prune',
  'codex-session-monitor-install',
  'codex-session-monitor-remove'
]);
const HTML_INCOMPATIBILITY = '--html cannot be combined with --json, --share, --show-paths, --plain, or --no-banner.\n';
const GRACEFUL_VISUAL_CLOSE_REASONS = new Set<VisualReportCloseReason>([
  'page-close',
  'idle-timeout',
  'hard-timeout'
]);

export type CliResult = {
  exitCode: number;
  output: string;
  outputAlreadyWritten?: boolean;
  stream?: 'stdout' | 'stderr';
};

export type CliErrorKind = 'not-found' | 'usage' | 'blocked' | 'interrupted' | 'runtime';

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
  scanCodexSessionImages: typeof defaultScanCodexSessionImages;
  inspectCodexNativeCompression: typeof defaultInspectCodexNativeCompression;
  measureCodexSessionState: typeof defaultMeasureCodexSessionState;
  sendCodexSessionMonitorNotification: typeof defaultSendCodexSessionMonitorNotification;
  openVisualReport: typeof defaultOpenVisualReport;
  createPlan: typeof defaultCreateMaintenancePlan;
  applyPlan: typeof defaultApplyMaintenancePlan;
  createReclaimMeasurer: typeof defaultCreateReclaimMeasurer;
  writeReclaimRunRecord: typeof defaultWriteReclaimRunRecord;
  latestReclaimRun: typeof defaultLatestReclaimRunRecord;
};

export type CliRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  commands?: Partial<CliCommands>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function routeCli(argv: string[], runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  return applyOutputContract(argv, await routeCliCommand(argv, runtime));
}

// Failures keep their exit code; --json callers always get JSON, others get errors on stderr.
function applyOutputContract(argv: string[], result: CliResult): CliResult {
  if (result.exitCode === 0 || result.outputAlreadyWritten) return result;
  if (argv.includes('--json')) {
    if (isJsonText(result.output)) return result;
    return { ...result, output: cliErrorJson(result.exitCode, errorMessage(result.output)) };
  }
  if (result.exitCode === 1 || result.exitCode === 2) return { ...result, stream: 'stderr' };
  return result;
}

export function cliErrorJson(exitCode: number, message: string): string {
  return jsonOutput({
    schemaVersion: 1,
    status: 'error',
    exitCode,
    error: cliErrorKind(exitCode),
    message
  });
}

function cliErrorKind(exitCode: number): CliErrorKind {
  if (exitCode === 1) return 'not-found';
  if (exitCode === 2) return 'usage';
  if (exitCode === 3) return 'blocked';
  if (exitCode === 130) return 'interrupted';
  return 'runtime';
}

function errorMessage(output: string): string {
  const beforeUsage = output.split(/^Usage:/m, 1)[0] ?? '';
  const line = beforeUsage.split('\n').map((value) => value.trim()).find(Boolean);
  return line ?? 'invalid command or arguments';
}

function isJsonText(output: string): boolean {
  try {
    JSON.parse(output);
    return true;
  } catch {
    return false;
  }
}

async function routeCliCommand(argv: string[], runtime: CliRuntimeOptions): Promise<CliResult> {
  if (isRootVersionRequest(argv)) return { exitCode: 0, output: `${TOOL_VERSION}\n` };
  if (isRootHelpRequest(argv)) return { exitCode: 0, output: usageText() };

  const parsed = parseCliArgs(argv);
  if (parsed.command === 'doctor' || parsed.command === 'report') {
    const incompatibilityError = htmlIncompatibilityError(parsed);
    if (incompatibilityError) return { exitCode: 2, output: incompatibilityError };
  }
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
    scanCodexSessionImages: defaultScanCodexSessionImages,
    inspectCodexNativeCompression: defaultInspectCodexNativeCompression,
    measureCodexSessionState: defaultMeasureCodexSessionState,
    sendCodexSessionMonitorNotification: defaultSendCodexSessionMonitorNotification,
    openVisualReport: defaultOpenVisualReport,
    createPlan: defaultCreateMaintenancePlan,
    applyPlan: defaultApplyMaintenancePlan,
    createReclaimMeasurer: defaultCreateReclaimMeasurer,
    writeReclaimRunRecord: defaultWriteReclaimRunRecord,
    latestReclaimRun: defaultLatestReclaimRunRecord,
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
        createPlan: async (action) => commands.createPlan({ action, env }),
        applyPlan: async (planId) => commands.applyPlan({ planId, env }),
        measurer: commands.createReclaimMeasurer(env),
        writeRunRecord: async (record) => commands.writeReclaimRunRecord(record, env)
      }
    });
  }

  if (parsed.command === 'doctor') {
    const flagError = unknownFlagError(
      parsed.args,
      new Set(['--json', '--show-paths', '--share', '--html', '--no-banner', '--no-interactive', '--plain', '--wait-timeout']),
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
    if (parsed.html) {
      return await openVisualReportForCli(
        commands.openVisualReport,
        buildVisualReportModel(outputReport, { lastReclaim: await loadLastReclaim(commands, env) }),
        report.status === 'unsupported' ? 2 : 0
      );
    }
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
    const exitCode = result.status === 'blocked' || result.status === 'partial' ? 3 : 0;
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

  if (parsed.command === 'reclaim') {
    if (parsed.args[0] === 'scan' && parsed.args[1] === 'codex-session-images') {
      const imageOptions = readImageCliOptions(parsed.args);
      if ('error' in imageOptions) return { exitCode: 2, output: imageOptions.error };
      const flagError = unknownFlagError(
        parsed.args.slice(2),
        new Set(['--older-than-days', '--min-file-size-mb', '--json']),
        'reclaim scan codex-session-images'
      );
      if (flagError) return { exitCode: 2, output: flagError };
      const positionalError = exactPositionalsError(
        parsed.args,
        IMAGE_VALUE_FLAGS,
        ['scan', 'codex-session-images'],
        'reclaim scan codex-session-images'
      );
      if (positionalError) return { exitCode: 2, output: positionalError };

      const scan = await commands.scanCodexSessionImages({
        env,
        olderThanDays: imageOptions.olderThanDays,
        minFileSizeBytes: imageOptions.minFileSizeBytes
      });
      const output = publicCodexSessionImageScanResult(scan, imageOptions);
      return {
        exitCode: diagnosticExitCode(output.status),
        output: parsed.json ? jsonOutput(output) : renderSessionImageScan(output)
      };
    }

    if (parsed.args[0] === 'status' && parsed.args[1] === 'codex-native-compression') {
      const flagError = unknownFlagError(
        parsed.args.slice(2),
        new Set(['--json']),
        'reclaim status codex-native-compression'
      );
      if (flagError) return { exitCode: 2, output: flagError };
      const positionalError = exactPositionalsError(
        parsed.args,
        new Set(),
        ['status', 'codex-native-compression'],
        'reclaim status codex-native-compression'
      );
      if (positionalError) return { exitCode: 2, output: positionalError };

      const status = await commands.inspectCodexNativeCompression({ env });
      return {
        exitCode: diagnosticExitCode(status.status),
        output: parsed.json ? jsonOutput(status) : renderNativeCompressionStatus(status)
      };
    }

    return {
      exitCode: 2,
      output: `Unknown reclaim command: ${parsed.args.filter((arg) => !arg.startsWith('-')).join(' ') || '<missing>'}\n${usageText()}`
    };
  }

  if (parsed.command === 'monitor') {
    if (parsed.args[0] !== 'codex-sessions') {
      return {
        exitCode: 2,
        output: `Unknown monitor action: ${parsed.args[0] ?? '<missing>'}\n${usageText()}`
      };
    }
    const flagError = unknownFlagError(parsed.args.slice(1), new Set(['--json']), 'monitor codex-sessions');
    if (flagError) return { exitCode: 2, output: flagError };
    const positionalError = exactPositionalsError(
      parsed.args,
      new Set(),
      ['codex-sessions'],
      'monitor codex-sessions'
    );
    if (positionalError) return { exitCode: 2, output: positionalError };

    const result = await commands.measureCodexSessionState({
      env,
      persistState: false,
      notify: false
    });
    return {
      exitCode: diagnosticExitCode(result.status),
      output: parsed.json ? jsonOutput(result) : renderSessionMonitorResult(result)
    };
  }

  if (parsed.command === '__scheduled-monitor') {
    if (parsed.args[0] !== 'codex-sessions') {
      return { exitCode: 2, output: 'Unknown scheduled monitor action.\n' };
    }
    const thresholds = readScheduledMonitorCliOptions(parsed.args);
    if ('error' in thresholds) return { exitCode: 2, output: thresholds.error };
    const flagError = unknownFlagError(
      parsed.args.slice(1),
      SCHEDULED_MONITOR_VALUE_FLAGS,
      '__scheduled-monitor codex-sessions'
    );
    if (flagError) return { exitCode: 2, output: flagError };
    const positionalError = exactPositionalsError(
      parsed.args,
      SCHEDULED_MONITOR_VALUE_FLAGS,
      ['codex-sessions'],
      '__scheduled-monitor codex-sessions'
    );
    if (positionalError) return { exitCode: 2, output: positionalError };

    const result = await commands.measureCodexSessionState({
      env,
      thresholdBytes: thresholds.thresholdBytes,
      growthThresholdBytes: thresholds.growthThresholdBytes,
      persistState: true,
      notify: true,
      notificationSender: async (notification) => commands.sendCodexSessionMonitorNotification(
        notification,
        { env }
      )
    });
    return {
      exitCode: diagnosticExitCode(result.status),
      output: jsonOutput(result)
    };
  }

  if (parsed.command === 'plan') {
    const positionals = positionalArgsExcludingFlagValues(
      parsed.args,
      new Set([...IMAGE_VALUE_FLAGS, ...MONITOR_PLAN_VALUE_FLAGS])
    );
    const action = positionals[0];
    if (positionals.length !== 1 || !isPublicPlanAction(action)) {
      return {
        exitCode: 2,
        output: `Unknown plan action: ${positionals.join(' ') || '<missing>'}\n${usageText()}`
      };
    }

    let actionOptions: MaintenancePlanActionOptions | undefined;
    let allowedFlags = new Set(['--json']);
    if (action === 'codex-session-image-prune') {
      const imageOptions = readImageCliOptions(parsed.args);
      if ('error' in imageOptions) return { exitCode: 2, output: imageOptions.error };
      actionOptions = imageOptions;
      allowedFlags = new Set(['--older-than-days', '--min-file-size-mb', '--json']);
    } else if (action === 'codex-session-monitor-install') {
      const monitorOptions = readMonitorPlanCliOptions(parsed.args);
      if ('error' in monitorOptions) return { exitCode: 2, output: monitorOptions.error };
      actionOptions = monitorOptions;
      allowedFlags = new Set(['--threshold-gib', '--growth-gib', '--json']);
    }
    const flagError = unknownFlagError(parsed.args, allowedFlags, 'plan');
    if (flagError) return { exitCode: 2, output: flagError };

    const summary = await commands.createPlan(actionOptions
      ? { action, actionOptions, env }
      : { action, env });
    return {
      exitCode: summary.status === 'ready' ? 0 : 3,
      output: parsed.json ? jsonOutput(summary) : renderCliPlanSummary(summary)
    };
  }

  if (parsed.command === 'apply') {
    const flagError = unknownFlagError(
      parsed.args,
      new Set(['--plan', '--yes', '--accept-image-loss', '--json']),
      'apply'
    );
    if (flagError) return { exitCode: 2, output: flagError };
    if (!parsed.args.includes('--yes')) return { exitCode: 2, output: 'Missing required confirmation: --yes\n' };
    const planFlagCount = parsed.args.filter((arg) => arg === '--plan').length;
    if (planFlagCount > 1) return { exitCode: 2, output: `Duplicate --plan.\n${usageText()}` };
    const planIndex = parsed.args.indexOf('--plan');
    const plan = planIndex === -1 ? undefined : parsed.args[planIndex + 1];
    if (!plan || plan.startsWith('-')) return { exitCode: 2, output: `Missing --plan <planId>.\n${usageText()}` };
    const positionalError = exactPositionalsError(parsed.args, new Set(['--plan']), [], 'apply');
    if (positionalError) return { exitCode: 2, output: positionalError };
    const result = await commands.applyPlan({
      planId: plan,
      env,
      confirmations: { imageLoss: parsed.args.includes('--accept-image-loss') }
    });
    return {
      exitCode: result.status === 'ok' ? 0 : 3,
      output: parsed.json ? jsonOutput(result) : renderCliApplyResult(result)
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
    const flagError = unknownFlagError(parsed.args, new Set(['--latest', '--show-paths', '--json', '--html', '--unredacted']), 'report');
    if (flagError) return { exitCode: 2, output: flagError };
    if (parsed.args.includes('--unredacted')) {
      return { exitCode: 2, output: '--unredacted is not supported in v1.\n' };
    }
    const latest = await commands.latestReport();
    if (!latest) return { exitCode: 1, output: 'No report found.\n' };
    const includePath = parsed.args.includes('--show-paths');
    const payload = sanitizeReportForOutput(latest.report);
    if (parsed.html) {
      return await openVisualReportForCli(
        commands.openVisualReport,
        buildVisualReportModel(payload, { lastReclaim: await loadLastReclaim(commands, env) }),
        0
      );
    }
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

type HtmlCliFlags = {
  html: boolean;
  json: boolean;
  share: boolean;
  showPaths: boolean;
  plain: boolean;
  noBanner: boolean;
};

function htmlIncompatibilityError(flags: HtmlCliFlags): string | undefined {
  if (
    flags.html
    && (flags.json || flags.share || flags.showPaths || flags.plain || flags.noBanner)
  ) {
    return HTML_INCOMPATIBILITY;
  }
  return undefined;
}

// A missing record hides the section; an unreadable one is shown as unavailable rather than silently dropped.
async function loadLastReclaim(
  commands: CliCommands,
  env: NodeJS.ProcessEnv
): Promise<ReclaimRunRecord | 'unavailable' | null> {
  try {
    return await commands.latestReclaimRun(env);
  } catch {
    return 'unavailable';
  }
}

async function openVisualReportForCli(
  openReport: typeof defaultOpenVisualReport,
  model: Parameters<typeof defaultOpenVisualReport>[0],
  underlyingExitCode: number
): Promise<CliResult> {
  let reason: VisualReportCloseReason;
  try {
    reason = await openReport(model);
  } catch {
    return visualReportFailureResult();
  }

  if (GRACEFUL_VISUAL_CLOSE_REASONS.has(reason)) {
    return {
      exitCode: underlyingExitCode,
      output: 'Visual report closed. No HTML file was saved.\n'
    };
  }
  if (reason === 'signal') {
    return {
      exitCode: 130,
      output: 'Visual report interrupted. No HTML file was saved.\n'
    };
  }
  return visualReportFailureResult();
}

function visualReportFailureResult(): CliResult {
  return {
    exitCode: 3,
    output: 'Visual report could not be opened safely. No HTML file was saved.\n'
  };
}

type ImageCliOptions = {
  olderThanDays: number;
  minFileSizeBytes: number;
};

type MonitorPlanCliOptions = {
  thresholdBytes: number;
  growthThresholdBytes: number;
};

function readImageCliOptions(args: string[]): ImageCliOptions | { error: string } {
  const olderThanDays = readIntegerFlag(args, {
    flag: '--older-than-days',
    min: 1,
    max: MAX_IMAGE_OLDER_THAN_DAYS
  });
  if (olderThanDays.error) return { error: olderThanDays.error };
  const minFileSizeMib = readIntegerFlag(args, {
    flag: '--min-file-size-mb',
    min: 1,
    max: MAX_IMAGE_MIN_FILE_SIZE_MIB
  });
  if (minFileSizeMib.error) return { error: minFileSizeMib.error };
  return {
    olderThanDays: olderThanDays.value ?? DEFAULT_IMAGE_OLDER_THAN_DAYS,
    minFileSizeBytes: (minFileSizeMib.value ?? DEFAULT_IMAGE_MIN_FILE_SIZE_MIB) * MIB
  };
}

function readMonitorPlanCliOptions(
  args: string[]
): MonitorPlanCliOptions | { error: string } {
  const thresholdGib = readIntegerFlag(args, {
    flag: '--threshold-gib',
    min: 1,
    max: MAX_MONITOR_THRESHOLD_GIB
  });
  if (thresholdGib.error) return { error: thresholdGib.error };
  const growthGib = readIntegerFlag(args, {
    flag: '--growth-gib',
    min: 1,
    max: MAX_MONITOR_THRESHOLD_GIB
  });
  if (growthGib.error) return { error: growthGib.error };
  return {
    thresholdBytes: (thresholdGib.value ?? DEFAULT_MONITOR_THRESHOLD_GIB) * GIB,
    growthThresholdBytes: (growthGib.value ?? DEFAULT_MONITOR_GROWTH_GIB) * GIB
  };
}

function readScheduledMonitorCliOptions(
  args: string[]
): MonitorPlanCliOptions | { error: string } {
  const thresholdBytes = readIntegerFlag(args, {
    flag: '--threshold-bytes',
    min: 1,
    max: MAX_MONITOR_THRESHOLD_BYTES,
    required: true
  });
  if (thresholdBytes.error) return { error: thresholdBytes.error };
  const growthThresholdBytes = readIntegerFlag(args, {
    flag: '--growth-threshold-bytes',
    min: 1,
    max: MAX_MONITOR_THRESHOLD_BYTES,
    required: true
  });
  if (growthThresholdBytes.error) return { error: growthThresholdBytes.error };
  return {
    thresholdBytes: thresholdBytes.value as number,
    growthThresholdBytes: growthThresholdBytes.value as number
  };
}

function exactPositionalsError(
  args: string[],
  valueFlags: ReadonlySet<string>,
  expected: string[],
  command: string
): string | undefined {
  const actual = positionalArgsExcludingFlagValues(args, valueFlags);
  if (
    actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
  ) {
    return undefined;
  }
  return `Unexpected ${command} positional argument.\n${usageText()}`;
}

function isPublicPlanAction(value: string | undefined): value is MaintenancePlanAction {
  return value !== undefined && PUBLIC_PLAN_ACTIONS.has(value as MaintenancePlanAction);
}

function diagnosticExitCode(status: string): number {
  return status === 'ok' ? 0 : 3;
}

function renderSessionImageScan(result: PublicCodexSessionImageScanResult): string {
  const lines = [
    row(
      'Content access',
      'Reads candidate Codex session JSONL contents locally; no session content is printed or uploaded.'
    ),
    row('Image scan', result.status),
    row('Content read', 'yes'),
    row('Candidate files', String(result.totals.candidateFiles)),
    row('Files opened', String(result.totals.filesOpened)),
    row('Files blocked', String(result.totals.filesBlocked)),
    row('Images', String(result.totals.imagesPrunable)),
    row('Source size', formatBytes(result.totals.sourceBytes)),
    row('Projected size', formatBytes(result.totals.projectedBytes)),
    row('Reclaimable', formatBytes(result.totals.reclaimableBytes)),
    row('Changed', 'nothing; estimate only')
  ];
  for (const reason of result.blockedReasons) lines.push(row('Reason', reason));
  for (const warning of result.warnings) lines.push(row('Warning', warning));
  return `${lines.join('\n')}\n`;
}

function renderNativeCompressionStatus(result: CodexNativeCompressionStatus): string {
  const lines = [
    row('Native status', result.status),
    row('Supported', result.supported ? 'yes' : 'no'),
    row('Configured', result.configuredState),
    row('Plain JSONL', String(result.plainJsonlFiles)),
    row('Compressed JSONL', String(result.compressedJsonlFiles)),
    row('Changed', 'nothing; advisory only')
  ];
  if (result.featureStage !== undefined) lines.push(row('Feature stage', result.featureStage));
  if (result.defaultEnabled !== undefined) {
    lines.push(row('Default enabled', result.defaultEnabled ? 'yes' : 'no'));
  }
  for (const warning of result.warnings) lines.push(row('Warning', redactPath(warning)));
  for (const next of result.nextActions) lines.push(row('Next', redactPath(next)));
  return `${lines.join('\n')}\n`;
}

function renderSessionMonitorResult(result: CodexSessionMonitorResult): string {
  const lines = [
    row('Session monitor', result.status),
    row('Current', formatBytes(result.currentBytes)),
    row('Threshold', formatBytes(result.thresholdBytes)),
    row('Growth threshold', formatBytes(result.growthThresholdBytes)),
    row('Alert', result.alert ? 'yes' : 'no'),
    row('State persisted', result.statePersisted ? 'yes' : 'no; manual mode does not persist'),
    row('Notification', result.notificationAttempted ? (result.notificationDelivered ? 'delivered' : 'not delivered') : 'not attempted'),
    row('Changed', 'no session content; metadata measurement only')
  ];
  if (result.previousBytes !== undefined) lines.push(row('Previous', formatBytes(result.previousBytes)));
  if (result.deltaBytes !== undefined) lines.push(row('Growth', formatSignedBytes(result.deltaBytes)));
  for (const warning of result.warnings) lines.push(row('Warning', redactPath(warning)));
  return `${lines.join('\n')}\n`;
}

function renderCliPlanSummary(summary: MaintenancePlanSummary): string {
  if (summary.action !== 'codex-session-image-prune') return renderPlanSummary(summary);
  const lines = renderPlanSummary(summary).trimEnd().split('\n');
  const nextIndex = lines.findIndex((line) => line.startsWith('Next'));
  const consent = row(
    'Consent',
    'Irreversible image loss; apply requires both --yes and --accept-image-loss.'
  );
  lines.splice(nextIndex === -1 ? lines.length : nextIndex, 0, consent);
  return `${lines.join('\n')}\n`;
}

function renderCliApplyResult(result: ApplyPlanResult): string {
  if (
    result.action !== 'codex-session-image-prune'
    && result.action !== 'codex-sparkle-clean'
  ) {
    return renderApplyResult(result);
  }
  const lines = renderApplyResult(result).trimEnd().split('\n');
  const details = isPlainObject(result.result) ? result.result : undefined;
  if (!details) return `${lines.join('\n')}\n`;

  const reclaimed = result.action === 'codex-session-image-prune'
    ? safeIntegerField(details, 'reclaimedBytes')
    : safeIntegerField(details, 'deletedBytes');
  if (reclaimed !== undefined && reclaimed >= 0) {
    lines.push(row('Reclaimed', formatBytes(reclaimed)));
  }
  const freeDelta = safeIntegerField(details, 'volumeFreeDeltaBytes');
  if (freeDelta !== undefined) {
    lines.push(row('Free-space delta', formatSignedBytes(freeDelta)));
  }
  const changedCount = result.action === 'codex-session-image-prune'
    ? safeIntegerField(details, 'imagesStripped')
    : safeIntegerField(details, 'deletedEntries');
  if (changedCount !== undefined && changedCount >= 0) {
    lines.push(row(
      result.action === 'codex-session-image-prune' ? 'Images removed' : 'Entries removed',
      String(changedCount)
    ));
  }
  return `${lines.join('\n')}\n`;
}

function safeIntegerField(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return Number.isSafeInteger(candidate) ? candidate as number : undefined;
}

function formatSignedBytes(bytes: number): string {
  return bytes < 0 ? `-${formatBytes(Math.abs(bytes))}` : formatBytes(bytes);
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
    row('Changed', cursorChangedText(result))
  ];
  for (const reason of result.blockedReasons) lines.push(row('Reason', reason));
  for (const warning of result.warnings) lines.push(row('Warning', warning));
  if (result.mode === 'dry-run' && result.status === 'ready' && result.reclaimableBytes > 0) {
    lines.push(row('Next', 'ai-dev-maintenance cursor clean --safe --yes'));
  }
  return `${lines.join('\n')}\n`;
}

function cursorChangedText(result: Awaited<ReturnType<typeof defaultRunCursorSafeCleanup>>): string {
  if (result.mode !== 'cleanup') return 'nothing; dry run only';
  if (result.status === 'partial') {
    return result.deletedEntries > 0
      ? 'some Cursor cache/log contents removed; some entries remain'
      : 'nothing; every removal failed';
  }
  return 'Cursor cache/log contents removed';
}

function renderPruneResult(
  kind: 'reports' | 'backups',
  result: { deleted: number; incompleteDeleted?: number; warnings: string[] }
): string {
  const label = kind === 'reports' ? 'Deleted reports' : 'Deleted backups';
  const lines = [`${label.padEnd(17, ' ')}${result.deleted}`];
  if (result.incompleteDeleted) lines.push(`Abandoned temps  ${result.incompleteDeleted} (interrupted, never-validated backups)`);
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
