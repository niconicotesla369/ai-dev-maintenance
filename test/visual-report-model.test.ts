import { describe, expect, test } from 'vitest';
import { diskLevelForCapacityPercent } from '../src/pressure/levels.js';
import { buildVisualReportModel } from '../src/visual-report/model.js';
import {
  VISUAL_REPORT_COPY,
  type VisualReportCopyKey,
  type VisualReportLocale
} from '../src/visual-report/locales.js';
import type {
  MaintenanceReport,
  ProviderReport,
  Reclaimability,
  StateCategory,
  StateEntry
} from '../src/types.js';

const LEAK = ['', 'Users', 'alice', '<script>LEAK_SENTINEL</script>'].join('/');

describe('visual report model', () => {
  test('projects an aggregate report through an exact allowlist', () => {
    const model = buildVisualReportModel(aggregateReport());

    expect(model).toEqual({
      generatedAt: '2026-08-26T00:00:00.000Z',
      reportStatus: 'ok',
      coverage: 'complete',
      volume: {
        totalBytes: 100_000,
        usedBytes: 90_000,
        availableBytes: 10_000,
        capacityPercent: 90,
        diskLevel: 'high'
      },
      totals: {
        trackedBytes: 35_200,
        safeBytes: 7_700,
        reviewBytes: 13_600,
        protectedBytes: 13_900
      },
      providers: [
        { id: 'codex', bytes: 20_000 },
        { id: 'cursor', bytes: 10_000 },
        { id: 'claude-code', bytes: 4_000 },
        { id: 'other', bytes: 1_200 }
      ],
      counts: { safe: 2, review: 5, protected: 3 },
      availablePlans: ['cursor-clean', 'codex-fix', 'codex-sparkle-clean']
    });
    expect(model.totals.safeBytes + model.totals.reviewBytes).toBe(21_300);
    expect(model.totals.safeBytes + model.totals.reviewBytes).not.toBe(model.totals.trackedBytes);
    expect(JSON.stringify(model)).not.toMatch(/\/Users\/alice|<script>|LEAK_SENTINEL/);
  });

  test('collapses every unknown provider id into one fixed other row', () => {
    const report = aggregateReport();
    report.providers?.push(provider('another-private-provider', [
      entry('session', `${LEAK}/second`, 800, 'never')
    ]));
    report.totals = {
      totalBytes: 36_000,
      safeReclaimableBytes: 7_700,
      confirmBytes: 13_600,
      privateBytes: 14_700
    };

    const model = buildVisualReportModel(report);

    expect(model.providers).toContainEqual({ id: 'other', bytes: 2_000 });
    expect(model.providers.filter(({ id }) => id === 'other')).toHaveLength(1);
    expect(JSON.stringify(model)).not.toContain('another-private-provider');
  });

  test.each([
    [79.9, 'ok'],
    [80, 'medium'],
    [89.9, 'medium'],
    [90, 'high'],
    [undefined, 'unknown'],
    [Number.NaN, 'ok'],
    [Number.POSITIVE_INFINITY, 'high'],
    [-1, 'ok'],
    [101, 'high']
  ] as const)('classifies disk capacity %s as %s', (capacityPercent, expected) => {
    expect(diskLevelForCapacityPercent(capacityPercent)).toBe(expected);
  });

  test.each([
    '2026-08-26',
    '2026-08-26T00:00:00Z',
    '2026-02-30T00:00:00.000Z',
    LEAK,
    ''
  ])('omits non-canonical generatedAt value %s', (generatedAt) => {
    const report = aggregateReport();
    report.generatedAt = generatedAt;

    expect(buildVisualReportModel(report)).not.toHaveProperty('generatedAt');
  });

  test.each([
    ['negative', (report: MaintenanceReport) => { report.totals!.safeReclaimableBytes = -1; }],
    ['NaN', (report: MaintenanceReport) => { report.totals!.confirmBytes = Number.NaN; }],
    ['infinite', (report: MaintenanceReport) => { report.totals!.privateBytes = Number.POSITIVE_INFINITY; }],
    ['overflow', (report: MaintenanceReport) => { report.totals!.totalBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['bucket mismatch', (report: MaintenanceReport) => { report.totals!.totalBytes += 1; }],
    ['provider mismatch', (report: MaintenanceReport) => { report.providers![0]!.totalBytes += 1; }]
  ])('fails closed for %s aggregate bytes', (_label, mutate) => {
    const report = aggregateReport();
    mutate(report);

    const model = buildVisualReportModel(report);

    expect(model.reportStatus).toBe('partial');
    expect(model.coverage).toBe('unavailable');
    expect(model.totals).toEqual({
      trackedBytes: 0,
      safeBytes: 0,
      reviewBytes: 0,
      protectedBytes: 0
    });
    expect(model.providers).toEqual([]);
    expect(model.counts).toEqual({ safe: 0, review: 0, protected: 0 });
    expect(model.availablePlans).toEqual([]);
  });

  test.each([
    ['negative', (volume: Record<string, number>) => { volume.availableBytes = -1; }],
    ['NaN', (volume: Record<string, number>) => { volume.usedBytes = Number.NaN; }],
    ['infinite', (volume: Record<string, number>) => { volume.totalBytes = Number.POSITIVE_INFINITY; }],
    ['overflow', (volume: Record<string, number>) => { volume.totalBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['used beyond total', (volume: Record<string, number>) => { volume.usedBytes = 100_001; }],
    ['reserved-space overflow', (volume: Record<string, number>) => { volume.availableBytes = 20_000; }],
    ['capacity mismatch', (volume: Record<string, number>) => { volume.capacityPercent = 40; }]
  ])('omits rather than zero-fills %s volume metrics', (_label, mutate) => {
    const report = aggregateReport();
    const volume = report.metrics.volume as Record<string, number>;
    mutate(volume);

    const model = buildVisualReportModel(report);

    expect(model.reportStatus).toBe('partial');
    expect(model.volume).toEqual({ diskLevel: 'unknown' });
    expect(model.volume).not.toHaveProperty('totalBytes');
    expect(model.volume).not.toHaveProperty('usedBytes');
    expect(model.volume).not.toHaveProperty('availableBytes');
    expect(model.volume).not.toHaveProperty('capacityPercent');
  });

  test('accepts reserved volume space when used plus available stays below total', () => {
    const report = aggregateReport();
    report.metrics.volume = {
      totalBytes: 120_000,
      usedBytes: 90_000,
      availableBytes: 10_000,
      capacityPercent: 90
    };

    expect(buildVisualReportModel(report).volume).toEqual({
      totalBytes: 120_000,
      usedBytes: 90_000,
      availableBytes: 10_000,
      capacityPercent: 90,
      diskLevel: 'high'
    });
  });

  test.each([
    [{ complete: true, trackedStateIsLowerBound: false, warnings: [] }, 'complete'],
    [{ complete: false, trackedStateIsLowerBound: true, warnings: [] }, 'lower-bound'],
    [{ complete: false, trackedStateIsLowerBound: false, warnings: [{ code: 'scan-truncated', message: LEAK }] }, 'lower-bound'],
    [{ complete: false, trackedStateIsLowerBound: false, warnings: [{ code: LEAK, message: LEAK }] }, 'unavailable']
  ] as const)('maps coverage through fixed states', (coverage, expected) => {
    const report = aggregateReport();
    report.findings.coverage = coverage;

    const model = buildVisualReportModel(report);

    expect(model.coverage).toBe(expected);
    expect(JSON.stringify(model)).not.toContain(LEAK);
  });

  test('produces a limited unavailable model for schema-v1 without fabricating aggregate state', () => {
    const report: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.5.0',
      generatedAt: '2026-08-26T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: { kind: 'default-codex-log-db', pathCategory: LEAK },
      findings: { leaked: LEAK },
      metrics: {
        volume: {
          totalBytes: 100_000,
          usedBytes: 90_000,
          availableBytes: 10_000,
          capacityPercent: 90
        },
        leaked: LEAK
      },
      blockedReasons: [LEAK],
      nextSafeAction: LEAK,
      providers: aggregateReport().providers,
      totals: aggregateReport().totals
    };

    expect(buildVisualReportModel(report)).toEqual({
      generatedAt: '2026-08-26T00:00:00.000Z',
      reportStatus: 'partial',
      coverage: 'unavailable',
      volume: { diskLevel: 'unknown' },
      totals: { trackedBytes: 0, safeBytes: 0, reviewBytes: 0, protectedBytes: 0 },
      providers: [],
      counts: { safe: 0, review: 0, protected: 0 },
      availablePlans: []
    });
  });

  test('derives plans only from exact provider/category/path combinations', () => {
    const report = aggregateReport();
    report.providers = [provider('codex', [
      entry('log', `${LEAK}/logs_2.sqlite`, 1_000, 'confirm'),
      entry('cache', `${LEAK}/Sparkle`, 1_000, 'confirm')
    ])];
    report.totals = {
      totalBytes: 2_000,
      safeReclaimableBytes: 0,
      confirmBytes: 2_000,
      privateBytes: 0
    };

    const model = buildVisualReportModel(report);

    expect(model.availablePlans).toEqual([]);
    expect(JSON.stringify(model)).not.toContain(LEAK);
  });

  test('does not retain any arbitrary report string field', () => {
    const model = buildVisualReportModel({
      ...aggregateReport(),
      status: LEAK as MaintenanceReport['status'],
      generatedAt: LEAK,
      command: LEAK,
      target: { kind: 'aggregate-ai-tools', pathCategory: LEAK },
      findings: { coverage: { complete: false, warnings: [{ code: LEAK, message: LEAK }] } },
      metrics: { volume: LEAK },
      blockedReasons: [LEAK],
      nextSafeAction: LEAK
    });

    expect(model.reportStatus).toBe('error');
    expect(model.volume).toEqual({ diskLevel: 'unknown' });
    expect(JSON.stringify(model)).not.toContain(LEAK);
  });
});

describe('visual report locale dictionaries', () => {
  test('ships exact compile-time/runtime key parity with non-empty values', () => {
    const locales: VisualReportLocale[] = ['en', 'ja'];
    const englishKeys = Object.keys(VISUAL_REPORT_COPY.en).sort() as VisualReportCopyKey[];

    expect(Object.keys(VISUAL_REPORT_COPY.ja).sort()).toEqual(englishKeys);
    for (const locale of locales) {
      for (const key of englishKeys) {
        expect(VISUAL_REPORT_COPY[locale][key].trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  test('keeps placeholders and approved shared wayfinding exact', () => {
    for (const key of ['foundOpportunity', 'freeSpace'] as const) {
      expect(placeholders(VISUAL_REPORT_COPY.ja[key])).toEqual(placeholders(VISUAL_REPORT_COPY.en[key]));
    }
    for (const key of ['storageHealth', 'diskHigh', 'safe', 'review', 'protected'] as const) {
      expect(VISUAL_REPORT_COPY.ja[key]).toBe(VISUAL_REPORT_COPY.en[key]);
    }
    expect(VISUAL_REPORT_COPY.ja.localOnly).toContain('LOCAL ONLY');
    expect(VISUAL_REPORT_COPY.ja.noUpload).toContain('NO UPLOAD');
    expect(VISUAL_REPORT_COPY.ja.pathsRedacted).toContain('PATHS REDACTED');
    expect(VISUAL_REPORT_COPY.ja.noSourceChanges).toContain('NO SOURCE FILES CHANGED');
    expect(VISUAL_REPORT_COPY.ja.noHtmlSaved).toContain('NO HTML SAVED');
  });

  test('localizes Japanese primary controls and keeps fixed commands identical', () => {
    for (const key of [
      'readOnly',
      'lowStorage',
      'foundOpportunity',
      'noChangesYet',
      'reviewSafePlan',
      'copyCommand',
      'closeHint',
      'sessionEnded'
    ] as const) {
      expect(VISUAL_REPORT_COPY.ja[key], key).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
    expect(VISUAL_REPORT_COPY.ja.planCursorClean).toBe('aidm plan cursor-clean --json');
    expect(VISUAL_REPORT_COPY.ja.planCodexFix).toBe('aidm plan codex-fix --json');
    expect(VISUAL_REPORT_COPY.ja.planCodexSparkle).toBe('aidm plan codex-sparkle-clean --json');
    expect(VISUAL_REPORT_COPY.en.planCursorClean).toBe(VISUAL_REPORT_COPY.ja.planCursorClean);
    expect(VISUAL_REPORT_COPY.en.planCodexFix).toBe(VISUAL_REPORT_COPY.ja.planCodexFix);
    expect(VISUAL_REPORT_COPY.en.planCodexSparkle).toBe(VISUAL_REPORT_COPY.ja.planCodexSparkle);
  });
});

function aggregateReport(): MaintenanceReport {
  const providers = [
    provider('codex', [
      entry('log', '<home>/.codex/logs_2.sqlite', 5_000, 'confirm'),
      entry('sidecar', '<home>/.codex/logs_2.sqlite-wal', 1_000, 'confirm'),
      entry('cache', '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle', 4_000, 'confirm'),
      entry('session', `${LEAK}/sessions`, 10_000, 'never')
    ]),
    provider('cursor', [
      entry('cache', `${LEAK}/Cursor/Cache`, 7_000, 'safe'),
      entry('appdb', `${LEAK}/workspaceStorage`, 3_000, 'confirm')
    ]),
    provider('claude-code', [
      entry('log', `${LEAK}/debug`, 700, 'safe'),
      entry('cache', `${LEAK}/cache`, 600, 'confirm'),
      entry('session', `${LEAK}/projects`, 2_700, 'never')
    ]),
    provider('unknown-provider-LEAK_SENTINEL', [
      entry('session', `${LEAK}/unknown`, 1_200, 'never')
    ])
  ];
  return {
    schemaVersion: 2,
    toolVersion: LEAK,
    generatedAt: '2026-08-26T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: { kind: 'aggregate-ai-tools', pathCategory: LEAK },
    findings: {
      coverage: { complete: true, trackedStateIsLowerBound: false, warnings: [] },
      leaked: LEAK
    },
    metrics: {
      volume: {
        totalBytes: 100_000,
        usedBytes: 90_000,
        availableBytes: 10_000,
        capacityPercent: 90,
        leaked: LEAK
      }
    },
    blockedReasons: [LEAK],
    nextSafeAction: LEAK,
    providers,
    totals: {
      totalBytes: 35_200,
      safeReclaimableBytes: 7_700,
      confirmBytes: 13_600,
      privateBytes: 13_900
    }
  };
}

function provider(id: string, entries: StateEntry[]): ProviderReport {
  const buckets = {
    safeReclaimableBytes: sumEntries(entries, 'safe'),
    confirmBytes: sumEntries(entries, 'confirm'),
    privateBytes: sumEntries(entries, 'never')
  };
  return {
    id,
    displayName: LEAK,
    present: true,
    totalBytes: entries.reduce((sum, candidate) => sum + candidate.bytes, 0),
    buckets,
    entries,
    advisories: [{ severity: 'critical', code: LEAK, message: LEAK, nextAction: LEAK }]
  };
}

function entry(
  category: StateCategory,
  pathCategory: string,
  bytes: number,
  reclaimability: Reclaimability
): StateEntry {
  return {
    category,
    pathCategory,
    bytes,
    reclaimability,
    note: LEAK,
    warnings: [{ leaked: LEAK }]
  };
}

function sumEntries(entries: StateEntry[], reclaimability: Reclaimability): number {
  return entries
    .filter((candidate) => candidate.reclaimability === reclaimability)
    .reduce((sum, candidate) => sum + candidate.bytes, 0);
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{[a-z]+\}/g)].map(([match]) => match).sort();
}
