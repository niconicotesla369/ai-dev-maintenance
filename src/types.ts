export type SqliteMode = 'ro' | 'rw';

export type CommandRunResult = {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type CommandStat = {
  path: string;
  uid: number;
  mode: number;
  isSymbolicLink: boolean;
};

export type LsofClassification = {
  usable: boolean;
  openHandles: boolean;
  reason: string;
};

export type FixSafetyInput = {
  knownCodexProcessExists: boolean;
  anyOpenHandleOnTarget: boolean;
  lsofUsable: boolean;
  processListTruncated?: boolean;
};

export type FixSafetyPlan = {
  allowed: boolean;
  reasons: string[];
};

export type FixReadiness = {
  safe: boolean;
  reasons: string[];
};

export type FileIdentity = {
  pathCategory: string;
  realpath?: string;
  dev?: number;
  ino?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  size?: number;
  mtimeMs?: number;
  nlink?: number;
  exists: boolean;
  regularFile: boolean;
  symbolicLink: boolean;
};

export type TargetState = {
  mainPath: string;
  exists: boolean;
  fixable: boolean;
  blockers: string[];
  main?: FileIdentity;
  wal?: FileIdentity;
  shm?: FileIdentity;
};

export type ReportStatus = 'ok' | 'partial' | 'blocked' | 'unsupported' | 'error';

export type StateCategory = 'session' | 'log' | 'cache' | 'model' | 'index' | 'appdb' | 'sidecar';
export type Reclaimability = 'never' | 'safe' | 'confirm';

export type StateEntry = {
  category: StateCategory;
  pathCategory: string;
  bytes: number;
  reclaimability: Reclaimability;
  note?: string;
  sizeTruncated?: boolean;
  warnings?: Array<Record<string, unknown>>;
};

export type Advisory = {
  severity: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  nextAction?: string;
};

export type ProviderReport = {
  id: string;
  displayName: string;
  present: boolean;
  totalBytes: number;
  buckets: {
    safeReclaimableBytes: number;
    confirmBytes: number;
    privateBytes: number;
  };
  entries: StateEntry[];
  advisories: Advisory[];
};

export type MaintenanceTotals = {
  totalBytes: number;
  safeReclaimableBytes: number;
  confirmBytes: number;
  privateBytes: number;
};

export type MaintenanceReport = {
  schemaVersion: 1 | 2;
  toolVersion: string;
  generatedAt: string;
  command: string;
  status: ReportStatus;
  redacted: true;
  target: {
    kind: 'default-codex-log-db' | 'aggregate-ai-tools' | 'unknown';
    pathCategory: string;
  };
  findings: Record<string, unknown>;
  metrics: Record<string, unknown>;
  blockedReasons: string[];
  nextSafeAction?: string;
  providers?: ProviderReport[];
  totals?: MaintenanceTotals;
};
