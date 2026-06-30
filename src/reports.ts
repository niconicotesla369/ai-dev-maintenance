import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateAppDirSafe, assertSafeReadablePrivateFile } from './fs-safety.js';
import { appDataHome, redactPath } from './paths.js';
import { pruneReports } from './retention.js';
import type { MaintenanceReport } from './types.js';

export async function ensurePrivateDir(dir: string): Promise<void> {
  const blockers = await assertPrivateAppDirSafe(dir);
  if (blockers.length > 0) {
    throw new Error(`unsafe private directory: ${blockers.join('; ')}`);
  }
}

export async function writeReport(report: MaintenanceReport): Promise<string> {
  const dir = path.join(appDataHome(), 'reports');
  await ensurePrivateDir(dir);
  const sanitized = sanitizeReportForOutput(report);
  const retention = await pruneReports(dir).catch((error) => ({
    deleted: 0,
    warnings: [error instanceof Error ? error.message : String(error)]
  }));
  for (const warning of retention.warnings) addWarning(sanitized, `report retention: ${warning}`);
  const stamp = sanitized.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `report-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await pruneReports(dir).catch(() => undefined);
  return file;
}

export async function latestReport(): Promise<{ path: string; report: MaintenanceReport } | null> {
  const dir = path.join(appDataHome(), 'reports');
  await ensurePrivateDir(dir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const reports = entries.filter((entry) => /^report-.*\.json$/.test(entry)).sort();
  const latest = reports.at(-1);
  if (!latest) return null;
  const file = path.join(dir, latest);
  const fileBlockers = await assertSafeReadablePrivateFile(file, 'report file');
  if (fileBlockers.length > 0) {
    throw new Error(`unsafe report file: ${fileBlockers.join('; ')}`);
  }
  return {
    path: file,
    report: sanitizeReportForOutput(JSON.parse(await readFile(file, 'utf8')) as MaintenanceReport)
  };
}

export function sanitizeReportForOutput(report: MaintenanceReport): MaintenanceReport {
  return {
    schemaVersion: report.schemaVersion === 2 ? 2 : 1,
    toolVersion: sanitizeString(report.toolVersion),
    generatedAt: sanitizeString(report.generatedAt),
    command: sanitizeString(report.command),
    status: report.status,
    redacted: true,
    target: {
      kind: sanitizeTargetKind(report.target?.kind),
      pathCategory: sanitizeString(report.target?.pathCategory ?? 'unknown')
    },
    findings: sanitizeRecord(report.findings),
    metrics: sanitizeRecord(report.metrics),
    blockedReasons: Array.isArray(report.blockedReasons)
      ? report.blockedReasons.map((reason) => sanitizeString(String(reason)))
      : [],
    nextSafeAction: report.nextSafeAction ? sanitizeString(report.nextSafeAction) : undefined,
    providers: sanitizeProviders(report.providers),
    totals: sanitizeTotals(report.totals)
  };
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeJsonValue(value);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeJsonValue(value: unknown, key = ''): unknown {
  if (isForbiddenReportKey(key)) return undefined;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeJsonValue(childValue, childKey);
    if (sanitized !== undefined) result[sanitizeReportKey(childKey)] = sanitized;
  }
  return result;
}

function sanitizeString(value: string): string {
  return redactPath(value);
}

function sanitizeReportKey(key: string): string {
  return redactPath(key);
}

function sanitizeTargetKind(kind: unknown): MaintenanceReport['target']['kind'] {
  if (kind === 'default-codex-log-db') return 'default-codex-log-db';
  if (kind === 'aggregate-ai-tools') return 'aggregate-ai-tools';
  return 'unknown';
}

function sanitizeProviders(providers: unknown): MaintenanceReport['providers'] {
  if (!Array.isArray(providers)) return undefined;
  const sanitized = sanitizeJsonValue(providers);
  return Array.isArray(sanitized) ? sanitized as MaintenanceReport['providers'] : undefined;
}

function sanitizeTotals(totals: unknown): MaintenanceReport['totals'] {
  const sanitized = sanitizeJsonValue(totals);
  return isPlainObject(sanitized) ? sanitized as MaintenanceReport['totals'] : undefined;
}

function isForbiddenReportKey(key: string): boolean {
  return new Set([
    'dev',
    'ino',
    'uid',
    'gid',
    'mode',
    'mtimeMs',
    'realpath',
    'rawStderr',
    'stderr',
    'stdout'
  ]).has(key);
}

function addWarning(report: MaintenanceReport, warning: string): void {
  const findings = report.findings as Record<string, unknown>;
  const existing = Array.isArray(findings.warnings) ? findings.warnings.map(String) : [];
  findings.warnings = [...existing, sanitizeString(warning)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
