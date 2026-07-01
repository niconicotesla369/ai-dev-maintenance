import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { claudeCodeProvider } from '../src/providers/claude-code.js';
import { codexProvider } from '../src/providers/codex.js';
import { cursorProvider } from '../src/providers/cursor.js';
import { getProvider, listProviders } from '../src/providers/registry.js';

describe('maintenance provider registry', () => {
  test('registers the v0.2.6 provider set', () => {
    const providers = listProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['codex', 'claude-code', 'cursor']);
    expect(getProvider('codex')).toBe(codexProvider);
    expect(getProvider('claude-code')).toBe(claudeCodeProvider);
    expect(getProvider('cursor')).toBe(cursorProvider);
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

describe('Claude Code provider read-only scan', () => {
  test('classifies projects as never and debug logs as safe without reading contents', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-claude-home-'));
    try {
      await mkdir(path.join(home, '.claude', 'projects', 'workspace'), { recursive: true });
      await mkdir(path.join(home, '.claude', 'debug'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'projects', 'workspace', 'chat.jsonl'), 'private chat');
      await writeFile(path.join(home, '.claude', 'debug', 'debug.log'), 'debug log');

      const detected = await claudeCodeProvider.detect({ env: { HOME: home } });
      const entries = await claudeCodeProvider.scan({ env: { HOME: home } });

      expect(detected).toEqual({
        present: true,
        roots: ['<home>/.claude']
      });
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'session',
          pathCategory: '<home>/.claude/projects',
          bytes: 12,
          reclaimability: 'never',
          note: expect.stringContaining('private')
        }),
        expect.objectContaining({
          category: 'log',
          pathCategory: '<home>/.claude/debug',
          bytes: 9,
          reclaimability: 'safe'
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('Cursor provider read-only scan', () => {
  test('classifies state databases as never and caches as safe', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-cursor-home-'));
    const cursorRoot = path.join(home, 'Library', 'Application Support', 'Cursor');
    try {
      await mkdir(path.join(cursorRoot, 'User', 'globalStorage'), { recursive: true });
      await mkdir(path.join(cursorRoot, 'Cache'), { recursive: true });
      await mkdir(path.join(cursorRoot, 'CachedData'), { recursive: true });
      await mkdir(path.join(cursorRoot, 'User', 'workspaceStorage', 'workspace'), { recursive: true });
      await writeFile(path.join(cursorRoot, 'User', 'globalStorage', 'state.vscdb'), 'conversation history');
      await writeFile(path.join(cursorRoot, 'User', 'globalStorage', 'state.vscdb.backup'), 'conversation backup');
      await writeFile(path.join(cursorRoot, 'Cache', 'cache.bin'), 'cache');
      await writeFile(path.join(cursorRoot, 'CachedData', 'cached.bin'), 'cached');
      await writeFile(path.join(cursorRoot, 'User', 'workspaceStorage', 'workspace', 'state.json'), 'workspace');

      const detected = await cursorProvider.detect({ env: { HOME: home } });
      const entries = await cursorProvider.scan({ env: { HOME: home } });

      expect(detected).toEqual({
        present: true,
        roots: ['<home>/Library/Application Support/Cursor']
      });
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'appdb',
          pathCategory: '<home>/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
          bytes: 20,
          reclaimability: 'never',
          note: expect.stringContaining('private')
        }),
        expect.objectContaining({
          category: 'appdb',
          pathCategory: '<home>/Library/Application Support/Cursor/User/globalStorage/state.vscdb.backup',
          bytes: 19,
          reclaimability: 'never'
        }),
        expect.objectContaining({
          category: 'cache',
          pathCategory: '<home>/Library/Application Support/Cursor/Cache',
          bytes: 5,
          reclaimability: 'safe'
        }),
        expect.objectContaining({
          category: 'cache',
          pathCategory: '<home>/Library/Application Support/Cursor/CachedData',
          bytes: 6,
          reclaimability: 'safe'
        }),
        expect.objectContaining({
          category: 'session',
          pathCategory: '<home>/Library/Application Support/Cursor/User/workspaceStorage',
          bytes: 9,
          reclaimability: 'confirm'
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('provider source safety', () => {
  test('Claude Code and Cursor providers do not read file contents or invoke shell helpers', async () => {
    const sources = [
      await readFile(path.join(process.cwd(), 'src', 'providers', 'claude-code.ts'), 'utf8'),
      await readFile(path.join(process.cwd(), 'src', 'providers', 'cursor.ts'), 'utf8')
    ].join('\n');

    expect(sources).not.toMatch(/\breadFile\b/);
    expect(sources).not.toMatch(/\bcreateReadStream\b/);
    expect(sources).not.toMatch(/\brunCommand\b/);
    expect(sources).not.toMatch(/\bsqlite\b/i);
  });
});
