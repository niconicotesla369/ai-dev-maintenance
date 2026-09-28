import { bannerText } from './cli-banner.js';
import { formatBytes } from './cli-render.js';
import type { NormalizedCliIo } from './cli-io.js';
import { redactPath } from './paths.js';
import type { ApplyPlanResult, MaintenancePlanSummary } from './plan.js';
import {
  RECLAIM_ACTION_LABELS,
  buildReclaimRunRecord,
  byteChange,
  newReclaimRunId,
  outcomeLabel,
  renderReclaimRunRecord,
  sumOrNull,
  type ReclaimAction,
  type ReclaimMeasurer,
  type ReclaimOutcome,
  type ReclaimRunItem,
  type ReclaimRunRecord
} from './reclaim-run.js';
import { deriveFixReadiness } from './safety.js';
import type { MaintenanceReport } from './types.js';
import { box } from './ui/components.js';

export type GuidedCommands = {
  runDoctor: (options?: { persistReport?: boolean }) => Promise<{ report: MaintenanceReport; reportPath?: string }>;
  createPlan: (action: ReclaimAction) => Promise<MaintenancePlanSummary>;
  applyPlan: (planId: string) => Promise<ApplyPlanResult>;
  cursorBlocker: () => Promise<string | undefined>;
  measurer: ReclaimMeasurer;
  writeRunRecord: (record: ReclaimRunRecord) => Promise<string>;
};

export type GuidedOptions = {
  io: NormalizedCliIo;
  commands: GuidedCommands;
  wait: boolean;
  waitTimeoutMinutes: number;
  banner: {
    enabled: boolean;
    color: boolean;
    columns: number;
  };
  pretty: boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type GuidedResult = {
  exitCode: number;
  output: string;
  outputAlreadyWritten: boolean;
};

type CandidateStatus = 'ready' | 'blocked' | 'empty';

type Candidate = {
  action: ReclaimAction;
  status: CandidateStatus;
  planId?: string;
  estimateBytes: number | null;
  estimateNote?: 'wal-folds-into-database';
  lines: string[];
  reasons: string[];
  waitable: boolean;
};

const PROTECTED_TEXT = 'chats, session history, settings, sign-ins, workspace state, code, Git';

export async function runGuidedCli(options: GuidedOptions): Promise<GuidedResult> {
  try {
    if (options.banner.enabled) {
      await options.io.write(bannerText({ style: 'hero', color: options.banner.color, columns: options.banner.columns }));
    }
    await writeSection(options, 'AIDM SAFE RECLAIM', [
      'Reclaims only known, rebuildable caches and SQLite write-ahead logs.',
      'Always protected:',
      `  ${PROTECTED_TEXT}.`,
      'Nothing changes until you approve each item.'
    ], 'info');
    return await offerCandidates(options, { waited: false });
  } catch (error) {
    if (error instanceof GuidedAbort) return finish(options, 0);
    throw error;
  }
}

async function offerCandidates(options: GuidedOptions, state: { waited: boolean }): Promise<GuidedResult> {
  await options.io.write('Checking what can be reclaimed safely...\n');
  // The readiness check is Codex-only; persisting it would replace the latest full diagnosis report.
  const diagnosis = await options.commands.runDoctor({ persistReport: false });
  const candidates = await discoverCandidates(options, diagnosis.report);
  await writeCandidates(options, candidates);

  const ready = candidates.filter((candidate) => candidate.status === 'ready');
  if (ready.length === 0) {
    const waitable = candidates.some((candidate) => candidate.waitable);
    if (options.wait && waitable && !state.waited) {
      if (await waitForCodexRelease(options)) return offerCandidates(options, { waited: true });
      await options.io.write('Wait timed out. Nothing was changed.\n');
    } else {
      await options.io.write('Nothing can be reclaimed right now. Nothing was changed.\n');
    }
    return recheckOrQuit(options);
  }

  const approved: Candidate[] = [];
  for (const candidate of ready) {
    const answer = normalizeAnswer(await ask(options, `Reclaim ${RECLAIM_ACTION_LABELS[candidate.action]}? [y/N] `));
    if (answer === 'y' || answer === 'yes') approved.push(candidate);
  }
  if (approved.length === 0) {
    await options.io.write('No cleanup was run. Nothing was changed.\n');
    return finish(options, 0);
  }
  return runApproved(options, approved);
}

async function discoverCandidates(options: GuidedOptions, doctorReport: MaintenanceReport): Promise<Candidate[]> {
  return [await codexCandidate(options, doctorReport), await cursorCandidate(options)];
}

async function codexCandidate(options: GuidedOptions, doctorReport: MaintenanceReport): Promise<Candidate> {
  const targetState = (doctorReport.findings as Record<string, unknown>).targetState as
    | { main?: { size?: number }; wal?: { size?: number } }
    | undefined;
  const walBytes = targetState?.wal?.size ?? 0;
  const mainBytes = targetState?.main?.size ?? 0;
  const base = { action: 'codex-fix' as const, estimateBytes: null, estimateNote: 'wal-folds-into-database' as const };
  if (walBytes <= 0) {
    return { ...base, status: 'empty', lines: ['Nothing to fold: no SQLite write-ahead log bytes.'], reasons: [], waitable: false };
  }
  const plan = await options.commands.createPlan('codex-fix');
  const readiness = deriveFixReadiness(doctorReport);
  const reasons = unique([...plan.blockedReasons, ...(readiness.safe ? [] : readiness.reasons)]);
  return {
    ...base,
    status: plan.status === 'ready' && readiness.safe ? 'ready' : 'blocked',
    planId: plan.planId,
    lines: [
      `Estimate      none: ${formatBytes(walBytes)} WAL is folded into the DB, not deleted`,
      'Why           SQLite WAL not yet folded into the Codex log DB',
      `Impact        private backup (~${formatBytes(mainBytes + walBytes)}) kept first; rows kept`
    ],
    reasons,
    waitable: reasons.includes('target database is open by a process')
  };
}

async function cursorCandidate(options: GuidedOptions): Promise<Candidate> {
  const plan = await options.commands.createPlan('cursor-clean');
  const estimate = plan.preview.reclaimableBytes ?? 0;
  const base = { action: 'cursor-clean' as const, planId: plan.planId, estimateBytes: estimate, waitable: false };
  if (plan.status === 'ready' && estimate <= 0) {
    return { ...base, status: 'empty', lines: ['Nothing to remove: Cursor caches and logs are empty or absent.'], reasons: [] };
  }
  // A running Cursor rewrites its caches, so offering the item would only end in a drifted plan.
  const processBlocker = plan.status === 'ready' ? await options.commands.cursorBlocker() : undefined;
  return {
    ...base,
    status: plan.status === 'ready' && !processBlocker ? 'ready' : 'blocked',
    lines: [
      `Estimate      ${formatBytes(estimate)} in ${plan.preview.targetCount ?? 0} cache/log folders`,
      'Why           Cursor rebuilds its caches, VSIX cache, and logs',
      'Impact        Cursor must be closed; rebuilt on next launch'
    ],
    reasons: processBlocker ? [...plan.blockedReasons, processBlocker] : plan.blockedReasons
  };
}

async function writeCandidates(options: GuidedOptions, candidates: Candidate[]): Promise<void> {
  const lines: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) lines.push('');
    lines.push(`[${index + 1}] ${RECLAIM_ACTION_LABELS[candidate.action]}  ${statusLabel(candidate.status)}`);
    for (const line of candidate.lines) lines.push(`    ${line}`);
    for (const reason of candidate.reasons) lines.push(`    Reason        ${reason}`);
  }
  await writeSection(options, 'WHAT CAN BE RECLAIMED', lines, 'info');
}

async function runApproved(options: GuidedOptions, approved: Candidate[]): Promise<GuidedResult> {
  const { measurer } = options.commands;
  const startedAt = new Date(options.now());
  const volumeBefore = await measurer.volumeAvailableBytes();
  const appDataBefore = await measurer.appDataBytes();
  const items: ReclaimRunItem[] = [];

  for (const candidate of approved) {
    const before = await measurer.targetBytes(candidate.action);
    await options.io.write(`Re-checking and reclaiming ${RECLAIM_ACTION_LABELS[candidate.action]}...\n`);
    let outcome: ReclaimOutcome;
    let reasons: string[];
    try {
      const result = await options.commands.applyPlan(candidate.planId ?? '');
      outcome = result.status;
      reasons = result.blockedReasons.map(friendlyReason);
    } catch (error) {
      outcome = 'unknown';
      reasons = [`apply outcome is unknown: ${error instanceof Error ? error.message : String(error)}`];
    }
    const after = await measurer.targetBytes(candidate.action);
    await options.io.write(`  ${outcomeLabel(outcome)}\n`);
    items.push({
      action: candidate.action,
      outcome,
      estimateBytes: candidate.estimateBytes,
      ...(candidate.estimateNote ? { estimateNote: candidate.estimateNote } : {}),
      target: byteChange(before, after),
      reasons
    });
  }

  const appDataAfter = await measurer.appDataBytes();
  const volumeAfter = await measurer.volumeAvailableBytes();
  const record = buildReclaimRunRecord({
    runId: newReclaimRunId(startedAt),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(options.now()).toISOString(),
    items,
    managedState: byteChange(
      sumOrNull([...items.map((item) => item.target.beforeBytes), appDataBefore]),
      sumOrNull([...items.map((item) => item.target.afterBytes), appDataAfter])
    ),
    volume: byteChange(volumeBefore, volumeAfter)
  });

  let savedPath: string | undefined;
  let saveWarning: string | undefined;
  try {
    savedPath = redactPath(await options.commands.writeRunRecord(record));
  } catch (error) {
    saveWarning = `Result record could not be saved: ${redactPath(error instanceof Error ? error.message : String(error))}`;
  }
  const lines = renderReclaimRunRecord(record, savedPath);
  if (saveWarning) lines.push(`Warning         ${saveWarning}`);
  if (savedPath) lines.push('View            aidm doctor --html');
  await writeSection(options, 'WHAT CHANGED', lines, record.status === 'ok' ? 'success' : 'info');
  return finish(options, record.status === 'ok' && !saveWarning ? 0 : 3);
}

async function waitForCodexRelease(options: GuidedOptions): Promise<boolean> {
  await options.io.write('Waiting for Codex to release its log database. AIDM will not force close Codex.\n');
  const started = options.now();
  const timeoutMs = options.waitTimeoutMinutes * 60 * 1000;
  while (options.now() - started < timeoutMs) {
    const elapsed = options.now() - started;
    await options.sleep(elapsed < 30_000 ? 2_000 : 5_000);
    const diagnosis = await options.commands.runDoctor({ persistReport: false });
    if (deriveFixReadiness(diagnosis.report).safe) {
      await options.io.write('Database released.\n');
      return true;
    }
  }
  return false;
}

async function recheckOrQuit(options: GuidedOptions): Promise<GuidedResult> {
  while (true) {
    await writeSection(options, 'What do you want to do?', [
      '[1] Re-check    Check again now',
      '[2] Quit        Exit AIDM'
    ], 'info');
    const answer = normalizeAnswer(await ask(options, 'Choose [1-2]: '));
    if (answer === '1' || answer === 'r' || answer === 'retry') return offerCandidates(options, { waited: true });
    if (answer === '2' || answer === 'q' || answer === 'quit' || answer === '') {
      await options.io.write('No cleanup was run.\n');
      return finish(options, 0);
    }
    await options.io.write('Please choose 1 or 2.\n');
  }
}

async function writeSection(
  options: GuidedOptions,
  title: string,
  lines: string[],
  tone: 'info' | 'success'
): Promise<void> {
  if (options.pretty) {
    await options.io.write(`${box(title, lines, { width: guidedWidth(options), color: options.banner.color, tone })}\n`);
    return;
  }
  await options.io.write(`${title}\n${lines.map((line) => `${line}\n`).join('')}\n`);
}

function statusLabel(status: CandidateStatus): string {
  if (status === 'ready') return 'ready';
  if (status === 'blocked') return 'paused for safety';
  return 'nothing to reclaim';
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

function guidedWidth(options: GuidedOptions): number {
  return Math.max(80, Math.min(options.io.columns, 110));
}

function friendlyReason(reason: string): string {
  if (reason === 'plan identity drifted') {
    return 'targets changed after the check (is the app running?); nothing was changed. Close it and re-check.';
  }
  return reason;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
