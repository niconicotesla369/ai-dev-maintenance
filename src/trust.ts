import { lstat } from 'node:fs/promises';
import { ALLOWED_COMMANDS, isTrustedSystemCommand } from './commands.js';
import { row } from './cli-render.js';
import type { CommandStat } from './types.js';
import { TOOL_VERSION } from './version.js';

export type TrustCommandName = keyof typeof ALLOWED_COMMANDS;
export type TrustStatus = 'trusted' | 'untrusted' | 'missing';
export type TrustReason =
  | 'missing'
  | 'symbolic_link'
  | 'not_root_owned'
  | 'group_or_other_writable';

export type TrustEntry = {
  name: TrustCommandName;
  path: string;
  status: TrustStatus;
  reasons: TrustReason[];
};

export type TrustReport = {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  command: 'trust';
  status: 'ok' | 'partial';
  redacted: true;
  entries: TrustEntry[];
  summary: {
    trusted: number;
    untrusted: number;
    missing: number;
    total: number;
  };
  warnings: string[];
};

export type TrustOptions = {
  now?: () => string;
  statCommand?: (name: TrustCommandName, commandPath: string) => Promise<CommandStat>;
};

export async function runTrust(options: TrustOptions = {}): Promise<TrustReport> {
  const entries: TrustEntry[] = [];
  for (const [name, commandPath] of Object.entries(ALLOWED_COMMANDS) as Array<[TrustCommandName, string]>) {
    entries.push(await inspectCommand(name, commandPath, options.statCommand ?? defaultStatCommand));
  }
  const summary = {
    trusted: entries.filter((entry) => entry.status === 'trusted').length,
    untrusted: entries.filter((entry) => entry.status === 'untrusted').length,
    missing: entries.filter((entry) => entry.status === 'missing').length,
    total: entries.length
  };
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: options.now?.() ?? new Date().toISOString(),
    command: 'trust',
    status: summary.trusted === summary.total ? 'ok' : 'partial',
    redacted: true,
    entries,
    summary,
    warnings: []
  };
}

export function renderTrustReport(report: TrustReport): string {
  const lines = [
    'AIDM TRUST',
    row('Status', report.status),
    row('Trusted', `${report.summary.trusted}/${report.summary.total}`),
    ''
  ];
  for (const entry of report.entries) {
    const reasons = entry.reasons.length > 0 ? ` (${entry.reasons.join(', ')})` : '';
    lines.push(`${entry.status.padEnd(10, ' ')} ${entry.name.padEnd(16, ' ')} ${entry.path}${reasons}`);
  }
  return `${lines.join('\n')}\n`;
}

async function inspectCommand(
  name: TrustCommandName,
  commandPath: string,
  statCommand: NonNullable<TrustOptions['statCommand']>
): Promise<TrustEntry> {
  try {
    const stat = await statCommand(name, commandPath);
    const reasons = trustReasons(stat);
    return {
      name,
      path: commandPath,
      status: reasons.length === 0 && isTrustedSystemCommand(stat) ? 'trusted' : 'untrusted',
      reasons
    };
  } catch (error) {
    if (isMissingError(error)) {
      return {
        name,
        path: commandPath,
        status: 'missing',
        reasons: ['missing']
      };
    }
    return {
      name,
      path: commandPath,
      status: 'untrusted',
      reasons: ['missing']
    };
  }
}

async function defaultStatCommand(_name: TrustCommandName, commandPath: string): Promise<CommandStat> {
  const info = await lstat(commandPath);
  return {
    path: commandPath,
    uid: info.uid,
    mode: info.mode,
    isSymbolicLink: info.isSymbolicLink()
  };
}

function trustReasons(stat: CommandStat): TrustReason[] {
  const reasons: TrustReason[] = [];
  if (stat.isSymbolicLink) reasons.push('symbolic_link');
  if (stat.uid !== 0) reasons.push('not_root_owned');
  if ((stat.mode & 0o022) !== 0) reasons.push('group_or_other_writable');
  return reasons;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
