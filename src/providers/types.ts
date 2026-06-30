import type { MaintenanceReport } from '../types.js';
import type { SizeScanWarning } from '../fs-size.js';

export type MaintenanceProviderId = 'codex' | 'claude-code' | 'cursor' | (string & {});

export type StateCategory = 'session' | 'log' | 'cache' | 'model' | 'index' | 'appdb' | 'sidecar';
export type Reclaimability = 'never' | 'safe' | 'confirm';

export type ProviderRuntimeOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type ProviderDetection = {
  present: boolean;
  roots: string[];
};

export type StateEntry = {
  category: StateCategory;
  pathCategory: string;
  bytes: number;
  reclaimability: Reclaimability;
  note?: string;
  sizeTruncated?: boolean;
  warnings?: SizeScanWarning[];
};

export type Advisory = {
  severity: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  nextAction?: string;
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
