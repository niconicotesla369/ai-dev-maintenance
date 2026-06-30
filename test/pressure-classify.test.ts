import { describe, expect, test } from 'vitest';
import { classifyPressureProcesses, redactCommandSummary } from '../src/pressure/classify.js';

describe('pressure process classification', () => {
  test('classifies Codex, Claude, Cursor, and remote-control processes', () => {
    const rows = [
      raw('/Applications/Codex.app/Contents/Resources/codex', 10),
      raw('/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)', 11),
      raw('claude', 12),
      raw('/Applications/Cursor.app/Contents/MacOS/Cursor', 13),
      raw('Cursor Helper: extension-host (user) project [1-1]', 14),
      raw('/Library/PrivilegedHelperTools/ChromeRemoteDesktopHost.app/Contents/MacOS/remoting_me2me_host', 15),
      raw('/usr/libexec/syspolicyd', 16)
    ];

    expect(classifyPressureProcesses(rows).map((row) => [row.pid, row.provider, row.category])).toEqual([
      [10, 'codex', 'app'],
      [11, 'codex', 'renderer'],
      [12, 'claude-code', 'app'],
      [13, 'cursor', 'app'],
      [14, 'cursor', 'extension-host'],
      [15, 'remote-control', 'remote-control'],
      [16, 'other', 'other']
    ]);
  });

  test('redacts absolute local paths from command summaries', () => {
    const summary = redactCommandSummary('/tmp/example/private/project/node server.js --token abc');

    expect(summary).toContain('<absolute-path>');
    expect(summary).not.toContain('/tmp/example/private');
    expect(summary).not.toContain('abc');
  });
});

function raw(command: string, pid: number) {
  return {
    pid,
    ppid: 1,
    cpuPercent: pid,
    memoryPercent: 1,
    rssBytes: pid * 1024,
    command
  };
}
