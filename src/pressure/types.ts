export type PressureProviderId =
  | 'codex'
  | 'claude-code'
  | 'cursor'
  | 'remote-control'
  | 'other';

export type PressureProcessCategory =
  | 'app'
  | 'renderer'
  | 'extension-host'
  | 'terminal'
  | 'language-server'
  | 'browser'
  | 'build-tool'
  | 'system'
  | 'helper'
  | 'remote-control'
  | 'other';

export type PressureProcess = {
  pid: number;
  ppid: number;
  provider: PressureProviderId;
  category: PressureProcessCategory;
  displayName: string;
  cpuPercent: number;
  memoryPercent: number;
  rssBytes: number;
  commandSummary: string;
};

export type MemoryPressureSnapshot = {
  totalBytes?: number;
  pageSizeBytes?: number;
  freeBytes?: number;
  freePercent?: number;
  pagesFree?: number;
  pagesPurgeable?: number;
  pagesUsedByCompressor?: number;
  swapins?: number;
  swapouts?: number;
  pageins?: number;
  pageouts?: number;
};

export type DiskPressureSnapshot = {
  capacityPercent?: number;
  availableBytes?: number;
};

export type PressureLevel = 'ok' | 'medium' | 'high';

export type PressureLevelSummary = {
  overall: PressureLevel;
  cpu: PressureLevel;
  memory: PressureLevel;
  disk: PressureLevel;
  reasons: string[];
};

export type PressureReport = {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  command: 'pressure';
  status: 'ok' | 'partial' | 'unsupported' | 'error';
  redacted: true;
  platform: NodeJS.Platform;
  memory: MemoryPressureSnapshot;
  disk: DiskPressureSnapshot;
  processes: PressureProcess[];
  totals: {
    aiCpuPercent: number;
    aiRssBytes: number;
    processCount: number;
  };
  pressureLevel: PressureLevelSummary;
  warnings: string[];
  nextActions: string[];
};
