import { diskLevelForCapacityPercent } from '../pressure/levels.js';
import type { ReclaimRunRecord } from '../reclaim-run.js';
import type {
  MaintenanceReport,
  ProviderReport,
  Reclaimability,
  ReportStatus,
  StateCategory,
  StateEntry
} from '../types.js';

export type VisualProviderId = 'codex' | 'claude-code' | 'cursor' | 'other';
export type VisualDiskLevel = 'ok' | 'medium' | 'high' | 'unknown';
export type VisualCoverage = 'complete' | 'lower-bound' | 'unavailable';
export type VisualPlanAction = 'cursor-clean' | 'codex-fix' | 'codex-sparkle-clean';

// Numbers and fixed statuses only: reasons and paths from the run record are never projected.
export type VisualReclaimRun = {
  finishedAt: string;
  status: 'ok' | 'partial' | 'blocked';
  items: Array<{
    action: 'codex-fix' | 'cursor-clean';
    outcome: 'ok' | 'partial' | 'blocked' | 'unknown';
    targetDeltaBytes: number | null;
  }>;
  appliedTargetDeltaBytes: number | null;
  managedStateDeltaBytes: number | null;
  volumeDeltaBytes: number | null;
};

export type VisualReportModel = {
  generatedAt?: string;
  reportStatus: 'ok' | 'partial' | 'blocked' | 'unsupported' | 'error';
  coverage: VisualCoverage;
  volume: {
    totalBytes?: number;
    usedBytes?: number;
    availableBytes?: number;
    capacityPercent?: number;
    diskLevel: VisualDiskLevel;
  };
  totals: {
    trackedBytes: number;
    safeBytes: number;
    reviewBytes: number;
    protectedBytes: number;
  };
  providers: Array<{ id: VisualProviderId; bytes: number }>;
  counts: { safe: number; review: number; protected: number };
  availablePlans: VisualPlanAction[];
  lastReclaim?: VisualReclaimRun | 'unavailable';
};

type AggregateProjection = Pick<VisualReportModel, 'totals' | 'providers' | 'counts' | 'availablePlans'>;
type VisualVolume = VisualReportModel['volume'];

const CODEX_LOG_DB = '<home>/.codex/logs_2.sqlite';
const CODEX_SPARKLE_ROOT = '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle';
const PLAN_ORDER: VisualPlanAction[] = ['cursor-clean', 'codex-fix', 'codex-sparkle-clean'];
const PROVIDER_ORDER: VisualProviderId[] = ['codex', 'cursor', 'claude-code', 'other'];

export function buildVisualReportModel(
  report: MaintenanceReport,
  options: { lastReclaim?: ReclaimRunRecord | 'unavailable' | null } = {}
): VisualReportModel {
  const model = buildReportProjection(report);
  if (options.lastReclaim === 'unavailable') return { ...model, lastReclaim: 'unavailable' };
  if (options.lastReclaim) return { ...model, lastReclaim: projectReclaimRun(options.lastReclaim) };
  return model;
}

export function projectReclaimRun(record: ReclaimRunRecord): VisualReclaimRun {
  return {
    finishedAt: record.finishedAt,
    status: record.status,
    items: record.items.map((item) => ({
      action: item.action,
      outcome: item.outcome,
      targetDeltaBytes: item.target.deltaBytes
    })),
    appliedTargetDeltaBytes: record.totals.appliedTargetDeltaBytes,
    managedStateDeltaBytes: record.managedState.deltaBytes,
    volumeDeltaBytes: record.volume.deltaBytes
  };
}

function buildReportProjection(report: MaintenanceReport): VisualReportModel {
  const generatedAt = canonicalTimestamp(report.generatedAt);
  let reportStatus = visualReportStatus(report.status);

  if (report.schemaVersion !== 2 || report.target?.kind !== 'aggregate-ai-tools') {
    return {
      ...(generatedAt === undefined ? {} : { generatedAt }),
      reportStatus: degradeOk(reportStatus),
      coverage: 'unavailable',
      volume: { diskLevel: 'unknown' },
      ...emptyAggregateProjection()
    };
  }

  const volume = projectVolume(report.metrics);
  const aggregate = projectAggregate(report.providers, report.totals);
  const coverage = aggregate === undefined ? 'unavailable' : projectCoverage(report.findings);
  if (aggregate === undefined || !volume.valid || coverage === 'unavailable') {
    reportStatus = degradeOk(reportStatus);
  }

  return {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    reportStatus,
    coverage,
    volume: volume.value,
    ...(aggregate ?? emptyAggregateProjection())
  };
}

function projectAggregate(
  providers: ProviderReport[] | undefined,
  totals: MaintenanceReport['totals']
): AggregateProjection | undefined {
  const projectedTotals = projectTotals(totals);
  if (projectedTotals === undefined || !Array.isArray(providers)) return undefined;

  const providerBytes = new Map<VisualProviderId, number>();
  const counts = { safe: 0, review: 0, protected: 0 };
  const plans = new Set<VisualPlanAction>();
  const providerBucketTotals = { safe: 0, review: 0, protected: 0 };
  let providerTotalBytes = 0;

  for (const provider of providers) {
    const projection = projectProvider(provider);
    if (projection === undefined) return undefined;

    const id = visualProviderId(provider.id);
    const combinedProviderBytes = safeAdd(providerBytes.get(id) ?? 0, projection.totalBytes);
    if (combinedProviderBytes === undefined) return undefined;
    providerBytes.set(id, combinedProviderBytes);

    providerTotalBytes = safeAdd(providerTotalBytes, projection.totalBytes) ?? -1;
    providerBucketTotals.safe = safeAdd(providerBucketTotals.safe, projection.safeBytes) ?? -1;
    providerBucketTotals.review = safeAdd(providerBucketTotals.review, projection.reviewBytes) ?? -1;
    providerBucketTotals.protected = safeAdd(providerBucketTotals.protected, projection.protectedBytes) ?? -1;
    counts.safe = safeAdd(counts.safe, projection.counts.safe) ?? -1;
    counts.review = safeAdd(counts.review, projection.counts.review) ?? -1;
    counts.protected = safeAdd(counts.protected, projection.counts.protected) ?? -1;
    if (
      providerTotalBytes < 0 ||
      providerBucketTotals.safe < 0 ||
      providerBucketTotals.review < 0 ||
      providerBucketTotals.protected < 0 ||
      counts.safe < 0 ||
      counts.review < 0 ||
      counts.protected < 0
    ) {
      return undefined;
    }
    for (const plan of projection.plans) plans.add(plan);
  }

  if (
    providerTotalBytes !== projectedTotals.trackedBytes ||
    providerBucketTotals.safe !== projectedTotals.safeBytes ||
    providerBucketTotals.review !== projectedTotals.reviewBytes ||
    providerBucketTotals.protected !== projectedTotals.protectedBytes
  ) {
    return undefined;
  }

  const providerOrder = new Map(PROVIDER_ORDER.map((id, index) => [id, index]));
  const visualProviders = [...providerBytes]
    .map(([id, bytes]) => ({ id, bytes }))
    .sort((left, right) =>
      right.bytes - left.bytes ||
      (providerOrder.get(left.id) ?? PROVIDER_ORDER.length) -
        (providerOrder.get(right.id) ?? PROVIDER_ORDER.length)
    );

  return {
    totals: projectedTotals,
    providers: visualProviders,
    counts,
    availablePlans: PLAN_ORDER.filter((plan) => plans.has(plan))
  };
}

function projectTotals(totals: MaintenanceReport['totals']): VisualReportModel['totals'] | undefined {
  if (!isRecord(totals)) return undefined;
  const trackedBytes = totals.totalBytes;
  const safeBytes = totals.safeReclaimableBytes;
  const reviewBytes = totals.confirmBytes;
  const protectedBytes = totals.privateBytes;
  if (![trackedBytes, safeBytes, reviewBytes, protectedBytes].every(isByteCount)) return undefined;
  const bucketTotal = safeSum([safeBytes, reviewBytes, protectedBytes]);
  if (bucketTotal === undefined || bucketTotal !== trackedBytes) return undefined;
  return { trackedBytes, safeBytes, reviewBytes, protectedBytes };
}

function projectProvider(provider: ProviderReport): {
  totalBytes: number;
  safeBytes: number;
  reviewBytes: number;
  protectedBytes: number;
  counts: VisualReportModel['counts'];
  plans: Set<VisualPlanAction>;
} | undefined {
  if (!isRecord(provider) || typeof provider.id !== 'string' || !Array.isArray(provider.entries)) {
    return undefined;
  }
  if (!isByteCount(provider.totalBytes) || !isRecord(provider.buckets)) return undefined;

  const safeBytes = provider.buckets.safeReclaimableBytes;
  const reviewBytes = provider.buckets.confirmBytes;
  const protectedBytes = provider.buckets.privateBytes;
  if (![safeBytes, reviewBytes, protectedBytes].every(isByteCount)) return undefined;
  if (safeSum([safeBytes, reviewBytes, protectedBytes]) !== provider.totalBytes) return undefined;

  const entryBytes = { safe: 0, review: 0, protected: 0 };
  const counts = { safe: 0, review: 0, protected: 0 };
  const plans = new Set<VisualPlanAction>();
  let totalBytes = 0;

  for (const entry of provider.entries) {
    if (!validEntry(entry)) return undefined;
    const bucket = visualBucket(entry.reclaimability);
    const nextBucketBytes = safeAdd(entryBytes[bucket], entry.bytes);
    const nextCount = safeAdd(counts[bucket], 1);
    const nextTotal = safeAdd(totalBytes, entry.bytes);
    if (nextBucketBytes === undefined || nextCount === undefined || nextTotal === undefined) {
      return undefined;
    }
    entryBytes[bucket] = nextBucketBytes;
    counts[bucket] = nextCount;
    totalBytes = nextTotal;
    addEligiblePlans(plans, provider.id, entry);
  }

  if (
    totalBytes !== provider.totalBytes ||
    entryBytes.safe !== safeBytes ||
    entryBytes.review !== reviewBytes ||
    entryBytes.protected !== protectedBytes
  ) {
    return undefined;
  }

  return { totalBytes, safeBytes, reviewBytes, protectedBytes, counts, plans };
}

function projectCoverage(findings: MaintenanceReport['findings']): VisualCoverage {
  if (!isRecord(findings) || !isRecord(findings.coverage)) return 'unavailable';
  const coverage = findings.coverage;
  if (coverage.trackedStateIsLowerBound === true) return 'lower-bound';
  if (
    Array.isArray(coverage.warnings) &&
    coverage.warnings.some((warning) => isRecord(warning) && warning.code === 'scan-truncated')
  ) {
    return 'lower-bound';
  }
  return coverage.complete === true ? 'complete' : 'unavailable';
}

function projectVolume(metrics: MaintenanceReport['metrics']): { valid: boolean; value: VisualVolume } {
  if (!isRecord(metrics) || !isRecord(metrics.volume)) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }
  const volume = metrics.volume;
  const totalBytes = volume.totalBytes;
  const usedBytes = volume.usedBytes;
  const availableBytes = volume.availableBytes;
  if (
    !isByteCount(totalBytes) ||
    !isByteCount(usedBytes) ||
    !isByteCount(availableBytes)
  ) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }
  const occupiedBytes = safeAdd(usedBytes, availableBytes);
  if (
    occupiedBytes === undefined ||
    usedBytes > totalBytes ||
    availableBytes > totalBytes ||
    occupiedBytes > totalBytes
  ) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }

  if (volume.capacityPercent === undefined) {
    return {
      valid: true,
      value: { totalBytes, usedBytes, availableBytes, diskLevel: 'unknown' }
    };
  }
  const capacityPercent = volume.capacityPercent;
  if (
    typeof capacityPercent !== 'number' ||
    !Number.isFinite(capacityPercent) ||
    capacityPercent < 0 ||
    capacityPercent > 100 ||
    occupiedBytes === 0 ||
    capacityPercent !== round1((usedBytes / occupiedBytes) * 100)
  ) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }
  return {
    valid: true,
    value: {
      totalBytes,
      usedBytes,
      availableBytes,
      capacityPercent,
      diskLevel: diskLevelForCapacityPercent(capacityPercent)
    }
  };
}

function addEligiblePlans(
  plans: Set<VisualPlanAction>,
  providerId: string,
  entry: StateEntry
): void {
  if (
    providerId === 'cursor' &&
    entry.reclaimability === 'safe' &&
    (entry.category === 'cache' || entry.category === 'log')
  ) {
    plans.add('cursor-clean');
  }
  if (
    providerId === 'codex' &&
    entry.reclaimability === 'confirm' &&
    (
      (entry.category === 'log' && entry.pathCategory === CODEX_LOG_DB) ||
      (entry.category === 'sidecar' &&
        (entry.pathCategory === `${CODEX_LOG_DB}-wal` || entry.pathCategory === `${CODEX_LOG_DB}-shm`))
    )
  ) {
    plans.add('codex-fix');
  }
  if (
    providerId === 'codex' &&
    entry.reclaimability === 'confirm' &&
    entry.category === 'cache' &&
    entry.pathCategory === CODEX_SPARKLE_ROOT
  ) {
    plans.add('codex-sparkle-clean');
  }
}

function validEntry(entry: StateEntry): boolean {
  return (
    isRecord(entry) &&
    isStateCategory(entry.category) &&
    typeof entry.pathCategory === 'string' &&
    isByteCount(entry.bytes) &&
    isReclaimability(entry.reclaimability)
  );
}

function visualProviderId(id: string): VisualProviderId {
  if (id === 'codex' || id === 'claude-code' || id === 'cursor') return id;
  return 'other';
}

function visualBucket(reclaimability: Reclaimability): keyof VisualReportModel['counts'] {
  if (reclaimability === 'safe') return 'safe';
  if (reclaimability === 'confirm') return 'review';
  return 'protected';
}

function visualReportStatus(status: ReportStatus): VisualReportModel['reportStatus'] {
  if (
    status === 'ok' ||
    status === 'partial' ||
    status === 'blocked' ||
    status === 'unsupported' ||
    status === 'error'
  ) {
    return status;
  }
  return 'error';
}

function degradeOk(status: VisualReportModel['reportStatus']): VisualReportModel['reportStatus'] {
  return status === 'ok' ? 'partial' : status;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString() === value ? value : undefined;
}

function emptyAggregateProjection(): AggregateProjection {
  return {
    totals: { trackedBytes: 0, safeBytes: 0, reviewBytes: 0, protectedBytes: 0 },
    providers: [],
    counts: { safe: 0, review: 0, protected: 0 },
    availablePlans: []
  };
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeAdd(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : undefined;
}

function safeSum(values: number[]): number | undefined {
  let sum = 0;
  for (const value of values) {
    const next = safeAdd(sum, value);
    if (next === undefined) return undefined;
    sum = next;
  }
  return sum;
}

function isStateCategory(value: unknown): value is StateCategory {
  return (
    value === 'session' ||
    value === 'log' ||
    value === 'cache' ||
    value === 'model' ||
    value === 'index' ||
    value === 'appdb' ||
    value === 'sidecar'
  );
}

function isReclaimability(value: unknown): value is Reclaimability {
  return value === 'safe' || value === 'confirm' || value === 'never';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
