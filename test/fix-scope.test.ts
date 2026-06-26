import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { checkpointRowsAreComplete } from '../src/fix.js';

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

  test('does not call incremental vacuum in fix safe implementation', async () => {
    const source = await readFile('src/fix.ts', 'utf8');

    expect(source).not.toContain('incremental_vacuum');
  });
});
