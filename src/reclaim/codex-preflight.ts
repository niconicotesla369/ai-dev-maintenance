import type { Stats } from 'node:fs';
import { lstat, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  batchCommandArguments,
  runCommand,
  trustedCommandPath
} from '../commands.js';
import { collectFileIdentity } from '../fs-safety.js';
import { defaultCodexHome, resolveHome } from '../paths.js';
import { classifyLsofResult } from '../safety.js';
import type { FileIdentity } from '../types.js';

export type CodexMutationPreflight = {
  allowed: boolean;
  blockedReasons: string[];
  availableBytes?: number;
  requiredTemporaryBytes: number;
};

type CodexMutationTarget = {
  path: string;
  identity: FileIdentity;
};

type TrustedSessionRoots = {
  sessionsRoot: string;
  canonicalSessionsRoot: string;
};

const GIB = 1024 ** 3;
const MINIMUM_AVAILABLE_BYTES = 5 * GIB;
const TEMPORARY_RESERVE_BYTES = GIB;
const LSOF_MAX_TARGETS_PER_BATCH = 64;
const LSOF_MAX_ARGV_BYTES = 32 * 1024;

export async function preflightCodexSessionMutation(options: {
  env?: NodeJS.ProcessEnv;
  targets: CodexMutationTarget[];
  requiredTemporaryBytes: number;
  processList?: string;
}): Promise<CodexMutationPreflight> {
  const requiredTemporaryBytes = nonNegativeSafeInteger(
    options.requiredTemporaryBytes,
    'requiredTemporaryBytes'
  );
  const result: CodexMutationPreflight = {
    allowed: false,
    blockedReasons: [],
    requiredTemporaryBytes
  };

  if (process.platform !== 'darwin') {
    result.blockedReasons.push('platform-unsupported');
    return result;
  }

  const env = options.env ?? process.env;
  const codexHome = defaultCodexHome(env);
  if (codexHome.custom) {
    result.blockedReasons.push('custom-codex-home-unsupported');
    return result;
  }
  if (options.targets.length === 0) {
    result.blockedReasons.push('no-targets');
    return result;
  }

  const roots = await trustedSessionRoots(env);
  if (!roots) {
    result.blockedReasons.push('unsafe-target');
    return result;
  }

  result.blockedReasons.push(...await targetBlockers(options.targets, roots));
  if (result.blockedReasons.length > 0) {
    result.blockedReasons = uniqueInOrder(result.blockedReasons);
    return result;
  }

  const processCheck = await collectProcessList(options.processList);
  if (!processCheck.usable) {
    result.blockedReasons.push('process-check-unavailable');
  } else if (codexProcessRunning(processCheck.output)) {
    result.blockedReasons.push('codex-process-running');
  }
  if (result.blockedReasons.length > 0) return result;

  const handleCheck = await checkTargetHandles(options.targets.map((target) => target.path));
  if (!handleCheck.usable) {
    result.blockedReasons.push('open-handle-check-unavailable');
  } else if (handleCheck.open) {
    result.blockedReasons.push('target-open');
  }
  if (result.blockedReasons.length > 0) return result;

  try {
    const snapshot = await statfs(roots.sessionsRoot);
    const availableBytes = safeAvailableBytes(snapshot.bsize, snapshot.bavail);
    if (availableBytes === undefined) {
      result.blockedReasons.push('free-space-check-unavailable');
      return result;
    }
    result.availableBytes = availableBytes;
    const withReserve = safeAdd(requiredTemporaryBytes, TEMPORARY_RESERVE_BYTES);
    if (
      withReserve === undefined
      || availableBytes < MINIMUM_AVAILABLE_BYTES
      || availableBytes < withReserve
    ) {
      result.blockedReasons.push('insufficient-free-space');
      return result;
    }
  } catch {
    result.blockedReasons.push('free-space-check-unavailable');
    return result;
  }

  const finalRoots = await trustedSessionRoots(env);
  if (
    !finalRoots
    || finalRoots.canonicalSessionsRoot !== roots.canonicalSessionsRoot
  ) {
    result.blockedReasons.push('unsafe-target');
    return result;
  }

  result.blockedReasons.push(...await targetBlockers(options.targets, finalRoots));
  result.blockedReasons = uniqueInOrder(result.blockedReasons);
  result.allowed = result.blockedReasons.length === 0;
  return result;
}

async function trustedSessionRoots(
  env: NodeJS.ProcessEnv
): Promise<TrustedSessionRoots | undefined> {
  const homeRoot = resolveHome(env);
  const codexRoot = path.join(homeRoot, '.codex');
  const sessionsRoot = path.join(codexRoot, 'sessions');
  const [homeInfo, codexInfo, sessionsInfo] = await Promise.all([
    safeLstat(homeRoot),
    safeLstat(codexRoot),
    safeLstat(sessionsRoot)
  ]);
  if (
    !homeInfo || !safeDirectoryInfo(homeInfo)
    || !codexInfo || !safeDirectoryInfo(codexInfo)
    || !sessionsInfo || !safeDirectoryInfo(sessionsInfo)
  ) {
    return undefined;
  }

  const [canonicalHome, canonicalCodex, canonicalSessions] = await Promise.all([
    realpath(homeRoot).catch(() => undefined),
    realpath(codexRoot).catch(() => undefined),
    realpath(sessionsRoot).catch(() => undefined)
  ]);
  if (
    !canonicalHome || !canonicalCodex || !canonicalSessions
    || canonicalCodex !== path.join(canonicalHome, '.codex')
    || canonicalSessions !== path.join(canonicalCodex, 'sessions')
  ) {
    return undefined;
  }
  return { sessionsRoot, canonicalSessionsRoot: canonicalSessions };
}

async function targetBlockers(
  targets: CodexMutationTarget[],
  roots: TrustedSessionRoots
): Promise<string[]> {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const resolvedPath = path.resolve(target.path);
    if (seen.has(resolvedPath)) blockers.push('duplicate-target');
    seen.add(resolvedPath);

    if (
      target.path !== resolvedPath
      || !target.path.endsWith('.jsonl')
      || !containedBy(roots.sessionsRoot, resolvedPath)
      || !await safeDirectoryChain(path.dirname(resolvedPath), roots.sessionsRoot)
      || !safeIdentity(target.identity, roots.canonicalSessionsRoot)
    ) {
      blockers.push('unsafe-target');
    }

    const current = await collectFileIdentity(
      resolvedPath,
      '<home>/.codex/sessions/<session-file>'
    ).catch(() => undefined);
    if (!current || !safeIdentity(current, roots.canonicalSessionsRoot)) {
      blockers.push('unsafe-target');
    }
    if (!current || !sameIdentity(target.identity, current)) {
      blockers.push('target-identity-changed');
    }
    if (await pathMayExist(`${resolvedPath}.zst`)) {
      blockers.push('compressed-session-state');
    }
  }
  return uniqueInOrder(blockers);
}

async function collectProcessList(
  provided: string | undefined
): Promise<{ usable: true; output: string } | { usable: false; output: '' }> {
  if (provided !== undefined) {
    return processOutputIsWellFormed(provided, false)
      ? { usable: true, output: provided }
      : { usable: false, output: '' };
  }
  try {
    const ps = await trustedCommandPath('ps');
    const result = await runCommand(ps, ['-axo', 'pid=,command='], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 16 * 1024
    });
    if (
      result.code !== 0
      || result.timedOut
      || result.stdoutTruncated
      || result.stderrTruncated
      || result.stderr.trim().length > 0
      || !processOutputIsWellFormed(result.stdout, true)
    ) {
      return { usable: false, output: '' };
    }
    return { usable: true, output: result.stdout };
  } catch {
    return { usable: false, output: '' };
  }
}

function processOutputIsWellFormed(processList: string, requireCurrentProcess: boolean): boolean {
  const lines = processList.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return !requireCurrentProcess;
  let includesCurrentProcess = false;
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return false;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    if (pid === process.pid) includesCurrentProcess = true;
  }
  return !requireCurrentProcess || includesCurrentProcess;
}

function codexProcessRunning(processList: string): boolean {
  for (const line of processList.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (Number(match[1]) === process.pid) continue;
    const command = match[2];
    const lower = command.toLowerCase();
    if (lower.includes('/codex.app/')) return true;
    if (/(?:^|\/)codex helper(?:\s|\(|\.app\/|$)/i.test(command)) return true;
    const executable = command.match(/^(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean);
    const basename = executable ? path.basename(executable).toLowerCase() : '';
    if (basename === 'codex' || basename === 'codex-cli') return true;
  }
  return false;
}

async function checkTargetHandles(
  paths: string[]
): Promise<{ usable: boolean; open: boolean }> {
  try {
    const lsof = await trustedCommandPath('lsof');
    const batches = batchCommandArguments(['-F', 'pcn'], paths, {
      executable: lsof,
      maxValuesPerBatch: LSOF_MAX_TARGETS_PER_BATCH,
      maxBytesPerBatch: LSOF_MAX_ARGV_BYTES
    });
    for (const args of batches) {
      const commandResult = await runCommand(lsof, args, {
        timeoutMs: 5_000,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 64 * 1024
      });
      if (commandResult.stderr.trim().length > 0) {
        return { usable: false, open: false };
      }
      const classification = classifyLsofResult(commandResult);
      if (!classification.usable) return { usable: false, open: false };
      if (classification.openHandles) return { usable: true, open: true };
    }
    return { usable: true, open: false };
  } catch {
    return { usable: false, open: false };
  }
}

async function safeDirectoryChain(directory: string, stop: string): Promise<boolean> {
  let current = path.resolve(directory);
  const root = path.resolve(stop);
  if (current !== root && !containedBy(root, current)) return false;
  while (current === root || containedBy(root, current)) {
    const info = await safeLstat(current);
    if (!info || !safeDirectoryInfo(info)) return false;
    if (current === root) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

function safeDirectoryInfo(info: Stats): boolean {
  const uid = process.getuid?.();
  return info.isDirectory()
    && !info.isSymbolicLink()
    && (uid === undefined || info.uid === uid)
    && (info.mode & 0o022) === 0;
}

function safeIdentity(identity: FileIdentity, sessionsRoot: string): boolean {
  const uid = process.getuid?.();
  return identity.exists
    && identity.regularFile
    && !identity.symbolicLink
    && identity.nlink === 1
    && (uid === undefined || identity.uid === uid)
    && identity.mode !== undefined
    && (identity.mode & 0o022) === 0
    && typeof identity.realpath === 'string'
    && containedBy(sessionsRoot, identity.realpath);
}

function sameIdentity(before: FileIdentity, after: FileIdentity): boolean {
  const keys: Array<keyof FileIdentity> = [
    'exists',
    'regularFile',
    'symbolicLink',
    'realpath',
    'dev',
    'ino',
    'mode',
    'uid',
    'gid',
    'size',
    'mtimeMs',
    'nlink'
  ];
  return keys.every((key) => before[key] === after[key]);
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

async function safeLstat(target: string): Promise<Stats | undefined> {
  return await lstat(target).catch(() => undefined);
}

async function pathMayExist(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function safeAvailableBytes(blockSize: number, availableBlocks: number): number | undefined {
  if (
    !Number.isSafeInteger(blockSize)
    || blockSize <= 0
    || !Number.isSafeInteger(availableBlocks)
    || availableBlocks < 0
  ) {
    return undefined;
  }
  const bytes = blockSize * availableBlocks;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function safeAdd(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}
