import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanPathSize } from '../fs-size.js';
import type { MaintenanceProvider, ProviderRuntimeOptions, Reclaimability, StateCategory, StateEntry } from './types.js';

const CLAUDE_ROOT_CATEGORY = '<home>/.claude';

export const claudeCodeProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  defaultPathCategory: CLAUDE_ROOT_CATEGORY,
  detect: detectClaudeCode,
  scan: scanClaudeCode,
  advisories: async () => []
} satisfies MaintenanceProvider;

async function detectClaudeCode(options: ProviderRuntimeOptions = {}) {
  const root = claudeRoot(options.env);
  return {
    present: await exists(root),
    roots: [CLAUDE_ROOT_CATEGORY]
  };
}

async function scanClaudeCode(options: ProviderRuntimeOptions = {}): Promise<StateEntry[]> {
  const root = claudeRoot(options.env);
  const candidates = [
    entrySpec(
      path.join(root, 'projects'),
      `${CLAUDE_ROOT_CATEGORY}/projects`,
      'session',
      'never',
      'private conversation history; never touched'
    ),
    entrySpec(
      path.join(root, 'debug'),
      `${CLAUDE_ROOT_CATEGORY}/debug`,
      'log',
      'safe',
      'debug logs; cleanup is not implemented in v0.2.0'
    ),
    entrySpec(
      path.join(root, 'auth'),
      `${CLAUDE_ROOT_CATEGORY}/auth`,
      'session',
      'never',
      'authentication state; never touched'
    ),
    entrySpec(
      path.join(root, 'settings.json'),
      `${CLAUDE_ROOT_CATEGORY}/settings.json`,
      'session',
      'never',
      'settings and account state; never touched'
    )
  ];

  const entries: StateEntry[] = [];
  for (const candidate of candidates) {
    const entry = await scanEntry(candidate);
    if (entry) entries.push(entry);
  }
  return entries;
}

function entrySpec(
  filePath: string,
  pathCategory: string,
  category: StateCategory,
  reclaimability: Reclaimability,
  note: string
) {
  return { filePath, pathCategory, category, reclaimability, note };
}

async function scanEntry(spec: ReturnType<typeof entrySpec>): Promise<StateEntry | undefined> {
  const scan = await scanPathSize(spec.filePath, spec.pathCategory);
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

function claudeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME || os.homedir(), '.claude');
}

async function exists(filePath: string): Promise<boolean> {
  return await lstat(filePath)
    .then(() => true)
    .catch(() => false);
}
