import { chmod, mkdtemp, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { trustedCommandPath, runCommand } from './commands.js';
import { assertDirectoryChainSafe, compareTargetIdentities, detectTargetState, safeTargetStateForReport } from './fs-safety.js';
import { appDataHome, createSqliteUri, defaultCodexHome, redactPath, targetTriple } from './paths.js';
import { ensurePrivateDir, writeReport } from './reports.js';
import { planFixSafety } from './safety.js';
import { checkSqliteJsonSupport, inspectSqliteSnapshot } from './sqlite.js';
import { checkOpenHandles, knownCodexProcessExists } from './doctor.js';
import { pruneBackups } from './retention.js';
import type { MaintenanceReport } from './types.js';
import { REPORT_SCHEMA_VERSION, TOOL_VERSION } from './version.js';

const BACKUP_HEADROOM_BYTES = 64 * 1024 * 1024;
const MIN_BACKUP_TIMEOUT_MS = 60_000;
const MIN_CHECKPOINT_TIMEOUT_MS = 10_000;
const MAX_SQLITE_TIMEOUT_MS = 30 * 60_000;
// Conservative 20 MiB/s so large databases get proportionally longer timeouts.
const ASSUMED_SQLITE_BYTES_PER_MS = (20 * 1024 * 1024) / 1000;

export async function runFixSafe(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ report: MaintenanceReport; reportPath?: string }> {
  const generatedAt = new Date().toISOString();
  const report = baseFixReport(generatedAt);
  if ((options.platform ?? process.platform) !== 'darwin') {
    report.status = 'unsupported';
    report.blockedReasons.push('platform is unsupported');
    return { report };
  }

  const { codexHome, custom } = defaultCodexHome(options.env);
  if (custom) {
    report.status = 'blocked';
    report.target.pathCategory = 'custom-codex-home';
    report.blockedReasons.push('custom CODEX_HOME is rejected by fix');
    report.nextSafeAction = 'Run doctor for diagnostics only, or unset CODEX_HOME before fix --safe.';
    return { report, reportPath: await writeReport(report) };
  }

  const mainPath = path.join(codexHome, 'logs_2.sqlite');
  report.blockedReasons.push(...(await targetDirectoryBlockers(mainPath)));

  const preflightResult = await runPreflight(mainPath);
  report.findings.preflight = redactPreflightFindings(preflightResult.findings);
  report.blockedReasons.push(...preflightResult.blockers);
  if (report.blockedReasons.length > 0) {
    report.status = 'blocked';
    report.nextSafeAction = 'Close AI coding tools, verify the target path, then run doctor again.';
    return { report, reportPath: await writeReport(report) };
  }

  const beforeBackup = await runPreflight(mainPath);
  report.blockedReasons.push(...(await targetDirectoryBlockers(mainPath)));
  report.blockedReasons.push(
    ...compareTargetIdentities(preflightResult.findings.targetState, beforeBackup.findings.targetState, {
      allowSidecarSizeMtimeChange: false
    })
  );
  if (report.blockedReasons.length > 0) {
    report.status = 'blocked';
    return { report, reportPath: await writeReport(report) };
  }
  if (beforeBackup.blockers.length > 0) {
    report.status = 'blocked';
    report.blockedReasons.push(...beforeBackup.blockers.map((reason) => `before backup: ${reason}`));
    return { report, reportPath: await writeReport(report) };
  }
  const sourceBytes = Number(beforeBackup.findings.targetState?.main?.size ?? 0)
    + Number(beforeBackup.findings.targetState?.wal?.size ?? 0);
  const requiredBackupBytes = sourceBytes + BACKUP_HEADROOM_BYTES;
  const availableBackupBytes = await availableBytesNear(appDataHome());
  report.metrics.backupRequiredBytes = requiredBackupBytes;
  if (availableBackupBytes === undefined) {
    report.status = 'blocked';
    report.blockedReasons.push('before backup: free-space check unavailable');
    return { report, reportPath: await writeReport(report) };
  }
  report.metrics.backupAvailableBytes = availableBackupBytes;
  if (availableBackupBytes < requiredBackupBytes) {
    report.status = 'blocked';
    report.blockedReasons.push('before backup: insufficient free space for backup');
    report.nextSafeAction = 'Nothing was changed. Free disk space, then run doctor again.';
    return { report, reportPath: await writeReport(report) };
  }

  let backup: Awaited<ReturnType<typeof createBackup>>;
  try {
    backup = await createBackup(mainPath, scaledTimeoutMs(sourceBytes, MIN_BACKUP_TIMEOUT_MS));
  } catch (error) {
    report.status = 'blocked';
    report.blockedReasons.push(`backup: ${redactPath(error instanceof Error ? error.message : String(error))}`);
    report.nextSafeAction = 'The Codex log database was not changed. Check free space, then run doctor again.';
    return { report, reportPath: await writeReport(report) };
  }
  report.metrics.backupCreated = true;
  report.findings.backup = { path: redactPath(backup.path), manifest: redactPath(backup.manifestPath) };

  const beforeMutation = await runPreflight(mainPath);
  report.blockedReasons.push(...(await targetDirectoryBlockers(mainPath)));
  report.blockedReasons.push(
    ...compareTargetIdentities(preflightResult.findings.targetState, beforeMutation.findings.targetState, {
      allowSidecarSizeMtimeChange: true
    })
  );
  if (report.blockedReasons.length > 0) {
    report.status = 'blocked';
    return { report, reportPath: await writeReport(report) };
  }
  if (beforeMutation.blockers.length > 0) {
    report.status = 'blocked';
    report.blockedReasons.push(...beforeMutation.blockers.map((reason) => `before mutation: ${reason}`));
    return { report, reportPath: await writeReport(report) };
  }

  const beforeWalBytes = preflightResult.findings.targetState?.wal?.size ?? 0;
  const sqlite = await trustedCommandPath('sqlite3');
  const dbUri = createSqliteUri(mainPath, 'rw');
  // From here on the database may have been touched, so failures are partial, never blocked.
  try {
    report.metrics.checkpointAttempted = true;
    await runCheckpoint(sqlite, dbUri, scaledTimeoutMs(Number(beforeWalBytes), MIN_CHECKPOINT_TIMEOUT_MS));
  } catch (error) {
    report.status = 'partial';
    report.blockedReasons.push(error instanceof Error ? error.message : String(error));
    report.nextSafeAction = 'The checkpoint did not complete; SQLite keeps logical data consistent. Run doctor again before retrying.';
    return { report, reportPath: await writeReport(report) };
  }

  const postMutation = await runTargetCheck(mainPath);
  report.blockedReasons.push(
    ...compareTargetIdentities(beforeMutation.findings.targetState, postMutation.targetState, {
      allowMainSizeMtimeChange: true,
      allowSidecarSizeMtimeChange: true
    })
  );
  if (report.blockedReasons.length > 0) {
    report.status = 'partial';
    return { report, reportPath: await writeReport(report) };
  }
  if (postMutation.blockers.length > 0) {
    report.status = 'partial';
    report.blockedReasons.push(...postMutation.blockers.map((reason) => `after mutation: ${reason}`));
    return { report, reportPath: await writeReport(report) };
  }
  report.status = 'ok';
  const afterWalBytes = postMutation.targetState?.wal?.size ?? 0;
  if (afterWalBytes > 0) {
    addWarning(report, 'WAL still has bytes after checkpoint');
  }
  report.metrics.beforeWalBytes = beforeWalBytes;
  report.metrics.afterWalBytes = afterWalBytes;
  // Kept for compatibility: WAL bytes folded into the database, not bytes freed.
  report.metrics.reclaimedBytes = Math.max(0, Number(beforeWalBytes) - Number(afterWalBytes));
  report.metrics.mainDbForcedShrink = false;
  const beforeMainBytes = beforeMutation.findings.targetState?.main?.size;
  const afterMainBytes = postMutation.targetState?.main?.size;
  if (typeof beforeMainBytes === 'number' && typeof afterMainBytes === 'number') {
    report.metrics.beforeMainBytes = beforeMainBytes;
    report.metrics.afterMainBytes = afterMainBytes;
    report.metrics.targetNetDeltaBytes = (afterMainBytes + Number(afterWalBytes)) - (beforeMainBytes + Number(beforeWalBytes));
  }
  const backupBytes = await stat(backup.path).then((info) => info.size).catch(() => undefined);
  if (backupBytes !== undefined) report.metrics.backupBytes = backupBytes;
  const retention = await pruneBackups(path.join(appDataHome(), 'backups'), { keepPath: path.dirname(backup.path) }).catch((error) => ({
    deleted: 0,
    warnings: [error instanceof Error ? error.message : String(error)]
  }));
  if (retention.warnings.length > 0) {
    for (const warning of retention.warnings) addWarning(report, `backup retention: ${warning}`);
  }
  report.nextSafeAction = 'Review the before/after metrics in the saved report.';
  return { report, reportPath: await writeReport(report) };
}

async function runTargetCheck(mainPath: string) {
  const targetState = await detectTargetState(mainPath);
  return {
    targetState,
    blockers: targetState.blockers
  };
}

async function runPreflight(mainPath: string) {
  const blockers: string[] = [];
  const targetState = await detectTargetState(mainPath);
  blockers.push(...targetState.blockers);

  const sqliteSupport = await checkSqliteJsonSupport();
  if (!sqliteSupport.ok) blockers.push('sqlite3 JSON mode is unavailable');

  const lsof = await checkOpenHandles(targetTriple(mainPath));
  const knownProcess = await knownCodexProcessExists();
  const safety = planFixSafety({
    knownCodexProcessExists: knownProcess === true || knownProcess === 'unknown',
    anyOpenHandleOnTarget: lsof.openHandles,
    lsofUsable: lsof.usable
  });
  blockers.push(...safety.reasons);

  return {
    blockers,
    findings: {
      targetState,
      sqliteJson: sqliteSupport,
      openHandles: lsof,
      knownCodexProcessExists: knownProcess,
      sqlite: {
        available: false,
        reason: 'source database inspection is skipped in v1 to avoid copying private log bytes'
      }
    }
  };
}

function redactPreflightFindings(findings: Awaited<ReturnType<typeof runPreflight>>['findings']) {
  return {
    ...findings,
    targetState: safeTargetStateForReport(findings.targetState)
  };
}

function scaledTimeoutMs(bytes: number, minimumMs: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return minimumMs;
  return Math.min(MAX_SQLITE_TIMEOUT_MS, Math.max(minimumMs, Math.ceil(bytes / ASSUMED_SQLITE_BYTES_PER_MS)));
}

async function availableBytesNear(target: string): Promise<number | undefined> {
  let current = target;
  while (true) {
    try {
      const volume = await statfs(current);
      const available = Number(volume.bavail) * Number(volume.bsize);
      return Number.isSafeInteger(available) && available >= 0 ? available : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function createBackup(mainPath: string, timeoutMs: number) {
  const backupDir = path.join(appDataHome(), 'backups');
  await ensurePrivateDir(backupDir);
  const workDir = await mkdtemp(path.join(backupDir, 'backup-'));
  await chmod(workDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(workDir, `logs_2.sqlite.${stamp}.sqlite`);
  const tmpPath = `${backupPath}.tmp`;
  try {
    const sqlite = await trustedCommandPath('sqlite3');
    const vacuum = await runCommand(sqlite, ['-init', '/dev/null', createSqliteUri(mainPath, 'ro'), `VACUUM INTO '${tmpPath.replaceAll("'", "''")}';`], {
      timeoutMs
    });
    if (vacuum.timedOut) throw new Error('backup timed out');
    if (vacuum.code !== 0) throw new Error('backup failed');
    await chmod(tmpPath, 0o600);
    const inspection = await inspectSqliteSnapshot(tmpPath);
    if (inspection.quickCheck !== 'ok') throw new Error('backup quick_check failed');
    if (!inspection.recognizedSchema) throw new Error('backup schema is unsupported');
    await rename(tmpPath, backupPath);
    const manifestPath = `${backupPath}.manifest.json`;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          toolVersion: TOOL_VERSION,
          createdAt: new Date().toISOString(),
          sourcePath: redactPath(mainPath),
          backupPath: redactPath(backupPath),
          inspection
        },
        null,
        2
      )}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    await chmod(manifestPath, 0o600);
    return { path: backupPath, manifestPath };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function targetDirectoryBlockers(mainPath: string): Promise<string[]> {
  const startDir = path.dirname(mainPath);
  const stopDir = path.dirname(startDir);
  const blockers = await assertDirectoryChainSafe(startDir, stopDir).catch((error) => [
    error instanceof Error ? error.message : String(error)
  ]);
  return blockers.map(redactPath);
}

async function runCheckpoint(sqlite: string, dbUri: string, timeoutMs: number) {
  const checkpoint = await runCommand(sqlite, [
    '-json',
    '-init',
    '/dev/null',
    dbUri,
    'PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE);'
  ], { timeoutMs });
  if (checkpoint.timedOut) throw new Error('checkpoint timed out; outcome unknown');
  if (checkpoint.code !== 0 || checkpoint.stdoutTruncated || checkpoint.stderrTruncated) {
    throw new Error('checkpoint failed');
  }
  const rows = parseLastSqliteJsonArray(checkpoint.stdout) as Array<{ busy?: number }>;
  if (!checkpointRowsAreComplete(rows)) {
    throw new Error('checkpoint busy');
  }
}

export function parseLastSqliteJsonArray(stdout: string): unknown[] {
  const lastJsonLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('['))
    .at(-1);
  return JSON.parse(lastJsonLine || '[]') as unknown[];
}

export function checkpointRowsAreComplete(rows: Array<{ busy?: unknown; log?: unknown; checkpointed?: unknown }>): boolean {
  return (
    rows.length === 1 &&
    typeof rows[0]?.busy === 'number' &&
    typeof rows[0]?.log === 'number' &&
    typeof rows[0]?.checkpointed === 'number' &&
    Number.isFinite(rows[0].busy) &&
    Number.isFinite(rows[0].log) &&
    Number.isFinite(rows[0].checkpointed) &&
    rows[0].busy === 0 &&
    rows[0].log === rows[0].checkpointed
  );
}

function baseFixReport(generatedAt: string): MaintenanceReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    generatedAt,
    command: 'fix --safe',
    status: 'partial',
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics: {},
    blockedReasons: []
  };
}

function addWarning(report: MaintenanceReport, warning: string): void {
  const findings = report.findings as { warnings?: string[] };
  findings.warnings ??= [];
  findings.warnings.push(warning);
}
