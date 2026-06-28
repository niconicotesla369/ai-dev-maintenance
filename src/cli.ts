import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redactPath } from './paths.js';
import { routeCli, type CliResult, type CliRuntimeOptions } from './cli-router.js';

export { fixSafeConfirmationError } from './cli-router.js';
export { renderReport } from './cli-render.js';
export { shouldShowBanner } from './cli-banner.js';

export async function runCli(argv = process.argv.slice(2), runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  return routeCli(argv, runtime);
}

export function isDirectCliInvocation(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  runCli()
    .then((result) => {
      if (!result.outputAlreadyWritten) process.stdout.write(result.output);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(formatCliError(error));
      process.exitCode = 1;
    });
}

export function formatCliError(error: unknown): string {
  return `${redactPath(error instanceof Error ? error.message : String(error))}\n`;
}
