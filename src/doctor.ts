import { statfs as defaultStatfs } from 'node:fs/promises';
import { codexProvider, checkOpenHandles, knownCodexProcessExists } from './providers/codex.js';
import { resolveHome } from './paths.js';
import { listProviders } from './providers/registry.js';
import { writeReport } from './reports.js';
import type { AggregateDoctorReport, ProviderReport, ReportStatus, StateEntry } from './types.js';
import { TOOL_VERSION } from './version.js';

export { checkOpenHandles, knownCodexProcessExists };

export type StatfsSnapshot = {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
};

export type StatfsReader = (targetPath: string) => Promise<StatfsSnapshot>;

type AggregateDoctorOptions = {
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  statfs?: StatfsReader;
};

type CoverageWarning = {
  code: 'scan-truncated' | 'tracked-state-gap' | 'volume-usage-unavailable';
  message: string;
};

type VolumeUsage = {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  capacityPercent?: number;
  trackedStatePercentOfUsedBytes?: number;
};

const nextSafeAction = 'Review tracked provider buckets and coverage warnings. Dry run: aidm cursor clean --safe. To clean, create a plan with "aidm plan cursor-clean --json" and have a human run "aidm apply --plan <planId> --yes".';

export async function runDoctor(options: AggregateDoctorOptions = {}) {
  const generatedAt = new Date().toISOString();
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    const report = baseAggregateReport(generatedAt, 'unsupported');
    report.blockedReasons.push('platform is unsupported');
    report.nextSafeAction = 'Run this tool on macOS.';
    return { report };
  }

  const providers: ProviderReport[] = [];
  for (const provider of listProviders()) {
    const detection = await provider.detect({ platform, env: options.env });
    const entries = detection.present ? await provider.scan({ platform, env: options.env }) : [];
    const advisories = await provider.advisories({ platform, env: options.env });
    providers.push({
      id: provider.id,
      displayName: provider.displayName,
      present: detection.present,
      totalBytes: sumBytes(entries),
      buckets: bucketEntries(entries),
      entries,
      advisories
    });
  }

  const report = baseAggregateReport(generatedAt, 'ok');
  report.providers = providers;
  report.totals = {
    totalBytes: providers.reduce((sum, provider) => sum + provider.totalBytes, 0),
    safeReclaimableBytes: providers.reduce((sum, provider) => sum + provider.buckets.safeReclaimableBytes, 0),
    confirmBytes: providers.reduce((sum, provider) => sum + provider.buckets.confirmBytes, 0),
    privateBytes: providers.reduce((sum, provider) => sum + provider.buckets.privateBytes, 0)
  };
  const truncated = providers.flatMap((provider) =>
    provider.entries
      .filter((entry) => entry.sizeTruncated === true)
      .map((entry) => ({ providerId: provider.id, pathCategory: entry.pathCategory }))
  );
  const volume = await readVolumeUsage(options.statfs ?? defaultStatfs, resolveHome(options.env), report.totals.totalBytes);
  const warnings = coverageWarnings(truncated.length > 0, volume);

  report.findings.coverage = {
    complete: truncated.length === 0 && volume !== undefined,
    trackedStateIsLowerBound: truncated.length > 0,
    warnings
  };
  if (volume) report.metrics.volume = volume;
  if (truncated.length > 0 || !volume) report.status = 'partial';
  report.nextSafeAction = nextSafeAction;

  const reportPath = options.persistReport === false ? undefined : await writeReport(report);
  return { report, reportPath };
}

export async function runCodexDoctor(options: {
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}) {
  if (!codexProvider.runDoctor) throw new Error('Codex doctor is unavailable');
  return await codexProvider.runDoctor({
    ...options,
    generatedAt: new Date().toISOString()
  });
}

async function readVolumeUsage(
  statfs: StatfsReader,
  home: string,
  trackedStateBytes: number
): Promise<VolumeUsage | undefined> {
  try {
    return calculateVolumeUsage(await statfs(home), trackedStateBytes);
  } catch {
    return undefined;
  }
}

function calculateVolumeUsage(snapshot: StatfsSnapshot, trackedStateBytes: number): VolumeUsage | undefined {
  const inputs = [snapshot.bsize, snapshot.blocks, snapshot.bfree, snapshot.bavail];
  if (!inputs.every(isFiniteNonNegative)) return undefined;

  const totalBytes = snapshot.bsize * snapshot.blocks;
  const usedBytes = snapshot.bsize * (snapshot.blocks - snapshot.bfree);
  const availableBytes = snapshot.bsize * snapshot.bavail;
  const occupiedBytes = usedBytes + availableBytes;
  if (![totalBytes, usedBytes, availableBytes, occupiedBytes].every(isFiniteNonNegative)) return undefined;

  const volume: VolumeUsage = {
    totalBytes,
    usedBytes,
    availableBytes
  };
  if (occupiedBytes > 0) {
    const capacityPercent = percentOf(usedBytes, occupiedBytes);
    if (!isFiniteNonNegative(capacityPercent)) return undefined;
    volume.capacityPercent = capacityPercent;
  }
  if (usedBytes > 0) {
    const trackedStatePercentOfUsedBytes = percentOf(trackedStateBytes, usedBytes);
    if (!isFiniteNonNegative(trackedStatePercentOfUsedBytes)) return undefined;
    volume.trackedStatePercentOfUsedBytes = trackedStatePercentOfUsedBytes;
  }

  return volume;
}

function coverageWarnings(scanTruncated: boolean, volume: VolumeUsage | undefined): CoverageWarning[] {
  const warnings: CoverageWarning[] = [];
  if (scanTruncated) {
    warnings.push({
      code: 'scan-truncated',
      message: 'Tracked state is a lower bound because one or more scans were incomplete.'
    });
  }
  if (
    volume &&
    volume.capacityPercent !== undefined &&
    volume.trackedStatePercentOfUsedBytes !== undefined &&
    volume.capacityPercent >= 90 &&
    volume.trackedStatePercentOfUsedBytes < 5
  ) {
    warnings.push({
      code: 'tracked-state-gap',
      message: 'Tracked AI-tool state is under 5% of used volume; inspect other System Data sources before attributing disk pressure to these providers.'
    });
  }
  if (!volume) {
    warnings.push({
      code: 'volume-usage-unavailable',
      message: 'Volume usage context is unavailable.'
    });
  }
  return warnings;
}

function percentOf(value: number, total: number): number {
  return Math.round((value / total) * 1_000) / 10;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function baseAggregateReport(generatedAt: string, status: ReportStatus): AggregateDoctorReport {
  return {
    schemaVersion: 2,
    toolVersion: TOOL_VERSION,
    generatedAt,
    command: 'doctor',
    status,
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: 'ai-tools'
    },
    findings: {},
    metrics: {},
    blockedReasons: []
  };
}

function sumBytes(entries: StateEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

function bucketEntries(entries: StateEntry[]): ProviderReport['buckets'] {
  return {
    safeReclaimableBytes: entries
      .filter((entry) => entry.reclaimability === 'safe')
      .reduce((sum, entry) => sum + entry.bytes, 0),
    confirmBytes: entries
      .filter((entry) => entry.reclaimability === 'confirm')
      .reduce((sum, entry) => sum + entry.bytes, 0),
    privateBytes: entries
      .filter((entry) => entry.reclaimability === 'never')
      .reduce((sum, entry) => sum + entry.bytes, 0)
  };
}
