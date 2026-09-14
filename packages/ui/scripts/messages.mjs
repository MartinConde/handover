import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  compilationFingerprint,
  compiledCatalogIsCurrent,
  recordCompilation,
  removeCompilationRecord,
} from './message-cache.mjs';

const root = path.resolve(import.meta.dirname, '..');
const validateOnly = process.argv.includes('--validate-only');
const force = process.argv.includes('--force');

try {
  const fingerprint = compilationFingerprint(root);
  if (!validateOnly && !force && compiledCatalogIsCurrent(root, fingerprint)) process.exit(0);

  const validator = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, 'validate-catalogs.mjs')],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (validator.error) throw validator.error;
  if (validator.status !== 0) {
    process.exitCode = validator.status ?? 1;
  } else if (!validateOnly) {
    removeCompilationRecord(root);
    // Keep validation and compilation in separate processes. Both load the Inlang SDK,
    // whose heaps otherwise overlap and materially raise the build's peak memory.
    const compiler = spawnSync(
      'paraglide-js',
      [
        'compile',
        '--project',
        './project.inlang',
        '--outdir',
        './src/paraglide',
        '--strategy',
        'globalVariable',
        'baseLocale',
        '--emit-ts-declarations',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (compiler.error) throw compiler.error;
    if (compiler.status === 0) recordCompilation(root, fingerprint);
    process.exitCode = compiler.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
