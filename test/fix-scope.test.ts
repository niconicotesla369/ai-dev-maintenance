import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { checkpointRowsAreComplete, parseLastSqliteJsonArray } from '../src/fix.js';

describe('fix safe scope', () => {
  test('treats busy checkpoint rows as incomplete', () => {
    expect(checkpointRowsAreComplete([{ busy: 0, log: 0, checkpointed: 0 }])).toBe(true);
    expect(checkpointRowsAreComplete([{ busy: 1 }])).toBe(false);
    expect(checkpointRowsAreComplete([{ busy: 0 }])).toBe(false);
    expect(checkpointRowsAreComplete([{ busy: 0, log: '0' as never, checkpointed: 0 }])).toBe(false);
    expect(checkpointRowsAreComplete([{ busy: 0, log: 2, checkpointed: 1 }])).toBe(false);
    expect(
      checkpointRowsAreComplete([
        { busy: 0, log: 0, checkpointed: 0 },
        { busy: 0, log: 0, checkpointed: 0 }
      ])
    ).toBe(false);
  });

  test('parses the checkpoint rows from the last sqlite JSON result set', () => {
    expect(parseLastSqliteJsonArray('[{"busy_timeout":0}]\n[{"busy":0,"log":0,"checkpointed":0}]\n')).toEqual([
      { busy: 0, log: 0, checkpointed: 0 }
    ]);
  });

  test('does not call incremental vacuum in fix safe implementation', async () => {
    const source = await readFile('src/fix.ts', 'utf8');

    expect(source).not.toContain('incremental_vacuum');
  });

  test('does not run full preflight checks after checkpoint mutation', async () => {
    const source = await readFile('src/fix.ts', 'utf8');
    const checkpointIndex = source.indexOf('await runCheckpoint');
    const afterCheckpoint = source.slice(checkpointIndex);

    expect(checkpointIndex).toBeGreaterThan(0);
    expect(afterCheckpoint).not.toContain('runPreflight(mainPath)');
  });

  test('runs checkpoint once in fix safe implementation', async () => {
    const source = await readFile('src/fix.ts', 'utf8');
    const callCount = source.match(/await runCheckpoint\(sqlite, dbUri\);/g)?.length ?? 0;

    expect(callCount).toBe(1);
  });

  test('allows sidecar size and mtime drift after backup before mutation', async () => {
    const source = await readFile('src/fix.ts', 'utf8');
    const beforeMutationIndex = source.indexOf('const beforeMutation = await runPreflight(mainPath);');
    const beforeMutationBlock = source.slice(beforeMutationIndex, source.indexOf('if (report.blockedReasons.length > 0)', beforeMutationIndex));

    expect(beforeMutationIndex).toBeGreaterThan(0);
    expect(beforeMutationBlock).toContain('allowSidecarSizeMtimeChange: true');
  });
});
