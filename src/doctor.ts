import { codexProvider, checkOpenHandles, knownCodexProcessExists } from './providers/codex.js';

export { checkOpenHandles, knownCodexProcessExists };

export async function runDoctor(options: {
  json?: boolean;
  showPaths?: boolean;
  persistReport?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}) {
  return await codexProvider.runDoctor({
    ...options,
    generatedAt: new Date().toISOString()
  });
}
