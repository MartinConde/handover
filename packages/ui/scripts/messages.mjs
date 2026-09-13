import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@handover/core';
import { validateCatalogs } from './catalog-validator.mjs';

const projectPath = path.resolve(import.meta.dirname, '../project.inlang');

try {
  await validateCatalogs({
    projectPath,
    expectedLocales: UI_LOCALES,
    expectedBaseLocale: DEFAULT_UI_LOCALE,
  });

  if (!process.argv.includes('--validate-only')) {
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
      { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit' },
    );
    if (compiler.error) throw compiler.error;
    process.exitCode = compiler.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
