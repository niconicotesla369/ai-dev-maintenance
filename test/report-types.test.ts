import { describe, expect, test } from 'vitest';
import type {
  AggregateDoctorReport,
  CodexMaintenanceReport,
  MaintenanceReport,
  ReportEnvelope
} from '../src/types.js';
import type { CodexSessionMonitorResult } from '../src/monitor/codex-sessions.js';
import type { CodexNativeCompressionStatus } from '../src/reclaim/codex-native.js';
import type { PublicCodexSessionImageScanResult } from '../src/reclaim/codex-session-images.js';
import { CODEX_REPORT_SCHEMA_VERSION } from '../src/version.js';

describe('maintenance report internal types', () => {
  test('separates Codex schema v1 and aggregate schema v2 report types', () => {
    const codex: CodexMaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.5.0',
      generatedAt: '2026-07-03T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: '<home>/.codex/logs_2.sqlite'
      },
      findings: {},
      metrics: {},
      blockedReasons: []
    };
    const aggregate: AggregateDoctorReport = {
      schemaVersion: 2,
      toolVersion: '0.5.0',
      generatedAt: '2026-07-03T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: {
        kind: 'aggregate-ai-tools',
        pathCategory: 'ai-tools'
      },
      findings: {},
      metrics: {},
      blockedReasons: [],
      providers: [],
      totals: {
        totalBytes: 0,
        safeReclaimableBytes: 0,
        confirmBytes: 0,
        privateBytes: 0
      }
    };

    const reports: MaintenanceReport[] = [codex, aggregate];

    expect(reports.map((report) => report.schemaVersion)).toEqual([1, 2]);
  });

  test('exposes a common report envelope for additive wire-compatible types', () => {
    const envelope: ReportEnvelope<2, 'aggregate-ai-tools'> = {
      schemaVersion: 2,
      toolVersion: '0.5.0',
      generatedAt: '2026-07-03T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: {
        kind: 'aggregate-ai-tools',
        pathCategory: 'ai-tools'
      },
      findings: {},
      metrics: {},
      blockedReasons: []
    };

    expect(envelope.target.kind).toBe('aggregate-ai-tools');
  });

  test('names the schema v1 constant as Codex-specific', () => {
    expect(CODEX_REPORT_SCHEMA_VERSION).toBe(1);
  });

  test('models standalone public result variants without private scan details', () => {
    const scan: PublicCodexSessionImageScanResult = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim scan codex-session-images',
      status: 'ok',
      contentRead: true,
      filters: { olderThanDays: 30, minFileSizeBytes: 52_428_800 },
      totals: {
        filesConsidered: 1,
        filesOpened: 1,
        filesSkippedBySize: 0,
        filesSkippedAfterRead: 0,
        filesBlocked: 0,
        sourceBytes: 52_428_800,
        projectedBytes: 1_024,
        reclaimableBytes: 52_427_776,
        occurrencesSeen: 1,
        imagesPrunable: 1,
        knownPlaceholders: 0,
        belowMinimum: 0,
        candidateFiles: 1
      },
      blockedReasons: [],
      warnings: []
    };
    const native: CodexNativeCompressionStatus = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim status codex-native-compression',
      status: 'partial',
      supported: false,
      configuredState: 'unknown',
      plainJsonlFiles: 0,
      compressedJsonlFiles: 0,
      warnings: ['native-feature-check-unavailable'],
      nextActions: ['Retry after verifying the bundled Codex executable.']
    };
    const monitor: CodexSessionMonitorResult = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'monitor codex-sessions',
      status: 'blocked',
      currentBytes: 0,
      thresholdBytes: 8_589_934_592,
      growthThresholdBytes: 5_368_709_120,
      alert: false,
      statePersisted: false,
      notificationAttempted: false,
      warnings: ['session-root-untrusted']
    };

    expect([scan.status, native.status, monitor.status]).toEqual(['ok', 'partial', 'blocked']);
  });
});
