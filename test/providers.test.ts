import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { codexProvider } from '../src/providers/codex.js';
import { getProvider, listProviders } from '../src/providers/registry.js';

describe('maintenance provider registry', () => {
  test('starts with only the Codex provider for v0.2.0 A2', () => {
    const providers = listProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['codex']);
    expect(getProvider('codex')).toBe(codexProvider);
    expect(getProvider('missing')).toBeUndefined();
  });
});

describe('Codex provider doctor adapter', () => {
  test('preserves the v1 Codex doctor report shape without persisting when requested', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-home-'));
    try {
      const result = await codexProvider.runDoctor({
        generatedAt: '2026-01-01T00:00:00.000Z',
        platform: 'darwin',
        env: { ...process.env, CODEX_HOME: codexHome },
        persistReport: false
      });

      expect(result.reportPath).toBeUndefined();
      expect(result.report).toMatchObject({
        schemaVersion: 1,
        command: 'doctor',
        status: expect.any(String),
        redacted: true,
        target: {
          kind: 'default-codex-log-db',
          pathCategory: 'custom-codex-home'
        },
        findings: {
          targetState: expect.any(Object),
          sqliteJson: expect.any(Object),
          openHandles: expect.any(Object),
          knownCodexProcessExists: expect.anything(),
          fixReadiness: {
            safe: expect.any(Boolean),
            reasons: expect.any(Array)
          },
          sqlite: {
            available: false,
            reason: 'source database inspection is skipped in v1 to avoid copying private log bytes'
          }
        },
        metrics: {},
        blockedReasons: expect.any(Array)
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
