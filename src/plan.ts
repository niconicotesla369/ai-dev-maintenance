import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCursorSafeCleanup, planCursorSafeCleanup } from './cursor-clean.js';
import { runFixSafe } from './fix.js';
import {
  assertExistingPrivateDirSafe,
  assertPrivateAppDirSafe,
  assertSafeReadablePrivateFile,
  collectFileIdentity,
  detectTargetState
} from './fs-safety.js';
import {
  installCodexMonitor,
  removeCodexMonitor,
  type CodexMonitorInstallSpec
} from './monitor/launchd.js';
import {
  appDataHome,
  codexSessionMonitorLaunchAgentPath,
  defaultCodexHome,
  redactPath
} from './paths.js';
import {
  pruneCodexSessionImages
} from './reclaim/codex-session-image-prune.js';
import {
  scanCodexSessionImages,
  type CodexSessionImageCandidate,
  type CodexSessionImagePrivateOutcome
} from './reclaim/codex-session-images.js';
import {
  planCodexSparkleCleanup,
  runCodexSparkleCleanup,
  type CodexSparkleTarget
} from './reclaim/codex-sparkle.js';
import type { FileIdentity } from './types.js';
import { TOOL_VERSION } from './version.js';

const MAINTENANCE_PLAN_ACTIONS = [
  'codex-fix',
  'cursor-clean',
  'codex-sparkle-clean',
  'codex-session-image-prune',
  'codex-session-monitor-install',
  'codex-session-monitor-remove'
] as const;

export type MaintenancePlanAction = typeof MAINTENANCE_PLAN_ACTIONS[number];
export type MaintenancePlanActionOptions = {
  olderThanDays?: number;
  minFileSizeBytes?: number;
  thresholdBytes?: number;
  growthThresholdBytes?: number;
};

export type ApplyConfirmations = {
  imageLoss: boolean;
};

export type MaintenancePlanStatus = 'ready' | 'blocked';

type MaintenancePlanPreview = {
  targetCount?: number;
  reclaimableBytes?: number;
  walBytes?: number;
  imagesPrunable?: number;
  filesBlocked?: number;
  sourceBytes?: number;
  projectedBytes?: number;
  contentRead?: boolean;
  irreversible?: boolean;
  thresholdBytes?: number;
  growthThresholdBytes?: number;
};

export type MaintenancePlanSummary = {
  schemaVersion: 1;
  toolVersion: string;
  planId: string;
  action: MaintenancePlanAction;
  status: MaintenancePlanStatus;
  createdAt: string;
  expiresAt: string;
  identityHash: string;
  preview: MaintenancePlanPreview;
  blockedReasons: string[];
  warnings: string[];
};

export type ApplyPlanResult = {
  status: 'ok' | 'partial' | 'blocked';
  planId: string;
  action?: MaintenancePlanAction;
  applied: boolean;
  blockedReasons: string[];
  warnings: string[];
  result?: unknown;
};

type ActionTargetMap = {
  'codex-fix': { kind: 'default-codex-log-db'; pathCategory: string };
  'cursor-clean': { kind: 'cursor-safe-cleanup'; pathCategory: string };
  'codex-sparkle-clean': { kind: 'codex-sparkle-installation'; pathCategory: string };
  'codex-session-image-prune': { kind: 'codex-session-images'; pathCategory: string };
  'codex-session-monitor-install': { kind: 'codex-session-monitor-install'; pathCategory: string };
  'codex-session-monitor-remove': { kind: 'codex-session-monitor-remove'; pathCategory: string };
};

type CursorTargetIdentity = {
  targets: Array<{
    path: string;
    pathCategory: string;
    bytes: number;
    identity: FileIdentity;
  }>;
};

type ImageTargetIdentity = {
  filters: {
    olderThanDays: number;
    minFileSizeBytes: number;
  };
  candidates: CodexSessionImageCandidate[];
  excludedOutcomes: CodexSessionImagePrivateOutcome[];
};

type MonitorInstallTargetIdentity = {
  spec: CodexMonitorInstallSpec;
  nodeIdentity: FileIdentity;
  cliIdentity: FileIdentity;
  plistIdentity: FileIdentity;
};

type ActionIdentityMap = {
  'codex-fix': { targetState: Awaited<ReturnType<typeof detectTargetState>> };
  'cursor-clean': CursorTargetIdentity;
  'codex-sparkle-clean': { targets: CodexSparkleTarget[] };
  'codex-session-image-prune': ImageTargetIdentity;
  'codex-session-monitor-install': MonitorInstallTargetIdentity;
  'codex-session-monitor-remove': { plistIdentity: FileIdentity };
};

type PrivateMaintenancePlan<A extends MaintenancePlanAction = MaintenancePlanAction> =
  Omit<MaintenancePlanSummary, 'action'> & {
    action: A;
    target: ActionTargetMap[A];
    targetIdentity: ActionIdentityMap[A];
  };

export type MaintenancePlanDependencies = {
  detectTargetState: typeof detectTargetState;
  planCursorSafeCleanup: typeof planCursorSafeCleanup;
  runCursorSafeCleanup: typeof runCursorSafeCleanup;
  runFixSafe: typeof runFixSafe;
  collectFileIdentity: typeof collectFileIdentity;
  planCodexSparkleCleanup: typeof planCodexSparkleCleanup;
  runCodexSparkleCleanup: typeof runCodexSparkleCleanup;
  scanCodexSessionImages: typeof scanCodexSessionImages;
  pruneCodexSessionImages: typeof pruneCodexSessionImages;
  installCodexMonitor: typeof installCodexMonitor;
  removeCodexMonitor: typeof removeCodexMonitor;
};

export type CreateMaintenancePlanOptions = {
  action: MaintenancePlanAction;
  actionOptions?: MaintenancePlanActionOptions;
  monitorInstallSpec?: CodexMonitorInstallSpec;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  randomSuffix?: () => string;
  dependencies?: Partial<MaintenancePlanDependencies>;
};

export type ApplyMaintenancePlanOptions = {
  planId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  confirmations?: ApplyConfirmations;
  dependencies?: Partial<MaintenancePlanDependencies>;
  runFixSafe?: typeof runFixSafe;
  runCursorSafeCleanup?: typeof runCursorSafeCleanup;
};

const PLAN_TTL_MS = 15 * 60 * 1000;
const IMAGE_PLAN_TTL_MS = 60 * 60 * 1000;
const PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLAN_RETENTION_MAX = 10;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DEFAULT_IMAGE_OLDER_THAN_DAYS = 30;
const DEFAULT_IMAGE_MIN_FILE_SIZE_BYTES = 50 * MIB;
const DEFAULT_MONITOR_THRESHOLD_BYTES = 8 * GIB;
const DEFAULT_MONITOR_GROWTH_THRESHOLD_BYTES = 5 * GIB;
const MAX_IMAGE_OLDER_THAN_DAYS = 3650;
const MAX_IMAGE_MIN_FILE_SIZE_BYTES = 1_048_576 * MIB;
const MAX_MONITOR_THRESHOLD_BYTES = 1024 * GIB;
const DEFAULT_CLI_SCRIPT_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

const DEFAULT_DEPENDENCIES: MaintenancePlanDependencies = {
  detectTargetState,
  planCursorSafeCleanup,
  runCursorSafeCleanup,
  runFixSafe,
  collectFileIdentity,
  planCodexSparkleCleanup,
  runCodexSparkleCleanup,
  scanCodexSessionImages,
  pruneCodexSessionImages,
  installCodexMonitor,
  removeCodexMonitor
};

type CollectContext = {
  env: NodeJS.ProcessEnv;
  now: Date;
  actionOptions?: MaintenancePlanActionOptions;
  monitorInstallSpec?: CodexMonitorInstallSpec;
  dependencies: MaintenancePlanDependencies;
};

type RunContext = {
  env: NodeJS.ProcessEnv;
  planId: string;
  dependencies: MaintenancePlanDependencies;
};

type CollectedAction<A extends MaintenancePlanAction> = {
  target: ActionTargetMap[A];
  targetIdentity: ActionIdentityMap[A];
  preview: MaintenancePlanPreview;
  blockedReasons: string[];
  warnings: string[];
};

type ActionDefinition<A extends MaintenancePlanAction> = {
  ttlMs: number;
  collect: (
    context: CollectContext,
    previousIdentity?: ActionIdentityMap[A]
  ) => Promise<CollectedAction<A>>;
  run: (
    identity: ActionIdentityMap[A],
    context: RunContext
  ) => Promise<unknown>;
};

type ActionRegistry = {
  [A in MaintenancePlanAction]: ActionDefinition<A>;
};

const ACTION_REGISTRY = {
  'codex-fix': {
    ttlMs: PLAN_TTL_MS,
    collect: collectCodexFix,
    run: async (_identity, context) => context.dependencies.runFixSafe({ env: context.env })
  },
  'cursor-clean': {
    ttlMs: PLAN_TTL_MS,
    collect: collectCursorCleanup,
    run: async (_identity, context) => context.dependencies.runCursorSafeCleanup({
      env: context.env,
      yes: true
    })
  },
  'codex-sparkle-clean': {
    ttlMs: PLAN_TTL_MS,
    collect: collectSparkleCleanup,
    run: async (identity, context) => context.dependencies.runCodexSparkleCleanup({
      env: context.env,
      expectedTargets: identity.targets
    })
  },
  'codex-session-image-prune': {
    ttlMs: IMAGE_PLAN_TTL_MS,
    collect: collectSessionImagePrune,
    run: async (identity, context) => context.dependencies.pruneCodexSessionImages({
      env: context.env,
      planId: context.planId,
      candidates: identity.candidates,
      excludedOutcomes: identity.excludedOutcomes
    })
  },
  'codex-session-monitor-install': {
    ttlMs: PLAN_TTL_MS,
    collect: collectMonitorInstall,
    run: async (identity, context) => context.dependencies.installCodexMonitor(
      identity.spec,
      { env: context.env }
    )
  },
  'codex-session-monitor-remove': {
    ttlMs: PLAN_TTL_MS,
    collect: collectMonitorRemove,
    run: async (_identity, context) => context.dependencies.removeCodexMonitor({
      env: context.env
    })
  }
} satisfies ActionRegistry;

export async function createMaintenancePlan(options: CreateMaintenancePlanOptions): Promise<MaintenancePlanSummary> {
  const now = options.now ?? new Date();
  const definition = actionDefinition(options.action);
  const expiresAt = new Date(now.getTime() + definition.ttlMs);
  const dependencies = resolveDependencies(options.dependencies);
  const collected = await definition.collect({
    env: options.env ?? process.env,
    now,
    actionOptions: options.actionOptions,
    monitorInstallSpec: options.monitorInstallSpec,
    dependencies
  });
  const identityHash = hashIdentity(collected.targetIdentity);
  const plan: PrivateMaintenancePlan<typeof options.action> = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    planId: planId(now, options.randomSuffix),
    action: options.action,
    status: collected.blockedReasons.length > 0 ? 'blocked' : 'ready',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    identityHash,
    preview: collected.preview,
    blockedReasons: collected.blockedReasons,
    warnings: collected.warnings,
    target: collected.target,
    targetIdentity: collected.targetIdentity
  };

  await writePrivatePlan(plan, options.env);
  await prunePrivatePlans(options.env, now, plan.planId);
  return publicPlanSummary(plan);
}

export async function applyMaintenancePlan(options: ApplyMaintenancePlanOptions): Promise<ApplyPlanResult> {
  const loaded = await readPrivatePlan(options.planId, options.env);
  if ('blockedReason' in loaded) {
    return {
      status: 'blocked',
      planId: options.planId,
      applied: false,
      blockedReasons: publicStrings([loaded.blockedReason]),
      warnings: []
    };
  }

  const plan = loaded.plan;
  if (!isPlanAction(plan.action)) {
    return blockedApply(plan, ['unknown plan action']);
  }
  if (!targetMatchesAction(plan.action, plan.target)) {
    return blockedApply(plan, ['plan target does not match action']);
  }
  if (hashIdentity(plan.targetIdentity) !== plan.identityHash) {
    return blockedApply(plan, ['plan identity is invalid']);
  }
  const expiresAtMs = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return blockedApply(plan, ['invalid plan expiry']);
  }
  if (expiresAtMs <= (options.now ?? new Date()).getTime()) {
    return blockedApply(plan, ['plan expired']);
  }
  if (plan.status !== 'ready') {
    return blockedApply(plan, plan.blockedReasons.length > 0 ? plan.blockedReasons : ['plan is not ready']);
  }

  const confirmationBlocker = confirmationMismatch(plan.action, options.confirmations);
  if (confirmationBlocker) return blockedApply(plan, [confirmationBlocker]);

  const claimed = await claimPlan(plan.planId, options.env);
  if (!claimed) return blockedApply(plan, ['plan apply is already in progress']);

  const dependencies = resolveDependencies(options.dependencies, {
    runFixSafe: options.runFixSafe,
    runCursorSafeCleanup: options.runCursorSafeCleanup
  });
  const definition = actionDefinition(plan.action);
  let recollected: CollectedAction<typeof plan.action>;
  try {
    recollected = await definition.collect(
      {
        env: options.env ?? process.env,
        now: options.now ?? new Date(),
        dependencies
      },
      plan.targetIdentity
    );
  } catch {
    return await blockedAfterClaim(plan, ['plan target is invalid'], options.env);
  }
  if (hashIdentity(recollected.targetIdentity) !== plan.identityHash) {
    return await blockedAfterClaim(plan, ['plan identity drifted'], options.env);
  }
  if (recollected.blockedReasons.length > 0) {
    return await blockedAfterClaim(plan, recollected.blockedReasons, options.env);
  }

  let result: unknown;
  try {
    result = await definition.run(plan.targetIdentity, {
      env: options.env ?? process.env,
      planId: plan.planId,
      dependencies
    });
  } catch {
    const consumed = await consumePlanClaim(plan.planId, options.env);
    return {
      status: 'partial',
      planId: plan.planId,
      action: plan.action,
      applied: true,
      blockedReasons: uniqueStrings([
        'plan runner outcome is unknown',
        ...(consumed ? [] : ['plan consumption could not be finalized'])
      ]),
      warnings: []
    };
  }
  const status = resultStatus(result);
  const changed = resultChanged(result);
  if (status !== 'ok' && !changed) {
    const restored = await restorePlanClaim(plan.planId, options.env);
    return {
      status: 'blocked',
      planId: plan.planId,
      action: plan.action,
      applied: false,
      blockedReasons: uniqueStrings([
        ...resultBlockedReasons(result),
        ...(restored ? [] : ['plan claim could not be restored'])
      ]),
      warnings: resultWarnings(result),
      result: publicApplyResult(result)
    };
  }

  const consumed = await consumePlanClaim(plan.planId, options.env);
  if (!consumed) {
    return {
      status: 'partial',
      planId: plan.planId,
      action: plan.action,
      applied: true,
      blockedReasons: uniqueStrings([
        ...(status === 'ok' ? [] : resultBlockedReasons(result)),
        'plan consumption could not be finalized'
      ]),
      warnings: resultWarnings(result),
      result: publicApplyResult(result)
    };
  }
  return {
    status: status === 'ok' ? 'ok' : 'partial',
    planId: plan.planId,
    action: plan.action,
    applied: true,
    blockedReasons: status === 'ok' ? [] : resultBlockedReasons(result),
    warnings: resultWarnings(result),
    result: publicApplyResult(result)
  };
}

export function renderPlanSummary(summary: MaintenancePlanSummary): string {
  const lines = [
    `Plan             ${summary.planId}`,
    `Action           ${summary.action}`,
    `Status           ${summary.status}`,
    `Expires          ${summary.expiresAt}`,
    `Identity hash    ${summary.identityHash}`
  ];
  if (summary.preview.reclaimableBytes !== undefined) lines.push(`Reclaimable      ${summary.preview.reclaimableBytes}`);
  if (summary.preview.walBytes !== undefined) lines.push(`WAL bytes        ${summary.preview.walBytes}`);
  if (summary.preview.targetCount !== undefined) lines.push(`Targets          ${summary.preview.targetCount}`);
  if (summary.preview.imagesPrunable !== undefined) lines.push(`Images           ${summary.preview.imagesPrunable}`);
  if (summary.preview.filesBlocked !== undefined) lines.push(`Files blocked    ${summary.preview.filesBlocked}`);
  if (summary.preview.sourceBytes !== undefined) lines.push(`Source bytes     ${summary.preview.sourceBytes}`);
  if (summary.preview.projectedBytes !== undefined) lines.push(`Projected bytes  ${summary.preview.projectedBytes}`);
  if (summary.preview.contentRead !== undefined) lines.push(`Content read     ${summary.preview.contentRead}`);
  if (summary.preview.irreversible !== undefined) lines.push(`Irreversible     ${summary.preview.irreversible}`);
  if (summary.preview.thresholdBytes !== undefined) lines.push(`Threshold bytes  ${summary.preview.thresholdBytes}`);
  if (summary.preview.growthThresholdBytes !== undefined) lines.push(`Growth threshold ${summary.preview.growthThresholdBytes}`);
  for (const reason of summary.blockedReasons) lines.push(`Reason           ${reason}`);
  for (const warning of summary.warnings) lines.push(`Warning          ${warning}`);
  if (summary.status === 'ready') {
    const imageConsent = summary.action === 'codex-session-image-prune' ? ' --accept-image-loss' : '';
    lines.push(`Next             ai-dev-maintenance apply --plan ${summary.planId} --yes${imageConsent}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderApplyResult(result: ApplyPlanResult): string {
  const lines = [
    `Apply            ${result.status}`,
    `Plan             ${result.planId}`,
    `Changed          ${result.applied ? 'existing safe engine executed' : 'nothing'}`
  ];
  if (result.action) lines.push(`Action           ${result.action}`);
  for (const reason of result.blockedReasons) lines.push(`Reason           ${reason}`);
  for (const warning of result.warnings) lines.push(`Warning          ${warning}`);
  return `${lines.join('\n')}\n`;
}

async function collectCodexFix(context: CollectContext): Promise<CollectedAction<'codex-fix'>> {
  const { codexHome, custom } = defaultCodexHome(context.env);
  const mainPath = path.join(codexHome, 'logs_2.sqlite');
  const targetState = await context.dependencies.detectTargetState(mainPath);
  return {
    target: {
      kind: 'default-codex-log-db',
      pathCategory: custom ? 'custom-codex-home' : '<home>/.codex/logs_2.sqlite'
    },
    targetIdentity: { targetState },
    preview: { walBytes: targetState.wal?.size ?? 0 },
    blockedReasons: custom ? ['custom CODEX_HOME is rejected by fix'] : targetState.blockers,
    warnings: []
  };
}

async function collectCursorCleanup(
  context: CollectContext
): Promise<CollectedAction<'cursor-clean'>> {
  const cleanupPlan = await context.dependencies.planCursorSafeCleanup({ env: context.env });
  const targetIdentities = await Promise.all(
    cleanupPlan.targets.map(async (target) => ({
      path: target.path,
      pathCategory: target.pathCategory,
      bytes: target.bytes,
      identity: await context.dependencies.collectFileIdentity(target.path, target.pathCategory)
    }))
  );
  return {
    target: {
      kind: 'cursor-safe-cleanup',
      pathCategory: '<home>/Library/Application Support/Cursor'
    },
    targetIdentity: { targets: targetIdentities },
    preview: {
      targetCount: cleanupPlan.targets.length,
      reclaimableBytes: cleanupPlan.reclaimableBytes
    },
    blockedReasons: cleanupPlan.blockedReasons,
    warnings: cleanupPlan.warnings
  };
}

async function collectSparkleCleanup(
  context: CollectContext
): Promise<CollectedAction<'codex-sparkle-clean'>> {
  const cleanupPlan = await context.dependencies.planCodexSparkleCleanup({ env: context.env });
  const blockedReasons = cleanupPlan.status === 'blocked' && cleanupPlan.blockedReasons.length === 0
    ? ['sparkle-plan-blocked']
    : cleanupPlan.blockedReasons;
  return {
    target: {
      kind: 'codex-sparkle-installation',
      pathCategory: '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation'
    },
    targetIdentity: { targets: cleanupPlan.targets },
    preview: {
      targetCount: cleanupPlan.targets.length,
      reclaimableBytes: cleanupPlan.reclaimableBytes
    },
    blockedReasons,
    warnings: cleanupPlan.warnings
  };
}

async function collectSessionImagePrune(
  context: CollectContext,
  previousIdentity?: ImageTargetIdentity
): Promise<CollectedAction<'codex-session-image-prune'>> {
  const filters = previousIdentity
    ? checkedImageFilters(previousIdentity)
    : imageFilters(context.actionOptions);
  const scan = await context.dependencies.scanCodexSessionImages({
    env: context.env,
    now: context.now,
    olderThanDays: filters.olderThanDays,
    minFileSizeBytes: filters.minFileSizeBytes
  });
  const hasSafeCandidates = scan.candidates.length > 0;
  const globallyBlocked = scan.status === 'blocked';
  const blockedReasons = globallyBlocked || !hasSafeCandidates
    ? uniqueStrings([
        ...scan.blockedReasons,
        globallyBlocked ? 'image-scan-blocked' : 'no-safe-image-candidates'
      ])
    : [];
  const warnings = scan.status === 'partial' && hasSafeCandidates
    ? uniqueStrings([...scan.warnings, 'image-scan-partial-safe-subset'])
    : scan.warnings;
  return {
    target: {
      kind: 'codex-session-images',
      pathCategory: '<home>/.codex/sessions'
    },
    targetIdentity: {
      filters,
      candidates: scan.candidates,
      excludedOutcomes: scan.privateOutcomes
    },
    preview: {
      targetCount: scan.candidates.length,
      reclaimableBytes: scan.totals.reclaimableBytes,
      imagesPrunable: scan.totals.imagesPrunable,
      filesBlocked: scan.totals.filesBlocked,
      sourceBytes: scan.totals.sourceBytes,
      projectedBytes: scan.totals.projectedBytes,
      contentRead: true,
      irreversible: true
    },
    blockedReasons,
    warnings
  };
}

async function collectMonitorInstall(
  context: CollectContext,
  previousIdentity?: MonitorInstallTargetIdentity
): Promise<CollectedAction<'codex-session-monitor-install'>> {
  const spec = previousIdentity
    ? checkedMonitorInstallIdentity(previousIdentity).spec
    : monitorInstallSpec(context.actionOptions, context.monitorInstallSpec);
  const plistPath = codexSessionMonitorLaunchAgentPath(context.env);
  const [nodeIdentity, cliIdentity, plistIdentity] = await Promise.all([
    context.dependencies.collectFileIdentity(spec.nodePath, '<runtime>/node'),
    context.dependencies.collectFileIdentity(spec.cliScriptPath, '<package>/dist/cli.js'),
    context.dependencies.collectFileIdentity(
      plistPath,
      '<home>/Library/LaunchAgents/<aidm-codex-monitor-plist>'
    )
  ]);
  const blockedReasons: string[] = [];
  if (!safeMonitorProgram(nodeIdentity, spec.nodePath, true)) {
    blockedReasons.push('node-executable-untrusted');
  }
  if (!safeMonitorProgram(cliIdentity, spec.cliScriptPath, false)) {
    blockedReasons.push('cli-script-untrusted');
  }
  if (!safeMonitorPlist(plistIdentity, plistPath)) {
    blockedReasons.push('monitor-plist-untrusted');
  }
  return {
    target: {
      kind: 'codex-session-monitor-install',
      pathCategory: '<home>/Library/LaunchAgents/<aidm-codex-monitor-plist>'
    },
    targetIdentity: { spec, nodeIdentity, cliIdentity, plistIdentity },
    preview: {
      targetCount: 1,
      thresholdBytes: spec.thresholdBytes,
      growthThresholdBytes: spec.growthThresholdBytes
    },
    blockedReasons,
    warnings: []
  };
}

async function collectMonitorRemove(
  context: CollectContext
): Promise<CollectedAction<'codex-session-monitor-remove'>> {
  const plistPath = codexSessionMonitorLaunchAgentPath(context.env);
  const plistIdentity = await context.dependencies.collectFileIdentity(
    plistPath,
    '<home>/Library/LaunchAgents/<aidm-codex-monitor-plist>'
  );
  return {
    target: {
      kind: 'codex-session-monitor-remove',
      pathCategory: '<home>/Library/LaunchAgents/<aidm-codex-monitor-plist>'
    },
    targetIdentity: { plistIdentity },
    preview: { targetCount: plistIdentity.exists ? 1 : 0 },
    blockedReasons: safeMonitorPlist(plistIdentity, plistPath)
      ? []
      : ['monitor-plist-untrusted'],
    warnings: []
  };
}

function actionDefinition<A extends MaintenancePlanAction>(action: A): ActionDefinition<A> {
  return ACTION_REGISTRY[action] as unknown as ActionDefinition<A>;
}

function resolveDependencies(
  overrides: Partial<MaintenancePlanDependencies> = {},
  legacy: {
    runFixSafe?: typeof runFixSafe;
    runCursorSafeCleanup?: typeof runCursorSafeCleanup;
  } = {}
): MaintenancePlanDependencies {
  return {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
    ...(legacy.runFixSafe ? { runFixSafe: legacy.runFixSafe } : {}),
    ...(legacy.runCursorSafeCleanup
      ? { runCursorSafeCleanup: legacy.runCursorSafeCleanup }
      : {})
  };
}

function targetMatchesAction(action: MaintenancePlanAction, target: unknown): boolean {
  if (!isObject(target) || typeof target.kind !== 'string') return false;
  const kinds: { [A in MaintenancePlanAction]: ActionTargetMap[A]['kind'] } = {
    'codex-fix': 'default-codex-log-db',
    'cursor-clean': 'cursor-safe-cleanup',
    'codex-sparkle-clean': 'codex-sparkle-installation',
    'codex-session-image-prune': 'codex-session-images',
    'codex-session-monitor-install': 'codex-session-monitor-install',
    'codex-session-monitor-remove': 'codex-session-monitor-remove'
  };
  return target.kind === kinds[action];
}

function confirmationMismatch(
  action: MaintenancePlanAction,
  confirmations: ApplyConfirmations | undefined
): string | undefined {
  const imageLossAccepted = confirmations?.imageLoss === true;
  if (action === 'codex-session-image-prune') {
    return imageLossAccepted ? undefined : 'image loss confirmation required';
  }
  return imageLossAccepted
    ? 'image loss confirmation does not match plan action'
    : undefined;
}

function imageFilters(
  options: MaintenancePlanActionOptions | undefined
): ImageTargetIdentity['filters'] {
  return {
    olderThanDays: boundedPositiveInteger(
      options?.olderThanDays ?? DEFAULT_IMAGE_OLDER_THAN_DAYS,
      MAX_IMAGE_OLDER_THAN_DAYS,
      'olderThanDays'
    ),
    minFileSizeBytes: boundedPositiveInteger(
      options?.minFileSizeBytes ?? DEFAULT_IMAGE_MIN_FILE_SIZE_BYTES,
      MAX_IMAGE_MIN_FILE_SIZE_BYTES,
      'minFileSizeBytes'
    )
  };
}

function checkedImageFilters(identity: unknown): ImageTargetIdentity['filters'] {
  if (
    !isObject(identity)
    || !isObject(identity.filters)
    || !Array.isArray(identity.candidates)
    || !Array.isArray(identity.excludedOutcomes)
  ) {
    throw new Error('invalid image plan identity');
  }
  return imageFilters({
    olderThanDays: identity.filters.olderThanDays as number,
    minFileSizeBytes: identity.filters.minFileSizeBytes as number
  });
}

function monitorInstallSpec(
  options: MaintenancePlanActionOptions | undefined,
  supplied: CodexMonitorInstallSpec | undefined
): CodexMonitorInstallSpec {
  const spec: CodexMonitorInstallSpec = {
    nodePath: supplied?.nodePath ?? process.execPath,
    cliScriptPath: supplied?.cliScriptPath ?? DEFAULT_CLI_SCRIPT_PATH,
    thresholdBytes: boundedPositiveInteger(
      options?.thresholdBytes ?? supplied?.thresholdBytes ?? DEFAULT_MONITOR_THRESHOLD_BYTES,
      MAX_MONITOR_THRESHOLD_BYTES,
      'thresholdBytes'
    ),
    growthThresholdBytes: boundedPositiveInteger(
      options?.growthThresholdBytes
        ?? supplied?.growthThresholdBytes
        ?? DEFAULT_MONITOR_GROWTH_THRESHOLD_BYTES,
      MAX_MONITOR_THRESHOLD_BYTES,
      'growthThresholdBytes'
    ),
    day: supplied?.day ?? 1,
    hour: supplied?.hour ?? 4,
    minute: supplied?.minute ?? 30
  };
  if (!validMonitorInstallSpec(spec)) throw new Error('invalid monitor install spec');
  return spec;
}

function checkedMonitorInstallIdentity(identity: unknown): MonitorInstallTargetIdentity {
  if (
    !isObject(identity)
    || !validMonitorInstallSpec(identity.spec)
    || !isFileIdentity(identity.nodeIdentity)
    || !isFileIdentity(identity.cliIdentity)
    || !isFileIdentity(identity.plistIdentity)
  ) {
    throw new Error('invalid monitor install identity');
  }
  return identity as MonitorInstallTargetIdentity;
}

function validMonitorInstallSpec(value: unknown): value is CodexMonitorInstallSpec {
  if (!isObject(value)) return false;
  return (
    safeAbsolutePath(value.nodePath)
    && safeAbsolutePath(value.cliScriptPath)
    && positiveIntegerWithin(value.thresholdBytes, MAX_MONITOR_THRESHOLD_BYTES)
    && positiveIntegerWithin(value.growthThresholdBytes, MAX_MONITOR_THRESHOLD_BYTES)
    && value.day === 1
    && value.hour === 4
    && value.minute === 30
  );
}

function safeMonitorProgram(
  identity: FileIdentity,
  expectedPath: string,
  executable: boolean
): boolean {
  const uid = process.getuid?.();
  const ownedByCurrentUser = uid !== undefined && identity.uid === uid;
  const ownerSafe = identity.uid === 0 || ownedByCurrentUser;
  const permissionSafe = identity.mode !== undefined && (
    executable
      ? (identity.mode & (ownedByCurrentUser ? 0o100 : 0o001)) !== 0
      : (identity.mode & (ownedByCurrentUser ? 0o400 : 0o004)) !== 0
  );
  return (
    identity.exists
    && identity.regularFile
    && !identity.symbolicLink
    && identity.realpath === expectedPath
    && identity.nlink === 1
    && ownerSafe
    && identity.mode !== undefined
    && (identity.mode & 0o022) === 0
    && permissionSafe
  );
}

function safeMonitorPlist(identity: FileIdentity, expectedPath: string): boolean {
  if (!identity.exists) return true;
  const uid = process.getuid?.();
  return (
    identity.regularFile
    && !identity.symbolicLink
    && identity.realpath === expectedPath
    && identity.nlink === 1
    && uid !== undefined
    && identity.uid === uid
    && identity.mode !== undefined
    && (identity.mode & 0o022) === 0
  );
}

function safeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && path.isAbsolute(value)
    && path.resolve(value) === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedPositiveInteger(value: unknown, maximum: number, name: string): number {
  if (!positiveIntegerWithin(value, maximum)) throw new Error(`invalid ${name}`);
  return value;
}

function positiveIntegerWithin(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function isFileIdentity(value: unknown): value is FileIdentity {
  return (
    isObject(value)
    && typeof value.pathCategory === 'string'
    && typeof value.exists === 'boolean'
    && typeof value.regularFile === 'boolean'
    && typeof value.symbolicLink === 'boolean'
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function writePrivatePlan(plan: PrivateMaintenancePlan, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = plansDir(env);
  const blockers = await assertPrivateAppDirSafe(dir);
  if (blockers.length > 0) throw new Error(`unsafe plans directory: ${blockers.map(redactPath).join('; ')}`);
  const file = planPath(plan.planId, env);
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
}

async function readPrivatePlan(planIdValue: string, env: NodeJS.ProcessEnv = process.env): Promise<{ plan: PrivateMaintenancePlan } | { blockedReason: string }> {
  if (!isValidPlanId(planIdValue)) return { blockedReason: 'invalid plan id' };
  const dirBlockers = await assertExistingPrivateDirSafe(plansDir(env)).catch((error) => [String(error)]);
  if (dirBlockers.length > 0) return { blockedReason: `unsafe plans directory: ${dirBlockers.map(redactPath).join('; ')}` };
  const file = planPath(planIdValue, env);
  const blockers = await assertSafeReadablePrivateFile(file, 'plan file');
  if (blockers.length > 0) {
    if (await planWasApplied(planIdValue, env)) return { blockedReason: 'plan was already applied' };
    if (await planApplyIsInProgress(planIdValue, env)) {
      return { blockedReason: 'plan apply is already in progress' };
    }
    return { blockedReason: `unsafe plan file: ${blockers.map(redactPath).join('; ')}` };
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isPrivatePlanEnvelope(parsed, planIdValue)) {
      return { blockedReason: 'plan file is unreadable' };
    }
    return { plan: parsed };
  } catch {
    return { blockedReason: 'plan file is unreadable' };
  }
}

function isPrivatePlanEnvelope(
  value: unknown,
  expectedPlanId: string
): value is PrivateMaintenancePlan {
  if (!isObject(value)) return false;
  const allowedKeys = new Set([
    'schemaVersion',
    'toolVersion',
    'planId',
    'action',
    'status',
    'createdAt',
    'expiresAt',
    'identityHash',
    'preview',
    'blockedReasons',
    'warnings',
    'target',
    'targetIdentity'
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (
    value.schemaVersion !== 1
    || typeof value.toolVersion !== 'string'
    || value.toolVersion.length === 0
    || value.planId !== expectedPlanId
    || typeof value.action !== 'string'
    || !/^[a-z0-9-]{1,64}$/.test(value.action)
    || (value.status !== 'ready' && value.status !== 'blocked')
    || typeof value.createdAt !== 'string'
    || value.createdAt.length === 0
    || typeof value.expiresAt !== 'string'
    || value.expiresAt.length === 0
    || typeof value.identityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.identityHash)
    || !validPrivatePreview(value.preview)
    || !isStringArray(value.blockedReasons)
    || !isStringArray(value.warnings)
    || !validPrivateTarget(value.target)
    || !isObject(value.targetIdentity)
  ) {
    return false;
  }
  return true;
}

function validPrivatePreview(value: unknown): value is MaintenancePlanPreview {
  if (!isObject(value)) return false;
  const numericKeys = new Set([
    'targetCount',
    'reclaimableBytes',
    'walBytes',
    'imagesPrunable',
    'filesBlocked',
    'sourceBytes',
    'projectedBytes',
    'thresholdBytes',
    'growthThresholdBytes'
  ]);
  const booleanKeys = new Set(['contentRead', 'irreversible']);
  for (const [key, child] of Object.entries(value)) {
    if (numericKeys.has(key)) {
      if (!Number.isSafeInteger(child) || Number(child) < 0) return false;
      continue;
    }
    if (booleanKeys.has(key)) {
      if (typeof child !== 'boolean') return false;
      continue;
    }
    return false;
  }
  return true;
}

function validPrivateTarget(value: unknown): boolean {
  return (
    isObject(value)
    && Object.keys(value).length === 2
    && typeof value.kind === 'string'
    && typeof value.pathCategory === 'string'
    && value.kind.length > 0
    && value.pathCategory.length > 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function claimPlan(
  planIdValue: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const source = planPath(planIdValue, env);
  const claimed = applyingPlanPath(planIdValue, env);
  let linked = false;
  try {
    await link(source, claimed);
    linked = true;
    await unlink(source);
    return true;
  } catch {
    if (linked) await unlink(claimed).catch(() => undefined);
    return false;
  }
}

async function restorePlanClaim(
  planIdValue: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return await transitionClaim(
    applyingPlanPath(planIdValue, env),
    planPath(planIdValue, env)
  );
}

async function consumePlanClaim(
  planIdValue: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return await transitionClaim(
    applyingPlanPath(planIdValue, env),
    appliedPlanPath(planIdValue, env)
  );
}

async function transitionClaim(source: string, destination: string): Promise<boolean> {
  try {
    await link(source, destination);
    await unlink(source);
    return true;
  } catch {
    return false;
  }
}

async function blockedAfterClaim(
  plan: PrivateMaintenancePlan,
  blockedReasons: string[],
  env: NodeJS.ProcessEnv | undefined
): Promise<ApplyPlanResult> {
  const restored = await restorePlanClaim(plan.planId, env);
  return blockedApply(plan, uniqueStrings([
    ...blockedReasons,
    ...(restored ? [] : ['plan claim could not be restored'])
  ]));
}

async function prunePrivatePlans(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  keepPlanId?: string
): Promise<void> {
  const dir = plansDir(env);
  const dirBlockers = await assertExistingPrivateDirSafe(dir).catch(() => ['unsafe']);
  if (dirBlockers.length > 0) return;
  const entries = await readdir(dir).catch(() => []);
  const nowMs = now.getTime();
  const candidates = entries
    .map((name) => planEntryCandidate(name, env))
    .filter((entry): entry is PlanEntryCandidate => entry !== undefined)
    .sort((left, right) => right.createdAtMs - left.createdAtMs || right.name.localeCompare(left.name));

  await Promise.all(candidates.map(async (entry, index) => {
    if (entry.planId === keepPlanId) return;
    if (nowMs - entry.createdAtMs <= PLAN_RETENTION_MS && index < PLAN_RETENTION_MAX) return;
    const blockers = await assertSafeReadablePrivateFile(entry.path, 'plan retention file').catch(() => ['unsafe']);
    if (blockers.length > 0) return;
    await unlink(entry.path).catch(() => undefined);
  }));
}

async function planWasApplied(planIdValue: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const blockers = await assertSafeReadablePrivateFile(appliedPlanPath(planIdValue, env), 'applied plan file').catch(() => ['missing']);
  return blockers.length === 0;
}

async function planApplyIsInProgress(planIdValue: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const blockers = await assertSafeReadablePrivateFile(
    applyingPlanPath(planIdValue, env),
    'applying plan file'
  ).catch(() => ['missing']);
  return blockers.length === 0;
}

function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(appDataHome(env), 'plans');
}

function planPath(planIdValue: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(plansDir(env), `${planIdValue}.json`);
}

function appliedPlanPath(planIdValue: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(plansDir(env), `${planIdValue}.json.applied`);
}

function applyingPlanPath(planIdValue: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(plansDir(env), `${planIdValue}.json.applying`);
}

type PlanEntryCandidate = {
  name: string;
  path: string;
  planId: string;
  createdAtMs: number;
};

function planEntryCandidate(name: string, env: NodeJS.ProcessEnv): PlanEntryCandidate | undefined {
  const match = /^(plan-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-z0-9]{1,32})\.json(?:\.(?:applied|applying))?$/.exec(name);
  if (!match) return undefined;
  const [, planIdValue, year, month, day, hour, minute, second, millisecond] = match;
  const createdAtMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond)
  );
  if (!Number.isFinite(createdAtMs)) return undefined;
  return {
    name,
    path: path.join(plansDir(env), name),
    planId: planIdValue,
    createdAtMs
  };
}

function planId(now: Date, options: CreateMaintenancePlanOptions['randomSuffix']): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = options ? options() : randomBytes(3).toString('hex');
  return `plan-${stamp}-${suffix}`;
}

function publicPlanSummary(plan: PrivateMaintenancePlan): MaintenancePlanSummary {
  return {
    schemaVersion: plan.schemaVersion,
    toolVersion: plan.toolVersion,
    planId: plan.planId,
    action: plan.action,
    status: plan.status,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    identityHash: plan.identityHash,
    preview: plan.preview,
    blockedReasons: publicStrings(plan.blockedReasons),
    warnings: publicStrings(plan.warnings)
  };
}

function blockedApply(plan: PrivateMaintenancePlan, blockedReasons: string[]): ApplyPlanResult {
  const result: ApplyPlanResult = {
    status: 'blocked',
    planId: plan.planId,
    applied: false,
    blockedReasons: publicStrings(blockedReasons),
    warnings: publicStrings(plan.warnings)
  };
  if (isPlanAction(plan.action)) result.action = plan.action;
  return result;
}

function publicApplyResult(result: unknown): unknown {
  return redactPlanOutput(result);
}

function resultStatus(result: unknown): string {
  if (isObject(result) && 'report' in result && isObject(result.report) && typeof result.report.status === 'string') {
    return result.report.status;
  }
  return isObject(result) && typeof result.status === 'string' ? result.status : 'blocked';
}

function resultChanged(result: unknown): boolean {
  return isObject(result) && result.changed === true;
}

function resultBlockedReasons(result: unknown): string[] {
  if (!isObject(result)) return ['plan apply failed'];
  if ('report' in result && isObject(result.report) && Array.isArray(result.report.blockedReasons)) {
    return publicStrings(result.report.blockedReasons.map(String));
  }
  if (Array.isArray(result.blockedReasons)) {
    return publicStrings(result.blockedReasons.map(String));
  }
  return ['plan apply failed'];
}

function resultWarnings(result: unknown): string[] {
  if (!isObject(result)) return [];
  if (Array.isArray(result.warnings)) return publicStrings(result.warnings.map(String));
  return [];
}

function publicStrings(values: string[]): string[] {
  return values.map((value) => redactPath(value));
}

function hashIdentity(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function isValidPlanId(value: string): boolean {
  return /^plan-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{1,32}$/.test(value);
}

function isPlanAction(value: unknown): value is MaintenancePlanAction {
  return (
    typeof value === 'string'
    && (MAINTENANCE_PLAN_ACTIONS as readonly string[]).includes(value)
  );
}

function redactPlanOutput(value: unknown): unknown {
  if (typeof value === 'string') return redactPath(value);
  if (Array.isArray(value)) return value.map((entry) => redactPlanOutput(entry));
  if (!isObject(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (['path', 'targetIdentity', 'dev', 'ino', 'uid', 'gid', 'mode', 'mtimeMs', 'realpath', 'stderr', 'stdout', 'rawStderr'].includes(key)) continue;
    output[key] = redactPlanOutput(child);
  }
  return output;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
