import { codexProvider } from './codex.js';
import type { MaintenanceProvider } from './types.js';

const providers: MaintenanceProvider[] = [codexProvider];

export function listProviders(): MaintenanceProvider[] {
  return [...providers];
}

export function getProvider(id: string): MaintenanceProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
