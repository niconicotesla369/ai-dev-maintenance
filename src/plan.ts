import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCursorSafeCleanup, planCursorSafeCleanup } from './cursor-clean.js';
import { runFixSafe } from './fix.js';
import {
  assertExistingPrivateDirSafe,
  assertPrivateAppDirSafe,
  assertSafeReadablePrivateFile,
  collectFileIdentity,
  detectTargetState
} from './fs-safety.js';
import { appDataHome, defaultCodexHome, redactPath } from './paths.js';
import { TOOL_VERSION } from './version.js';

export type MaintenancePlanAction = 'codex-fix' | 'cursor-clean';
export type MaintenancePlanStatus = 'ready' | 'blocked';

export type MaintenancePlanSummary = {
  schemaVersion: 1;
  toolVersion: string;
  planId: string;
  action: MaintenancePlanAction;
  status: MaintenancePlanStatus;
  createdAt: string;
  expiresAt: string;
  identityHash: string;
  preview: {
    targetCount?: number;
    reclaimableBytes?: number;
    walBytes?: number;
  };
  blockedReasons: string[];
  warnings: string[];
};

export type ApplyPlanResult = {
  status: 'ok' | 'blocked';
  planId: string;
  action?: MaintenancePlanAction;
  applied: boolean;
  blockedReasons: string[];
  warnings: string[];
  result?: unknown;
};

type PrivateMaintenancePlan = MaintenancePlanSummary & {
  target: {
    kind: 'default-codex-log-db' | 'cursor-safe-cleanup';
    pathCategory: string;
  };
  targetIdentity: unknown;
};

export type CreateMaintenancePlanOptions = {
  action: MaintenancePlanAction;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  randomSuffix?: () => string;
};

export type ApplyMaintenancePlanOptions = {
  planId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  runFixSafe?: typeof runFixSafe;
  runCursorSafeCleanup?: typeof runCursorSafeCleanup;
};

const PLAN_TTL_MS = 15 * 60 * 1000;
const PLAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLAN_RETENTION_MAX = 10;

export async function createMaintenancePlan(options: CreateMaintenancePlanOptions): Promise<MaintenancePlanSummary> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS);
  const collected = await collectPlanTarget(options.action, options.env);
  const identityHash = hashIdentity(collected.targetIdentity);
  const plan: PrivateMaintenancePlan = {
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
      blockedReasons: [loaded.blockedReason],
      warnings: []
    };
  }

  const plan = loaded.plan;
  if (!isPlanAction(plan.action)) {
    return blockedApply(plan, ['unknown plan action']);
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

  const recollected = await collectPlanTarget(plan.action, options.env);
  if (hashIdentity(recollected.targetIdentity) !== plan.identityHash) {
    return blockedApply(plan, ['plan identity drifted']);
  }

  const result = plan.action === 'codex-fix'
    ? await (options.runFixSafe ?? runFixSafe)({ env: options.env })
    : await (options.runCursorSafeCleanup ?? runCursorSafeCleanup)({ env: options.env, yes: true });
  const status = resultStatus(result);
  if (status !== 'ok') {
    return {
      status: 'blocked',
      planId: plan.planId,
      action: plan.action,
      applied: false,
      blockedReasons: resultBlockedReasons(result),
      warnings: resultWarnings(result),
      result: publicApplyResult(result)
    };
  }

  await markPlanApplied(plan.planId, options.env);
  return {
    status: 'ok',
    planId: plan.planId,
    action: plan.action,
    applied: true,
    blockedReasons: [],
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
  for (const reason of summary.blockedReasons) lines.push(`Reason           ${reason}`);
  for (const warning of summary.warnings) lines.push(`Warning          ${warning}`);
  if (summary.status === 'ready') lines.push(`Next             ai-dev-maintenance apply --plan ${summary.planId} --yes`);
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

async function collectPlanTarget(action: MaintenancePlanAction, env: NodeJS.ProcessEnv = process.env) {
  if (action === 'codex-fix') {
    const { codexHome, custom } = defaultCodexHome(env);
    const mainPath = path.join(codexHome, 'logs_2.sqlite');
    const targetState = await detectTargetState(mainPath);
    return {
      target: {
        kind: 'default-codex-log-db' as const,
        pathCategory: custom ? 'custom-codex-home' : '<home>/.codex/logs_2.sqlite'
      },
      targetIdentity: { targetState },
      preview: { walBytes: targetState.wal?.size ?? 0 },
      blockedReasons: custom ? ['custom CODEX_HOME is rejected by fix'] : targetState.blockers,
      warnings: []
    };
  }

  const cleanupPlan = await planCursorSafeCleanup({ env });
  const targetIdentities = await Promise.all(
    cleanupPlan.targets.map(async (target) => ({
      path: target.path,
      pathCategory: target.pathCategory,
      bytes: target.bytes,
      identity: await collectFileIdentity(target.path, target.pathCategory)
    }))
  );
  return {
    target: {
      kind: 'cursor-safe-cleanup' as const,
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
    return { blockedReason: `unsafe plan file: ${blockers.map(redactPath).join('; ')}` };
  }
  try {
    return { plan: JSON.parse(await readFile(file, 'utf8')) as PrivateMaintenancePlan };
  } catch {
    return { blockedReason: 'plan file is unreadable' };
  }
}

async function markPlanApplied(planIdValue: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rename(planPath(planIdValue, env), appliedPlanPath(planIdValue, env));
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

function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(appDataHome(env), 'plans');
}

function planPath(planIdValue: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(plansDir(env), `${planIdValue}.json`);
}

function appliedPlanPath(planIdValue: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(plansDir(env), `${planIdValue}.json.applied`);
}

type PlanEntryCandidate = {
  name: string;
  path: string;
  planId: string;
  createdAtMs: number;
};

function planEntryCandidate(name: string, env: NodeJS.ProcessEnv): PlanEntryCandidate | undefined {
  const match = /^(plan-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-z0-9]{1,32})\.json(?:\.applied)?$/.exec(name);
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
    blockedReasons: plan.blockedReasons,
    warnings: plan.warnings
  };
}

function blockedApply(plan: PrivateMaintenancePlan, blockedReasons: string[]): ApplyPlanResult {
  const result: ApplyPlanResult = {
    status: 'blocked',
    planId: plan.planId,
    applied: false,
    blockedReasons,
    warnings: plan.warnings
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

function resultBlockedReasons(result: unknown): string[] {
  if (!isObject(result)) return ['plan apply failed'];
  if ('report' in result && isObject(result.report) && Array.isArray(result.report.blockedReasons)) {
    return result.report.blockedReasons.map(String);
  }
  if (Array.isArray(result.blockedReasons)) return result.blockedReasons.map(String);
  return ['plan apply failed'];
}

function resultWarnings(result: unknown): string[] {
  if (!isObject(result)) return [];
  if (Array.isArray(result.warnings)) return result.warnings.map(String);
  return [];
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
  return value === 'codex-fix' || value === 'cursor-clean';
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
