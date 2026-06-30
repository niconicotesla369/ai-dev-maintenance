import { codexProvider, checkOpenHandles, knownCodexProcessExists } from './providers/codex.js';
import { listProviders } from './providers/registry.js';
import { writeReport } from './reports.js';
import type { MaintenanceReport, ProviderReport, StateEntry } from './types.js';
import { REPORT_SCHEMA_VERSION, TOOL_VERSION } from './version.js';

export { checkOpenHandles, knownCodexProcessExists };

export async function runDoctor(options: {
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}) {
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
  report.nextSafeAction = 'Review provider buckets. Use cursor clean --safe to dry-run Cursor cache/log cleanup.';

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

function baseAggregateReport(generatedAt: string, status: MaintenanceReport['status']): MaintenanceReport {
  return {
    schemaVersion: Math.max(REPORT_SCHEMA_VERSION, 2) as 2,
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
