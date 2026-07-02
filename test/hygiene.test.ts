import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  listSourceFilesForScan,
  scanPublicText,
  scanPackageText,
  shouldScanSourceFile
} from '../scripts/public-hygiene.mjs';

describe('public hygiene scanner', () => {
  test('passes neutral public text', () => {
    const findings = scanPublicText('AI coding tool maintenance for local SQLite state.', 'README.md');
    expect(findings).toEqual([]);
  });

  test('detects synthetic private terms without storing real identifiers', () => {
    const forbidden = [
      ['alice', 'private'].join('-'),
      ['private-handle', 'example'].join('.'),
      ['workspace', 'example'].join('-')
    ];
    const findings = forbidden.flatMap((term) => scanPublicText(term, 'README.md'));
    expect(findings).toHaveLength(forbidden.length);
  });

  test('detects generic launch and local-machine leak categories', () => {
    const samples = [
      ['https://', 'x', '.com', '/example/status/123'].join(''),
      ['LI', 'NE'].join(''),
      ['@', 'private-handle'].join(''),
      ['', 'Users', 'example', '.codex', 'logs_2.sqlite'].join('/'),
      ['', 'Volumes', 'Workspace', 'secret.txt'].join('/')
    ];

    const findings = samples.flatMap((sample) => scanPublicText(sample, 'README.md'));

    expect(findings).toHaveLength(samples.length);
  });

  test('scans package text after build instead of excluding generated publish files', async () => {
    const leakedPath = ['', 'Users', 'example', 'private'].join('/');
    const findings = await scanPackageText({
      'package/dist/cli.js.map': `{"sourcesContent":["const leak=\\"${leakedPath}\\""]}`,
      'package/README.md': 'AI coding tool maintenance'
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('package/dist/cli.js.map');
  });

  test('scanner source does not contain real private terms or self-exclusions', async () => {
    const scanner = await readFile(path.join(process.cwd(), 'scripts/public-hygiene.mjs'), 'utf8');
    const forbiddenFragments = [
      ['Ni', 'co'].join(''),
      ['dai', 'to'].join(''),
      ['Twit', 'ter'].join(''),
      ['/', 'Users'].join(''),
      ['ignored', 'Files'].join('')
    ];

    for (const term of forbiddenFragments) {
      expect(scanner).not.toContain(term);
    }
  });

  test('readme does not contain private launch material', async () => {
    const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8').catch(() => '');
    expect(scanPublicText(readme, 'README.md')).toEqual([]);
  });

  test('source scan excludes local-only untracked review and agent files without hiding tracked docs', () => {
    const agentPlan = [['.', 'claude'].join(''), 'brain', 'implementation_plan.md'].join('/');
    const reviewFile = ['REVIEW-0', '.', '1', '.', '4-critical.ja.md'].join('');

    expect(shouldScanSourceFile(agentPlan, { tracked: false })).toBe(false);
    expect(shouldScanSourceFile(reviewFile, { tracked: false })).toBe(false);
    expect(shouldScanSourceFile('docs/superpowers/plans/private-brief.md', { tracked: false })).toBe(false);
    expect(shouldScanSourceFile('docs/public-guide.md', { tracked: true })).toBe(true);
    expect(shouldScanSourceFile('src/cli-router.ts', { tracked: false })).toBe(true);
  });

  test('source scan warns when git listing is unavailable before using fallback filtering', async () => {
    const warnings: string[] = [];
    const files = await listSourceFilesForScan(process.cwd(), {
      listAllFiles: async () => [
        'docs/superpowers/plans/private-brief.md',
        'src/cli-router.ts',
        'README.md'
      ],
      listGitFiles: async () => undefined,
      warn: (message: string) => warnings.push(message)
    });

    expect(files).toEqual(['README.md', 'src/cli-router.ts']);
    expect(warnings).toEqual([
      'public hygiene: git file listing unavailable; falling back to source scan filters'
    ]);
  });
});
