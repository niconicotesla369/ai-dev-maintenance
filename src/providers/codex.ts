import path from 'node:path';
import { trustedCommandPath as defaultTrustedCommandPath, runCommand as defaultRunCommand } from '../commands.js';
import { scanPathSize } from '../fs-size.js';
import { detectTargetState, pathExists, safeTargetStateForReport } from '../fs-safety.js';
import { defaultCodexHome, redactPath, resolveHome, targetTriple } from '../paths.js';
import { writeReport } from '../reports.js';
import { classifyLsofResult, deriveFixReadiness, parseKnownCodexProcess } from '../safety.js';
import { checkSqliteJsonSupport } from '../sqlite.js';
import type { MaintenanceReport } from '../types.js';
import { CODEX_REPORT_SCHEMA_VERSION, TOOL_VERSION } from '../version.js';
import type { MaintenanceProvider, ProviderDoctorOptions, ProviderRuntimeOptions, StateEntry } from './types.js';

const CODEX_ROOT_CATEGORY = '<home>/.codex';
const CODEX_SPARKLE_CATEGORY =
  '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle';
const CODEX_ROOT_EXCLUSIONS = [
  'sessions',
  'archived_sessions',
  'maintenance-archive',
  'generated_images',
  'backups',
  'logs_2.sqlite',
  'logs_2.sqlite-wal',
  'logs_2.sqlite-shm'
] as const;
const CODEX_SCAN_LIMITS = {
  maxDepth: 32,
  maxEntries: 250_000,
  maxChildrenPerDir: 20_000,
  deadlineMs: 15_000
} as const;

export const codexProvider = {
  id: 'codex',
  displayName: 'Codex',
  defaultPathCategory: `${CODEX_ROOT_CATEGORY}/logs_2.sqlite`,
  detect: detectCodex,
  scan: scanCodex,
  advisories: codexAdvisories,
  runDoctor: runCodexDoctor
} satisfies MaintenanceProvider;

async function detectCodex(options: ProviderRuntimeOptions = {}) {
  const { codexHome, custom } = defaultCodexHome(options.env);
  const rootCategory = codexRootCategory(custom);
  const sparklePath = codexSparklePath(options.env);
  const ownership = codexRootOwnership(codexHome, sparklePath);
  const [codexPresent, sparklePresent] = await Promise.all([
    pathExists(codexHome),
    pathExists(sparklePath)
  ]);
  return {
    present: ownership === 'custom' ? codexPresent : ownership === 'sparkle' ? sparklePresent : codexPresent || sparklePresent,
    roots: ownership === 'custom'
      ? [rootCategory]
      : ownership === 'sparkle'
        ? [CODEX_SPARKLE_CATEGORY]
        : [rootCategory, CODEX_SPARKLE_CATEGORY]
  };
}

async function scanCodex(options: ProviderRuntimeOptions = {}): Promise<StateEntry[]> {
  const { codexHome, custom } = defaultCodexHome(options.env);
  const rootCategory = codexRootCategory(custom);
  const sparklePath = codexSparklePath(options.env);
  const ownership = codexRootOwnership(codexHome, sparklePath);

  if (ownership === 'sparkle') {
    const sparkleOwner = await scanEntry(entrySpec(
      sparklePath,
      CODEX_SPARKLE_CATEGORY,
      'cache',
      'never',
      'overlapping Sparkle and custom Codex state; diagnostic only; AIDM does not delete it'
    ));
    return sparkleOwner ? [sparkleOwner] : [];
  }

  const scans: Array<Promise<StateEntry | undefined>> = [
    scanEntry(entrySpec(
      path.join(codexHome, 'sessions'),
      `${rootCategory}/sessions`,
      'session',
      'never',
      'private Codex state; diagnostic only; AIDM does not delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'archived_sessions'),
      `${rootCategory}/archived_sessions`,
      'session',
      'never',
      'private Codex state; diagnostic only; AIDM does not delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'maintenance-archive'),
      `${rootCategory}/maintenance-archive`,
      'session',
      'never',
      'private Codex state; diagnostic only; AIDM does not delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'generated_images'),
      `${rootCategory}/generated_images`,
      'session',
      'never',
      'private Codex state; diagnostic only; AIDM does not delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'backups'),
      `${rootCategory}/backups`,
      'session',
      'never',
      'private Codex state; diagnostic only; AIDM does not delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'logs_2.sqlite'),
      `${rootCategory}/logs_2.sqlite`,
      'log',
      'confirm',
      `Codex log database diagnostic only; v${TOOL_VERSION} does not stop writes.`
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'logs_2.sqlite-wal'),
      `${rootCategory}/logs_2.sqlite-wal`,
      'sidecar',
      'confirm',
      'Codex log database sidecar diagnostic only; AIDM does not stop writes or delete it'
    )),
    scanEntry(entrySpec(
      path.join(codexHome, 'logs_2.sqlite-shm'),
      `${rootCategory}/logs_2.sqlite-shm`,
      'sidecar',
      'confirm',
      'Codex log database sidecar diagnostic only; AIDM does not stop writes or delete it'
    )),
    scanRootRemainder(codexHome, rootCategory)
  ];
  if (ownership === 'disjoint') {
    scans.push(scanEntry(entrySpec(
      sparklePath,
      CODEX_SPARKLE_CATEGORY,
      'cache',
      'confirm',
      'updater cache; manual review required; AIDM does not delete it'
    )));
  }
  const entries = await Promise.all(scans);
  return entries.filter((entry): entry is StateEntry => entry !== undefined);
}

type CodexRootOwnership = 'custom' | 'sparkle' | 'disjoint';

function codexRootOwnership(codexHome: string, sparklePath: string): CodexRootOwnership {
  const normalizedCodexHome = path.resolve(codexHome);
  const normalizedSparklePath = path.resolve(sparklePath);
  if (pathContains(normalizedCodexHome, normalizedSparklePath)) return 'custom';
  if (pathContains(normalizedSparklePath, normalizedCodexHome)) return 'sparkle';
  return 'disjoint';
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

type CodexEntrySpec = {
  filePath: string;
  pathCategory: string;
  category: StateEntry['category'];
  reclaimability: StateEntry['reclaimability'];
  note: string;
};

function entrySpec(
  filePath: string,
  pathCategory: string,
  category: StateEntry['category'],
  reclaimability: StateEntry['reclaimability'],
  note: string
): CodexEntrySpec {
  return { filePath, pathCategory, category, reclaimability, note };
}

async function scanEntry(spec: CodexEntrySpec): Promise<StateEntry | undefined> {
  const scan = await scanPathSize(spec.filePath, spec.pathCategory, CODEX_SCAN_LIMITS);
  if (!scan.exists) return undefined;
  return {
    category: spec.category,
    pathCategory: spec.pathCategory,
    bytes: scan.bytes,
    reclaimability: spec.reclaimability,
    note: spec.note,
    sizeTruncated: scan.sizeTruncated,
    warnings: scan.warnings
  };
}

async function scanRootRemainder(codexHome: string, rootCategory: string): Promise<StateEntry | undefined> {
  const scan = await scanPathSize(codexHome, `${rootCategory}/other-state`, {
    ...CODEX_SCAN_LIMITS,
    excludeRootEntries: CODEX_ROOT_EXCLUSIONS
  });
  if (!scan.exists || (scan.bytes === 0 && scan.warnings.length === 0 && !scan.sizeTruncated)) {
    return undefined;
  }
  return {
    category: 'session',
    pathCategory: `${rootCategory}/other-state`,
    bytes: scan.bytes,
    reclaimability: 'never',
    note: 'private unclassified Codex state; diagnostic only; AIDM does not delete it',
    sizeTruncated: scan.sizeTruncated,
    warnings: scan.warnings
  };
}

function codexRootCategory(custom: boolean): string {
  return custom ? 'custom-codex-home' : CODEX_ROOT_CATEGORY;
}

function codexSparklePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    resolveHome(env),
    'Library',
    'Caches',
    'com.openai.codex',
    'org.sparkle-project.Sparkle'
  );
}

async function codexAdvisories(): Promise<Awaited<ReturnType<MaintenanceProvider['advisories']>>> {
  return [{
    severity: 'warn',
    code: 'codex-ssd-log-write-volume',
    message: 'AIDM can diagnose Codex log size, but it does not stop high-frequency writes.',
    nextAction: 'Update Codex to a version with the upstream log-volume reduction.'
  }];
}

async function runCodexDoctor(options: ProviderDoctorOptions) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    const report = baseReport('doctor', options.generatedAt, 'unsupported');
    report.blockedReasons.push('platform is unsupported');
    report.nextSafeAction = 'Run this tool on macOS.';
    return { report };
  }

  const { codexHome, custom } = defaultCodexHome(options.env);
  const mainPath = path.join(codexHome, 'logs_2.sqlite');
  const state = await detectTargetState(mainPath);
  const report = baseReport('doctor', options.generatedAt, state.fixable ? 'ok' : 'partial');
  report.target.pathCategory = custom ? 'custom-codex-home' : codexProvider.defaultPathCategory;
  report.findings.targetState = redactState(state);
  report.blockedReasons.push(...state.blockers);
  if (custom) report.blockedReasons.push('custom CODEX_HOME is read-only in doctor and rejected by fix');

  const sqliteSupport = await checkSqliteJsonSupport();
  report.findings.sqliteJson = sqliteSupport;

  const lsof = await checkOpenHandles(targetTriple(mainPath));
  report.findings.openHandles = lsof;

  const knownProcess = await knownCodexProcessExists();
  report.findings.knownCodexProcessExists = knownProcess;
  report.findings.fixReadiness = deriveFixReadiness(report);

  report.findings.sqlite = {
    available: false,
    reason: 'source database inspection is skipped in v1 to avoid copying private log bytes'
  };

  const reportPath = options.persistReport === false ? undefined : await writeReport(report);
  if (options.showPaths && reportPath) report.findings.reportPath = redactPath(reportPath);
  return { report, reportPath };
}

type CheckOpenHandlesOptions = {
  trustedCommandPath?: typeof defaultTrustedCommandPath;
  runCommand?: typeof defaultRunCommand;
};

export async function checkOpenHandles(paths: string[], options: CheckOpenHandlesOptions = {}) {
  try {
    const trustedCommandPath = options.trustedCommandPath ?? defaultTrustedCommandPath;
    const runCommand = options.runCommand ?? defaultRunCommand;
    const existingPaths = [];
    for (const candidate of paths) {
      if (await pathExists(candidate)) existingPaths.push(candidate);
    }
    if (existingPaths.length === 0) {
      return { usable: true, openHandles: false, reason: 'no target files exist' };
    }
    const lsof = await trustedCommandPath('lsof');
    const result = await runCommand(lsof, ['-F', 'pcn', ...existingPaths], { timeoutMs: 5_000 });
    return classifyLsofResult(result);
  } catch (error) {
    return {
      usable: false,
      openHandles: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function knownCodexProcessExists(): Promise<boolean | 'unknown'> {
  try {
    const ps = await defaultTrustedCommandPath('ps');
    const result = await defaultRunCommand(ps, ['-axo', 'pid=,comm=,command='], { timeoutMs: 5_000 });
    if (result.stdoutTruncated || result.stderrTruncated) return 'unknown';
    if (result.code !== 0) return 'unknown';
    return parseKnownCodexProcess(result.stdout);
  } catch {
    return 'unknown';
  }
}

function baseReport(command: string, generatedAt: string, status: MaintenanceReport['status']): MaintenanceReport {
  return {
    schemaVersion: CODEX_REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    generatedAt,
    command,
    status,
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: codexProvider.defaultPathCategory
    },
    findings: {},
    metrics: {},
    blockedReasons: []
  };
}

function redactState(state: Awaited<ReturnType<typeof detectTargetState>>) {
  return safeTargetStateForReport(state);
}
