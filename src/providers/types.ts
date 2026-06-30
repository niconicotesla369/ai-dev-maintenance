import type { MaintenanceReport } from '../types.js';

export type MaintenanceProviderId = 'codex' | (string & {});

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
  runDoctor(options: ProviderDoctorOptions): Promise<ProviderDoctorResult>;
};
