import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { fixSafeConfirmationError, isDirectCliInvocation, renderReport, runCli } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';
import { TOOL_VERSION } from '../src/version.js';

type RuntimeNetworkSource = { path: string; source: string };
type ReleaseNetworkCheck = {
  findRuntimeNetworkPolicyViolations(files: readonly RuntimeNetworkSource[]): string[];
};

async function loadReleaseNetworkCheck(): Promise<ReleaseNetworkCheck> {
  const modulePath = new URL('../scripts/release-network-check.mjs', import.meta.url).href;
  return await import(modulePath) as ReleaseNetworkCheck;
}

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
    const [releaseCheck, networkCheck] = await Promise.all([
      readFile('scripts/release-check.mjs', 'utf8'),
      readFile('scripts/release-network-check.mjs', 'utf8')
    ]);
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
    expect(releaseCheck).toContain('findRuntimeNetworkPolicyViolations');
    expect(networkCheck).toContain('node:net');
    expect(networkCheck).toContain('NODE_NETWORK_PRIMITIVE');
    expect(workflow).toContain('corepack pnpm run release:check:prepublic');
    expect(workflow).toContain('--ignore-scripts');
    expect(workflow).toContain('npm install --ignore-scripts');
  });

  test('release network policy accepts only the exact production loopback lane', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const client = [
      'let heartbeatPath: string | null = config.token === null ? null : `/${config.token}/heartbeat`;',
      'let closePath: string | null = config.token === null ? null : `/${config.token}/close`;',
      'const response = await fetch(heartbeatPath, { method: \'POST\', cache: \'no-store\' });',
      'navigator.sendBeacon(closePath);'
    ].join('\n');
    const server = [
      "import http from 'node:http';",
      "import type { AddressInfo } from 'node:net';",
      'export const VISUAL_REPORT_SERVER_LIMITS = Object.freeze({',
      "  host: '127.0.0.1',",
      '  port: 0',
      '});',
      'server.listen(VISUAL_REPORT_SERVER_LIMITS.port, VISUAL_REPORT_SERVER_LIMITS.host);'
    ].join('\n');

    expect(findRuntimeNetworkPolicyViolations([
      { path: 'src/visual-report/client.ts', source: client },
      { path: 'src/visual-report/server.ts', source: server },
      { path: 'src/cli.ts', source: 'export const version = 1;' }
    ])).toEqual([]);
  });

  test('release network policy rejects an extra client fetch', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const source = [
      'let heartbeatPath: string | null = config.token === null ? null : `/${config.token}/heartbeat`;',
      'await fetch(heartbeatPath, { method: \'POST\' });',
      'await fetch(heartbeatPath, { method: \'POST\' });'
    ].join('\n');

    expect(findRuntimeNetworkPolicyViolations([
      { path: 'src/visual-report/client.ts', source }
    ])).toContain('visual report client must contain only the approved heartbeat fetch and close beacon');
  });

  test('release network policy rejects an external client URL', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const source = [
      'let heartbeatPath: string | null = config.token === null ? null : `/${config.token}/heartbeat`;',
      "await fetch('https://example.test/heartbeat', { method: 'POST' });"
    ].join('\n');

    expect(findRuntimeNetworkPolicyViolations([
      { path: 'src/visual-report/client.ts', source }
    ])).toContain('visual report client must contain only the approved heartbeat fetch and close beacon');
  });

  test('release network policy rejects additional browser network capabilities', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const approved = [
      'let heartbeatPath: string | null = config.token === null ? null : `/${config.token}/heartbeat`;',
      'let closePath: string | null = config.token === null ? null : `/${config.token}/close`;',
      'await fetch(heartbeatPath, { method: \'POST\' });',
      'navigator.sendBeacon(closePath);'
    ];

    for (const extra of [
      "navigator.sendBeacon('https://example.test/collect');",
      "new WebSocket('wss://example.test/socket');",
      "new EventSource('https://example.test/events');",
      'new XMLHttpRequest();'
    ]) {
      expect(findRuntimeNetworkPolicyViolations([
        { path: 'src/visual-report/client.ts', source: [...approved, extra].join('\n') }
      ])).toContain('visual report client must contain only the approved heartbeat fetch and close beacon');
    }
  });

  test('release network policy rejects a wildcard or non-fixed server listener', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const source = [
      "import http from 'node:http';",
      "import type { AddressInfo } from 'node:net';",
      'export const VISUAL_REPORT_SERVER_LIMITS = Object.freeze({',
      "  host: '0.0.0.0',",
      '  port: 0',
      '});',
      "server.listen(0, '0.0.0.0');"
    ].join('\n');

    expect(findRuntimeNetworkPolicyViolations([
      { path: 'src/visual-report/server.ts', source }
    ])).toContain('visual report server must contain only the approved loopback listener');
  });

  test('release network policy rejects additional server requests', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();
    const approved = [
      "import http from 'node:http';",
      "import type { AddressInfo } from 'node:net';",
      'export const VISUAL_REPORT_SERVER_LIMITS = Object.freeze({',
      "  host: '127.0.0.1',",
      '  port: 0',
      '});',
      'server.listen(VISUAL_REPORT_SERVER_LIMITS.port, VISUAL_REPORT_SERVER_LIMITS.host);'
    ];

    for (const extra of [
      "http.get('http://example.test');",
      "http.request('http://example.test');"
    ]) {
      expect(findRuntimeNetworkPolicyViolations([
        { path: 'src/visual-report/server.ts', source: [...approved, extra].join('\n') }
      ])).toContain('visual report server must contain only the approved loopback listener');
    }
  });

  test('release network policy rejects every network primitive outside visual report sources', async () => {
    const { findRuntimeNetworkPolicyViolations } = await loadReleaseNetworkCheck();

    for (const source of [
      "fetch('/unexpected');",
      "import http from 'node:http';",
      "import type { Socket } from 'node:net';",
      "import https from 'node:https';",
      "import dns from 'node:dns';",
      "import tls from 'node:tls';",
      "new WebSocket('wss://example.test/socket');",
      "navigator.sendBeacon('https://example.test/collect');",
      "await runCommand('/usr/bin/curl', ['https://example.test']);"
    ]) {
      expect(findRuntimeNetworkPolicyViolations([
        { path: 'src/cli.ts', source }
      ])).toEqual([
        'runtime network primitive detected in src/cli.ts'
      ]);
    }
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
    expect(output).toContain(`Review          npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- report --latest`);
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
    expect(readme).toContain('npm install -g ai-dev-maintenance@0.6.1');
    expect(readme).toContain('ai-dev-maintenance --version | -v | version');
    expect(readme).toContain('cursor clean --safe --yes');
    expect(readme).toContain('aidm');
  });

  test('public docs preserve the ephemeral visual-report privacy contract', async () => {
    const [readme, japaneseReadme, security] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8'),
      readFile('SECURITY.md', 'utf8')
    ]);
    const english = readme.split('## Ephemeral Local Visual Reports', 2)[1]
      ?.split('## v0.6 Guided Codex Reclaim', 1)[0] ?? '';
    const japanese = japaneseReadme.split('## ローカルVisual Report（一時表示）', 2)[1]
      ?.split('## v0.6 Guided Codex Reclaim', 1)[0] ?? '';
    const securityBoundary = security.split('## Ephemeral Visual-Report Boundary', 2)[1]
      ?.split('## v0.6 Safety Boundaries and Recovery', 1)[0] ?? '';

    for (const document of [english, securityBoundary]) {
      for (const expected of [
        'aidm doctor --html',
        'aidm report --latest --html',
        'no HTML file is written',
        'no upload or external request',
        'Japanese / English switch',
        'session-only language preference',
        '`sessionStorage`',
        'The zero-file promise applies to HTML only.',
        'source/tool state',
        'normal redacted JSON retention',
        'transient HTML',
        'browser-controlled history/cache',
        '`--json`, `--share`, `--show-paths`, `--plain`, and `--no-banner`',
        'in-memory document, not a temporary file that is later deleted',
        'does not guarantee perfect browser erasure or APFS byte-for-byte reclaim'
      ]) {
        expect(document).toContain(expected);
      }
      expect(document).toMatch(/only on the literal loopback address `127\.0\.0\.1`/);
      expect(document).toMatch(/Closing the page or reaching session expiry destroys .*in-memory view/);
      expect(document).toMatch(/(?:Browser|browser) history may retain an unusable tokenized loopback URL/);
      expect(document).toContain('`doctor --html` still follows normal redacted JSON retention: it runs `doctor` and creates its normal redacted JSON report.');
      expect(document).toContain('`report --latest --html` reads the existing latest redacted JSON report; it performs neither a new diagnosis nor a new report write.');
      expect(document).toMatch(/cannot execute `plan`, `apply`, or cleanup/);
      expect(document).toMatch(/not exposed through MCP/);
    }

    for (const expected of [
      'aidm doctor --html',
      'aidm report --latest --html',
      '`127.0.0.1`',
      'HTMLファイルは最初から書き込みません',
      '`sessionStorage`',
      '`--json`, `--share`, `--show-paths`, `--plain`, `--no-banner`',
      'zero-fileという約束はHTMLだけが対象です',
      '元データやツールの状態',
      '通常保存される伏せ字済みJSONレポート',
      '一時的なHTML表示',
      'ブラウザ管理の履歴やキャッシュ',
      'MCP'
    ]) {
      expect(japanese).toContain(expected);
    }
    expect(japanese).toMatch(/ループバックアドレス `127\.0\.0\.1` のみに/);
    expect(japanese).toMatch(/外部へのアップロードやリクエストは.*行いません/);
    expect(japanese).toMatch(/日本語 \/ 英語に切り替え/);
    expect(japanese).toMatch(/現在のブラウザセッション中だけ有効/);
    expect(japanese).toMatch(/ページを閉じるかセッションの有効期限が切れると.*メモリ上の表示を破棄/);
    expect(japanese).toMatch(/`doctor --html` は通常どおり診断を行い.*伏せ字済みJSONレポートを作成・保持/);
    expect(japanese).toMatch(/`report --latest --html` は既存の最新の伏せ字済みJSONレポートを読み取り.*新たな診断もレポート書き込みも行いません/);
    expect(japanese).toMatch(/メモリ上だけの文書.*後から削除される一時ファイルではありません/);
    expect(japanese).toMatch(/利用できないトークン付きのループバックURL/);
    expect(japanese).toMatch(/ブラウザデータの完全な消去.*APFS.*byte-for-byte reclaim.*保証しません/);
    expect(japanese).toMatch(/`plan` \/ `apply` \/ cleanupを実行できず/);
    expect(japanese).toMatch(/MCPにも公開されません/);
  });

  test('each README publishes the exact implemented HTML command syntax', async () => {
    const commandSyntax = [
      'ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--html] [--no-banner]',
      'ai-dev-maintenance report --latest [--show-paths] [--json] [--html]',
      'aidm doctor [--json] [--show-paths] [--share] [--html] [--no-banner]',
      'aidm report --latest [--show-paths] [--json] [--html]'
    ];

    for (const [name, document] of [
      ['README.md', await readFile('README.md', 'utf8')],
      ['README.ja.md', await readFile('README.ja.md', 'utf8')]
    ] as const) {
      for (const syntax of commandSyntax) {
        expect(document, name).toContain(syntax);
      }
    }
  });

  test('v0.6.0 release notes retain the visual-report boundary', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const releaseNotes = changelog
      .split('## 0.6.0 - 2026-09-29', 2)[1]
      ?.split('\n## ', 1)[0] ?? '';

    for (const expected of [
      'aidm doctor --html',
      'aidm report --latest --html',
      'local-only',
      'memory-only',
      'CLI-only'
    ]) {
      expect(releaseNotes).toContain(expected);
    }
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
    expect(example).toContain('npx --yes ai-dev-maintenance@0.5.0');
    expect(example).toContain('Private danger buckets are never auto-touched.');
    expect(example).not.toContain('/Users');
    expect(example).not.toContain('<home>');
    expect(example).not.toContain('pid');
    expect(example).not.toContain('/');
  });

  test('pressure share card example stays path-free and public-safe', async () => {
    const example = await readFile('examples/pressure-share-card.txt', 'utf8');

    expect(example).toContain('AIDM PRESSURE CARD');
    expect(example).toContain('npx --yes ai-dev-maintenance@0.5.0 pressure');
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

  test('readmes and v0.5.0 notes document tracked-state scope and compatibility', async () => {
    const [readme, japaneseReadme, changelog] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8'),
      readFile('CHANGELOG.md', 'utf8')
    ]);
    const releaseNotes = changelog
      .split('## 0.5.0 - 2026-08-24', 2)[1]
      ?.split('## 0.4.1 - 2026-07-06', 1)[0];
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

    expect(releaseNotes).toContain('Codex sessions, archives, generated images, backups, sidecars, and unknown root state');
    expect(releaseNotes).toContain('without double counting');
    expect(releaseNotes).toContain('OpenAI Codex Sparkle cache');
    expect(releaseNotes).toContain('review-first');
    expect(releaseNotes).toContain('remains untouched');
    expect(releaseNotes).toContain('lower-bound warnings');
    expect(releaseNotes).toContain('schema v2');
    expect(releaseNotes).toContain('cleanup engines/action gates are unchanged');
    expect(releaseNotes).toContain('Change human-facing wording from `Total state` to `Tracked state`.');
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

    expect(readme).toContain('v0.6.x currently supports macOS only');
    expect(readme).not.toMatch(/v0\.[234]\.x currently supports macOS only/);
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
    expect(readmes).toContain('ai-dev-maintenance plan codex-fix|cursor-clean|codex-sparkle-clean [--json]');
    expect(readmes).toContain('ai-dev-maintenance apply --plan <planId> --yes [--accept-image-loss] [--json]');
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

  test('v0.6 readmes document exact guided reclaim commands and defaults', async () => {
    const [readme, japaneseReadme] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8')
    ]);
    const english = readme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## Tracked State Scope', 1)[0] ?? '';
    const japanese = japaneseReadme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## 追跡対象の状態と互換性', 1)[0] ?? '';

    expect(english).toContain('reclaim scan codex-session-images');
    expect(english).toContain('--older-than-days 30');
    expect(english).toContain('--min-file-size-mb 50');
    expect(english).toContain('aidm apply --plan <planId> --yes --accept-image-loss');
    expect(japanese).toContain('reclaim scan codex-session-images');
    expect(japanese).toContain('--older-than-days 30');
    expect(japanese).toContain('--min-file-size-mb 50');
    expect(japanese).toContain('aidm apply --plan <planId> --yes --accept-image-loss');
  });

  test('v0.6 readmes retain each bilingual Step 1 safety boundary', async () => {
    const [readme, japaneseReadme] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8')
    ]);
    const english = readme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## Tracked State Scope', 1)[0] ?? '';
    const japanese = japaneseReadme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## 追跡対象の状態と互換性', 1)[0] ?? '';

    expect(english).toContain('doctor remains metadata-only');
    expect(english).toContain('reads session files');
    expect(english).toContain('irreversible and CLI-only');
    expect(english).toContain('does not change Codex native-compression configuration');
    expect(english).toContain('exact Codex Sparkle');
    expect(english).toContain('only when every safety check passes');
    expect(english).toContain('The monitor is **opt-in**');
    expect(english).toContain('scheduled run persists the monitor state and latest report');
    expect(english).toContain('MCP cannot invoke these new actions');
    expect(english).toContain('not auditable from files alone');

    expect(japanese).toContain('doctor はmetadata-onlyのまま');
    expect(japanese).toContain('session fileを読みます');
    expect(japanese).toContain('不可逆かつCLI限定');
    expect(japanese).toContain('Codex native-compressionの設定を変更しません');
    expect(japanese).toContain('正確なCodex Sparkle');
    expect(japanese).toContain('すべての安全確認に合格した場合だけ');
    expect(japanese).toContain('monitorは `opt-in` です');
    expect(japanese).toContain('ローカルstateを書き込みます');
    expect(japanese).toContain('MCPはこれらの新しいactionを呼び出せません');
    expect(japanese).toContain('ファイルだけから監査できません');
  });

  test('v0.6 readmes document recovery and monitor persistence contracts', async () => {
    const [readme, japaneseReadme] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8')
    ]);
    const english = readme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## Tracked State Scope', 1)[0] ?? '';
    const japanese = japaneseReadme.split('## v0.6 Guided Codex Reclaim', 2)[1]?.split('## 追跡対象の状態と互換性', 1)[0] ?? '';

    expect(english).toContain('manifest mode `0600`');
    expect(english).toContain('global preflight failure changes nothing');
    expect(english).toContain('post-mutation failure returns `partial` and consumes the plan');
    expect(english).toContain('install writes the LaunchAgent plist and bootstraps it');
    expect(english).toContain('Manual `aidm monitor codex-sessions` is metadata-only and does not persist');
    expect(english).toContain('scheduled run persists the monitor state and latest report');
    expect(english).toContain('Notification delivery is best-effort');
    expect(english).toContain('Reinstall after either validated Node or AIDM path moves');
    expect(japanese).toContain('manifest mode `0600`');
    expect(japanese).toContain('global preflight failureなら変更しません');
    expect(japanese).toContain('post-mutation failureは `partial` となりplanを消費します');
    expect(japanese).toContain('installはLaunchAgent plistを書き込みbootstrapします');
    expect(japanese).toContain('手動 `aidm monitor codex-sessions` はmetadata-onlyでpersistしません');
    expect(japanese).toContain('scheduled runがmonitor stateとlatest reportをpersistします');
    expect(japanese).toContain('notification deliveryはbest-effort');
    expect(japanese).toContain('validated Node/AIDM pathを移動したらmonitorをreinstall');
  });

  const assertPathFree = (value: string, label: string): void => {
    const pathPattern = /(?:^|[\s"'(=:`\[,])(?:file:\/\/[^\s"'()]+|[A-Za-z]:[\\/][^\s"'()]+|\\\\[^\\/\s]+(?:[\\/][^\\/\s"'()]+)+|\/(?!\/)[^\s"'()]+)/i;
    expect(value, label).not.toMatch(pathPattern);
  };

  const collectStrings = (value: unknown, label: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => collectStrings(child, `${label}[${index}]`));
    } else if (typeof value === 'string') {
      assertPathFree(value, label);
    } else if (value !== null && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => collectStrings(child, `${label}.${key}`));
    }
  };

  test('path-free helper rejects embedded local paths but allows ordinary text', () => {
    for (const value of [
      'path=/Users/a',
      'location: C:\\Users\\a',
      'source=file:///Users/a',
      'backup=\\\\server\\share\\a'
    ]) {
      expect(() => assertPathFree(value, value)).toThrow();
    }
    for (const value of [
      '--yes --accept-image-loss',
      'copy: 100.0 MiB; version 0.6.0',
      'See https://example.com/docs'
    ]) {
      expect(() => assertPathFree(value, value)).not.toThrow();
    }
  });

  test('v0.6 public examples validate against Task14 schemas and stay synthetic', async () => {
    const cases = [
      {
        examplePath: 'examples/reclaim-session-images.json',
        schemaPath: 'schemas/reclaim-scan-result.v1.schema.json',
        expected: {
          schemaVersion: 1,
          toolVersion: '0.6.1',
          command: 'reclaim scan codex-session-images',
          status: 'ok',
          contentRead: true,
          filters: { olderThanDays: 30, minFileSizeBytes: 52_428_800 },
          totals: {
            filesConsidered: 3,
            filesOpened: 2,
            filesSkippedBySize: 1,
            filesSkippedAfterRead: 0,
            filesBlocked: 0,
            sourceBytes: 104_857_600,
            projectedBytes: 20_971_520,
            reclaimableBytes: 83_886_080,
            occurrencesSeen: 4,
            imagesPrunable: 3,
            knownPlaceholders: 1,
            belowMinimum: 0,
            candidateFiles: 2
          },
          blockedReasons: [],
          warnings: ['size-filtered-estimate-is-lower-bound']
        }
      },
      {
        examplePath: 'examples/native-compression-status.json',
        schemaPath: 'schemas/native-compression-status.v1.schema.json',
        expected: {
          schemaVersion: 1,
          toolVersion: '0.6.1',
          command: 'reclaim status codex-native-compression',
          status: 'ok',
          supported: true,
          featureStage: 'stable',
          defaultEnabled: false,
          configuredState: 'unknown',
          plainJsonlFiles: 4,
          compressedJsonlFiles: 1,
          warnings: [],
          nextActions: [
            'Prune eligible session images before enabling native compression.',
            'Use the official Codex CLI to manage this feature; AIDM will not edit configuration.'
          ]
        }
      },
      {
        examplePath: 'examples/codex-session-monitor.json',
        schemaPath: 'schemas/codex-session-monitor-result.v1.schema.json',
        expected: {
          schemaVersion: 1,
          toolVersion: '0.6.1',
          command: 'monitor codex-sessions',
          status: 'ok',
          currentBytes: 10 * 1024 ** 3,
          previousBytes: 4 * 1024 ** 3,
          deltaBytes: 6 * 1024 ** 3,
          thresholdBytes: 8 * 1024 ** 3,
          growthThresholdBytes: 5 * 1024 ** 3,
          alert: true,
          statePersisted: false,
          notificationAttempted: false,
          warnings: []
        }
      }
    ] as const;
    const ajv = new Ajv({ allErrors: true, strict: true });
    const forbiddenKeys = new Set([
      'path', 'absolutePath', 'sessionContent', 'sessionText', 'candidates',
      'privateCandidates', 'sourceSha256', 'identity', 'manifest', 'manifestPath',
      'privateOutcomes'
    ]);
    for (const { examplePath, schemaPath, expected } of cases) {
      const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
      const example = JSON.parse(await readFile(examplePath, 'utf8'));
      const validate = ajv.compile(schema);
      expect(validate(example), `${examplePath}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
      expect(example).toEqual(expected);
      const keys: string[] = [];
      const collectKeys = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collectKeys);
        } else if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            keys.push(key);
            collectKeys(child);
          }
        }
      };
      collectKeys(example);
      expect(keys.filter((key) => forbiddenKeys.has(key))).toEqual([]);
      collectStrings(example, `${examplePath}:$`);
      expect(JSON.stringify(example)).not.toMatch(/(?:session contents|username|manifest)/i);
    }
  });

  test('v0.6 reclaim human example preserves renderer safety wording without local identity', async () => {
    const example = await readFile('examples/reclaim-session-images.txt', 'utf8');

    expect(example).toContain('Content access  Reads candidate Codex session JSONL contents locally; no session content is printed or uploaded.');
    for (const row of [
      'Image scan      ok',
      'Content read    yes',
      'Candidate files 2',
      'Files opened    2',
      'Files blocked   0',
      'Images          3',
      'Source size     100.0 MiB',
      'Projected size  20.0 MiB',
      'Reclaimable     80.0 MiB',
      'Changed         nothing; estimate only',
      'Warning         size-filtered-estimate-is-lower-bound'
    ]) {
      expect(example).toContain(row);
    }
    expect(example).toContain('Consent         Irreversible image loss; apply requires both --yes and --accept-image-loss.');
    example.split(/\r?\n/).forEach((line, lineIndex) => {
      assertPathFree(line, `human example line ${lineIndex}`);
      line.split(/\s+/).filter(Boolean).forEach((token, tokenIndex) => {
        assertPathFree(token, `human example line ${lineIndex} token ${tokenIndex}`);
      });
    });
    expect(example).not.toMatch(/(?:plan[- ]?[0-9a-f]{4,}|manifest|username)/i);
  });

  test('v0.6 readmes state supported homes metrics and bounded exclusions', async () => {
    const [readme, japaneseReadme] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('README.ja.md', 'utf8')
    ]);

    expect(readme).toContain('custom `CODEX_HOME` (anything other than `$HOME/.codex`)');
    expect(readme).toContain('`.jsonl.zst`');
    expect(readme).toContain('no unattended deletion');
    expect(readme).toContain('Free-space delta');
    expect(readme).toContain('`volumeFreeDeltaBytes`');
    expect(readme).toContain('free-space equality is not guaranteed');
    expect(readme).toContain('No universal compression ratio, including `104x`, is promised');
    expect(readme).not.toContain('AIDM does not clean Codex sessions or Sparkle.');
    expect(japaneseReadme).toContain('custom `CODEX_HOME`（`$HOME/.codex` 以外）');
    expect(japaneseReadme).toContain('`.jsonl.zst`');
    expect(japaneseReadme).toContain('unattended deletionはありません');
    expect(japaneseReadme).toContain('Free-space delta');
    expect(japaneseReadme).toContain('`volumeFreeDeltaBytes`');
    expect(japaneseReadme).toContain('free-space equalityは保証しません');
    expect(japaneseReadme).toContain('`104x`を含む）は約束しません');
    expect(japaneseReadme).not.toContain('AIDMはCodexのsessionやSparkleをcleanupしません。');
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
