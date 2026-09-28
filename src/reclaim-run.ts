import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes } from './cli-render.js';
import { cursorSafeTargetPaths } from './cursor-clean.js';
import { assertSafeReadablePrivateFile } from './fs-safety.js';
import { scanPathSize, type SizeScanResult } from './fs-size.js';
import { appDataHome, defaultCodexHome, resolveHome } from './paths.js';
import { ensurePrivateDir } from './reports.js';
import { TOOL_VERSION } from './version.js';

export const RECLAIM_ACTIONS = ['codex-fix', 'cursor-clean'] as const;
export type ReclaimAction = typeof RECLAIM_ACTIONS[number];
export type ReclaimOutcome = 'ok' | 'partial' | 'blocked' | 'unknown';
export type ReclaimRunStatus = 'ok' | 'partial' | 'blocked';

export type ByteChange = {
  beforeBytes: number | null;
  afterBytes: number | null;
  deltaBytes: number | null;
};

export type ReclaimRunItem = {
  action: ReclaimAction;
  outcome: ReclaimOutcome;
  estimateBytes: number | null;
  estimateNote?: 'wal-folds-into-database';
  target: ByteChange;
  reasons: string[];
};

export type ReclaimRunRecord = {
  schemaVersion: 1;
  toolVersion: string;
  command: 'reclaim-run';
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: ReclaimRunStatus;
  units: 'bytes';
  items: ReclaimRunItem[];
  totals: {
    appliedItems: number;
    excludedItems: number;
    appliedTargetDeltaBytes: number | null;
  };
  managedState: ByteChange;
  volume: ByteChange & { attributedToAidm: false };
};

export type ReclaimMeasurer = {
  targetBytes(action: ReclaimAction): Promise<number | null>;
  appDataBytes(): Promise<number | null>;
  volumeAvailableBytes(): Promise<number | null>;
};

export const RECLAIM_ACTION_LABELS: Record<ReclaimAction, string> = {
  'codex-fix': 'Codex log database WAL',
  'cursor-clean': 'Cursor caches and logs'
};

const RUN_DIR = 'reclaim-runs';
const RUN_FILE_PATTERN = /^reclaim-run-[0-9TZ-]+-[0-9a-f]{8}\.json$/;
const RUN_RETENTION_MAX = 20;
const UNMEASURABLE_SCAN_WARNINGS = new Set(['permission_denied', 'read_error', 'max_depth', 'max_entries', 'max_children', 'deadline']);
const SCAN_LIMITS = { maxDepth: 64, maxEntries: 500_000, maxChildrenPerDir: 100_000, deadlineMs: 30_000 };

export function createReclaimMeasurer(env: NodeJS.ProcessEnv = process.env): ReclaimMeasurer {
  return {
    targetBytes: async (action) => action === 'codex-fix' ? codexLogBytes(env) : cursorTargetBytes(env),
    appDataBytes: async () => scannedBytes(await scanPathSize(appDataHome(env), '<app-data>', SCAN_LIMITS)),
    volumeAvailableBytes: async () => {
      try {
        const volume = await statfs(resolveHome(env));
        const available = Number(volume.bavail) * Number(volume.bsize);
        return Number.isSafeInteger(available) ? available : null;
      } catch {
        return null;
      }
    }
  };
}

export function byteChange(beforeBytes: number | null, afterBytes: number | null): ByteChange {
  return {
    beforeBytes,
    afterBytes,
    deltaBytes: beforeBytes === null || afterBytes === null ? null : afterBytes - beforeBytes
  };
}

export function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function buildReclaimRunRecord(input: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  items: ReclaimRunItem[];
  managedState: ByteChange;
  volume: ByteChange;
}): ReclaimRunRecord {
  // Only completed or partially completed items count; blocked and unknown outcomes never add to results.
  const applied = input.items.filter((item) => item.outcome === 'ok' || item.outcome === 'partial');
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'reclaim-run',
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: runStatus(input.items),
    units: 'bytes',
    items: input.items,
    totals: {
      appliedItems: applied.length,
      excludedItems: input.items.length - applied.length,
      appliedTargetDeltaBytes: sumOrNull(applied.map((item) => item.target.deltaBytes))
    },
    managedState: input.managedState,
    volume: { ...input.volume, attributedToAidm: false }
  };
}

function runStatus(items: ReclaimRunItem[]): ReclaimRunStatus {
  if (items.length > 0 && items.every((item) => item.outcome === 'ok')) return 'ok';
  if (items.every((item) => item.outcome === 'blocked')) return 'blocked';
  return 'partial';
}

export function newReclaimRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
}

export async function writeReclaimRunRecord(
  record: ReclaimRunRecord,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const dir = path.join(appDataHome(env), RUN_DIR);
  await ensurePrivateDir(dir);
  const file = path.join(dir, `reclaim-run-${record.runId}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await pruneReclaimRuns(dir);
  return file;
}

export async function latestReclaimRunRecord(
  env: NodeJS.ProcessEnv = process.env
): Promise<ReclaimRunRecord | null> {
  const dir = path.join(appDataHome(env), RUN_DIR);
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const latest = entries.filter((entry) => RUN_FILE_PATTERN.test(entry)).sort().at(-1);
  if (!latest) return null;
  const file = path.join(dir, latest);
  const blockers = await assertSafeReadablePrivateFile(file, 'reclaim run record');
  if (blockers.length > 0) throw new Error(`unsafe reclaim run record: ${blockers.join('; ')}`);
  const record = parseReclaimRunRecord(JSON.parse(await readFile(file, 'utf8')));
  if (!record) throw new Error('reclaim run record is malformed');
  return record;
}

async function pruneReclaimRuns(dir: string): Promise<void> {
  const runs = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && RUN_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - RUN_RETENTION_MAX))) {
    await unlink(path.join(dir, name));
  }
}

export function parseReclaimRunRecord(value: unknown): ReclaimRunRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.command !== 'reclaim-run' || value.units !== 'bytes') return undefined;
  if (typeof value.toolVersion !== 'string' || typeof value.runId !== 'string') return undefined;
  if (typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return undefined;
  if (!['ok', 'partial', 'blocked'].includes(value.status as string)) return undefined;
  if (!Array.isArray(value.items) || !value.items.every(isRunItem)) return undefined;
  if (!isRecord(value.totals) || !isCount(value.totals.appliedItems) || !isCount(value.totals.excludedItems)) return undefined;
  if (!isNullableInteger(value.totals.appliedTargetDeltaBytes)) return undefined;
  if (!isByteChange(value.managedState)) return undefined;
  if (!isByteChange(value.volume) || value.volume.attributedToAidm !== false) return undefined;
  return value as ReclaimRunRecord;
}

function isRunItem(value: unknown): boolean {
  return isRecord(value)
    && (RECLAIM_ACTIONS as readonly unknown[]).includes(value.action)
    && ['ok', 'partial', 'blocked', 'unknown'].includes(value.outcome as string)
    && isNullableSize(value.estimateBytes)
    && (value.estimateNote === undefined || value.estimateNote === 'wal-folds-into-database')
    && isByteChange(value.target)
    && Array.isArray(value.reasons)
    && value.reasons.every((reason) => typeof reason === 'string');
}

function isByteChange(value: unknown): value is ByteChange & Record<string, unknown> {
  return isRecord(value)
    && isNullableSize(value.beforeBytes)
    && isNullableSize(value.afterBytes)
    && isNullableInteger(value.deltaBytes);
}

function isNullableInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function isNullableSize(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function codexLogBytes(env: NodeJS.ProcessEnv): Promise<number | null> {
  const { codexHome, custom } = defaultCodexHome(env);
  if (custom) return null;
  const mainPath = path.join(codexHome, 'logs_2.sqlite');
  return sumOrNull(await Promise.all([mainPath, `${mainPath}-wal`, `${mainPath}-shm`].map(regularFileBytes)));
}

async function regularFileBytes(filePath: string): Promise<number | null> {
  try {
    const info = await lstat(filePath);
    return info.isFile() ? info.size : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
  }
}

async function cursorTargetBytes(env: NodeJS.ProcessEnv): Promise<number | null> {
  const scans = await Promise.all(
    cursorSafeTargetPaths(env).map((target) => scanPathSize(target.path, target.pathCategory, SCAN_LIMITS))
  );
  return sumOrNull(scans.map(scannedBytes));
}

function scannedBytes(scan: SizeScanResult): number | null {
  if (!scan.exists) return 0;
  if (scan.sizeTruncated || scan.warnings.some((warning) => UNMEASURABLE_SCAN_WARNINGS.has(warning.code))) return null;
  return scan.bytes;
}

export function renderReclaimRunRecord(record: ReclaimRunRecord, savedPath?: string): string[] {
  const lines: string[] = [];
  for (const [index, item] of record.items.entries()) {
    lines.push(`[${index + 1}] ${RECLAIM_ACTION_LABELS[item.action]}  ${outcomeLabel(item.outcome)}`);
    lines.push(`    Target        ${changeText(item.target)}`);
    for (const reason of item.reasons) lines.push(`    Reason        ${reason}`);
  }
  lines.push('');
  lines.push(`Applied items   ${record.totals.appliedItems} (not counted: ${record.totals.excludedItems})`);
  lines.push(`Target change   ${signedBytes(record.totals.appliedTargetDeltaBytes)}`);
  lines.push(`Managed state   ${changeText(record.managedState)}`);
  lines.push(`Volume free     ${changeText(record.volume)}`);
  lines.push('');
  lines.push('Target change: logical size of applied items only.');
  lines.push('Managed state: targets plus AIDM backups, reports, and plans.');
  lines.push('Volume free: whole volume; not attributed to AIDM.');
  if (savedPath) lines.push(`Saved           ${savedPath}`);
  return lines;
}

export function outcomeLabel(outcome: ReclaimOutcome): string {
  if (outcome === 'ok') return 'done';
  if (outcome === 'partial') return 'partially done';
  if (outcome === 'blocked') return 'stopped; nothing changed';
  return 'result unknown';
}

export function changeText(change: ByteChange): string {
  if (change.beforeBytes === null || change.afterBytes === null) return 'not measurable';
  return `${formatBytes(change.beforeBytes)} -> ${formatBytes(change.afterBytes)} (${signedBytes(change.deltaBytes)})`;
}

export function signedBytes(bytes: number | null): string {
  if (bytes === null) return 'not measurable';
  if (bytes === 0) return '0 B';
  return bytes < 0 ? `-${formatBytes(-bytes)}` : `+${formatBytes(bytes)}`;
}
