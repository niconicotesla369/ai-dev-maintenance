import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { fixSafeConfirmationError, isDirectCliInvocation, renderReport, runCli } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';
import { TOOL_VERSION } from '../src/version.js';

describe('release readiness', () => {
  test('package version and runtime version stay synchronized', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));

    expect(pkg.version).toBe(TOOL_VERSION);
  });

  test('package prepack forces verification and build before publishing', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));

    expect(pkg.packageManager).toMatch(/^pnpm@10\./);
    expect(pkg.scripts.prepack).toContain('pnpm run verify');
    expect(pkg.scripts.prepack).toContain('pnpm run build');
    expect(pkg.scripts.prepack).toContain('pnpm run hygiene:package');
    expect(pkg.scripts.prepack.indexOf('pnpm run build')).toBeLessThan(
      pkg.scripts.prepack.indexOf('pnpm run hygiene:package')
    );
    expect(pkg.scripts.prepublishOnly).toContain('pnpm run release:check');
  });

  test('release check validates the packed artifact and install-time lifecycle posture', async () => {
    const releaseCheck = await readFile('scripts/release-check.mjs', 'utf8');
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.bin?.['ai-dev-maintenance']).toBe('dist/cli.js');
    expect(pkg.bin?.aidm).toBe('dist/cli.js');
    expect(releaseCheck).toContain('npm pack --json');
    expect(releaseCheck).toContain('assertNoInstallLifecycleScripts');
    expect(releaseCheck).toContain('assertVersionSync');
    expect(releaseCheck).toContain('assertDistSafetyMarkers');
    expect(releaseCheck).toContain('assertMcpStreamingSmoke');
    expect(releaseCheck).toContain('ai-dev-maintenance');
    expect(releaseCheck).toContain('bin.aidm must point to dist/cli.js');
    expect(releaseCheck).toContain('listSourceFiles');
    expect(releaseCheck).toContain('node:net');
    expect(releaseCheck).toContain('node:dns');
    expect(workflow).toContain('corepack pnpm run release:check:prepublic');
    expect(workflow).toContain('--ignore-scripts');
    expect(workflow).toContain('npm install --ignore-scripts');
  });

  test('ci bootstraps pnpm with corepack instead of setup-node pnpm cache', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).not.toContain('cache: pnpm');
    expect(workflow).toContain('corepack enable');
    expect(workflow.indexOf('corepack enable')).toBeLessThan(
      workflow.indexOf('corepack pnpm install --frozen-lockfile --ignore-scripts')
    );
  });

  test('ci tests supported LTS and current Node versions', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('node-version: [20, 22, 24]');
  });

  test('release workflow publishes from version tags with npm provenance', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('tags:');
    expect(workflow).toContain('v*');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('node-version: 24');
    expect(workflow).not.toContain('registry-url:');
    expect(workflow).toContain('npm publish --provenance');
    expect(workflow).toContain('PKG_VERSION=$(node -p');
    expect(workflow).toContain('tag $VERSION != package.json $PKG_VERSION');
    expect(workflow).toContain('corepack pnpm run verify');
    expect(workflow).toContain('corepack pnpm run release:check');
  });

  test('release check guards the release workflow contract', async () => {
    const releaseCheck = await readFile('scripts/release-check.mjs', 'utf8');

    expect(releaseCheck).toContain('assertReleaseWorkflow');
    expect(releaseCheck).toContain('npm publish --provenance');
    expect(releaseCheck).toContain('id-token: write');
    expect(releaseCheck).toContain('PKG_VERSION=$(node -p');
    expect(releaseCheck).toContain('tag $VERSION != package.json $PKG_VERSION');
  });

  test('ci tarball smoke reads pack json from a file instead of a fragile pipe', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('PACK_JSON="$(mktemp)"');
    expect(workflow).toContain('npm pack --json --ignore-scripts > "$PACK_JSON"');
    expect(workflow).toContain("readFileSync(process.env.PACK_JSON");
    expect(workflow).not.toContain('corepack pnpm pack --json | node -e');
    expect(workflow).not.toContain('corepack pnpm pack --json > "$PACK_JSON"');
  });

  test('prepublish runs the full fresh verification and packaging gate', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));

    expect(pkg.scripts.prepack).toContain('corepack pnpm run verify');
    expect(pkg.scripts.prepublishOnly).toContain('corepack pnpm run verify');
    expect(pkg.scripts.prepublishOnly).toContain('pnpm run verify');
    expect(pkg.scripts.prepublishOnly).toContain('pnpm run build');
    expect(pkg.scripts.prepublishOnly).toContain('pnpm run hygiene:package');
    expect(pkg.scripts.prepublishOnly).toContain('pnpm run release:check');
    expect(pkg.scripts.prepublishOnly).not.toContain('release:check:prepublic');
  });

  test('report command rejects removed unredacted flag', async () => {
    const result = await runCli(['report', '--latest', '--unredacted']);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('--unredacted is not supported');
  });

  test('fix safe requires explicit confirmation before mutation path can run', () => {
    expect(fixSafeConfirmationError(['--safe'])).toContain('--yes');
    expect(fixSafeConfirmationError(['--safe', '--yes'])).toBeUndefined();
  });

  test('human report output explains the decision and saved report review command', () => {
    const report: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.3.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: '<home>/.codex/logs_2.sqlite'
      },
      findings: {
        openHandles: {
          usable: true,
          openHandles: false
        },
        knownCodexProcessExists: false
      },
      metrics: {},
      blockedReasons: []
    };

    const output = renderReport(report, '/tmp/example/report.json');

    expect(output).toContain('Fix readiness   ready');
    expect(output).toContain('Changed         redacted report only');
    expect(output).toContain('Report          <absolute-path>');
    expect(output).toContain('Review          npm exec --ignore-scripts ai-dev-maintenance@0.4.1 -- report --latest');
  });

  test('report latest uses the same human safety summary by default', async () => {
    const source = await readFile('src/cli-router.ts', 'utf8');

    expect(source).toContain('renderReport(latest.report');
  });

  test('report latest show-paths prints the local report path only in the human path line', async () => {
    const latestPath = '/tmp/aidm-report.json';
    const result = await runCli(['report', '--latest', '--show-paths'], {
      commands: {
        latestReport: async () => ({
          path: latestPath,
          report: {
            schemaVersion: 1,
            toolVersion: '0.3.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            command: 'doctor',
            status: 'ok',
            redacted: true,
            target: {
              kind: 'default-codex-log-db',
              pathCategory: '<home>/.codex/logs_2.sqlite'
            },
            findings: {
              openHandles: {
                usable: true,
                openHandles: false
              }
            },
            metrics: {},
            blockedReasons: []
          }
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`Report: ${latestPath}`);
    expect(result.output).toContain('"pathCategory": "<home>/.codex/logs_2.sqlite"');
    expect(result.output).not.toContain('"path": "/tmp/aidm-report.json"');
  });

  test('blocked fix after checkpoint attempt does not claim nothing changed', async () => {
    const report: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.3.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      command: 'fix --safe',
      status: 'blocked',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: '<home>/.codex/logs_2.sqlite'
      },
      findings: {},
      metrics: {
        backupCreated: true,
        checkpointAttempted: true
      },
      blockedReasons: ['WAL was not truncated']
    };

    const output = renderReport(report);

    expect(output).toContain('Changed         private backup created + checkpoint attempted; review report');
    expect(output).not.toContain('nothing; fix was blocked');
  });

  test('readme warns that fix creates a private local backup and uses yes flag', async () => {
    const readme = await readFile('README.md', 'utf8');

    expect(readme).toContain('may contain Codex log data');
    expect(readme).toContain('fix --safe --yes');
    expect(readme).toContain('Emergency / Advanced Only');
    expect(readme).toContain('1. Diagnose only');
    expect(readme).toContain('3. Only if the output says it is safe');
    expect(readme).toContain('npm install -g ai-dev-maintenance@0.4.1');
    expect(readme).toContain('ai-dev-maintenance --version | -v | version');
    expect(readme).toContain('cursor clean --safe --yes');
    expect(readme).toContain('aidm');
  });

  test('readmes document CLI exit codes', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('Exit Codes');
    expect(readmes).toContain('0');
    expect(readmes).toContain('1');
    expect(readmes).toContain('2');
    expect(readmes).toContain('3');
    expect(readmes).toContain('usage');
    expect(readmes).toContain('blocked');
    expect(readmes).toContain('unexpected runtime error');
    expect(readmes).toContain('trust');
    expect(readmes).toContain('untrusted');
  });

  test('package publishes the changelog with the npm artifact', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(pkg.files).toContain('CHANGELOG.md');
    expect(changelog).toContain('# Changelog');
    expect(changelog).toContain('## Unreleased');
    expect(changelog).toContain('## 0.4.1 - 2026-07-06');
    expect(changelog).toContain('## 0.4.0 - 2026-07-06');
    expect(changelog).toContain('## 0.3.1 - 2026-07-03');
    expect(changelog).toContain('## 0.3.0 - 2026-07-02');
    for (const version of [
      '0.1.0',
      '0.1.1',
      '0.1.2',
      '0.1.3',
      '0.1.4',
      '0.1.5',
      '0.2.0',
      '0.2.2',
      '0.2.3',
      '0.2.4',
      '0.2.5',
      '0.2.6',
      '0.4.1',
      '0.4.0',
      '0.3.2',
      '0.3.1',
      '0.3.0'
    ]) {
      expect(changelog).toContain(`## ${version}`);
    }
  });

  test('changelog documents the pressure schema v2 change in the 0.3.0 release notes', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(changelog).toContain('pressure schemaVersion 2');
    expect(changelog).toContain('separates AI totals from non-AI process pressure');
    expect(changelog).toContain('aiCpuPercent no longer includes non-AI processes');
  });

  test('changelog documents the v0.3.1 defensible sharing changes', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(changelog).toContain('Normalize pressure CPU severity by logical CPU capacity');
    expect(changelog).toContain('aiCpuCapacityPercent');
    expect(changelog).toContain('Exclude AIDM');
    expect(changelog).toContain('doctor --share');
  });

  test('changelog documents the v0.3.2 pressure share card', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(changelog).toContain('pressure --share');
    expect(changelog).toContain('process-free pressure card');
    expect(changelog).toContain('pressure JSON schema');
  });

  test('changelog documents the v0.4.0 delegation release', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(changelog).toContain('0.4.0');
    expect(changelog).toContain('MCP');
    expect(changelog).toContain('plan');
    expect(changelog).toContain('apply');
    expect(changelog).toContain('trust');
    expect(changelog).toContain('npm provenance');
  });

  test('changelog documents the v0.4.1 pressure privacy polish', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(changelog).toContain('0.4.1');
    expect(changelog).toContain('commandSummary');
    expect(changelog).toContain('executable basenames');
    expect(changelog).toContain('whole-disk usage');
    expect(changelog).toContain('safe action gates unchanged');
  });

  test('pressure examples stay on schema v2 with separated AI and non-AI totals', async () => {
    const example = JSON.parse(await readFile('examples/pressure.json', 'utf8'));
    const text = await readFile('examples/pressure.txt', 'utf8');

    expect(example.schemaVersion).toBe(2);
    expect(example.totals).toEqual(expect.objectContaining({
      aiCpuPercent: expect.any(Number),
      aiCpuCapacityPercent: expect.any(Number),
      aiRssBytes: expect.any(Number),
      aiProcessCount: expect.any(Number),
      otherCpuPercent: expect.any(Number),
      otherCpuCapacityPercent: expect.any(Number),
      otherRssBytes: expect.any(Number),
      otherProcessCount: expect.any(Number),
      processCount: expect.any(Number),
      logicalCpuCount: expect.any(Number)
    }));
    expect(text).toContain('Other CPU');
    expect(text).toContain('% cap');
    expect(text).toContain('Other RSS');
  });

  test('share card example stays path-free and public-safe', async () => {
    const example = await readFile('examples/share-card.txt', 'utf8');

    expect(example).toContain('AIDM SHARE CARD');
    expect(example).toContain('npx --yes ai-dev-maintenance@0.4.1');
    expect(example).toContain('Private danger buckets are never auto-touched.');
    expect(example).not.toContain('/Users');
    expect(example).not.toContain('<home>');
    expect(example).not.toContain('pid');
    expect(example).not.toContain('/');
  });

  test('pressure share card example stays path-free and public-safe', async () => {
    const example = await readFile('examples/pressure-share-card.txt', 'utf8');

    expect(example).toContain('AIDM PRESSURE CARD');
    expect(example).toContain('npx --yes ai-dev-maintenance@0.4.1 pressure');
    expect(example).toContain('AI CPU');
    expect(example).toContain('Other CPU');
    expect(example).toContain('Signals');
    expect(example).toContain('Next actions');
    expect(example).not.toContain('/Users');
    expect(example).not.toContain('<home>');
    expect(example).not.toContain('pid');
    expect(example).not.toContain('/');
  });

  test('history example stays on the read-only report history contract', async () => {
    const example = await readFile('examples/history.txt', 'utf8');

    expect(example).toContain('AIDM HISTORY');
    expect(example).toContain('Data points');
    expect(example).toContain('Tracked state');
    expect(example).toContain('Run doctor again in a few days');
    expect(example).not.toContain('/Users');
  });

  test('public state examples document tracked state and safe Codex review boundaries', async () => {
    const [doctorExample, shareExample, historyExample] = await Promise.all([
      readFile('examples/doctor-aggregate.txt', 'utf8'),
      readFile('examples/share-card.txt', 'utf8'),
      readFile('examples/history.txt', 'utf8')
    ]);

    expect(doctorExample).toContain('Tracked state');
    expect(doctorExample).toContain('Volume used');
    expect(doctorExample).toContain('Tracked share');
    expect(doctorExample).toContain('sessions');
    expect(doctorExample).toContain('maintenance-archive');
    expect(doctorExample).toContain('Sparkle');
    expect(doctorExample).not.toContain('Total state');
    expect(shareExample).toContain('Tracked state');
    expect(historyExample).toContain('Tracked state');
    expect(doctorExample).toContain(
      'Tracked AI-tool state is under 5% of used volume; inspect other System Data sources before attributing disk pressure to these providers.'
    );

    for (const expectedRow of [
      'sessions        64.0 MiB never',
      'archived_sessions 8.0 MiB never',
      'maintenance-archive 32.0 MiB never',
      'generated_images 16.0 MiB never',
      'backups         8.0 MiB never',
      'other-state     4.0 MiB never',
      'logs_2.sqlite   7.0 MiB review',
      'logs_2.sqlite-wal 2.0 MiB review',
      'logs_2.sqlite-shm 32.0 KiB review',
      'Sparkle         64.0 MiB review'
    ]) {
      expect(doctorExample).toContain(expectedRow);
    }
  });

  test('readmes and unreleased notes document tracked-state scope and compatibility', async () => {
    const [readme, japaneseReadme, changelog] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8'),
      readFile('CHANGELOG.md', 'utf8')
    ]);
    const unreleased = changelog.split('## 0.4.1', 1)[0];
    const sparklePath = '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle';

    expect(readme).toContain('Tracked state');
    expect(readme).toContain('tracked state');
    expect(readme).toContain('lower bound');
    expect(readme).toContain(sparklePath);
    expect(readme).toContain('review-first');
    expect(readme).toContain('statfs');
    expect(readme).toContain('known disjoint buckets');
    expect(readme).toContain('private `other-state`');
    expect(readme).toContain('all regular files under `CODEX_HOME`');
    expect(readme).toContain('not all macOS System Data');
    expect(readme).toContain('never auto-deleted');
    expect(readme).toContain('Generic updater globs are not scanned or cleaned');
    expect(readme).toContain('diagnostic, not causal');
    expect(readme).toContain('schema v2');
    expect(readme).toContain('`totals.totalBytes`');

    expect(japaneseReadme).toContain('追跡対象の状態');
    expect(japaneseReadme).toContain('下限値');
    expect(japaneseReadme).toContain(sparklePath);
    expect(japaneseReadme).toContain('確認が必要');
    expect(japaneseReadme).toContain('statfs');
    expect(japaneseReadme).toContain('既知の重複しないバケット');
    expect(japaneseReadme).toContain('privateな `other-state`');
    expect(japaneseReadme).toContain('`CODEX_HOME` 配下のすべての通常ファイル');
    expect(japaneseReadme).toContain('macOSの「System Data」全体ではありません');
    expect(japaneseReadme).toContain('自動削除しません');
    expect(japaneseReadme).toContain('汎用のupdater globはscanもcleanupもしません');
    expect(japaneseReadme).toContain('診断用であり、因果関係を示すものではありません');
    expect(japaneseReadme).toContain('schema v2');
    expect(japaneseReadme).toContain('`totals.totalBytes`');

    expect(unreleased).toContain('Codex sessions, archives, generated images, backups, sidecars, and unknown root state');
    expect(unreleased).toContain('without double counting');
    expect(unreleased).toContain('OpenAI Codex Sparkle cache');
    expect(unreleased).toContain('review-first');
    expect(unreleased).toContain('remains untouched');
    expect(unreleased).toContain('lower-bound warnings');
    expect(unreleased).toContain('schema v2');
    expect(unreleased).toContain('cleanup engines/action gates are unchanged');
    expect(unreleased).toContain('Change human-facing wording from `Total state` to `Tracked state`.');
  });

  test('aggregate sample report preserves complete coverage and bucket arithmetic', async () => {
    type SampleEntry = {
      pathCategory: string;
      bytes: number;
      reclaimability: 'safe' | 'confirm' | 'never';
    };
    type SampleBuckets = {
      safeReclaimableBytes: number;
      confirmBytes: number;
      privateBytes: number;
    };
    type SampleProvider = {
      id: string;
      totalBytes: number;
      buckets: SampleBuckets;
      entries: SampleEntry[];
    };
    type AggregateSample = {
      schemaVersion: number;
      metrics: { volume: Record<string, number> };
      findings: { coverage: Record<string, unknown> };
      providers: SampleProvider[];
      totals: { totalBytes: number } & SampleBuckets;
    };
    const sample: AggregateSample = JSON.parse(await readFile('examples/sample-report.json', 'utf8'));
    const codex = sample.providers.find((provider) => provider.id === 'codex');
    if (!codex) throw new Error('Codex provider sample is missing');
    const expectedCodexEntries = [
      { pathCategory: '<home>/.codex/sessions', bytes: 67108864, reclaimability: 'never' },
      { pathCategory: '<home>/.codex/archived_sessions', bytes: 8388608, reclaimability: 'never' },
      { pathCategory: '<home>/.codex/maintenance-archive', bytes: 33554432, reclaimability: 'never' },
      { pathCategory: '<home>/.codex/generated_images', bytes: 16777216, reclaimability: 'never' },
      { pathCategory: '<home>/.codex/backups', bytes: 8388608, reclaimability: 'never' },
      { pathCategory: '<home>/.codex/logs_2.sqlite', bytes: 7340032, reclaimability: 'confirm' },
      { pathCategory: '<home>/.codex/logs_2.sqlite-wal', bytes: 2097152, reclaimability: 'confirm' },
      { pathCategory: '<home>/.codex/logs_2.sqlite-shm', bytes: 32768, reclaimability: 'confirm' },
      { pathCategory: '<home>/.codex/other-state', bytes: 4194304, reclaimability: 'never' },
      {
        pathCategory: '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle',
        bytes: 67108864,
        reclaimability: 'confirm'
      }
    ] as const;
    const expectedProviders = [
      {
        id: 'codex',
        totalBytes: 214990848,
        buckets: { safeReclaimableBytes: 0, confirmBytes: 76578816, privateBytes: 138412032 }
      },
      {
        id: 'claude-code',
        totalBytes: 20971520,
        buckets: { safeReclaimableBytes: 1048576, confirmBytes: 0, privateBytes: 19922944 }
      },
      {
        id: 'cursor',
        totalBytes: 52428800,
        buckets: { safeReclaimableBytes: 4194304, confirmBytes: 8388608, privateBytes: 39845888 }
      }
    ] as const;
    const bucketFields = [
      { reclaimability: 'safe', totalKey: 'safeReclaimableBytes' },
      { reclaimability: 'confirm', totalKey: 'confirmBytes' },
      { reclaimability: 'never', totalKey: 'privateBytes' }
    ] as const;

    expect(sample.schemaVersion).toBe(2);
    expect(sample.metrics.volume).toEqual(expect.objectContaining({
      usedBytes: expect.any(Number),
      capacityPercent: expect.any(Number),
      trackedStatePercentOfUsedBytes: expect.any(Number)
    }));
    expect(sample.findings.coverage).toEqual(expect.objectContaining({
      complete: expect.any(Boolean),
      trackedStateIsLowerBound: expect.any(Boolean),
      warnings: expect.any(Array)
    }));
    expect(codex.entries).toHaveLength(expectedCodexEntries.length);
    expect(codex.entries).toEqual(expect.arrayContaining(
      expectedCodexEntries.map((entry) => expect.objectContaining(entry))
    ));
    expect(sample.metrics.volume).toEqual({
      totalBytes: 274877906944,
      usedBytes: 193273528320,
      availableBytes: 81604378624,
      capacityPercent: 70.3,
      trackedStatePercentOfUsedBytes: 0.1
    });
    expect(sample.findings.coverage).toEqual({
      complete: true,
      trackedStateIsLowerBound: false,
      warnings: []
    });
    expect(sample.providers).toHaveLength(expectedProviders.length);
    for (const expectedProvider of expectedProviders) {
      expect(sample.providers.find((provider) => provider.id === expectedProvider.id))
        .toEqual(expect.objectContaining(expectedProvider));
    }
    expect(sample.totals).toEqual({
      totalBytes: 288391168,
      safeReclaimableBytes: 5242880,
      confirmBytes: 84967424,
      privateBytes: 198180864
    });

    for (const provider of sample.providers) {
      expect(provider.totalBytes).toBe(provider.entries.reduce(
        (sum, entry) => sum + entry.bytes,
        0
      ));
      for (const { reclaimability, totalKey } of bucketFields) {
        expect(provider.buckets[totalKey]).toBe(provider.entries
          .filter((entry) => entry.reclaimability === reclaimability)
          .reduce((sum, entry) => sum + entry.bytes, 0));
      }
    }
    expect(sample.totals.totalBytes).toBe(sample.providers.reduce(
      (sum, provider) => sum + provider.totalBytes,
      0
    ));
    for (const { totalKey } of bucketFields) {
      expect(sample.totals[totalKey]).toBe(sample.providers.reduce(
        (sum, provider) => sum + provider.buckets[totalKey],
        0
      ));
    }
  });

  test('readmes document pressure measurement sources and schema v2 semantics', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('memory_pressure -Q');
    expect(readmes).toContain('100% = one logical CPU core');
    expect(readmes).toContain('100% = 1つの論理CPUコア');
    expect(readmes).toContain('capacity-normalized CPU percentages');
    expect(readmes).toContain('capacity正規化済みCPU%');
    expect(readmes).toContain('schemaVersion 2');
    expect(readmes).toContain('aiCpuPercent no longer includes non-AI processes');
    expect(readmes).toContain('aiCpuPercent は非AIプロセスを含みません');
    expect(readmes).toContain('doctor --share');
    expect(readmes).toContain('pressure --share');
  });

  test('public release notes do not carry stale current-series wording or duplicate migration notes', async () => {
    const readme = await readFile('README.md', 'utf8');
    const changelog = await readFile('CHANGELOG.md', 'utf8');

    expect(readme).toContain('v0.4.x currently supports macOS only');
    expect(readme).not.toContain('v0.2.x currently supports macOS only');
    expect(countOccurrences(readme, 'aiCpuPercent no longer includes non-AI processes')).toBe(1);
    expect(countOccurrences(changelog, 'aiCpuPercent no longer includes non-AI processes')).toBe(1);
  });

  test('pressure CPU thresholds are shared between diagnosis and rendering', async () => {
    const doctor = await readFile('src/pressure/doctor.ts', 'utf8');
    const render = await readFile('src/pressure/render.ts', 'utf8');

    expect(doctor).toContain("from './levels.js'");
    expect(render).toContain("from './levels.js'");
    expect(render).not.toContain('cpuPercent >= 80');
    expect(render).not.toContain('cpuPercent >= 30');
  });

  test('provider notes derive release wording from TOOL_VERSION', async () => {
    const sources = [
      await readFile('src/providers/codex.ts', 'utf8'),
      await readFile('src/providers/claude-code.ts', 'utf8')
    ].join('\n');

    expect(sources).toContain('TOOL_VERSION');
    expect(sources).not.toContain('v0.3.0 does not stop writes');
    expect(sources).not.toContain('not implemented in v0.3.0');
  });

  test('readmes document live pressure doctor without process mutation', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('pressure');
    expect(readmes).toContain('CPU/RAM');
    expect(readmes).toContain('process metadata');
    expect(readmes).toContain('overall pressure level');
    expect(readmes).toContain('Codex Renderer');
    expect(readmes).toContain('node/vitest');
    expect(readmes).toContain('command summaries are limited to executable basenames');
    expect(readmes).toContain('command summaryは実行ファイル名だけに制限');
    expect(readmes).toContain('terminal-native pretty output');
    expect(readmes).toContain('NO_COLOR=1');
    expect(readmes).toContain('pressure [--json] [--share] [--no-banner] [--plain]');
    expect(readmes).toContain('does not kill');
    expect(readmes).toContain('processのkill');
    expect(readmes).not.toContain('pressure --kill');
  });

  test('readmes document the experimental read-only MCP surface', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('ai-dev-maintenance history [--json] [--plain]');
    expect(readmes).toContain('ai-dev-maintenance trust [--json]');
    expect(readmes).toContain('ai-dev-maintenance plan codex-fix|cursor-clean [--json]');
    expect(readmes).toContain('ai-dev-maintenance apply --plan <planId> --yes [--json]');
    expect(readmes).toContain('ai-dev-maintenance mcp serve');
    expect(readmes).toContain('aidm mcp serve');
    expect(readmes).toContain('allowlist');
    expect(readmes).toContain('信頼状態');
    expect(readmes).toContain('MCP');
    expect(readmes).toContain('stdio-only');
    expect(readmes).toContain('aidm_doctor');
    expect(readmes).toContain('aidm_pressure');
    expect(readmes).toContain('aidm_report_latest');
    expect(readmes).toContain('aidm_history');
    expect(readmes).toContain('aidm_plan');
    expect(readmes).toContain('aidm_apply');
    expect(readmes).toContain('does not expose');
    expect(readmes).toContain('公開しません');
    expect(readmes).toContain('No network, socket, or HTTP server');
    expect(readmes).toContain('ネットワーク、socket、HTTP server');
    expect(readmes).toContain('claude mcp add aidm -- aidm mcp serve');
    expect(readmes).toContain('MCP requests are handled serially');
    expect(readmes).toContain('MCP requestは直列処理');
    expect(readmes).toContain('MCP doctor requests do not write reports and do not appear in history');
    expect(readmes).toContain('MCP doctor requestはreportを書き込まず、historyにも残りません');
    expect(readmes).toContain('approval means a human runs `aidm apply --plan <planId> --yes`');
    expect(readmes).toContain('承認とは、人間が `aidm apply --plan <planId> --yes` を実行すること');
  });

  test('readmes document release workflow provenance posture', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('npm provenance');
    expect(readmes).toContain('Trusted Publishers');
    expect(readmes).toContain('dist-tag `next`');
    expect(readmes).toContain('dist-tag `latest`');
  });

  test('public readmes do not publish raw wildcard deletion cleanup commands', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    const rawWildcardDelete = [
      'rm',
      ' -f ',
      '"$HOME/.ai-dev-maintenance/reports"/report-',
      '*.json'
    ].join('');
    expect(readmes).not.toContain(rawWildcardDelete);
    expect(readmes).not.toContain('report-*.json');
  });

  test('report directory setup avoids path-based chmod after safety validation', async () => {
    const reportsSource = await readFile('src/reports.ts', 'utf8');

    expect(reportsSource).not.toContain(['chmod', '(dir'].join(''));
    expect(reportsSource).not.toContain("import { chmod");
  });

  test('restore validation does not emit manual move or copy instructions', async () => {
    const source = await readFile('src/restore.ts', 'utf8');

    expect(source).toContain('backup is outside the tool backup directory');
    expect(source).not.toContain('Move the current');
    expect(source).not.toContain('Copy the validated');
  });

  test('non-mutating commands reject unknown flags', async () => {
    expect((await runCli(['doctor', '--wat'])).output).toContain('Unknown doctor flag');
    expect((await runCli(['report', '--latest', '--wat'])).output).toContain('Unknown report flag');
  });

  test('no-command guided mode rejects unknown flags before running doctor', async () => {
    let doctorCalls = 0;
    const result = await runCli(['--wat'], {
      env: {},
      io: {
        input: '',
        isInputTty: true,
        isOutputTty: true,
        columns: 80
      },
      commands: {
        runDoctor: async () => {
          doctorCalls += 1;
          return {
            report: {
              schemaVersion: 1,
              toolVersion: '0.3.0',
              generatedAt: '2026-01-01T00:00:00.000Z',
              command: 'doctor',
              status: 'ok',
              redacted: true,
              target: { kind: 'default-codex-log-db', pathCategory: '<home>/.codex/logs_2.sqlite' },
              findings: {},
              metrics: {},
              blockedReasons: []
            },
            reportPath: '/tmp/report.json'
          };
        }
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown doctor flag: --wat');
    expect(doctorCalls).toBe(0);
  });

  test('supports equals wait timeout and rejects command-looking timeout values', async () => {
    const doctorReport: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.3.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      command: 'doctor',
      status: 'ok',
      redacted: true,
      target: { kind: 'default-codex-log-db', pathCategory: '<home>/.codex/logs_2.sqlite' },
      findings: { openHandles: { usable: true, openHandles: false }, knownCodexProcessExists: false },
      metrics: {},
      blockedReasons: []
    };
    expect(
      (await runCli(['--wait-timeout=1', '--no-interactive'], {
        commands: {
          runDoctor: async () => ({ report: doctorReport, reportPath: '/tmp/report.json' })
        }
      })).exitCode
    ).toBe(0);
    const invalid = await runCli(['--wait-timeout', 'doctor']);

    expect(invalid.exitCode).toBe(2);
    expect(invalid.output).toContain('Invalid --wait-timeout: doctor');
  });

  test('direct invocation detection resolves npm bin symlinks', () => {
    const moduleUrl = new URL('../src/cli.ts', import.meta.url).href;
    const realPath = new URL('../src/cli.ts', import.meta.url).pathname;

    expect(isDirectCliInvocation(moduleUrl, realPath)).toBe(true);
  });
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
