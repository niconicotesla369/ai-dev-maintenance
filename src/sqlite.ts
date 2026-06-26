import { trustedCommandPath, runCommand } from './commands.js';
import { createSqliteUri, redactPath } from './paths.js';

export type SnapshotInspection = {
  quickCheck?: string;
  hasLogsTable?: boolean;
  columns?: string[];
  recognizedSchema: boolean;
  pageSize?: number;
  pageCount?: number;
  freelistCount?: number;
  autoVacuum?: number;
  error?: string;
};

export async function checkSqliteJsonSupport(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const sqlite = await trustedCommandPath('sqlite3');
    const result = await runCommand(sqlite, ['-json', '-init', '/dev/null', ':memory:', 'select 1 as ok'], {
      timeoutMs: 5_000
    });
    if (result.code !== 0) return { ok: false, reason: result.stderr.trim() || 'sqlite3 failed' };
    const parsed = JSON.parse(result.stdout);
    return { ok: parsed?.[0]?.ok === 1, reason: parsed?.[0]?.ok === 1 ? undefined : 'unexpected sqlite3 json output' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectSqliteSnapshot(mainPath: string): Promise<SnapshotInspection> {
  try {
    const quickCheck = await sqliteJson(mainPath, 'ro', 'PRAGMA quick_check;');
    const table = await sqliteJson(
      mainPath,
      'ro',
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='logs';"
    );
    const columns = await sqliteJson(mainPath, 'ro', 'PRAGMA table_info(logs);');
    const pageSize = await sqliteJson(mainPath, 'ro', 'PRAGMA page_size;');
    const pageCount = await sqliteJson(mainPath, 'ro', 'PRAGMA page_count;');
    const freelistCount = await sqliteJson(mainPath, 'ro', 'PRAGMA freelist_count;');
    const autoVacuum = await sqliteJson(mainPath, 'ro', 'PRAGMA auto_vacuum;');
    const columnNames = Array.isArray(columns) ? columns.map((row) => String(row.name)) : [];

    return {
      quickCheck: String(quickCheck?.[0]?.quick_check ?? ''),
      hasLogsTable: Boolean(table?.[0]?.name === 'logs'),
      columns: columnNames,
      recognizedSchema:
        quickCheck?.[0]?.quick_check === 'ok' &&
        table?.[0]?.name === 'logs' &&
        columnNames.includes('id') &&
        columnNames.includes('level'),
      pageSize: Number(pageSize?.[0]?.page_size ?? 0),
      pageCount: Number(pageCount?.[0]?.page_count ?? 0),
      freelistCount: Number(freelistCount?.[0]?.freelist_count ?? 0),
      autoVacuum: Number(autoVacuum?.[0]?.auto_vacuum ?? 0)
    };
  } catch (error) {
    return {
      recognizedSchema: false,
      error: sanitizeSqliteError(error)
    };
  }
}

export async function sqliteJson(
  dbPath: string,
  mode: 'ro' | 'rw',
  sql: string
): Promise<Record<string, unknown>[]> {
  const sqlite = await trustedCommandPath('sqlite3');
  const result = await runCommand(sqlite, ['-json', '-init', '/dev/null', createSqliteUri(dbPath, mode), sql], {
    timeoutMs: 15_000
  });
  if (result.code !== 0) {
    throw new Error(classifySqliteCommandFailure(result.stderr, result.code));
  }
  return JSON.parse(result.stdout || '[]') as Record<string, unknown>[];
}

function classifySqliteCommandFailure(stderr: string, code: number | null): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('permission denied') || lower.includes('operation not permitted')) {
    return 'sqlite3 permission_denied';
  }
  if (lower.includes('database is locked') || lower.includes('busy')) {
    return 'sqlite3 database_busy';
  }
  if (lower.includes('file is not a database') || lower.includes('malformed')) {
    return 'sqlite3 invalid_database';
  }
  return code === null ? 'sqlite3 failed' : `sqlite3 exited with ${code}`;
}

function sanitizeSqliteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactPath(message);
}
