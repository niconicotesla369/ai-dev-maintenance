export type ParsedCli = {
  command: string;
  args: string[];
  noCommand: boolean;
  json: boolean;
  showPaths: boolean;
  share: boolean;
  html: boolean;
  noBanner: boolean;
  plain: boolean;
  noInteractive: boolean;
  wait: boolean;
  waitTimeoutMinutes: number;
};

export type IntegerFlagOptions = {
  flag: string;
  min: number;
  max: number;
  required?: boolean;
};

export type IntegerFlagResult = {
  value?: number;
  error?: string;
};

export function parseCliArgs(argv: string[]): ParsedCli {
  const commandIndex = findCommandIndex(argv);
  const noCommand = commandIndex === -1;
  const command = noCommand ? 'doctor' : argv[commandIndex] ?? 'doctor';
  const args = noCommand ? argv : [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
  return {
    command,
    args,
    noCommand,
    json: args.includes('--json'),
    showPaths: args.includes('--show-paths'),
    share: args.includes('--share'),
    html: args.includes('--html'),
    noBanner: args.includes('--no-banner'),
    plain: args.includes('--plain'),
    noInteractive: args.includes('--no-interactive'),
    wait: args.includes('--wait'),
    waitTimeoutMinutes: parseWaitTimeoutMinutes(args)
  };
}

function findCommandIndex(argv: string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--wait-timeout') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--wait-timeout=')) continue;
    if (!arg.startsWith('-')) return index;
  }
  return -1;
}

export function unknownFlagError(args: string[], allowed: Set<string>, command: string): string | undefined {
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) continue;
    if (arg.startsWith('--wait-timeout=') && allowed.has('--wait-timeout')) continue;
    if (!allowed.has(arg)) unknown.push(arg);
    if (arg === '--wait-timeout') index += 1;
  }
  return unknown.length > 0 ? `Unknown ${command} flag: ${unknown.join(', ')}\n${usageText()}` : undefined;
}

export function invalidWaitTimeoutError(args: string[]): string | undefined {
  const raw = rawWaitTimeout(args);
  if (raw === undefined) return undefined;
  if (!raw || raw.startsWith('-')) return `Missing --wait-timeout <minutes>.\n${usageText()}`;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return `Invalid --wait-timeout: ${raw}\n${usageText()}`;
  return undefined;
}

export function readIntegerFlag(
  args: string[],
  options: IntegerFlagOptions
): IntegerFlagResult {
  const indexes = args.flatMap((arg, index) => arg === options.flag ? [index] : []);
  if (indexes.length > 1) {
    return { error: `Duplicate ${options.flag}.\n${usageText()}` };
  }
  if (indexes.length === 0) {
    return options.required
      ? { error: `Missing ${options.flag} <integer>.\n${usageText()}` }
      : {};
  }

  const raw = args[(indexes[0] ?? -1) + 1];
  if (!raw || raw.startsWith('-')) {
    return { error: `Missing ${options.flag} <integer>.\n${usageText()}` };
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    return { error: invalidIntegerFlagMessage(options, raw) };
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < options.min
    || value > options.max
  ) {
    return { error: invalidIntegerFlagMessage(options, raw) };
  }
  return { value };
}

export function positionalArgsExcludingFlagValues(
  args: string[],
  valueFlags: ReadonlySet<string>
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) positionals.push(arg);
  }
  return positionals;
}

export function usageText(): string {
  return [
    'Usage:',
    '  ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive] [--no-banner] [--plain]',
    '  ai-dev-maintenance --help | -h',
    '  ai-dev-maintenance --version | -v | version',
  '  ai-dev-maintenance logo [--plain]',
  '  ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--html] [--no-banner]',
  '  ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]',
  '  ai-dev-maintenance history [--json] [--plain]',
  '  ai-dev-maintenance trust [--json]',
  '  ai-dev-maintenance reclaim scan codex-session-images [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]',
  '  ai-dev-maintenance reclaim status codex-native-compression [--json]',
  '  ai-dev-maintenance monitor codex-sessions [--json]',
  '  ai-dev-maintenance plan codex-fix|cursor-clean [--json]',
  '  ai-dev-maintenance plan codex-sparkle-clean [--json]',
  '  ai-dev-maintenance plan codex-session-image-prune [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]',
  '  ai-dev-maintenance plan codex-session-monitor-install [--threshold-gib <GiB>] [--growth-gib <GiB>] [--json]',
  '  ai-dev-maintenance plan codex-session-monitor-remove [--json]',
  '  ai-dev-maintenance apply --plan <planId> --yes [--accept-image-loss] [--json]',
  '  ai-dev-maintenance mcp serve',
  '  ai-dev-maintenance cursor clean --safe [--yes] [--json]',
  '  ai-dev-maintenance fix --safe --yes [--json]',
  '  ai-dev-maintenance report --latest [--show-paths] [--json] [--html]',
  '  ai-dev-maintenance reports prune --yes [--json]',
  '  ai-dev-maintenance backups prune --yes [--json]',
  '  ai-dev-maintenance restore validate --backup <path> [--json]'
  ].join('\n') + '\n';
}

function parseWaitTimeoutMinutes(args: string[]): number {
  const raw = rawWaitTimeout(args);
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function rawWaitTimeout(args: string[]): string | undefined {
  const equals = args.find((arg) => arg.startsWith('--wait-timeout='));
  if (equals) return equals.slice('--wait-timeout='.length);
  const index = args.indexOf('--wait-timeout');
  if (index === -1) return undefined;
  return args[index + 1];
}

function invalidIntegerFlagMessage(options: IntegerFlagOptions, raw: string): string {
  return `Invalid ${options.flag}: ${raw}. Expected an integer from ${options.min} to ${options.max}.\n${usageText()}`;
}
