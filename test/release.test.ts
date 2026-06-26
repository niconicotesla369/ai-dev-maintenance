import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { fixSafeConfirmationError, isDirectCliInvocation, renderReport, runCli } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';

describe('release readiness', () => {
  test('package prepack forces verification and build before publishing', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));

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

    expect(releaseCheck).toContain('npm pack --json');
    expect(releaseCheck).toContain('assertNoInstallLifecycleScripts');
    expect(releaseCheck).toContain('assertVersionSync');
    expect(releaseCheck).toContain('assertDistSafetyMarkers');
    expect(releaseCheck).toContain('ai-dev-maintenance');
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

  test('prepublish runs the full fresh verification and packaging gate', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));

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
      toolVersion: '0.1.0',
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

    expect(output).toContain('Safe to run fix --safe --yes: yes');
    expect(output).toContain('What changed: redacted report only');
    expect(output).toContain('Report saved: <absolute-path>');
    expect(output).toContain('Review with: npm exec --ignore-scripts ai-dev-maintenance@0.1.0 -- report --latest');
  });

  test('report latest uses the same human safety summary by default', async () => {
    const source = await readFile('src/cli.ts', 'utf8');

    expect(source).toContain('renderReport(latest.report');
  });

  test('blocked fix after checkpoint attempt does not claim nothing changed', async () => {
    const report: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.1.0',
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

    expect(output).toContain('What changed: private backup created + checkpoint attempted; review report');
    expect(output).not.toContain('nothing; fix was blocked');
  });

  test('readme warns that fix creates a private local backup and uses yes flag', async () => {
    const readme = await readFile('README.md', 'utf8');

    expect(readme).toContain('may contain Codex log data');
    expect(readme).toContain('fix --safe --yes');
    expect(readme).toContain('Emergency / Advanced Only');
    expect(readme).toContain('1. Diagnose only');
    expect(readme).toContain('3. Only if the output says it is safe');
  });

  test('public readmes do not publish raw wildcard deletion cleanup commands', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).not.toContain('rm -f "$HOME/.ai-dev-maintenance/reports"/report-*.json');
    expect(readmes).not.toContain('report-*.json');
  });

  test('report directory setup avoids path-based chmod after safety validation', async () => {
    const reportsSource = await readFile('src/reports.ts', 'utf8');

    expect(reportsSource).not.toContain('chmod(dir');
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

  test('direct invocation detection resolves npm bin symlinks', () => {
    const moduleUrl = new URL('../src/cli.ts', import.meta.url).href;
    const realPath = new URL('../src/cli.ts', import.meta.url).pathname;

    expect(isDirectCliInvocation(moduleUrl, realPath)).toBe(true);
  });
});
