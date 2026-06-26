import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { SqliteMode } from './types.js';

const macHomePathPattern = /\/Users\/[^/]+/g;
const nonHomeAbsolutePathStart = /\/(?:private|Volumes|tmp|var)\//g;

export function createSqliteUri(absolutePath: string, mode: SqliteMode): string {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('SQLite paths must be absolute');
  }
  const url = pathToFileURL(absolutePath);
  url.searchParams.set('mode', mode);
  return url.href;
}

export function redactPath(value: string): string {
  const home = os.homedir();
  let redacted = value;
  if (home) {
    redacted = redacted.replaceAll(home, '<home>');
  }
  redacted = redacted.replace(macHomePathPattern, '<home>');
  return redactNonHomeAbsolutePaths(redacted);
}

function redactNonHomeAbsolutePaths(value: string): string {
  let result = '';
  let cursor = 0;
  for (const match of value.matchAll(nonHomeAbsolutePathStart)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const end = findAbsolutePathEnd(value, start);
    result += value.slice(cursor, start);
    result += '<absolute-path>';
    cursor = end;
  }
  return result + value.slice(cursor);
}

function findAbsolutePathEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && !['"', "'", ',', ';', ':', ')', '\n', '\r'].includes(value[end] ?? '')) {
    end++;
  }
  const segment = value.slice(start, end);
  const extensionBeforeSpace = /\.[A-Za-z0-9_-]+(?=\s)/.exec(segment);
  if (extensionBeforeSpace) return start + extensionBeforeSpace.index + extensionBeforeSpace[0].length;
  return end;
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): {
  codexHome: string;
  custom: boolean;
} {
  const defaultHome = path.join(os.homedir(), '.codex');
  const candidate = env.CODEX_HOME;
  if (candidate && path.resolve(candidate) !== defaultHome) {
    return { codexHome: path.resolve(candidate), custom: true };
  }
  return { codexHome: defaultHome, custom: false };
}

export function targetTriple(mainPath: string): string[] {
  return [mainPath, `${mainPath}-wal`, `${mainPath}-shm`];
}

export function appDataHome(): string {
  return path.join(os.homedir(), '.ai-dev-maintenance');
}
