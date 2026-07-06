import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { runTrust } from '../src/trust.js';
import type { CommandStat } from '../src/types.js';

describe('trust command', () => {
  test('classifies trusted, untrusted, and missing allowlist commands', async () => {
    const report = await runTrust({
      now: () => '2026-07-04T00:00:00.000Z',
      statCommand: async (name, commandPath): Promise<CommandStat> => {
        if (name === 'sqlite3') {
          return {
            path: commandPath,
            uid: 0,
            mode: 0o100755,
            isSymbolicLink: false
          };
        }
        if (name === 'ps') {
          return {
            path: commandPath,
            uid: 501,
            mode: 0o100777,
            isSymbolicLink: true
          };
        }
        const error = new Error('missing command') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'trust',
      status: 'partial',
      redacted: true,
      summary: {
        trusted: 1,
        untrusted: 1,
        missing: 4,
        total: 6
      }
    });
    expect(report.entries.find((entry) => entry.name === 'sqlite3')).toMatchObject({
      path: '/usr/bin/sqlite3',
      status: 'trusted',
      reasons: []
    });
    expect(report.entries.find((entry) => entry.name === 'ps')).toMatchObject({
      path: '/bin/ps',
      status: 'untrusted',
      reasons: ['symbolic_link', 'not_root_owned', 'group_or_other_writable']
    });
    expect(report.entries.find((entry) => entry.name === 'df')).toMatchObject({
      path: '/bin/df',
      status: 'missing',
      reasons: ['missing']
    });
  });

  test('trust --json prints only the trust report', async () => {
    const result = await runCli(['trust', '--json'], {
      commands: {
        runTrust: async () => ({
          schemaVersion: 1,
          toolVersion: '0.4.1',
          generatedAt: '2026-07-04T00:00:00.000Z',
          command: 'trust',
          status: 'ok',
          redacted: true,
          entries: [{
            name: 'sqlite3',
            path: '/usr/bin/sqlite3',
            status: 'trusted',
            reasons: []
          }],
          summary: {
            trusted: 1,
            untrusted: 0,
            missing: 0,
            total: 1
          },
          warnings: []
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('AIDM TRUST');
    expect(JSON.parse(result.output)).toMatchObject({
      command: 'trust',
      entries: [{
        name: 'sqlite3',
        path: '/usr/bin/sqlite3',
        status: 'trusted'
      }]
    });
  });

  test('trust --json exits 3 when any allowlist command is not trusted', async () => {
    const result = await runCli(['trust', '--json'], {
      commands: {
        runTrust: async () => ({
          schemaVersion: 1,
          toolVersion: '0.4.1',
          generatedAt: '2026-07-04T00:00:00.000Z',
          command: 'trust',
          status: 'partial',
          redacted: true,
          entries: [{
            name: 'ps',
            path: '/bin/ps',
            status: 'untrusted',
            reasons: ['not_root_owned']
          }],
          summary: {
            trusted: 0,
            untrusted: 1,
            missing: 0,
            total: 1
          },
          warnings: []
        })
      }
    });

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      command: 'trust',
      status: 'partial'
    });
  });

  test('trust human output shows command paths and reasons', async () => {
    const result = await runCli(['trust'], {
      commands: {
        runTrust: async () => ({
          schemaVersion: 1,
          toolVersion: '0.4.1',
          generatedAt: '2026-07-04T00:00:00.000Z',
          command: 'trust',
          status: 'partial',
          redacted: true,
          entries: [
            {
              name: 'sqlite3',
              path: '/usr/bin/sqlite3',
              status: 'trusted',
              reasons: []
            },
            {
              name: 'ps',
              path: '/bin/ps',
              status: 'untrusted',
              reasons: ['not_root_owned']
            }
          ],
          summary: {
            trusted: 1,
            untrusted: 1,
            missing: 0,
            total: 2
          },
          warnings: []
        })
      }
    });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('AIDM TRUST');
    expect(result.output).toContain('/usr/bin/sqlite3');
    expect(result.output).toContain('/bin/ps');
    expect(result.output).toContain('not_root_owned');
  });
});
