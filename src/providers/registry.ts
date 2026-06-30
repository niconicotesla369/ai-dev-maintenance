import { claudeCodeProvider } from './claude-code.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import type { MaintenanceProvider } from './types.js';

const providers: MaintenanceProvider[] = [codexProvider, claudeCodeProvider, cursorProvider];

export function listProviders(): MaintenanceProvider[] {
  return [...providers];
}

export function getProvider(id: string): MaintenanceProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
