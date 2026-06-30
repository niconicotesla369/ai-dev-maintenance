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
      displayName: displayName(row.command, provider),
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
  if (isBrowserProcess(command)) return 'browser';
  if (isBuildToolProcess(command)) return 'build-tool';
  if (isSystemProcess(command)) return 'system';
  if (/renderer/i.test(command)) return 'renderer';
  if (/extension-host/i.test(command)) return 'extension-host';
  if (/terminal pty-host/i.test(command)) return 'terminal';
  if (/language[- ]?server|serverWorkerMain/i.test(command)) return 'language-server';
  if (/Helper|Service|gpu-process|utility/i.test(command)) return 'helper';
  if (provider === 'codex' || provider === 'claude-code' || provider === 'cursor') return 'app';
  return 'other';
}

function displayName(command: string, provider: PressureProviderId): string {
  if (provider === 'codex') {
    if (/renderer/i.test(command)) return 'Codex Renderer';
    if (/Helper|Service|gpu-process|utility/i.test(command)) return 'Codex Helper';
    return 'Codex';
  }
  if (provider === 'cursor') {
    if (/extension-host/i.test(command)) return 'Cursor ExtHost';
    if (/renderer/i.test(command)) return 'Cursor Renderer';
    if (/Helper|Service|gpu-process|utility/i.test(command)) return 'Cursor Helper';
    return 'Cursor';
  }
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'remote-control') return 'Remote Desktop';
  if (/vitest/i.test(command)) return 'node/vitest';
  if (/\btsc\b|typescript/i.test(command)) return 'node/tsc';
  if (/\btsserver\b/i.test(command)) return 'tsserver';
  if (/\btsup\b/i.test(command)) return 'node/tsup';
  if (/\brollup\b/i.test(command)) return 'node/rollup';
  if (/\besbuild\b/i.test(command)) return 'node/esbuild';
  if (/\bnode\b/i.test(command)) return 'node';
  if (/\bpnpm\b/i.test(command)) return 'pnpm';
  if (/\bnpm\b/i.test(command)) return 'npm';
  if (/Google Chrome Helper|Chrome Helper/i.test(command)) return 'Chrome Helper';
  if (/Google Chrome|com\.google\.Chrome/i.test(command)) return 'Chrome';
  if (/Safari/i.test(command)) return 'Safari';
  if (/WindowServer/i.test(command)) return 'WindowServer';
  if (/kernel_task/i.test(command)) return 'kernel_task';
  if (/syspolicyd/i.test(command)) return 'syspolicyd';
  if (/\bmdworker\b/i.test(command)) return 'mdworker';
  if (/\bmds\b/i.test(command)) return 'mds';
  return fallbackName(command);
}

function isBrowserProcess(command: string): boolean {
  return /Google Chrome|Chrome Helper|com\.google\.Chrome|Safari|Firefox|Arc Helper|Microsoft Edge/i.test(command);
}

function isBuildToolProcess(command: string): boolean {
  return /\b(node|npm|pnpm|yarn|bun|vitest|tsx|tsup|rollup|esbuild|webpack|vite)\b/i.test(command);
}

function isSystemProcess(command: string): boolean {
  return /\/usr\/libexec\/|\/System\/Library\/|WindowServer|kernel_task|\bmdworker\b|\bmds\b|syspolicyd/i.test(command);
}

function fallbackName(command: string): string {
  const redacted = redactCommandSummary(command);
  const lastPathPart = redacted.split(/\s+/)[0]?.split('/').filter(Boolean).at(-1);
  const candidate = lastPathPart && lastPathPart !== '<absolute-path>' ? lastPathPart : redacted.split(/\s+/)[0];
  return (candidate ?? 'process').slice(0, 32);
}
