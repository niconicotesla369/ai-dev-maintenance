import type { Stats } from 'node:fs';
import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, trustedCommandPath } from '../commands.js';
import { resolveHome } from '../paths.js';

const INSTALLED_CODEX = '/Applications/Codex.app';
const BUNDLE_ID = 'com.openai.codex';
const SPARKLE_COMPONENTS = [
  'Library',
  'Caches',
  'com.openai.codex',
  'org.sparkle-project.Sparkle'
] as const;
const ALLOWED_ROOT_CHILDREN = new Set(['Installation', 'Launcher', 'PersistentDownloads']);
const TARGET_CATEGORY =
  '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/<item>';
const MAX_TREE_ENTRIES = 100_000;
const MAX_CHILDREN_PER_DIRECTORY = 10_000;
const MAX_TREE_DEPTH = 64;
const MAX_IDENTITY_PATH_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_PLIST_OUTPUT_BYTES = 4 * 1024;
const MAX_EXPECTED_TARGETS = 10_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;

type TreeEntry = {
  relativePath: string;
  type: 'directory' | 'file';
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
};

type TreeIdentity = {
  version: 1;
  rootRealpath: string;
  totalBytes: number;
  entries: TreeEntry[];
};

type BundleMetadata = {
  bundleId: string;
  shortVersion: string;
  buildVersion: string;
};

export type CodexSparkleTarget = {
  path: string;
  pathCategory: string;
  bytes: number;
  identity: unknown;
};

export type CodexSparklePlan = {
  status: 'ready' | 'blocked';
  reclaimableBytes: number;
  targets: CodexSparkleTarget[];
  blockedReasons: string[];
  warnings: string[];
};

export type CodexSparkleResult = {
  status: 'ok' | 'partial' | 'blocked';
  changed: boolean;
  deletedBytes: number;
  deletedEntries: number;
  volumeFreeDeltaBytes?: number;
  blockedReasons: string[];
  warnings: string[];
};

type TrustedRoots = {
  sparkleRoot: string;
  installationRoot: string;
  rootChildren: string[];
  installationChildren: string[];
};

type NormalizedTarget = Omit<CodexSparkleTarget, 'identity'> & { identity: TreeIdentity };

export async function planCodexSparkleCleanup(options: {
  env?: NodeJS.ProcessEnv;
  processList?: string;
} = {}): Promise<CodexSparklePlan> {
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  const env = options.env ?? process.env;

  const processCheck = await collectProcessList(options.processList);
  if (!processCheck.usable) blockedReasons.push('process-check-unavailable');
  else if (codexOrUpdaterRunning(processCheck.output)) {
    blockedReasons.push('codex-updater-process-running');
  }
  if (blockedReasons.length > 0) return blockedPlan(blockedReasons, warnings);

  try {
    const rootsBefore = await inspectTrustedRoots(env);
    const installed = await inspectBundle(INSTALLED_CODEX, 0, 'installed-codex-unavailable');
    if (installed.metadata.bundleId !== BUNDLE_ID) {
      throw sparkleError('installed-codex-unavailable');
    }
    const installedShort = parseVersion(installed.metadata.shortVersion);
    const installedBuild = parseVersion(installed.metadata.buildVersion);
    if (!installedShort || !installedBuild) throw sparkleError('installed-codex-unavailable');

    const targets: NormalizedTarget[] = [];
    for (const child of rootsBefore.installationChildren) {
      const targetPath = path.join(rootsBefore.installationRoot, child);
      const candidate = await inspectStagedTarget(targetPath);
      if (candidate.metadata.bundleId !== BUNDLE_ID) {
        throw sparkleError('staged-codex-ineligible');
      }
      const stagedShort = parseVersion(candidate.metadata.shortVersion);
      const stagedBuild = parseVersion(candidate.metadata.buildVersion);
      if (
        !stagedShort
        || !stagedBuild
        || compareVersion(stagedShort, installedShort) > 0
        || (
          compareVersion(stagedShort, installedShort) === 0
          && compareVersion(stagedBuild, installedBuild) > 0
        )
      ) {
        throw sparkleError('staged-codex-ineligible');
      }
      targets.push({
        path: targetPath,
        pathCategory: TARGET_CATEGORY,
        bytes: candidate.identity.totalBytes,
        identity: candidate.identity
      });
    }

    const rootsAfter = await inspectTrustedRoots(env);
    if (!sameRootShape(rootsBefore, rootsAfter)) throw sparkleError('sparkle-root-drift');
    const reclaimableBytes = safeSum(targets.map((target) => target.bytes));
    if (reclaimableBytes === undefined) throw sparkleError('sparkle-size-invalid');
    return {
      status: 'ready',
      reclaimableBytes,
      targets,
      blockedReasons: [],
      warnings
    };
  } catch (error) {
    blockedReasons.push(sparkleErrorCode(error, 'sparkle-inspection-failed'));
    return blockedPlan(blockedReasons, warnings);
  }
}

export async function runCodexSparkleCleanup(options: {
  env?: NodeJS.ProcessEnv;
  expectedTargets: CodexSparklePlan['targets'];
}): Promise<CodexSparkleResult> {
  const env = options.env ?? process.env;
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  let deletedBytes = 0;
  let deletedEntries = 0;
  let changed = false;
  let beforeAvailable: number | undefined;
  let installationRoot: string | undefined;

  const expected = normalizeExpectedTargets(options.expectedTargets, env);
  if (!expected) {
    return result('blocked', false, 0, 0, ['invalid-sparkle-plan'], warnings);
  }

  try {
    const roots = await inspectTrustedRoots(env);
    installationRoot = roots.installationRoot;
    beforeAvailable = await availableBytesFor(installationRoot);
  } catch (error) {
    return result(
      'blocked',
      false,
      0,
      0,
      [sparkleErrorCode(error, 'sparkle-inspection-failed')],
      warnings
    );
  }

  for (const target of expected) {
    let current: TreeIdentity;
    try {
      current = await revalidateTarget(env, target);
    } catch (error) {
      blockedReasons.push(sparkleErrorCode(error, 'sparkle-preflight-failed'));
      break;
    }

    try {
      await rm(target.path, { recursive: true, force: false });
      if (await pathMayExist(target.path)) throw sparkleError('sparkle-delete-unverified');
      changed = true;
      deletedEntries += 1;
      deletedBytes = safeAdd(deletedBytes, target.bytes) ?? deletedBytes;
    } catch (error) {
      const afterFailure = await collectTreeIdentity(target.path, process.getuid?.())
        .catch(() => undefined);
      if (!afterFailure || !sameTreeIdentity(current, afterFailure)) changed = true;
      blockedReasons.push(sparkleErrorCode(error, 'sparkle-delete-failed'));
      break;
    }
  }

  let volumeFreeDeltaBytes: number | undefined;
  if (installationRoot && beforeAvailable !== undefined) {
    const afterAvailable = await availableBytesFor(installationRoot);
    if (afterAvailable === undefined) warnings.push('volume-free-delta-unavailable');
    else {
      const delta = afterAvailable - beforeAvailable;
      if (Number.isSafeInteger(delta)) volumeFreeDeltaBytes = delta;
      else warnings.push('volume-free-delta-unavailable');
    }
  } else if (expected.length > 0) {
    warnings.push('volume-free-delta-unavailable');
  }

  const status = blockedReasons.length === 0 ? 'ok' : changed ? 'partial' : 'blocked';
  return result(
    status,
    changed,
    deletedBytes,
    deletedEntries,
    blockedReasons,
    warnings,
    volumeFreeDeltaBytes
  );
}

async function revalidateTarget(
  env: NodeJS.ProcessEnv,
  target: NormalizedTarget
): Promise<TreeIdentity> {
  const rootsBefore = await inspectTrustedRoots(env);
  if (!isDirectTarget(target.path, rootsBefore.installationRoot)) {
    throw sparkleError('invalid-sparkle-plan');
  }
  if (!rootsBefore.installationChildren.includes(path.basename(target.path))) {
    throw sparkleError('sparkle-target-drift');
  }

  const installed = await inspectBundle(INSTALLED_CODEX, 0, 'installed-codex-unavailable');
  const staged = await inspectStagedTarget(target.path);
  if (installed.metadata.bundleId !== BUNDLE_ID || staged.metadata.bundleId !== BUNDLE_ID) {
    throw sparkleError('staged-codex-ineligible');
  }
  const installedShort = parseVersion(installed.metadata.shortVersion);
  const installedBuild = parseVersion(installed.metadata.buildVersion);
  const stagedShort = parseVersion(staged.metadata.shortVersion);
  const stagedBuild = parseVersion(staged.metadata.buildVersion);
  if (
    !installedShort
    || !installedBuild
    || !stagedShort
    || !stagedBuild
    || compareVersion(stagedShort, installedShort) > 0
    || (
      compareVersion(stagedShort, installedShort) === 0
      && compareVersion(stagedBuild, installedBuild) > 0
    )
  ) {
    throw sparkleError('staged-codex-ineligible');
  }
  if (
    target.bytes !== staged.identity.totalBytes
    || !sameTreeIdentity(target.identity, staged.identity)
  ) {
    throw sparkleError('sparkle-target-drift');
  }

  const rootsAfter = await inspectTrustedRoots(env);
  if (!sameRootShape(rootsBefore, rootsAfter)) throw sparkleError('sparkle-root-drift');

  const processCheck = await collectProcessList(undefined);
  if (!processCheck.usable) throw sparkleError('process-check-unavailable');
  if (codexOrUpdaterRunning(processCheck.output)) {
    throw sparkleError('codex-updater-process-running');
  }

  const finalIdentity = await collectTreeIdentity(target.path, process.getuid?.());
  if (!sameTreeIdentity(target.identity, finalIdentity)) {
    throw sparkleError('sparkle-target-drift');
  }
  return finalIdentity;
}

async function inspectTrustedRoots(env: NodeJS.ProcessEnv): Promise<TrustedRoots> {
  const home = resolveHome(env);
  const uid = process.getuid?.();
  if (uid === undefined) throw sparkleError('sparkle-root-unavailable');
  const sparkleRoot = path.join(home, ...SPARKLE_COMPONENTS);
  let current = home;
  await assertSafeDirectory(current, uid);
  for (const component of SPARKLE_COMPONENTS) {
    current = path.join(current, component);
    await assertSafeDirectory(current, uid);
  }
  if (current !== sparkleRoot) throw sparkleError('sparkle-root-unavailable');

  const rootChildren = await boundedDirectoryNames(sparkleRoot);
  if (rootChildren.some((name) => !ALLOWED_ROOT_CHILDREN.has(name))) {
    throw sparkleError('sparkle-root-shape-unsupported');
  }
  const installationRoot = path.join(sparkleRoot, 'Installation');
  if (!rootChildren.includes('Installation')) throw sparkleError('sparkle-root-unavailable');
  for (const child of rootChildren) {
    await assertSafeDirectory(path.join(sparkleRoot, child), uid);
  }

  const installationChildren = await boundedDirectoryNames(installationRoot);
  for (const child of installationChildren) {
    await assertSafeDirectory(path.join(installationRoot, child), uid);
  }
  return { sparkleRoot, installationRoot, rootChildren, installationChildren };
}

async function assertSafeDirectory(target: string, expectedUid: number): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (
    !info
    || !info.isDirectory()
    || info.isSymbolicLink()
    || info.uid !== expectedUid
    || (info.mode & 0o022) !== 0
  ) {
    throw sparkleError('sparkle-root-unavailable');
  }
  const canonical = await realpath(target).catch(() => undefined);
  if (canonical !== target) throw sparkleError('sparkle-root-unavailable');
}

async function inspectStagedTarget(targetPath: string): Promise<{
  identity: TreeIdentity;
  metadata: BundleMetadata;
}> {
  const uid = process.getuid?.();
  if (uid === undefined) throw sparkleError('staged-codex-ineligible');
  const before = await collectTreeIdentity(targetPath, uid);
  const appPaths = before.entries
    .filter((entry) => entry.type === 'directory' && path.basename(entry.relativePath) === 'Codex.app')
    .map((entry) => path.join(targetPath, entry.relativePath));
  if (appPaths.length !== 1) throw sparkleError('staged-app-count-invalid');
  const appPath = appPaths[0];
  if (!appPath) throw sparkleError('staged-app-count-invalid');
  const metadata = await readBundleMetadata(appPath);
  const after = await collectTreeIdentity(targetPath, uid);
  if (!sameTreeIdentity(before, after)) throw sparkleError('sparkle-target-drift');
  return { identity: after, metadata };
}

async function inspectBundle(
  appPath: string,
  expectedUid: number,
  errorCode: string
): Promise<{ identity: TreeIdentity; metadata: BundleMetadata }> {
  try {
    const before = await collectTreeIdentity(appPath, expectedUid);
    const metadata = await readBundleMetadata(appPath);
    const after = await collectTreeIdentity(appPath, expectedUid);
    if (!sameTreeIdentity(before, after)) throw sparkleError(errorCode);
    return { identity: after, metadata };
  } catch {
    throw sparkleError(errorCode);
  }
}

async function readBundleMetadata(appPath: string): Promise<BundleMetadata> {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const [bundleId, shortVersion, buildVersion] = await Promise.all([
    readPlistValue(infoPlist, 'CFBundleIdentifier'),
    readPlistValue(infoPlist, 'CFBundleShortVersionString'),
    readPlistValue(infoPlist, 'CFBundleVersion')
  ]);
  return { bundleId, shortVersion, buildVersion };
}

async function readPlistValue(plistPath: string, key: string): Promise<string> {
  const plutil = await trustedCommandPath('plutil');
  const commandResult = await runCommand(
    plutil,
    ['-extract', key, 'raw', '-o', '-', plistPath],
    {
      timeoutMs: 5_000,
      maxStdoutBytes: MAX_PLIST_OUTPUT_BYTES,
      maxStderrBytes: MAX_PLIST_OUTPUT_BYTES
    }
  );
  if (
    commandResult.code !== 0
    || commandResult.timedOut
    || commandResult.stdoutTruncated
    || commandResult.stderrTruncated
    || commandResult.stderr.trim().length > 0
  ) {
    throw sparkleError('plist-check-unavailable');
  }
  const rawValue = commandResult.stdout.endsWith('\n')
    ? commandResult.stdout.slice(0, -1)
    : commandResult.stdout;
  if (
    rawValue.length === 0
    || rawValue.trim() !== rawValue
    || rawValue.includes('\n')
    || rawValue.includes('\r')
    || rawValue.includes('\0')
  ) {
    throw sparkleError('plist-check-unavailable');
  }
  return rawValue;
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
    const commandResult = await runCommand(ps, ['-axo', 'pid=,command='], {
      timeoutMs: 5_000,
      maxStdoutBytes: MAX_PROCESS_OUTPUT_BYTES,
      maxStderrBytes: 16 * 1024
    });
    if (
      commandResult.code !== 0
      || commandResult.timedOut
      || commandResult.stdoutTruncated
      || commandResult.stderrTruncated
      || commandResult.stderr.trim().length > 0
      || !processOutputIsWellFormed(commandResult.stdout, true)
    ) {
      return { usable: false, output: '' };
    }
    return { usable: true, output: commandResult.stdout };
  } catch {
    return { usable: false, output: '' };
  }
}

function processOutputIsWellFormed(processList: string, requireCurrentProcess: boolean): boolean {
  const lines = processList.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return !requireCurrentProcess;
  let includesCurrentProcess = false;
  for (const line of lines) {
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) return false;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    if (pid === process.pid) includesCurrentProcess = true;
  }
  return !requireCurrentProcess || includesCurrentProcess;
}

function codexOrUpdaterRunning(processList: string): boolean {
  for (const line of processList.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = match[2];
    const lower = command.toLowerCase();
    const executable = command.match(/^(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean);
    const basename = executable ? path.basename(executable).toLowerCase() : '';
    if (lower.includes('/codex.app/')) return true;
    if (/(?:^|\/)codex helper(?:\s|\(|\.app\/|$)/i.test(command)) return true;
    if (basename === 'codex' || basename === 'codex-cli') return true;
    if (
      lower.includes('/sparkle.framework/')
      || lower.includes('org.sparkle-project.sparkle')
      || /(?:^|[\s/])(shipit|autoupdate)(?:\.app)?(?:[\s/]|$)/i.test(command)
    ) return true;
  }
  return false;
}

async function collectTreeIdentity(rootPath: string, expectedUid: number | undefined): Promise<TreeIdentity> {
  if (expectedUid === undefined) throw sparkleError('tree-identity-unsafe');
  const canonicalRoot = await realpath(rootPath).catch(() => undefined);
  if (canonicalRoot !== rootPath) throw sparkleError('tree-identity-unsafe');

  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: rootPath, relativePath: '', depth: 0 }
  ];
  const entries: TreeEntry[] = [];
  const seenDirectories = new Set<string>();
  let rootDevice: number | undefined;
  let totalBytes = 0;
  let pathBytes = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current || entries.length >= MAX_TREE_ENTRIES || current.depth > MAX_TREE_DEPTH) {
      throw sparkleError('tree-enumeration-bounded');
    }
    const info = await lstat(current.absolutePath);
    assertSafeTreeEntry(info, expectedUid);
    if (rootDevice === undefined) rootDevice = info.dev;
    if (info.dev !== rootDevice) throw sparkleError('tree-identity-unsafe');

    const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined;
    if (!type) throw sparkleError('tree-identity-unsafe');
    const entry = treeEntry(current.relativePath, type, info);
    entries.push(entry);
    pathBytes += Buffer.byteLength(current.relativePath);
    if (!Number.isSafeInteger(pathBytes) || pathBytes > MAX_IDENTITY_PATH_BYTES) {
      throw sparkleError('tree-enumeration-bounded');
    }
    if (type === 'file') {
      totalBytes = safeAdd(totalBytes, info.size) ?? -1;
      if (totalBytes < 0) throw sparkleError('sparkle-size-invalid');
      continue;
    }

    const inodeKey = `${info.dev}:${info.ino}`;
    if (seenDirectories.has(inodeKey)) throw sparkleError('tree-identity-unsafe');
    seenDirectories.add(inodeKey);
    const children = await boundedDirectoryNames(current.absolutePath);
    for (const child of children) {
      queue.push({
        absolutePath: path.join(current.absolutePath, child),
        relativePath: current.relativePath ? path.join(current.relativePath, child) : child,
        depth: current.depth + 1
      });
    }
  }

  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return { version: 1, rootRealpath: canonicalRoot, totalBytes, entries };
}

function assertSafeTreeEntry(info: Stats, expectedUid: number): void {
  if (
    info.isSymbolicLink()
    || (!info.isDirectory() && !info.isFile())
    || info.uid !== expectedUid
    || (info.mode & 0o022) !== 0
    || (info.isFile() && info.nlink !== 1)
  ) {
    throw sparkleError('tree-identity-unsafe');
  }
  const integers = [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw sparkleError('tree-identity-unsafe');
  }
  if (!Number.isFinite(info.mtimeMs) || info.mtimeMs < 0) {
    throw sparkleError('tree-identity-unsafe');
  }
}

function treeEntry(relativePath: string, type: TreeEntry['type'], info: Stats): TreeEntry {
  return {
    relativePath,
    type,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs
  };
}

async function boundedDirectoryNames(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  if (names.length > MAX_CHILDREN_PER_DIRECTORY) throw sparkleError('tree-enumeration-bounded');
  return [...names].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeExpectedTargets(
  targets: CodexSparklePlan['targets'],
  env: NodeJS.ProcessEnv
): NormalizedTarget[] | undefined {
  if (!Array.isArray(targets) || targets.length > MAX_EXPECTED_TARGETS) return undefined;
  const installationRoot = path.join(resolveHome(env), ...SPARKLE_COMPONENTS, 'Installation');
  const normalized: NormalizedTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (!isPlainRecord(target)) return undefined;
    const targetPath = ownPrimitive(target, 'path', 'string');
    const pathCategory = ownPrimitive(target, 'pathCategory', 'string');
    const bytes = ownPrimitive(target, 'bytes', 'number');
    const identityValue = ownValue(target, 'identity');
    if (
      typeof targetPath !== 'string'
      || pathCategory !== TARGET_CATEGORY
      || typeof bytes !== 'number'
      || !Number.isSafeInteger(bytes)
      || bytes < 0
      || !isDirectTarget(targetPath, installationRoot)
      || seen.has(targetPath)
    ) {
      return undefined;
    }
    const identity = normalizeTreeIdentity(identityValue);
    if (!identity || identity.rootRealpath !== targetPath || identity.totalBytes !== bytes) {
      return undefined;
    }
    seen.add(targetPath);
    normalized.push({ path: targetPath, pathCategory, bytes, identity });
  }
  return safeSum(normalized.map((target) => target.bytes)) === undefined ? undefined : normalized;
}

function normalizeTreeIdentity(value: unknown): TreeIdentity | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (ownPrimitive(value, 'version', 'number') !== 1) return undefined;
  const rootRealpath = ownPrimitive(value, 'rootRealpath', 'string');
  const totalBytes = ownPrimitive(value, 'totalBytes', 'number');
  const entriesValue = ownValue(value, 'entries');
  if (
    typeof rootRealpath !== 'string'
    || typeof totalBytes !== 'number'
    || !Number.isSafeInteger(totalBytes)
    || totalBytes < 0
    || !Array.isArray(entriesValue)
    || entriesValue.length === 0
    || entriesValue.length > MAX_TREE_ENTRIES
  ) {
    return undefined;
  }
  const entries: TreeEntry[] = [];
  for (let index = 0; index < entriesValue.length; index += 1) {
    const entry = normalizeTreeEntry(ownArrayValue(entriesValue, index));
    if (!entry) return undefined;
    entries.push(entry);
  }
  return { version: 1, rootRealpath, totalBytes, entries };
}

function normalizeTreeEntry(value: unknown): TreeEntry | undefined {
  if (!isPlainRecord(value)) return undefined;
  const relativePath = ownPrimitive(value, 'relativePath', 'string');
  const type = ownPrimitive(value, 'type', 'string');
  const dev = ownPrimitive(value, 'dev', 'number');
  const ino = ownPrimitive(value, 'ino', 'number');
  const mode = ownPrimitive(value, 'mode', 'number');
  const uid = ownPrimitive(value, 'uid', 'number');
  const gid = ownPrimitive(value, 'gid', 'number');
  const nlink = ownPrimitive(value, 'nlink', 'number');
  const size = ownPrimitive(value, 'size', 'number');
  const mtimeMs = ownPrimitive(value, 'mtimeMs', 'number');
  const integers = [dev, ino, mode, uid, gid, nlink, size];
  if (
    typeof relativePath !== 'string'
    || (type !== 'directory' && type !== 'file')
    || integers.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
    || typeof mtimeMs !== 'number'
    || !Number.isFinite(mtimeMs)
    || mtimeMs < 0
  ) {
    return undefined;
  }
  return {
    relativePath,
    type,
    dev: dev as number,
    ino: ino as number,
    mode: mode as number,
    uid: uid as number,
    gid: gid as number,
    nlink: nlink as number,
    size: size as number,
    mtimeMs
  };
}

function ownPrimitive(
  value: Record<string, unknown>,
  key: string,
  expectedType: 'string' | 'number'
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
  return typeof descriptor.value === expectedType ? descriptor.value : undefined;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor && descriptor.enumerable === true
    ? descriptor.value
    : undefined;
}

function ownArrayValue(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor && 'value' in descriptor && descriptor.enumerable === true
    ? descriptor.value
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseVersion(value: string): bigint[] | undefined {
  if (value.length > 256 || !VERSION_PATTERN.test(value)) return undefined;
  const components = value.split('.');
  if (components.length > 32 || components.some((component) => component.length > 128)) {
    return undefined;
  }
  return components.map((component) => BigInt(component));
}

function compareVersion(left: bigint[], right: bigint[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0n;
    const rightValue = right[index] ?? 0n;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function sameTreeIdentity(left: TreeIdentity, right: TreeIdentity): boolean {
  if (
    left.version !== right.version
    || left.rootRealpath !== right.rootRealpath
    || left.totalBytes !== right.totalBytes
    || left.entries.length !== right.entries.length
  ) {
    return false;
  }
  const keys: Array<keyof TreeEntry> = [
    'relativePath', 'type', 'dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs'
  ];
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return other !== undefined && keys.every((key) => entry[key] === other[key]);
  });
}

function sameRootShape(left: TrustedRoots, right: TrustedRoots): boolean {
  return left.sparkleRoot === right.sparkleRoot
    && left.installationRoot === right.installationRoot
    && sameStrings(left.rootChildren, right.rootChildren)
    && sameStrings(left.installationChildren, right.installationChildren);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDirectTarget(target: string, installationRoot: string): boolean {
  return path.isAbsolute(target)
    && path.resolve(target) === target
    && path.dirname(target) === installationRoot
    && path.basename(target).length > 0;
}

async function pathMayExist(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

async function availableBytesFor(target: string): Promise<number | undefined> {
  try {
    const snapshot = await statfs(target);
    const available = snapshot.bavail * snapshot.bsize;
    return Number.isSafeInteger(available) && available >= 0 ? available : undefined;
  } catch {
    return undefined;
  }
}

function safeAdd(left: number, right: number): number | undefined {
  const value = left + right;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    const next = safeAdd(total, value);
    if (next === undefined) return undefined;
    total = next;
  }
  return total;
}

function blockedPlan(blockedReasons: string[], warnings: string[]): CodexSparklePlan {
  return {
    status: 'blocked',
    reclaimableBytes: 0,
    targets: [],
    blockedReasons: uniqueCodes(blockedReasons),
    warnings: uniqueCodes(warnings)
  };
}

function result(
  status: CodexSparkleResult['status'],
  changed: boolean,
  deletedBytes: number,
  deletedEntries: number,
  blockedReasons: string[],
  warnings: string[],
  volumeFreeDeltaBytes?: number
): CodexSparkleResult {
  return {
    status,
    changed,
    deletedBytes,
    deletedEntries,
    blockedReasons: uniqueCodes(blockedReasons),
    warnings: uniqueCodes(warnings),
    ...(volumeFreeDeltaBytes === undefined ? {} : { volumeFreeDeltaBytes })
  };
}

function uniqueCodes(values: string[]): string[] {
  return [...new Set(values.filter((value) => /^[a-z0-9-]+$/.test(value)))];
}

class SparkleError extends Error {
  override readonly name = 'CodexSparkleError';
}

function sparkleError(code: string): SparkleError {
  return new SparkleError(/^[a-z0-9-]+$/.test(code) ? code : 'sparkle-inspection-failed');
}

function sparkleErrorCode(error: unknown, fallback: string): string {
  return error instanceof SparkleError ? error.message : fallback;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
