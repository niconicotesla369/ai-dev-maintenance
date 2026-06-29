import { redactPath } from './paths.js';
import { deriveFixReadiness } from './safety.js';
import type { MaintenanceReport } from './types.js';
import { TOOL_VERSION } from './version.js';
import { bannerText } from './cli-banner.js';

export type RenderReportOptions = {
  banner?: boolean;
};

export function renderReport(report: MaintenanceReport, reportPath?: string, showPaths = false, options: RenderReportOptions = {}): string {
  const readiness = report.command === 'doctor' ? deriveFixReadiness(report) : undefined;
  const lines: string[] = [];
  if (options.banner) lines.push(bannerText().trimEnd(), '');
  lines.push(row('Diagnosis', diagnosisLabel(report)));
  if (readiness) {
    lines.push(row('Fix readiness', readiness.safe ? 'ready' : 'blocked'));
    if (!readiness.safe) lines.push(row('Reason', readiness.reasons.join('; ') || 'not safe to run fix'));
  } else if (report.blockedReasons.length > 0) {
    lines.push(row('Reason', report.blockedReasons.join('; ')));
  }
  lines.push(row('Target', report.target.pathCategory));
  lines.push(...targetSizeRows(report));
  lines.push(...metricRows(report));
  lines.push(row('Changed', whatChanged(report)));
  if (reportPath) {
    const reportLocation = showPaths ? reportPath : redactPath(reportPath);
    lines.push(row('Report', reportLocation));
    lines.push(row('Review', `npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- report --latest`));
  }
  const next = nextAction(report, readiness?.safe === true);
  if (next) lines.push(row('Next', next));
  return `${lines.join('\n')}\n`;
}

export function row(label: string, value: string): string {
  return `${label.padEnd(16, ' ')}${value}`;
}

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function targetSizeRows(report: MaintenanceReport): string[] {
  const targetState = (report.findings as Record<string, unknown>).targetState as Record<string, unknown> | undefined;
  return [
    sizeRow('Main DB', targetState?.main),
    sizeRow('WAL', targetState?.wal),
    sizeRow('SHM', targetState?.shm)
  ].filter((line): line is string => Boolean(line));
}

export function metricRows(report: MaintenanceReport): string[] {
  const rows: string[] = [];
  for (const [key, label] of [
    ['beforeWalBytes', 'Before WAL'],
    ['afterWalBytes', 'After WAL'],
    ['reclaimedBytes', 'Reclaimed']
  ] as const) {
    const value = report.metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) rows.push(row(label, formatMiB(value)));
  }
  return rows;
}

function whatChanged(report: MaintenanceReport): string {
  if (report.command === 'doctor') return 'redacted report only';
  if (report.command === 'fix --safe' && report.status === 'ok') return 'private backup + WAL cleanup';
  if (report.command === 'fix --safe' && report.metrics.backupCreated && report.metrics.checkpointAttempted) {
    return 'private backup created + checkpoint attempted; review report';
  }
  if (report.command === 'fix --safe' && report.metrics.backupCreated) return 'private backup created; fix was blocked';
  if (report.command === 'fix --safe') return 'nothing; fix was blocked';
  return 'nothing';
}

function diagnosisLabel(report: MaintenanceReport): string {
  if (report.command === 'doctor' && report.status === 'ok') return 'complete';
  return report.status;
}

function sizeRow(label: string, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const size = value.size;
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined;
  return row(label, formatMiB(size));
}

function nextAction(report: MaintenanceReport, ready: boolean): string | undefined {
  if (report.nextSafeAction) return report.nextSafeAction;
  if (report.command !== 'doctor') return undefined;
  if (ready) return `npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- fix --safe --yes`;
  return 'Close AI coding tools, then run doctor again.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
