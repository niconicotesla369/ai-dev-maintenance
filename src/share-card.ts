import { formatBytes } from './cli-render.js';
import type { PressureReport } from './pressure/types.js';
import type { MaintenanceReport, ProviderReport } from './types.js';
import { TOOL_VERSION } from './version.js';

type KnownProvider = {
  id: 'codex' | 'claude-code' | 'cursor';
  label: string;
};

const KNOWN_PROVIDERS: KnownProvider[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' }
];

const CARD_WIDTH = 72;

export function renderShareCard(report: MaintenanceReport): string {
  const version = safeVersion(report.toolVersion);
  const providers = shareProviders(report.providers ?? []);
  const totals = report.totals ?? {
    totalBytes: providers.reduce((sum, provider) => sum + provider.totalBytes, 0),
    safeReclaimableBytes: providers.reduce((sum, provider) => sum + provider.safeReclaimableBytes, 0),
    confirmBytes: providers.reduce((sum, provider) => sum + provider.confirmBytes, 0),
    privateBytes: providers.reduce((sum, provider) => sum + provider.privateBytes, 0)
  };

  return boxed([
    'AIDM SHARE CARD',
    '',
    pairLine('Version', `v${version}`),
    pairLine('Date', shareDate(report.generatedAt)),
    '',
    'Providers',
    ...providers.map((provider) => {
      const status = provider.present ? 'detected' : 'not found';
      return tableLine(provider.label, status, formatBytes(provider.totalBytes));
    }),
    '',
    'Buckets',
    pairLine('Tracked state', formatBytes(totals.totalBytes)),
    pairLine('Safe reclaimable', formatBytes(totals.safeReclaimableBytes)),
    pairLine('Review first', formatBytes(totals.confirmBytes)),
    pairLine('Private danger', formatBytes(totals.privateBytes)),
    '',
    'Private danger buckets are never auto-touched.',
    `Run ${shareCommand(version)}`
  ]);
}

export function renderPressureShareCard(report: PressureReport): string {
  const version = safeVersion(report.toolVersion);
  const signals = sharePressureSignals(report.pressureLevel.reasons);
  const nextActions = sharePressureActions(report.nextActions);

  return boxed([
    'AIDM PRESSURE CARD',
    '',
    pairLine('Version', `v${version}`),
    pairLine('Date', shareDate(report.generatedAt)),
    '',
    'Status',
    pairLine('Pressure', report.pressureLevel.overall.toUpperCase()),
    pairLine('Memory', report.pressureLevel.memory.toUpperCase()),
    pairLine('Disk', report.pressureLevel.disk.toUpperCase()),
    pairLine('AI CPU', shareCpu(report.totals.aiCpuPercent, report.totals.aiCpuCapacityPercent)),
    pairLine('Other CPU', shareCpu(report.totals.otherCpuPercent, report.totals.otherCpuCapacityPercent)),
    pairLine('AI RSS', formatBytes(safeNonNegativeNumber(report.totals.aiRssBytes))),
    pairLine('Other RSS', formatBytes(safeNonNegativeNumber(report.totals.otherRssBytes))),
    '',
    'Signals',
    ...(signals.length > 0 ? signals.map((signal) => `- ${signal}`) : ['- No urgent pressure signals.']),
    '',
    'Next actions',
    ...(nextActions.length > 0 ? nextActions.map((action) => `- ${action}`) : ['- No urgent pressure action detected.']),
    '',
    `Run ${sharePressureCommand(version)}`
  ]);
}

function shareProviders(providers: ProviderReport[]): Array<{
  label: string;
  present: boolean;
  totalBytes: number;
  safeReclaimableBytes: number;
  confirmBytes: number;
  privateBytes: number;
}> {
  return KNOWN_PROVIDERS.map((known) => {
    const provider = providers.find((candidate) => candidate.id === known.id);
    return {
      label: known.label,
      present: provider?.present === true,
      totalBytes: safeNonNegativeNumber(provider?.totalBytes),
      safeReclaimableBytes: safeNonNegativeNumber(provider?.buckets.safeReclaimableBytes),
      confirmBytes: safeNonNegativeNumber(provider?.buckets.confirmBytes),
      privateBytes: safeNonNegativeNumber(provider?.buckets.privateBytes)
    };
  });
}

function shareCommand(version: string): string {
  return `npx --yes ai-dev-maintenance@${version}`;
}

function sharePressureCommand(version: string): string {
  return `${shareCommand(version)} pressure`;
}

function shareCpu(rawPercent: unknown, capacityPercent: unknown): string {
  const raw = `${formatPercent(safeNonNegativeNumber(rawPercent))}%`;
  const capacity = typeof capacityPercent === 'number' && Number.isFinite(capacityPercent) && capacityPercent >= 0
    ? ` (${formatPercent(capacityPercent)}% cap)`
    : '';
  return `${raw}${capacity}`;
}

function formatPercent(value: number): string {
  return value.toFixed(1);
}

function sharePressureSignals(reasons: string[]): string[] {
  const allowed = new Map([
    ['memory pressure is high', 'Memory pressure is high'],
    ['AI CPU pressure is high', 'AI CPU pressure is high'],
    ['disk pressure is high', 'Disk pressure is high'],
    ['AI CPU pressure is elevated', 'AI CPU pressure is elevated'],
    ['disk usage is elevated', 'Disk usage is elevated'],
    ['non-AI process pressure is high', 'Non-AI process pressure is high'],
    ['non-AI process pressure is elevated', 'Non-AI process pressure is elevated']
  ]);
  return reasons.flatMap((reason) => {
    const signal = allowed.get(reason);
    return signal ? [signal] : [];
  });
}

function sharePressureActions(actions: string[]): string[] {
  const allowed = new Set([
    'Close idle browser tabs or AI tool windows before restarting the Mac.',
    'Wait for the top AI process to finish, or close that app manually if it is stuck.',
    'Run doctor to inspect disk buckets before deleting anything.',
    'Check Activity Monitor for non-AI apps using high CPU.',
    'No urgent pressure action detected.'
  ]);
  return actions.filter((action) => allowed.has(action));
}

function shareDate(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return /^\d{4}-\d{2}-\d{2}/.exec(generatedAt)?.[0] ?? 'unknown-date';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function safeVersion(version: string): string {
  return /^[0-9A-Za-z.-]+$/.test(version) ? version : TOOL_VERSION;
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function pairLine(label: string, value: string): string {
  return `${label.padEnd(18, ' ')}${value}`;
}

function tableLine(label: string, status: string, value: string): string {
  return `${label.padEnd(14, ' ')}${status.padEnd(12, ' ')}${value}`;
}

function boxed(lines: string[]): string {
  const innerWidth = CARD_WIDTH - 4;
  const top = `+${'-'.repeat(CARD_WIDTH - 2)}+`;
  const body = lines.map((line) => `| ${line.slice(0, innerWidth).padEnd(innerWidth, ' ')} |`);
  return `${[top, ...body, top].join('\n')}\n`;
}
