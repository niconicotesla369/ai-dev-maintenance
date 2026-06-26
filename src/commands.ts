import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunResult, CommandStat } from './types.js';

export const ALLOWED_COMMANDS = {
  sqlite3: '/usr/bin/sqlite3',
  lsof: '/usr/sbin/lsof',
  ps: '/bin/ps'
} as const;

export function isTrustedSystemCommand(stat: CommandStat): boolean {
  const allowed = new Set<string>(Object.values(ALLOWED_COMMANDS));
  const groupOrOtherWritable = (stat.mode & 0o022) !== 0;
  return (
    allowed.has(stat.path) &&
    stat.uid === 0 &&
    !stat.isSymbolicLink &&
    !groupOrOtherWritable
  );
}

export async function trustedCommandPath(name: keyof typeof ALLOWED_COMMANDS): Promise<string> {
  const commandPath = ALLOWED_COMMANDS[name];
  const info = await lstat(commandPath);
  const trusted = isTrustedSystemCommand({
    path: commandPath,
    uid: info.uid,
    mode: info.mode,
    isSymbolicLink: info.isSymbolicLink()
  });
  if (!trusted) {
    throw new Error(`untrusted system command: ${name}`);
  }
  return commandPath;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number } = {}
): Promise<CommandRunResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 256_000;
  const maxStderrBytes = options.maxStderrBytes ?? 64_000;

  const childHome = await mkdtemp(path.join(os.tmpdir(), 'ai-dev-maintenance-home-'));
  await chmod(childHome, 0o700);

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: childHome
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let timeoutSignal: NodeJS.Signals | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: CommandRunResult) => {
      rm(childHome, { recursive: true, force: true })
        .catch(() => undefined)
        .finally(() =>
          resolve({
            ...result,
            stdoutTruncated,
            stderrTruncated
          })
        );
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutSignal = 'SIGTERM';
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        timeoutSignal = 'SIGKILL';
        child.kill('SIGKILL');
      }, 1_000);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxStdoutBytes) {
        stdoutTruncated = true;
        return;
      }
      const next = Buffer.concat([stdout, chunk]);
      if (next.length > maxStdoutBytes) stdoutTruncated = true;
      stdout = next.subarray(0, maxStdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= maxStderrBytes) {
        stderrTruncated = true;
        return;
      }
      const next = Buffer.concat([stderr, chunk]);
      if (next.length > maxStderrBytes) stderrTruncated = true;
      stderr = next.subarray(0, maxStderrBytes);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      finish({ code: null, stdout: '', stderr: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      finish({
        code,
        signal: signal ?? timeoutSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut
      });
    });
  });
}
