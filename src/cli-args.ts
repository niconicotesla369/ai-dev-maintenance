export type ParsedCli = {
  command: string;
  args: string[];
  noCommand: boolean;
  json: boolean;
  showPaths: boolean;
  noBanner: boolean;
  noInteractive: boolean;
  wait: boolean;
  waitTimeoutMinutes: number;
};

export function parseCliArgs(argv: string[]): ParsedCli {
  const noCommand = argv.length === 0 || argv[0]?.startsWith('-') === true;
  const command = noCommand ? 'doctor' : argv[0] ?? 'doctor';
  const args = noCommand ? argv : argv.slice(1);
  return {
    command,
    args,
    noCommand,
    json: args.includes('--json'),
    showPaths: args.includes('--show-paths'),
    noBanner: args.includes('--no-banner'),
    noInteractive: args.includes('--no-interactive'),
    wait: args.includes('--wait'),
    waitTimeoutMinutes: parseWaitTimeoutMinutes(args)
  };
}

export function unknownFlagError(args: string[], allowed: Set<string>, command: string): string | undefined {
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) continue;
    if (!allowed.has(arg)) unknown.push(arg);
    if (arg === '--wait-timeout') index += 1;
  }
  return unknown.length > 0 ? `Unknown ${command} flag: ${unknown.join(', ')}\n${usageText()}` : undefined;
}

export function invalidWaitTimeoutError(args: string[]): string | undefined {
  if (!args.includes('--wait-timeout')) return undefined;
  const raw = args[args.indexOf('--wait-timeout') + 1];
  if (!raw || raw.startsWith('-')) return `Missing --wait-timeout <minutes>.\n${usageText()}`;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return `Invalid --wait-timeout: ${raw}\n${usageText()}`;
  return undefined;
}

export function usageText(): string {
  return [
    'Usage:',
    '  ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive]',
    '  ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]',
    '  ai-dev-maintenance fix --safe --yes',
    '  ai-dev-maintenance report --latest [--show-paths]',
    '  ai-dev-maintenance restore validate --backup <path>'
  ].join('\n') + '\n';
}

function parseWaitTimeoutMinutes(args: string[]): number {
  const index = args.indexOf('--wait-timeout');
  if (index === -1) return 10;
  const parsed = Number(args[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}
