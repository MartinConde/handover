import path from 'node:path';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@handover/core';
import { validateCatalogs } from './catalog-validator.mjs';

try {
  await validateCatalogs({
    projectPath: path.resolve(import.meta.dirname, '../project.inlang'),
    expectedLocales: UI_LOCALES,
    expectedBaseLocale: DEFAULT_UI_LOCALE,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
