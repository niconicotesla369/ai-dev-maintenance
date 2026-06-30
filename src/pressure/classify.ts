import { redactPath } from '../paths.js';
import type { PressureProcess, PressureProcessCategory, PressureProviderId } from './types.js';
import type { RawProcessRow } from './parse.js';

export function classifyPressureProcesses(rows: RawProcessRow[]): PressureProcess[] {
  return rows.map((row) => {
    const provider = classifyProvider(row.command);
    return {
      pid: row.pid,
      ppid: row.ppid,
      provider,
      category: classifyCategory(row.command, provider),
      cpuPercent: row.cpuPercent,
      memoryPercent: row.memoryPercent,
      rssBytes: row.rssBytes,
      commandSummary: redactCommandSummary(row.command)
    };
  });
}

export function redactCommandSummary(command: string): string {
  const withoutSecrets = command
    .replace(/(--token|--api-key|--password|--secret)\s+\S+/gi, '$1 <redacted>')
    .replace(/(token|api[_-]?key|password|secret)=\S+/gi, '$1=<redacted>');
  return redactPath(withoutSecrets);
}

function classifyProvider(command: string): PressureProviderId {
  if (command.includes('/Applications/Codex.app/') || /\bcodex\b/i.test(command)) return 'codex';
  if (command === 'claude' || /\bclaude\b/i.test(command)) return 'claude-code';
  if (command.includes('/Applications/Cursor.app/') || /\bCursor Helper\b/.test(command) || /\bcursor\b/i.test(command)) return 'cursor';
  if (command.includes('ChromeRemoteDesktopHost') || command.includes('remoting_me2me_host')) return 'remote-control';
  return 'other';
}

function classifyCategory(command: string, provider: PressureProviderId): PressureProcessCategory {
  if (provider === 'remote-control') return 'remote-control';
  if (/renderer/i.test(command)) return 'renderer';
  if (/extension-host/i.test(command)) return 'extension-host';
  if (/terminal pty-host/i.test(command)) return 'terminal';
  if (/language[- ]?server|serverWorkerMain/i.test(command)) return 'language-server';
  if (/Helper|Service|gpu-process|utility/i.test(command)) return 'helper';
  if (provider === 'codex' || provider === 'claude-code' || provider === 'cursor') return 'app';
  return 'other';
}
