import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stampName = '.handover-compile-inputs';
const requiredOutputs = [
  'messages.d.ts',
  'messages.js',
  'registry.d.ts',
  'registry.js',
  'runtime.d.ts',
  'runtime.js',
  'server.d.ts',
  'server.js',
];

const inputFiles = (root) => [
  '../../pnpm-lock.yaml',
  'package.json',
  '../core/src/content/ui-locale.ts',
  'project.inlang/settings.json',
  'scripts/message-cache.mjs',
  'scripts/messages.mjs',
  ...fs
    .readdirSync(path.join(root, 'messages'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => `messages/${file}`),
];

const stampPath = (root) => path.join(root, 'src/paraglide', stampName);

export function compilationFingerprint(root) {
  const hash = createHash('sha256');
  for (const relative of inputFiles(root)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.resolve(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function compiledCatalogIsCurrent(root, fingerprint) {
  try {
    if (fs.readFileSync(stampPath(root), 'utf8').trim() !== fingerprint) return false;
    return requiredOutputs.every((file) => fs.existsSync(path.join(root, 'src/paraglide', file)));
  } catch {
    return false;
  }
}

export function removeCompilationRecord(root) {
  fs.rmSync(stampPath(root), { force: true });
}

export function recordCompilation(root, fingerprint) {
  fs.writeFileSync(stampPath(root), `${fingerprint}\n`);
}
