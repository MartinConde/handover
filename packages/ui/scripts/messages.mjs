import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compilationFingerprint,
  compiledCatalogIsCurrent,
  recordCompilation,
  removeCompilationRecord,
} from './message-cache.mjs';

export function readCatalogs(root, settings, locales) {
  const pattern = settings['plugin.inlang.messageFormat']?.pathPattern;
  // Without it Paraglide compiles successfully with no messages at all.
  if (typeof pattern !== 'string' || !pattern.includes('{locale}')) {
    throw new Error(
      'project.inlang/settings.json needs a plugin.inlang.messageFormat.pathPattern with {locale}',
    );
  }
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      JSON.parse(fs.readFileSync(path.resolve(root, pattern.replace('{locale}', locale)), 'utf8')),
    ]),
  );
}

const messageKeys = (catalog) => Object.keys(catalog).filter((key) => !key.startsWith('$'));
const placeholders = (text) => [...new Set(text.match(/\{[^{}]*\}/g))].sort().join(' ');
const isFallback = (when) => when.split(/,\s*/).every((part) => /=(\*|other)$/.test(part));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isVariant = (message) =>
  Array.isArray(message?.declarations) &&
  Array.isArray(message.selectors) &&
  message.match !== null &&
  typeof message.match === 'object' &&
  Object.values(message.match).every((text) => typeof text === 'string');

// Checks one locale's message against the base locale's; the base is checked against itself.
function messageProblems(key, source, message) {
  if (typeof source === 'string') {
    if (typeof message !== 'string') return [`shape differs: ${key}`];
    if (message.trim() === '') return [`empty text: ${key}`];
    return placeholders(message) === placeholders(source) ? [] : [`placeholders differ: ${key}`];
  }
  if (
    !Array.isArray(message) ||
    message.length !== source.length ||
    !message.every(isVariant) ||
    !source.every(isVariant)
  ) {
    return [`shape differs: ${key}`];
  }
  const problems = [];
  message.forEach(({ declarations, selectors, match }, i) => {
    const base = source[i];
    if (!same([...declarations].sort(), [...base.declarations].sort())) {
      problems.push(`declarations differ: ${key}`);
    }
    if (!same(selectors, base.selectors)) problems.push(`selectors differ: ${key}`);
    if (!Object.keys(match).some(isFallback)) problems.push(`has no * or other fallback: ${key}`);
    const baseFallback = Object.keys(base.match).find(isFallback);
    for (const [when, text] of Object.entries(match)) {
      if (text.trim() === '') problems.push(`empty text: ${key} (${when})`);
      const expected = base.match[when] ?? base.match[baseFallback];
      if (expected !== undefined && placeholders(text) !== placeholders(expected)) {
        problems.push(`placeholders differ: ${key} (${when})`);
      }
    }
  });
  return problems;
}

export function catalogProblems(settings, catalogs, locales, baseLocale) {
  const problems = [];
  if (!same(settings.locales, locales)) {
    problems.push(
      `locales must equal core's UI_LOCALES (${locales.join(', ')}): ${[settings.locales].flat().join(', ')}`,
    );
  }
  if (settings.baseLocale !== baseLocale) {
    problems.push(
      `baseLocale must equal core's DEFAULT_UI_LOCALE (${baseLocale}): ${settings.baseLocale}`,
    );
  }
  const base = catalogs[baseLocale];
  const keys = messageKeys(base);
  for (const locale of locales) {
    const catalog = catalogs[locale];
    const missing = keys.filter((key) => !Object.hasOwn(catalog, key));
    const extra = messageKeys(catalog).filter((key) => !Object.hasOwn(base, key));
    if (missing.length > 0) problems.push(`${locale} missing keys: ${missing.join(', ')}`);
    if (extra.length > 0) problems.push(`${locale} extra keys: ${extra.join(', ')}`);
    for (const key of keys) {
      if (!Object.hasOwn(catalog, key)) continue;
      for (const problem of new Set(messageProblems(key, base[key], catalog[key]))) {
        problems.push(`${locale} ${problem}`);
      }
    }
  }
  return problems;
}

export function uncompiledKeys(outdir, keys) {
  return keys.filter((key) => !fs.existsSync(path.join(outdir, 'messages', `${key}.js`)));
}

const main = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (main) {
  const root = path.resolve(import.meta.dirname, '..');
  const validateOnly = process.argv.includes('--validate-only');
  const force = process.argv.includes('--force');
  try {
    const fingerprint = compilationFingerprint(root);
    if (!validateOnly && !force && compiledCatalogIsCurrent(root, fingerprint)) process.exit(0);

    // Loaded after the cache check, so an unchanged catalog costs no core import.
    const { DEFAULT_UI_LOCALE, UI_LOCALES } = await import('@handover/core');
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, 'project.inlang/settings.json'), 'utf8'),
    );
    const catalogs = readCatalogs(root, settings, UI_LOCALES);
    const problems = catalogProblems(settings, catalogs, UI_LOCALES, DEFAULT_UI_LOCALE);
    if (problems.length > 0) {
      throw new Error(`catalog validation failed:\n- ${problems.join('\n- ')}`);
    }
    if (!validateOnly) {
      removeCompilationRecord(root);
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
      if (compiler.status === 0) {
        const keys = messageKeys(catalogs[DEFAULT_UI_LOCALE]);
        const missing = uncompiledKeys(path.join(root, 'src/paraglide'), keys);
        if (missing.length > 0) {
          throw new Error(
            `paraglide compiled no module for ${missing.length} of ${keys.length} messages (${missing.slice(0, 3).join(', ')}); check project.inlang/settings.json`,
          );
        }
        recordCompilation(root, fingerprint);
      }
      process.exitCode = compiler.status ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
