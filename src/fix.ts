import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { trustedCommandPath, runCommand } from './commands.js';
import { assertDirectoryChainSafe, compareTargetIdentities, detectTargetState, safeTargetStateForReport } from './fs-safety.js';
import { appDataHome, createSqliteUri, defaultCodexHome, redactPath, targetTriple } from './paths.js';
import { ensurePrivateDir, writeReport } from './reports.js';
import { planFixSafety } from './safety.js';
import { checkSqliteJsonSupport, inspectSqliteSnapshot } from './sqlite.js';
import { checkOpenHandles, knownCodexProcessExists } from './doctor.js';
import type { MaintenanceReport } from './types.js';
import { REPORT_SCHEMA_VERSION, TOOL_VERSION } from './version.js';

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
  const backup = await createBackup(mainPath);
  report.metrics.backupCreated = true;
  report.findings.backup = { path: redactPath(backup.path), manifest: redactPath(backup.manifestPath) };

  const beforeMutation = await runPreflight(mainPath);
  report.blockedReasons.push(...(await targetDirectoryBlockers(mainPath)));
  report.blockedReasons.push(
    ...compareTargetIdentities(preflightResult.findings.targetState, beforeMutation.findings.targetState, {
      allowSidecarSizeMtimeChange: false
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
  try {
    report.metrics.checkpointAttempted = true;
    await runCheckpoint(sqlite, dbUri);
    await runCheckpoint(sqlite, dbUri);
  } catch (error) {
    report.status = 'blocked';
    report.blockedReasons.push(error instanceof Error ? error.message : String(error));
    return { report, reportPath: await writeReport(report) };
  }

  const postMutation = await runPreflight(mainPath);
  report.blockedReasons.push(
    ...compareTargetIdentities(beforeMutation.findings.targetState, postMutation.findings.targetState, {
      allowMainSizeMtimeChange: true,
      allowSidecarSizeMtimeChange: true
    })
  );
  if (report.blockedReasons.length > 0) {
    report.status = 'blocked';
    return { report, reportPath: await writeReport(report) };
  }
  if (postMutation.blockers.length > 0) {
    report.status = 'blocked';
    report.blockedReasons.push(...postMutation.blockers.map((reason) => `after mutation: ${reason}`));
    return { report, reportPath: await writeReport(report) };
  }
  const postflight = await runPreflight(mainPath);
  if (postflight.blockers.length > 0) {
    report.status = 'blocked';
    report.blockedReasons.push(...postflight.blockers);
  } else {
    report.status = 'ok';
  }
  const afterWalBytes = postflight.findings.targetState?.wal?.size ?? 0;
  if (afterWalBytes > 0) {
    report.status = 'blocked';
    report.blockedReasons.push('WAL was not truncated');
  }
  report.metrics.beforeWalBytes = beforeWalBytes;
  report.metrics.afterWalBytes = afterWalBytes;
  report.metrics.reclaimedBytes = Math.max(0, Number(beforeWalBytes) - Number(afterWalBytes));
  report.metrics.mainDbForcedShrink = false;
  report.nextSafeAction = 'Review the before/after metrics in the saved report.';
  return { report, reportPath: await writeReport(report) };
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

async function createBackup(mainPath: string) {
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
      timeoutMs: 60_000
    });
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

async function runCheckpoint(sqlite: string, dbUri: string) {
  const checkpoint = await runCommand(sqlite, [
    '-json',
    '-init',
    '/dev/null',
    dbUri,
    'PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE);'
  ]);
  if (checkpoint.code !== 0 || checkpoint.stdoutTruncated || checkpoint.stderrTruncated) {
    throw new Error('checkpoint failed');
  }
  const rows = JSON.parse(checkpoint.stdout || '[]') as Array<{ busy?: number }>;
  if (!checkpointRowsAreComplete(rows)) {
    throw new Error('checkpoint busy');
  }
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
