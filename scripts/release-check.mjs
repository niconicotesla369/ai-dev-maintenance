import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const allowMissingMetadata = args.has('--allow-missing-metadata');
const failures = [];
const packCommandDescription = 'npm pack --json';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));

assertReleaseMetadata(pkg);
assertNoInstallLifecycleScripts(pkg);
assertPackageInvariants(pkg);
await assertVersionSync(pkg);
await assertDistSafetyMarkers();
await assertNoRuntimeNetworkImports();
await assertPackedArtifact();

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}

async function assertDistSafetyMarkers() {
  const dist = await readFile('dist/cli.js', 'utf8').catch(() => '');
  for (const marker of [
    'backupCreated',
    'checkpointAttempted',
    'allowMainSizeMtimeChange',
    'private backup created + checkpoint attempted; review report'
  ]) {
    if (!dist.includes(marker)) failures.push(`dist/cli.js is missing safety marker: ${marker}`);
  }
}

async function assertVersionSync(packageJson) {
  const versionSource = await readFile('src/version.ts', 'utf8');
  const sample = JSON.parse(await readFile('examples/sample-report.json', 'utf8'));
  const readme = await readFile('README.md', 'utf8');
  if (!versionSource.includes(`TOOL_VERSION = '${packageJson.version}'`)) {
    failures.push('src/version.ts TOOL_VERSION must match package.json version');
  }
  if (sample.toolVersion !== packageJson.version) {
    failures.push('sample report toolVersion must match package.json version');
  }
  if (sample.schemaVersion !== 2 || !Array.isArray(sample.providers) || !sample.totals) {
    failures.push('sample report must use schema v2 aggregate provider shape');
  }
  if (!readme.includes(`ai-dev-maintenance@${packageJson.version}`)) {
    failures.push('README command pin must match package.json version');
  }
}

function assertReleaseMetadata(packageJson) {
  const missing = [];
  if (!packageJson.repository?.url) missing.push('repository.url');
  if (!packageJson.bugs?.url) missing.push('bugs.url');
  if (!packageJson.homepage) missing.push('homepage');
  if (missing.length === 0) return;
  const message = `Release metadata is incomplete: ${missing.join(', ')}`;
  if (allowMissingMetadata) {
    console.error(`${message} (allowed before public repository URL exists)`);
  } else {
    failures.push(message);
  }
}

export function assertNoInstallLifecycleScripts(packageJson) {
  const scripts = packageJson.scripts ?? {};
  const blocked = [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'prepare'
  ].filter((name) => Object.prototype.hasOwnProperty.call(scripts, name));
  if (blocked.length > 0) {
    failures.push(`Install-time lifecycle scripts are not allowed: ${blocked.join(', ')}`);
  }
}

function assertPackageInvariants(packageJson) {
  if (packageJson.name !== 'ai-dev-maintenance') failures.push('package name must be ai-dev-maintenance');
  if (packageJson.bin?.['ai-dev-maintenance'] !== 'dist/cli.js') {
    failures.push('bin.ai-dev-maintenance must point to dist/cli.js');
  }
  if (packageJson.bin?.aidm !== 'dist/cli.js') {
    failures.push('bin.aidm must point to dist/cli.js');
  }
  if (Object.keys(packageJson.dependencies ?? {}).length > 0) {
    failures.push('runtime dependencies are not allowed in v1');
  }
  for (const required of ['dist', 'README.md', 'README.ja.md', 'SECURITY.md', 'LICENSE', 'examples']) {
    if (!packageJson.files?.includes(required)) failures.push(`package files must include ${required}`);
  }
}

async function assertNoRuntimeNetworkImports() {
  const files = await listSourceFiles('src');
  const blocked = /\b(?:fetch\s*\(|node:https|node:http|node:net|node:dns|node:tls|https:\/\/|http:\/\/)/;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (blocked.test(source)) failures.push(`runtime network primitive detected in ${file}`);
  }
}

async function listSourceFiles(root, prefix = '') {
  const dir = path.join(root, prefix);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(root, rel)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.join(root, rel));
    }
  }
  return files.sort();
}

async function assertPackedArtifact() {
  let filename;
  try {
    const { stdout } = await execFileAsync('npm', ['pack', '--json', '--ignore-scripts'], {
      timeout: 60_000,
      maxBuffer: 2_000_000
    });
    const parsed = JSON.parse(stdout);
    filename = parsed?.[0]?.filename;
    const files = new Set((parsed?.[0]?.files ?? []).map((file) => file.path));
    for (const required of ['dist/cli.js', 'dist/cli.d.ts', 'README.md', 'SECURITY.md', 'LICENSE']) {
      if (!files.has(required)) failures.push(`packed artifact is missing ${required}`);
    }
    for (const file of files) {
      if (file.endsWith('.map')) failures.push(`sourcemap should not be published: ${file}`);
    }
  } catch (error) {
    failures.push(`${packCommandDescription} failed`);
  } finally {
    if (filename) await rm(filename, { force: true });
  }
}
