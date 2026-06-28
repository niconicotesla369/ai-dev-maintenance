import { bannerText } from './cli-banner.js';
import { renderReport, row, targetSizeRows } from './cli-render.js';
import type { NormalizedCliIo } from './cli-io.js';
import { deriveFixReadiness } from './safety.js';
import type { MaintenanceReport } from './types.js';
import { TOOL_VERSION } from './version.js';

export type GuidedCommands = {
  runDoctor: () => Promise<{ report: MaintenanceReport; reportPath?: string }>;
  runFixSafe: () => Promise<{ report: MaintenanceReport; reportPath?: string }>;
};

export type GuidedOptions = {
  io: NormalizedCliIo;
  commands: GuidedCommands;
  wait: boolean;
  waitTimeoutMinutes: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type GuidedResult = {
  exitCode: number;
  output: string;
  outputAlreadyWritten: boolean;
};

export async function runGuidedCli(options: GuidedOptions): Promise<GuidedResult> {
  try {
    await options.io.write(bannerText());
    await options.io.write('Checking whether Codex cleanup is safe...\n');
    await options.io.write('AIDM will not delete chats, rewrite history, or touch Codex while it is open.\n\n');

    const diagnosis = await options.commands.runDoctor();
    return handleDoctorResult(options, diagnosis);
  } catch (error) {
    if (error instanceof GuidedAbort) return finish(options, 0);
    throw error;
  }
}

async function handleDoctorResult(
  options: GuidedOptions,
  diagnosis: { report: MaintenanceReport; reportPath?: string }
): Promise<GuidedResult> {
  const readiness = deriveFixReadiness(diagnosis.report);
  if (readiness.safe) return handleReady(options, diagnosis);

  await options.io.write(row('Status', 'Paused for safety') + '\n');
  await options.io.write(row('Reason', readiness.reasons.join('; ') || 'not safe to clean yet') + '\n');
  await options.io.write(row('Target', diagnosis.report.target.pathCategory) + '\n');
  for (const line of targetSizeRows(diagnosis.report)) await options.io.write(`${line}\n`);
  await options.io.write('\nCodex is still open, so AIDM will not clean anything yet.\n');
  await options.io.write('Nothing was changed except a redacted local report.\n');
  await options.io.write('WAL is SQLite temporary log storage; SHM is SQLite sidecar metadata.\n\n');

  if (options.wait) return waitUntilReady(options);

  while (true) {
    await options.io.write('What do you want to do?\n');
    await options.io.write('1. Wait\n');
    await options.io.write('2. Re-check\n');
    await options.io.write('3. Show report command\n');
    await options.io.write('4. Quit\n');
    const answer = normalizeAnswer(await ask(options, 'Choose [1-4]: '));
    if (answer === '1' || answer === 'wait') return waitUntilReady(options);
    if (answer === '2' || answer === 'r' || answer === 'retry') {
      await options.io.write('\nRe-checking...\n\n');
      return handleDoctorResult(options, await options.commands.runDoctor());
    }
    if (answer === '3' || answer === 'report') {
      await options.io.write(`Review with: npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- report --latest\n`);
      return finish(options, 0);
    }
    if (answer === '4' || answer === 'q' || answer === 'quit' || answer === '') {
      await options.io.write('No cleanup was run.\n');
      return finish(options, 0);
    }
    await options.io.write('Please choose 1, 2, 3, or 4.\n');
  }
}

async function handleReady(
  options: GuidedOptions,
  diagnosis: { report: MaintenanceReport; reportPath?: string }
): Promise<GuidedResult> {
  await options.io.write(row('Status', 'Ready to clean') + '\n');
  await options.io.write(row('Target', diagnosis.report.target.pathCategory) + '\n');
  for (const line of targetSizeRows(diagnosis.report)) await options.io.write(`${line}\n`);
  await options.io.write('\nCodex is closed and no open database handles were found.\n');
  await options.io.write('AIDM will create a private backup first, then run SQLite WAL checkpoint/truncate.\n');
  await options.io.write('If any safety check changes, it will stop without modifying the database.\n\n');

  const answer = normalizeAnswer(await ask(options, 'Clean now? [y/N] '));
  if (answer !== 'y' && answer !== 'yes') {
    await options.io.write('No cleanup was run.\n');
    return finish(options, 0);
  }

  await options.io.write('\nRunning safe cleanup...\n');
  const fix = await options.commands.runFixSafe();
  await options.io.write(renderReport(fix.report, fix.reportPath));
  return finish(options, fix.report.status === 'ok' ? 0 : 3);
}

async function waitUntilReady(options: GuidedOptions): Promise<GuidedResult> {
  await options.io.write('Waiting for Codex to close safely. AIDM will not force close Codex.\n');
  const started = options.now();
  const timeoutMs = options.waitTimeoutMinutes * 60 * 1000;

  while (options.now() - started < timeoutMs) {
    const elapsed = options.now() - started;
    await options.sleep(elapsed < 30_000 ? 2_000 : 5_000);
    const diagnosis = await options.commands.runDoctor();
    const readiness = deriveFixReadiness(diagnosis.report);
    if (readiness.safe) {
      await options.io.write('\nDatabase released.\n');
      return handleReady(options, diagnosis);
    }
  }

  await options.io.write('Wait timed out. Nothing was changed.\n');
  await options.io.write('What do you want to do?\n');
  await options.io.write('1. Re-check\n');
  await options.io.write('2. Quit\n');
  const answer = normalizeAnswer(await ask(options, 'Choose [1-2]: '));
  if (answer === '1' || answer === 'r' || answer === 'retry') {
    await options.io.write('\nRe-checking...\n\n');
    return handleDoctorResult(options, await options.commands.runDoctor());
  }
  await options.io.write('No cleanup was run.\n');
  return finish(options, 0);
}

function finish(options: GuidedOptions, exitCode: number): GuidedResult {
  return {
    exitCode,
    output: options.io.output(),
    outputAlreadyWritten: options.io.writesLive
  };
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

async function ask(options: GuidedOptions, prompt: string): Promise<string> {
  try {
    return await options.io.readLine(prompt);
  } catch {
    await options.io.write('Interrupted. Nothing was changed before cleanup confirmation.\n');
    throw new GuidedAbort();
  }
}

class GuidedAbort extends Error {}
