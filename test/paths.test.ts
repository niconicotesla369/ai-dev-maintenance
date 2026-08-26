import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  appDataHome,
  CODEX_SESSION_MONITOR_LABEL,
  codexSessionMonitorLaunchAgentPath,
  codexSessionMonitorReportPath,
  codexSessionMonitorStatePath,
  defaultCodexHome,
  monitorDataDir,
  resolveHome
} from '../src/paths.js';

describe('home path resolution', () => {
  test('resolves HOME from an injected environment before falling back to os.homedir', () => {
    expect(resolveHome({ HOME: '/tmp/aidm-home' })).toBe(path.resolve('/tmp/aidm-home'));
    expect(resolveHome({})).toBe(os.homedir());
  });

  test('uses the injected HOME for default Codex and app data paths', () => {
    const home = '/tmp/aidm-home';

    expect(defaultCodexHome({ HOME: home })).toEqual({
      codexHome: path.join(home, '.codex'),
      custom: false
    });
    expect(appDataHome({ HOME: home })).toBe(path.join(home, '.ai-dev-maintenance'));
  });

  test('does not mark CODEX_HOME as custom when it matches the injected HOME default', () => {
    const home = '/tmp/aidm-home';

    expect(defaultCodexHome({
      HOME: home,
      CODEX_HOME: path.join(home, '.codex')
    })).toEqual({
      codexHome: path.join(home, '.codex'),
      custom: false
    });
  });

  test('marks CODEX_HOME as custom when it differs from the injected HOME default', () => {
    const home = '/tmp/aidm-home';

    expect(defaultCodexHome({
      HOME: home,
      CODEX_HOME: '/tmp/alternate-codex'
    })).toEqual({
      codexHome: '/tmp/alternate-codex',
      custom: true
    });
  });

  test('uses fixed private monitor and LaunchAgent paths under the injected HOME', () => {
    const home = '/tmp/aidm-home';
    const env = { HOME: home };

    expect(CODEX_SESSION_MONITOR_LABEL).toBe(
      'com.niconicotesla369.ai-dev-maintenance.codex-session-monitor'
    );
    expect(monitorDataDir(env)).toBe(
      path.join(home, '.ai-dev-maintenance', 'monitor')
    );
    expect(codexSessionMonitorStatePath(env)).toBe(
      path.join(home, '.ai-dev-maintenance', 'monitor', 'codex-sessions-state.v1.json')
    );
    expect(codexSessionMonitorReportPath(env)).toBe(
      path.join(home, '.ai-dev-maintenance', 'monitor', 'codex-sessions-latest.v1.json')
    );
    expect(codexSessionMonitorLaunchAgentPath(env)).toBe(
      path.join(
        home,
        'Library',
        'LaunchAgents',
        'com.niconicotesla369.ai-dev-maintenance.codex-session-monitor.plist'
      )
    );
  });
});
