import type { Advisory, MaintenanceReport, Reclaimability, StateCategory, StateEntry } from '../types.js';

export type MaintenanceProviderId = 'codex' | 'claude-code' | 'cursor' | (string & {});
export type { Advisory, Reclaimability, StateCategory, StateEntry };

export type ProviderRuntimeOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type ProviderDetection = {
  present: boolean;
  roots: string[];
};

export type ProviderDoctorOptions = {
  generatedAt: string;
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type ProviderDoctorResult = {
  report: MaintenanceReport;
  reportPath?: string;
};

export type MaintenanceProvider = {
  id: MaintenanceProviderId;
  displayName: string;
  defaultPathCategory: string;
  detect(options?: ProviderRuntimeOptions): Promise<ProviderDetection>;
  scan(options?: ProviderRuntimeOptions): Promise<StateEntry[]>;
  advisories(options?: ProviderRuntimeOptions): Promise<Advisory[]>;
  runDoctor?(options: ProviderDoctorOptions): Promise<ProviderDoctorResult>;
};
