import type {
  CommandRunResult,
  FixSafetyInput,
  FixSafetyPlan,
  LsofClassification
} from './types.js';

export function classifyLsofResult(
  result: Pick<
    CommandRunResult,
    'code' | 'stdout' | 'stderr' | 'timedOut' | 'stdoutTruncated' | 'stderrTruncated'
  >
): LsofClassification {
  if ('timedOut' in result && result.timedOut) {
    return { usable: false, openHandles: false, reason: 'timeout' };
  }
  if ('stdoutTruncated' in result && result.stdoutTruncated) {
    return { usable: false, openHandles: false, reason: 'lsof_output_truncated' };
  }
  if ('stderrTruncated' in result && result.stderrTruncated) {
    return { usable: false, openHandles: false, reason: 'lsof_error_truncated' };
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    const lower = stderr.toLowerCase();
    if (lower.includes('permission denied') || lower.includes('operation not permitted')) {
      return { usable: false, openHandles: false, reason: 'permission_denied' };
    }
    return { usable: false, openHandles: false, reason: 'nonzero_stderr' };
  }
  if (result.code === 0) {
    return {
      usable: true,
      openHandles: stdout.length > 0,
      reason: stdout.length > 0 ? 'open handles reported' : 'no open handles reported'
    };
  }
  if (result.code === 1 && stdout.length === 0 && stderr.length === 0) {
    return { usable: true, openHandles: false, reason: 'no open handles reported' };
  }
  return { usable: false, openHandles: false, reason: 'nonzero_exit' };
}

export function planFixSafety(input: FixSafetyInput): FixSafetyPlan {
  const reasons: string[] = [];
  if (input.knownCodexProcessExists) reasons.push('known Codex process is running');
  if (input.anyOpenHandleOnTarget) reasons.push('target database is open by a process');
  if (!input.lsofUsable) reasons.push('open-handle check is unavailable');
  if (input.processListTruncated) reasons.push('process list check was truncated');
  return { allowed: reasons.length === 0, reasons };
}

export function parseKnownCodexProcess(psOutput: string, currentPid = process.pid): boolean {
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      const pid = Number(line.split(/\s+/, 1)[0]);
      if (pid === currentPid) return false;
      return /\b(Codex|codex|codex-cli|Codex Helper|OpenAI Codex|com\.openai\.codex)\b/.test(line);
    });
}
