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
      [16, 'other', 'system']
    ]);
  });

  test('redacts absolute local paths from command summaries', () => {
    const summary = redactCommandSummary('/tmp/example/private/project/node server.js --token abc');

    expect(summary).toContain('<absolute-path>');
    expect(summary).not.toContain('/tmp/example/private');
    expect(summary).not.toContain('abc');
  });

  test('gives common high-pressure non-AI processes readable categories and names', () => {
    const rows = [
      raw('/usr/local/bin/node ./node_modules/vitest/vitest.mjs run', 20),
      raw('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)', 21),
      raw('/usr/libexec/syspolicyd', 22)
    ];

    expect(classifyPressureProcesses(rows).map((row) => [row.displayName, row.provider, row.category])).toEqual([
      ['node/vitest', 'other', 'build-tool'],
      ['Chrome Helper', 'other', 'browser'],
      ['syspolicyd', 'other', 'system']
    ]);
  });

  test('keeps non-AI command summaries to the executable basename only', () => {
    const [process] = classifyPressureProcesses([
      raw('/usr/local/bin/python worker.py -p private-value Bearer secret-token --project sensitive', 30)
    ]);

    expect(process.provider).toBe('other');
    expect(process.commandSummary).toBe('python');
    expect(process.commandSummary).not.toContain('private-value');
    expect(process.commandSummary).not.toContain('Bearer');
    expect(process.commandSummary).not.toContain('secret-token');
    expect(process.commandSummary).not.toContain('--project');
  });

  test('characterizes known process labels without changing provider scope', () => {
    const rows = [
      raw('/Applications/Codex.app/Contents/MacOS/Codex', 40),
      raw('/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex Renderer.app/Contents/MacOS/Codex Renderer', 41),
      raw('claude', 42),
      raw('/Applications/Cursor.app/Contents/MacOS/Cursor', 43),
      raw('Cursor Helper: extension-host (user) workspace [1-1]', 44),
      raw('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper', 45),
      raw('/System/Library/CoreServices/WindowServer', 46),
      raw('/Library/PrivilegedHelperTools/ChromeRemoteDesktopHost.app/Contents/MacOS/remoting_me2me_host', 47)
    ];

    expect(classifyPressureProcesses(rows).map((row) => [row.displayName, row.provider, row.category])).toEqual([
      ['Codex', 'codex', 'app'],
      ['Codex Renderer', 'codex', 'renderer'],
      ['Claude', 'claude-code', 'app'],
      ['Cursor', 'cursor', 'app'],
      ['Cursor ExtHost', 'cursor', 'extension-host'],
      ['Chrome Helper', 'other', 'browser'],
      ['WindowServer', 'other', 'system'],
      ['Remote Desktop', 'remote-control', 'remote-control']
    ]);
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
