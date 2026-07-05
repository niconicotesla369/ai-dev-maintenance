import { describe, expect, test } from 'vitest';
import type {
  AggregateDoctorReport,
  CodexMaintenanceReport,
  MaintenanceReport,
  ReportEnvelope
} from '../src/types.js';
import { CODEX_REPORT_SCHEMA_VERSION } from '../src/version.js';

describe('maintenance report internal types', () => {
  test('separates Codex schema v1 and aggregate schema v2 report types', () => {
    const codex: CodexMaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.4.0-beta.1',
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
      toolVersion: '0.4.0-beta.1',
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
      toolVersion: '0.4.0-beta.1',
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
});
