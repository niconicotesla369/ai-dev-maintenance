import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanPathSize } from '../fs-size.js';
import type { MaintenanceProvider, ProviderRuntimeOptions, Reclaimability, StateCategory, StateEntry } from './types.js';

const CURSOR_ROOT_CATEGORY = '<home>/Library/Application Support/Cursor';

export const cursorProvider = {
  id: 'cursor',
  displayName: 'Cursor',
  defaultPathCategory: CURSOR_ROOT_CATEGORY,
  detect: detectCursor,
  scan: scanCursor,
  advisories: async () => []
} satisfies MaintenanceProvider;

async function detectCursor(options: ProviderRuntimeOptions = {}) {
  const root = cursorRoot(options.env);
  return {
    present: await exists(root),
    roots: [CURSOR_ROOT_CATEGORY]
  };
}

async function scanCursor(options: ProviderRuntimeOptions = {}): Promise<StateEntry[]> {
  const root = cursorRoot(options.env);
  const candidates = [
    entrySpec(
      path.join(root, 'User', 'globalStorage', 'state.vscdb'),
      `${CURSOR_ROOT_CATEGORY}/User/globalStorage/state.vscdb`,
      'appdb',
      'never',
      'private conversation and history database; never touched'
    ),
    entrySpec(
      path.join(root, 'User', 'globalStorage', 'state.vscdb.backup'),
      `${CURSOR_ROOT_CATEGORY}/User/globalStorage/state.vscdb.backup`,
      'appdb',
      'never',
      'private conversation and history database backup; never touched'
    ),
    entrySpec(
      path.join(root, 'Cache'),
      `${CURSOR_ROOT_CATEGORY}/Cache`,
      'cache',
      'safe',
      'cache data; cleanup is not implemented in v0.2.0'
    ),
    entrySpec(
      path.join(root, 'CachedData'),
      `${CURSOR_ROOT_CATEGORY}/CachedData`,
      'cache',
      'safe',
      'cached runtime data; cleanup is not implemented in v0.2.0'
    ),
    entrySpec(
      path.join(root, 'CachedExtensionVSIXs'),
      `${CURSOR_ROOT_CATEGORY}/CachedExtensionVSIXs`,
      'cache',
      'safe',
      'extension cache; cleanup is not implemented in v0.2.0'
    ),
    entrySpec(
      path.join(root, 'logs'),
      `${CURSOR_ROOT_CATEGORY}/logs`,
      'log',
      'safe',
      'logs; cleanup is not implemented in v0.2.0'
    ),
    entrySpec(
      path.join(root, 'User', 'workspaceStorage'),
      `${CURSOR_ROOT_CATEGORY}/User/workspaceStorage`,
      'session',
      'confirm',
      'workspace state can contain project context; manual review required'
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

function cursorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME || os.homedir(), 'Library', 'Application Support', 'Cursor');
}

async function exists(filePath: string): Promise<boolean> {
  return await lstat(filePath)
    .then(() => true)
    .catch(() => false);
}
