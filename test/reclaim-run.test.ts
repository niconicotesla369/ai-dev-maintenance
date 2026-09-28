import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildReclaimRunRecord,
  byteChange,
  createReclaimMeasurer,
  latestReclaimRunRecord,
  parseReclaimRunRecord,
  writeReclaimRunRecord,
  type ReclaimRunItem
} from '../src/reclaim-run.js';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'aidm-reclaim-run-'));
});

afterEach(async () => {
  await chmod(path.join(home, 'Library', 'Application Support', 'Cursor', 'logs', 'locked'), 0o700).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

describe('reclaim measurer', () => {
  test('measures the Codex log database, WAL, and SHM together and counts absent files as zero', async () => {
    await mkdir(path.join(home, '.codex'), { mode: 0o700 });
    await writeFile(path.join(home, '.codex', 'logs_2.sqlite'), Buffer.alloc(3_000));
    await writeFile(path.join(home, '.codex', 'logs_2.sqlite-wal'), Buffer.alloc(500));

    expect(await createReclaimMeasurer({ HOME: home }).targetBytes('codex-fix')).toBe(3_500);
  });

  test('reports a non-regular Codex sidecar as not measurable', async () => {
    await mkdir(path.join(home, '.codex'), { mode: 0o700 });
    await writeFile(path.join(home, '.codex', 'logs_2.sqlite'), Buffer.alloc(10));
    await symlink('/dev/null', path.join(home, '.codex', 'logs_2.sqlite-wal'));

    expect(await createReclaimMeasurer({ HOME: home }).targetBytes('codex-fix')).toBeNull();
  });

  test('does not measure a custom CODEX_HOME that fix rejects', async () => {
    expect(await createReclaimMeasurer({ HOME: home, CODEX_HOME: path.join(home, 'custom') }).targetBytes('codex-fix')).toBeNull();
  });

  test('measures only the four Cursor cache and log folders', async () => {
    const cursor = path.join(home, 'Library', 'Application Support', 'Cursor');
    await mkdir(path.join(cursor, 'Cache', 'nested'), { recursive: true });
    await mkdir(path.join(cursor, 'logs'), { recursive: true });
    await mkdir(path.join(cursor, 'User'), { recursive: true });
    await writeFile(path.join(cursor, 'Cache', 'nested', 'a.bin'), Buffer.alloc(700));
    await writeFile(path.join(cursor, 'logs', 'main.log'), Buffer.alloc(300));
    await writeFile(path.join(cursor, 'User', 'settings.json'), Buffer.alloc(9_999));

    expect(await createReclaimMeasurer({ HOME: home }).targetBytes('cursor-clean')).toBe(1_000);
  });

  test('reports an unreadable Cursor folder as not measurable instead of zero', async () => {
    const locked = path.join(home, 'Library', 'Application Support', 'Cursor', 'logs', 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(locked, 'hidden.log'), Buffer.alloc(100));
    await chmod(locked, 0o000);

    expect(await createReclaimMeasurer({ HOME: home }).targetBytes('cursor-clean')).toBeNull();
  });

  test('measures AIDM data and volume free space', async () => {
    await mkdir(path.join(home, '.ai-dev-maintenance', 'backups'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, '.ai-dev-maintenance', 'backups', 'b.sqlite'), Buffer.alloc(1_234));
    const measurer = createReclaimMeasurer({ HOME: home });

    expect(await measurer.appDataBytes()).toBe(1_234);
    expect(await measurer.volumeAvailableBytes()).toBeGreaterThan(0);
  });
});

describe('reclaim run record rules', () => {
  test('counts only ok and partial items and keeps growth as a positive delta', () => {
    const record = buildReclaimRunRecord(runInput([
      item('codex-fix', 'ok', 1_000, 1_200),
      item('cursor-clean', 'partial', 5_000, 2_000)
    ]));

    expect(record.status).toBe('partial');
    expect(record.items[0].target.deltaBytes).toBe(200);
    expect(record.totals).toEqual({ appliedItems: 2, excludedItems: 0, appliedTargetDeltaBytes: -2_800 });
  });

  test('never adds blocked or unknown outcomes, even when their files changed', () => {
    const record = buildReclaimRunRecord(runInput([
      item('codex-fix', 'blocked', 1_000, 1_000),
      item('cursor-clean', 'unknown', 5_000, 0)
    ]));

    expect(record.status).toBe('partial');
    expect(record.totals).toEqual({ appliedItems: 0, excludedItems: 2, appliedTargetDeltaBytes: 0 });
  });

  test('propagates an unmeasurable applied item as null totals', () => {
    const record = buildReclaimRunRecord(runInput([
      item('codex-fix', 'ok', 1_000, 900),
      item('cursor-clean', 'ok', 5_000, null)
    ]));

    expect(record.status).toBe('ok');
    expect(record.totals.appliedTargetDeltaBytes).toBeNull();
  });

  test('reports an all-blocked run as blocked and marks volume change as not attributed', () => {
    const record = buildReclaimRunRecord(runInput([item('cursor-clean', 'blocked', 5_000, 5_000)]));

    expect(record.status).toBe('blocked');
    expect(record.volume.attributedToAidm).toBe(false);
  });

  test('computes a change only when both sides were measured', () => {
    expect(byteChange(10, 4)).toEqual({ beforeBytes: 10, afterBytes: 4, deltaBytes: -6 });
    expect(byteChange(null, 4)).toEqual({ beforeBytes: null, afterBytes: 4, deltaBytes: null });
  });

  test('builds records that validate against the published schema', async () => {
    const schema = JSON.parse(await readFile('schemas/reclaim-run.v1.schema.json', 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    const record = buildReclaimRunRecord(runInput([
      { ...item('codex-fix', 'ok', 8_274_296, 8_220_672), estimateBytes: null, estimateNote: 'wal-folds-into-database' },
      item('cursor-clean', 'unknown', 5_000, null)
    ]));

    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('reclaim run persistence', () => {
  test('writes one private record per run and reads back the latest', async () => {
    const env = { HOME: home };
    const first = buildReclaimRunRecord(runInput([item('cursor-clean', 'ok', 5, 0)], '2026-09-28T00-00-00-000Z-00000001'));
    const second = buildReclaimRunRecord(runInput([item('codex-fix', 'ok', 9, 7)], '2026-09-28T00-00-01-000Z-00000002'));

    const firstPath = await writeReclaimRunRecord(first, env);
    await writeReclaimRunRecord(second, env);

    expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(firstPath))).mode & 0o777).toBe(0o700);
    expect(await latestReclaimRunRecord(env)).toEqual(second);
    await expect(writeReclaimRunRecord(second, env)).rejects.toThrow();
  });

  test('returns null when no run has been recorded', async () => {
    expect(await latestReclaimRunRecord({ HOME: home })).toBeNull();
  });

  test('keeps only the newest twenty records', async () => {
    const env = { HOME: home };
    for (let index = 0; index < 23; index += 1) {
      const runId = `2026-09-28T00-00-${String(index).padStart(2, '0')}-000Z-${String(index).padStart(8, '0')}`;
      await writeReclaimRunRecord(buildReclaimRunRecord(runInput([item('cursor-clean', 'ok', 1, 0)], runId)), env);
    }

    const names = (await readdir(path.join(home, '.ai-dev-maintenance', 'reclaim-runs'))).sort();
    expect(names).toHaveLength(20);
    expect(names[0]).toContain('00-00-03-000Z');
  });

  test('refuses a malformed or group-writable latest record', async () => {
    const env = { HOME: home };
    const recordPath = await writeReclaimRunRecord(
      buildReclaimRunRecord(runInput([item('cursor-clean', 'ok', 1, 0)])),
      env
    );

    await writeFile(recordPath, '{"schemaVersion":1}', { mode: 0o600 });
    await expect(latestReclaimRunRecord(env)).rejects.toThrow('reclaim run record is malformed');

    await chmod(recordPath, 0o664);
    await expect(latestReclaimRunRecord(env)).rejects.toThrow('unsafe reclaim run record');
  });

  test('rejects records that claim the volume change for AIDM or use negative sizes', () => {
    const record = buildReclaimRunRecord(runInput([item('cursor-clean', 'ok', 1, 0)]));

    expect(parseReclaimRunRecord(record)).toEqual(record);
    expect(parseReclaimRunRecord({ ...record, volume: { ...record.volume, attributedToAidm: true } })).toBeUndefined();
    expect(parseReclaimRunRecord({ ...record, managedState: { beforeBytes: -1, afterBytes: 0, deltaBytes: 1 } })).toBeUndefined();
  });
});

function item(
  action: ReclaimRunItem['action'],
  outcome: ReclaimRunItem['outcome'],
  before: number | null,
  after: number | null
): ReclaimRunItem {
  return { action, outcome, estimateBytes: before, target: byteChange(before, after), reasons: [] };
}

function runInput(items: ReclaimRunItem[], runId = '2026-09-28T00-00-00-000Z-0a1b2c3d') {
  return {
    runId,
    startedAt: '2026-09-28T00:00:00.000Z',
    finishedAt: '2026-09-28T00:00:01.000Z',
    items,
    managedState: byteChange(100, 50),
    volume: byteChange(1_000, 1_100)
  };
}
