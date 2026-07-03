import { formatBytes } from './cli-render.js';
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
    pairLine('Total state', formatBytes(totals.totalBytes)),
    pairLine('Safe reclaimable', formatBytes(totals.safeReclaimableBytes)),
    pairLine('Review first', formatBytes(totals.confirmBytes)),
    pairLine('Private danger', formatBytes(totals.privateBytes)),
    '',
    'Private danger buckets are never auto-touched.',
    `Run ${shareCommand(version)}`
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
