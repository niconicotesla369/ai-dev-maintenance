import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const publicBlocked = [
  ['alice', 'private'].join('-'),
  ['private-handle', 'example'].join('.'),
  ['workspace', 'example'].join('-')
];

const publicBlockedPatterns = [
  {
    term: 'x-social-url',
    pattern: new RegExp(['https?:\\/\\/(?:www\\.)?', 'x', '\\.', 'com\\/'].join(''), 'i')
  },
  {
    term: 'legacy-social-name',
    pattern: new RegExp(['\\b', 'Twit', 'ter', '\\b'].join(''), 'i')
  },
  {
    term: 'messaging-platform-name',
    pattern: new RegExp(['\\b', 'LI', 'NE', '\\b'].join(''))
  },
  {
    term: 'social-handle',
    pattern: /(^|[\s("'`])@(?!__)[A-Za-z0-9_-]{3,30}\b(?=$|[\s)"'`.,:])/
  },
  {
    term: 'mac-home-path',
    pattern: new RegExp(['(^|[\\s"\'`])', '\\/', 'Users', '\\/', '[^\\s"\'`]+'].join(''))
  },
  {
    term: 'external-volume-path',
    pattern: new RegExp(['(^|[\\s"\'`])', '\\/', 'Volumes', '\\/', '[^\\s"\'`]+'].join(''))
  }
];

const ignoredSourceDirs = new Set(['node_modules', 'dist', '.git', 'coverage']);
const ignoredPackageDirs = new Set(['node_modules', '.git', 'coverage']);

export function scanPublicText(text, file, extraBlocked = []) {
  const literalFindings = [...publicBlocked, ...extraBlocked]
    .filter((term) => text.includes(term))
    .map((term) => ({ file, term }));
  const patternFindings = publicBlockedPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ term }) => ({ file, term }));
  return [...literalFindings, ...patternFindings];
}

export async function readPrivateDenylist(
  file = process.env.AI_DEV_MAINTENANCE_PRIVATE_DENYLIST,
  options = {}
) {
  if (!file) {
    if (options.required) throw new Error('AI_DEV_MAINTENANCE_PRIVATE_DENYLIST is required for release hygiene');
    return [];
  }
  const content = await readFile(file, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function isProbablyText(buffer) {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 4096);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

async function listFiles(root, options = {}, prefix = '') {
  const ignoredDirs = options.includePackageFiles ? ignoredPackageDirs : ignoredSourceDirs;
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...(await listFiles(root, options, rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

async function listPackageFiles(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  const files = new Set(['package.json']);
  for (const entry of entries) {
    const full = path.join(root, entry);
    try {
      const stat = await import('node:fs/promises').then((fs) => fs.lstat(full));
      if (stat.isDirectory()) {
        for (const file of await listFiles(root, { includePackageFiles: true }, entry)) files.add(file);
      } else {
        files.add(entry);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...files].sort();
}

export async function scanPackageText(filesByPath, extraBlocked = []) {
  const findings = [];
  for (const [file, text] of Object.entries(filesByPath)) {
    findings.push(...scanPublicText(String(text), file, extraBlocked));
  }
  return findings;
}

async function main() {
  const root = process.cwd();
  const packageMode = process.argv.includes('--package');
  const requirePrivateDenylist = process.argv.includes('--require-private-denylist');
  const files = packageMode ? await listPackageFiles(root) : await listFiles(root);
  const privateBlocked = await readPrivateDenylist(undefined, { required: requirePrivateDenylist });
  const findings = [];
  for (const file of files) {
    const buffer = await readFile(path.join(root, file));
    if (!isProbablyText(buffer)) continue;
    findings.push(...scanPublicText(buffer.toString('utf8'), file, privateBlocked));
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: blocked public term detected`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(redactErrorMessage(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}

function redactErrorMessage(message) {
  return message
    .replace(new RegExp(['\\/', 'Users', '\\/', '[^"\']+'].join(''), 'g'), '<home>')
    .replace(new RegExp(['\\/', '(?:private|Volumes|tmp|var)', '\\/', '[^"\']+'].join(''), 'g'), '<absolute-path>');
}
