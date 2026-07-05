import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertExistingPrivateDirSafe, assertSafeReadablePrivateFile } from './fs-safety.js';
import { appDataHome, redactPath } from './paths.js';
import { formatBytes, row } from './cli-render.js';
import { sanitizeReportForOutput } from './reports.js';
import { TOOL_VERSION } from './version.js';
import type { MaintenanceReport, ProviderReport } from './types.js';

type AggregateHistoryReport = MaintenanceReport & {
  providers: ProviderReport[];
  totals: NonNullable<MaintenanceReport['totals']>;
};

export type HistoryPoint = {
  date: string;
  totalBytes: number;
};

export type HistorySeries = {
  id: string;
  displayName: string;
  points: HistoryPoint[];
  firstBytes: number;
  lastBytes: number;
  deltaBytes: number;
  bytesPerDay: number;
  sparkline: string;
};

export type HistoryReport = {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  command: 'history';
  status: 'ok' | 'partial';
  redacted: true;
  windowDays: number;
  dataPoints: number;
  providers: HistorySeries[];
  totals: Omit<HistorySeries, 'id' | 'displayName' | 'points'>;
  warnings: string[];
  nextActions: string[];
};

export type HistoryOptions = {
  reportsDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

const HISTORY_WINDOW_DAYS = 30;

export async function buildHistoryReport(options: HistoryOptions = {}): Promise<HistoryReport> {
  const now = options.now ?? new Date();
  const reportsDir = options.reportsDir ?? path.join(appDataHome(options.env), 'reports');
  const warnings: string[] = [];
  const reportByDay = new Map<string, AggregateHistoryReport>();
  let skippedUnsupported = 0;

  const dirBlockers = await assertExistingPrivateDirSafe(reportsDir).catch((error) => [String(error)]);
  if (dirBlockers.length > 0) {
    warnings.push(...dirBlockers.map(redactPath));
    return emptyHistory(now, warnings);
  }

  const entries = await readdir(reportsDir).catch(() => []);
  for (const name of entries.sort()) {
    if (!/^report-.*\.json$/.test(name)) continue;
    const file = path.join(reportsDir, name);
    const fileBlockers = await assertSafeReadablePrivateFile(file, `report ${name}`);
    if (fileBlockers.length > 0) {
      warnings.push(...fileBlockers.map(redactPath));
      continue;
    }

    const parsed = await readJsonReport(file).catch((error) => {
      warnings.push(`Skipped unreadable report ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    if (!parsed || !isAggregateDoctorReport(parsed)) {
      skippedUnsupported += 1;
      continue;
    }

    const day = dayKey(parsed.generatedAt);
    if (!day) {
      warnings.push(`Skipped report ${name} with invalid generatedAt.`);
      continue;
    }
    const existing = reportByDay.get(day);
    if (!existing || Date.parse(parsed.generatedAt) >= Date.parse(existing.generatedAt)) {
      reportByDay.set(day, parsed);
    }
  }

  if (skippedUnsupported > 0) {
    warnings.push(
      skippedUnsupported === 1
        ? 'Skipped 1 report that was not aggregate doctor schema v2.'
        : `Skipped ${skippedUnsupported} reports that were not aggregate doctor schema v2.`
    );
  }

  const reports = [...reportByDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, report]) => ({ date, report }));
  return historyFromReports(reports, now, warnings);
}

export function renderHistoryReport(report: HistoryReport): string {
  const lines = [
    'AIDM HISTORY',
    row('Window', `last ${report.windowDays} days`),
    row('Data points', String(report.dataPoints)),
    row('Total state', historyLine(report.totals))
  ];

  for (const provider of report.providers) {
    lines.push(row(provider.displayName, historyLine(provider)));
  }
  for (const warning of report.warnings) lines.push(row('Warning', warning));
  for (const action of report.nextActions) lines.push(row('Next', action));
  return `${lines.join('\n')}\n`;
}

async function readJsonReport(file: string): Promise<MaintenanceReport> {
  return sanitizeReportForOutput(JSON.parse(await readFile(file, 'utf8')) as MaintenanceReport);
}

function isAggregateDoctorReport(report: MaintenanceReport): report is AggregateHistoryReport {
  return (
    report.schemaVersion === 2 &&
    report.command === 'doctor' &&
    Array.isArray(report.providers) &&
    report.totals !== undefined
  );
}

function historyFromReports(
  reports: Array<{ date: string; report: AggregateHistoryReport }>,
  now: Date,
  warnings: string[]
): HistoryReport {
  const totalsPoints = reports.map(({ date, report }) => ({
    date,
    totalBytes: report.totals.totalBytes
  }));
  const providerMap = new Map<string, { displayName: string; points: HistoryPoint[] }>();
  for (const { date, report } of reports) {
    for (const provider of report.providers) {
      const existing = providerMap.get(provider.id) ?? { displayName: provider.displayName, points: [] };
      existing.points.push({ date, totalBytes: provider.totalBytes });
      providerMap.set(provider.id, existing);
    }
  }

  const providers = [...providerMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => seriesFromPoints(id, value.displayName, value.points));
  const nextActions = reports.length < 2
    ? ['Run doctor again in a few days to build history.']
    : [];

  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: now.toISOString(),
    command: 'history',
    status: warnings.length > 0 ? 'partial' : 'ok',
    redacted: true,
    windowDays: HISTORY_WINDOW_DAYS,
    dataPoints: reports.length,
    providers,
    totals: totalsFromPoints(totalsPoints),
    warnings,
    nextActions
  };
}

function emptyHistory(now: Date, warnings: string[]): HistoryReport {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: now.toISOString(),
    command: 'history',
    status: warnings.length > 0 ? 'partial' : 'ok',
    redacted: true,
    windowDays: HISTORY_WINDOW_DAYS,
    dataPoints: 0,
    providers: [],
    totals: {
      firstBytes: 0,
      lastBytes: 0,
      deltaBytes: 0,
      bytesPerDay: 0,
      sparkline: ''
    },
    warnings,
    nextActions: ['Run doctor again in a few days to build history.']
  };
}

function seriesFromPoints(id: string, displayName: string, points: HistoryPoint[]): HistorySeries {
  return {
    id,
    displayName,
    points,
    ...totalsFromPoints(points)
  };
}

function totalsFromPoints(points: HistoryPoint[]): Omit<HistorySeries, 'id' | 'displayName' | 'points'> {
  const first = points[0];
  const last = points.at(-1);
  const firstBytes = first?.totalBytes ?? 0;
  const lastBytes = last?.totalBytes ?? 0;
  const deltaBytes = lastBytes - firstBytes;
  return {
    firstBytes,
    lastBytes,
    deltaBytes,
    bytesPerDay: first && last && points.length >= 2 ? Math.round(deltaBytes / dayDistance(first.date, last.date)) : 0,
    sparkline: sparkline(points.map((point) => point.totalBytes))
  };
}

function dayKey(value: string): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayDistance(first: string, last: string): number {
  const diff = Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`);
  return Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)));
}

function historyLine(series: Pick<HistorySeries, 'firstBytes' | 'lastBytes' | 'deltaBytes' | 'bytesPerDay' | 'sparkline'>): string {
  return `${formatBytes(series.firstBytes)} -> ${formatBytes(series.lastBytes)} (${signedBytes(series.deltaBytes)}, ${formatBytes(series.bytesPerDay)}/day) ${series.sparkline}`.trimEnd();
}

function signedBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  return `${bytes > 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return '•';
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return '─'.repeat(values.length);
  return values.map((value) => {
    const index = Math.round(((value - min) / (max - min)) * (bars.length - 1));
    return bars[index] ?? bars[0];
  }).join('');
}
