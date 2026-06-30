export type ParsedCli = {
  command: string;
  args: string[];
  noCommand: boolean;
  json: boolean;
  showPaths: boolean;
  noBanner: boolean;
  plain: boolean;
  noInteractive: boolean;
  wait: boolean;
  waitTimeoutMinutes: number;
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

export function usageText(): string {
  return [
    'Usage:',
    '  ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive] [--no-banner] [--plain]',
    '  ai-dev-maintenance logo [--plain]',
    '  ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]',
    '  ai-dev-maintenance pressure [--json] [--no-banner] [--plain]',
    '  ai-dev-maintenance cursor clean --safe [--yes]',
    '  ai-dev-maintenance fix --safe --yes',
    '  ai-dev-maintenance report --latest [--show-paths]',
    '  ai-dev-maintenance reports prune --yes',
    '  ai-dev-maintenance backups prune --yes',
    '  ai-dev-maintenance restore validate --backup <path>'
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
