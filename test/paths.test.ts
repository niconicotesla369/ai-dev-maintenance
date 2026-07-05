import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { appDataHome, defaultCodexHome, resolveHome } from '../src/paths.js';

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
});
