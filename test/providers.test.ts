import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { claudeCodeProvider } from '../src/providers/claude-code.js';
import { codexProvider } from '../src/providers/codex.js';
import { cursorProvider } from '../src/providers/cursor.js';
import { getProvider, listProviders } from '../src/providers/registry.js';

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const fixturePath = path.join(root, relativePath);
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, contents);
}

describe('maintenance provider registry', () => {
  test('registers the v0.3.0 provider set', () => {
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
  }, 10_000);
});

describe('Codex provider read-only scan', () => {
  test('counts disjoint Codex state and the exact Sparkle cache once', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-state-'));
    try {
      await writeFixture(home, '.codex/sessions/current.jsonl', 'session');
      await writeFixture(home, '.codex/archived_sessions/old.jsonl', 'archive');
      await writeFixture(home, '.codex/maintenance-archive/item', 'old');
      await writeFixture(home, '.codex/generated_images/image.png', 'image');
      await writeFixture(home, '.codex/backups/state.bin', 'backup');
      await writeFixture(home, '.codex/logs_2.sqlite', 'logdb');
      await writeFixture(home, '.codex/logs_2.sqlite-wal', 'wal');
      await writeFixture(home, '.codex/logs_2.sqlite-shm', 'shm');
      await writeFixture(home, '.codex/config.toml', 'cfg');
      await writeFixture(home, '.codex/skills/tool.txt', 'skill');
      await writeFixture(
        home,
        'Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/PersistentDownloads/update.zip',
        'update'
      );

      const entries = await codexProvider.scan({ env: { HOME: home } });

      expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(53);
      expect(entries.filter((entry) => entry.reclaimability === 'never')
        .reduce((sum, entry) => sum + entry.bytes, 0)).toBe(36);
      expect(entries.filter((entry) => entry.reclaimability === 'confirm')
        .reduce((sum, entry) => sum + entry.bytes, 0)).toBe(17);
      expect(entries.filter((entry) => entry.reclaimability === 'safe')).toEqual([]);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ pathCategory: '<home>/.codex/sessions', bytes: 7, reclaimability: 'never' }),
        expect.objectContaining({ pathCategory: '<home>/.codex/other-state', bytes: 8, reclaimability: 'never' }),
        expect.objectContaining({ pathCategory: '<home>/.codex/logs_2.sqlite-wal', bytes: 3, category: 'sidecar' }),
        expect.objectContaining({
          pathCategory: '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle',
          bytes: 6,
          reclaimability: 'confirm',
          note: 'updater cache; manual review required; AIDM does not delete it'
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('detects the exact Sparkle cache and redacts custom Codex home categories', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-detection-'));
    const customRoot = path.join(home, 'custom-codex');
    try {
      await writeFixture(
        home,
        'Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/PersistentDownloads/update.zip',
        'update'
      );

      expect(await codexProvider.detect({ env: { HOME: home } })).toEqual({
        present: true,
        roots: [
          '<home>/.codex',
          '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle'
        ]
      });

      await writeFixture(customRoot, 'sessions/current.jsonl', 'session');
      const entries = await codexProvider.scan({ env: { HOME: home, CODEX_HOME: customRoot } });

      expect(await codexProvider.detect({ env: { HOME: home, CODEX_HOME: customRoot } }))
        .toEqual({
          present: true,
          roots: [
            'custom-codex-home',
            '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle'
          ]
        });
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathCategory: 'custom-codex-home/sessions',
          bytes: 7,
          reclaimability: 'never'
        }),
        expect.objectContaining({
          pathCategory: '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle',
          bytes: 6,
          reclaimability: 'confirm'
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('lets an equal custom Codex home own the Sparkle union once', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-equal-root-'));
    const sparkleRoot = path.join(
      home,
      'Library',
      'Caches',
      'com.openai.codex',
      'org.sparkle-project.Sparkle'
    );
    try {
      await writeFixture(sparkleRoot, 'sessions/current.jsonl', 'private');
      await writeFixture(sparkleRoot, 'PersistentDownloads/update.zip', 'cache');
      await writeFixture(sparkleRoot, 'settings.toml', 'other');

      const [detected, entries] = await Promise.all([
        codexProvider.detect({ env: { HOME: home, CODEX_HOME: sparkleRoot } }),
        codexProvider.scan({ env: { HOME: home, CODEX_HOME: sparkleRoot } })
      ]);

      expect(detected).toEqual({ present: true, roots: ['custom-codex-home'] });
      expect(entries.map((entry) => entry.pathCategory)).toEqual([
        'custom-codex-home/sessions',
        'custom-codex-home/other-state'
      ]);
      expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(17);
      expect(entries.every((entry) => entry.reclaimability === 'never')).toBe(true);
      expect(entries.filter((entry) => entry.reclaimability === 'safe')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('lets an ancestor custom Codex home own the Sparkle union once', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-ancestor-root-'));
    const customRoot = path.join(home, 'Library', 'Caches', 'com.openai.codex');
    try {
      await writeFixture(customRoot, 'sessions/current.jsonl', 'private');
      await writeFixture(
        customRoot,
        'org.sparkle-project.Sparkle/PersistentDownloads/update.zip',
        'cache'
      );
      await writeFixture(customRoot, 'outside-sparkle.bin', 'other');

      const [detected, entries] = await Promise.all([
        codexProvider.detect({ env: { HOME: home, CODEX_HOME: customRoot } }),
        codexProvider.scan({ env: { HOME: home, CODEX_HOME: customRoot } })
      ]);

      expect(detected).toEqual({ present: true, roots: ['custom-codex-home'] });
      expect(entries.map((entry) => entry.pathCategory)).toEqual([
        'custom-codex-home/sessions',
        'custom-codex-home/other-state'
      ]);
      expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(17);
      expect(entries.every((entry) => entry.reclaimability === 'never')).toBe(true);
      expect(entries.filter((entry) => entry.reclaimability === 'safe')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('lets an ancestor Sparkle root own the custom Codex union once', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-provider-codex-descendant-root-'));
    const sparkleRoot = path.join(
      home,
      'Library',
      'Caches',
      'com.openai.codex',
      'org.sparkle-project.Sparkle'
    );
    const customRoot = path.join(sparkleRoot, 'custom-codex');
    try {
      await writeFixture(sparkleRoot, 'PersistentDownloads/update.zip', 'cache');
      await writeFixture(customRoot, 'sessions/current.jsonl', 'private');
      await writeFixture(customRoot, 'settings.toml', 'other');

      const [detected, entries] = await Promise.all([
        codexProvider.detect({ env: { HOME: home, CODEX_HOME: customRoot } }),
        codexProvider.scan({ env: { HOME: home, CODEX_HOME: customRoot } })
      ]);

      expect(detected).toEqual({
        present: true,
        roots: ['<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle']
      });
      expect(entries).toEqual([
        expect.objectContaining({
          pathCategory: '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle',
          bytes: 17,
          category: 'cache',
          reclaimability: 'never'
        })
      ]);
      expect(entries.filter((entry) => entry.reclaimability === 'safe')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
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
