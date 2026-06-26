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

export type MaintenanceReport = {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  command: string;
  status: ReportStatus;
  redacted: true;
  target: {
    kind: 'default-codex-log-db' | 'unknown';
    pathCategory: string;
  };
  findings: Record<string, unknown>;
  metrics: Record<string, unknown>;
  blockedReasons: string[];
  nextSafeAction?: string;
};
