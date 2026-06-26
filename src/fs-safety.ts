import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileIdentity, TargetState } from './types.js';

export async function collectFileIdentity(filePath: string, pathCategory: string): Promise<FileIdentity> {
  try {
    const lst = await lstat(filePath);
    const isLink = lst.isSymbolicLink();
    const resolved = isLink ? undefined : await realpath(filePath).catch(() => undefined);
    return {
      pathCategory,
      realpath: resolved,
      dev: lst.dev,
      ino: lst.ino,
      mode: lst.mode,
      uid: lst.uid,
      gid: lst.gid,
      size: lst.size,
      mtimeMs: lst.mtimeMs,
      nlink: lst.nlink,
      exists: true,
      regularFile: lst.isFile(),
      symbolicLink: isLink
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        pathCategory,
        exists: false,
        regularFile: false,
        symbolicLink: false
      };
    }
    throw error;
  }
}

export async function detectTargetState(mainPath: string): Promise<TargetState> {
  const main = await collectFileIdentity(mainPath, 'codex-log-db-main');
  const wal = await collectFileIdentity(`${mainPath}-wal`, 'codex-log-db-wal');
  const shm = await collectFileIdentity(`${mainPath}-shm`, 'codex-log-db-shm');
  const blockers: string[] = [];
  const uid = process.getuid?.();

  if (!main.exists) blockers.push('main database is missing');
  blockers.push(...fileBlockers(main, 'main database', uid));
  for (const sidecar of [wal, shm]) {
    if (!sidecar.exists) continue;
    blockers.push(...fileBlockers(sidecar, sidecar.pathCategory, uid));
  }

  return {
    mainPath,
    exists: main.exists,
    fixable: blockers.length === 0,
    blockers,
    main,
    wal,
    shm
  };
}

function fileBlockers(file: FileIdentity, label: string, uid?: number): string[] {
  if (!file.exists) return [];
  const blockers: string[] = [];
  if (file.symbolicLink) blockers.push(`${label} is a symlink`);
  if (!file.regularFile) blockers.push(`${label} is not a regular file`);
  if (file.nlink !== undefined && file.nlink > 1) blockers.push(`${label} has hard links`);
  if (uid !== undefined && file.uid !== uid) blockers.push(`${label} is not owned by current user`);
  if (file.mode !== undefined && (file.mode & 0o022) !== 0) {
    blockers.push(`${label} is group/other writable`);
  }
  return blockers;
}

export async function assertDirectoryChainSafe(startDir: string, stopDir: string): Promise<string[]> {
  const blockers: string[] = [];
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  const uid = process.getuid?.();

  while (current === stop || current.startsWith(`${stop}${path.sep}`)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) blockers.push(`${current} is a symlink`);
    if (uid !== undefined && info.uid !== uid) blockers.push(`${current} is not owned by current user`);
    if ((info.mode & 0o022) !== 0) blockers.push(`${current} is group/other writable`);
    if (current === stop) break;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return blockers;
}

export async function assertPrivateAppDirSafe(dir: string): Promise<string[]> {
  return await checkPrivateAppDirSafe(dir, { createMissing: true });
}

export async function assertExistingPrivateDirSafe(dir: string): Promise<string[]> {
  return await checkPrivateAppDirSafe(dir, { createMissing: false });
}

async function checkPrivateAppDirSafe(dir: string, options: { createMissing: boolean }): Promise<string[]> {
  const blockers: string[] = [];
  const resolved = path.resolve(dir);
  const uid = process.getuid?.();
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const markerIndex = parts.indexOf('.ai-dev-maintenance');
  const startIndex = markerIndex >= 0 ? markerIndex : parts.length - 1;
  let current = path.join(root, ...parts.slice(0, startIndex));
  for (const [offset, part] of parts.slice(startIndex).entries()) {
    current = path.join(current, part);
    let info = await lstat(current).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.createMissing) {
        blockers.push(`${offset === 0 ? '<app-data>' : `<app-data-component:${offset}>`} is missing`);
        return undefined;
      }
      await mkdir(current, { mode: 0o700 });
      return await lstat(current);
    });
    const label = offset === 0 ? '<app-data>' : `<app-data-component:${offset}>`;
    if (!info) return blockers;
    if (info.isSymbolicLink()) {
      blockers.push(`${label} is a symlink`);
      return blockers;
    }
    if (!info.isDirectory()) {
      blockers.push(`${label} is not a directory`);
      return blockers;
    }
    if (uid !== undefined && info.uid !== uid) blockers.push(`${label} is not owned by current user`);
    if ((info.mode & 0o022) !== 0) blockers.push(`${label} is group/other writable`);
    else if ((info.mode & 0o077) !== 0) blockers.push(`${label} exposes group/other permissions`);
    if (blockers.length > 0) return blockers;
  }
  return blockers;
}

export async function assertSafeReadablePrivateFile(filePath: string, label: string): Promise<string[]> {
  const blockers: string[] = [];
  const uid = process.getuid?.();
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [`${label} is missing`];
    throw error;
  }
  if (info.isSymbolicLink()) blockers.push(`${label} is a symlink`);
  if (!info.isFile()) blockers.push(`${label} is not a regular file`);
  if (info.nlink > 1) blockers.push(`${label} has hard links`);
  if (uid !== undefined && info.uid !== uid) blockers.push(`${label} is not owned by current user`);
  if ((info.mode & 0o022) !== 0) blockers.push(`${label} is group/other writable`);
  return blockers;
}

export function compareTargetIdentities(
  before: TargetState,
  after: TargetState,
  options: { allowSidecarSizeMtimeChange: boolean; allowMainSizeMtimeChange?: boolean }
): string[] {
  const blockers: string[] = [];
  compareFileIdentity('main database', before.main, after.main, Boolean(options.allowMainSizeMtimeChange), blockers);
  compareFileIdentity('codex-log-db-wal', before.wal, after.wal, options.allowSidecarSizeMtimeChange, blockers);
  compareFileIdentity('codex-log-db-shm', before.shm, after.shm, options.allowSidecarSizeMtimeChange, blockers);
  return blockers;
}

function compareFileIdentity(
  label: string,
  before: FileIdentity | undefined,
  after: FileIdentity | undefined,
  allowSizeMtimeChange: boolean,
  blockers: string[]
) {
  if (!before?.exists && !after?.exists) return;
  const stableKeys: Array<keyof FileIdentity> = [
    'exists',
    'regularFile',
    'symbolicLink',
    'dev',
    'ino',
    'nlink',
    'mode',
    'uid',
    'gid'
  ];
  for (const key of stableKeys) {
    if (before?.[key] !== after?.[key]) {
      blockers.push(`${label} identity changed`);
      return;
    }
  }
  if (!allowSizeMtimeChange && (before?.size !== after?.size || before?.mtimeMs !== after?.mtimeMs)) {
    blockers.push(`${label} identity changed`);
  }
}

export function safeTargetStateForReport(state: TargetState) {
  return {
    exists: state.exists,
    fixable: state.fixable,
    blockers: state.blockers,
    main: safeIdentityForReport(state.main),
    wal: safeIdentityForReport(state.wal),
    shm: safeIdentityForReport(state.shm)
  };
}

function safeIdentityForReport(file: FileIdentity | undefined) {
  if (!file) return undefined;
  return {
    pathCategory: file.pathCategory,
    exists: file.exists,
    regularFile: file.regularFile,
    symbolicLink: file.symbolicLink,
    size: file.size
  };
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
