import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanPathSize } from '../src/fs-size.js';

describe('filesystem size scanner', () => {
  test('sums nested regular file sizes without reading file contents', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'a.txt'), 'abc');
    await writeFile(path.join(root, 'nested', 'b.txt'), 'hello');

    const result = await scanPathSize(root, 'fixture-root');

    expect(result).toMatchObject({
      pathCategory: 'fixture-root',
      exists: true,
      bytes: 8,
      files: 2,
      directories: 2,
      symlinksSkipped: 0,
      sizeTruncated: false
    });
    expect(result.warnings).toEqual([]);
  });

  test('measures a root regular file directly', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'single.bin');
    await writeFile(file, 'data');

    const result = await scanPathSize(file, 'single-file');

    expect(result).toMatchObject({
      pathCategory: 'single-file',
      exists: true,
      bytes: 4,
      files: 1,
      directories: 0,
      symlinksSkipped: 0,
      sizeTruncated: false
    });
    expect(result.warnings).toEqual([]);
  });

  test('returns a missing warning instead of throwing for absent paths', async () => {
    const root = await makeTempDir();

    const result = await scanPathSize(path.join(root, 'missing'), 'missing-target');

    expect(result).toMatchObject({
      pathCategory: 'missing-target',
      exists: false,
      bytes: 0,
      files: 0,
      directories: 0,
      symlinksSkipped: 0,
      sizeTruncated: false
    });
    expect(result.warnings).toEqual([
      {
        code: 'missing',
        pathCategory: 'missing-target',
        message: expect.any(String)
      }
    ]);
  });

  test('skips symlinks without counting linked target bytes', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(path.join(root, 'owned.txt'), 'ok');
    await writeFile(path.join(outside, 'large.txt'), 'not-owned-by-scan');
    await symlink(path.join(outside, 'large.txt'), path.join(root, 'link.txt'));

    const result = await scanPathSize(root, 'symlink-root');

    expect(result.bytes).toBe(2);
    expect(result.files).toBe(1);
    expect(result.symlinksSkipped).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toContain('symlink_skipped');
  });

  test('stops descending when maxDepth is reached', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'deep.txt'), 'hidden');

    const result = await scanPathSize(root, 'depth-root', { maxDepth: 1 });

    expect(result.bytes).toBe(0);
    expect(result.directories).toBe(2);
    expect(result.sizeTruncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('max_depth');
  });

  test('stops scanning when maxEntries is reached', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'b.txt'), 'b');
    await writeFile(path.join(root, 'c.txt'), 'c');

    const result = await scanPathSize(root, 'entry-root', { maxEntries: 2 });

    expect(result.files).toBeLessThan(3);
    expect(result.sizeTruncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('max_entries');
  });

  test('limits child entries per directory', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'b.txt'), 'b');
    await writeFile(path.join(root, 'c.txt'), 'c');

    const result = await scanPathSize(root, 'child-root', { maxChildrenPerDir: 1 });

    expect(result.files).toBe(1);
    expect(result.sizeTruncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('max_children');
  });

  const permissionTest = process.getuid?.() === 0 ? test.skip : test;

  permissionTest('reports permission denied directories without throwing', async () => {
    const root = await makeTempDir();
    const denied = path.join(root, 'denied');
    await mkdir(denied);
    await writeFile(path.join(denied, 'secret.txt'), 'secret');

    try {
      await chmod(denied, 0o000);

      const result = await scanPathSize(root, 'permission-root');

      expect(result.sizeTruncated).toBe(true);
      expect(result.warnings.map((warning) => warning.code)).toContain('permission_denied');
    } finally {
      await chmod(denied, 0o700).catch(() => {});
    }
  });

  test('does not include raw absolute paths in warnings', async () => {
    const root = await makeTempDir();
    await symlink(path.join(root, 'missing-target'), path.join(root, 'link'));

    const result = await scanPathSize(root, 'redacted-root');

    expect(JSON.stringify(result.warnings)).not.toContain(root);
    expect(result.warnings.every((warning) => warning.pathCategory === 'redacted-root')).toBe(true);
  });

  test('source implementation does not use content readers, sqlite, or shell helpers', async () => {
    const source = await readFile(path.join(process.cwd(), 'src', 'fs-size.ts'), 'utf8');

    expect(source).not.toMatch(/\breadFile\b/);
    expect(source).not.toMatch(/\bcreateReadStream\b/);
    expect(source).not.toMatch(/\bsqlite\b/i);
    expect(source).not.toMatch(/\brunCommand\b/);
  });
});

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'adm-size-test-'));
}
