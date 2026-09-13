import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDirectory } from '@inlang/sdk';

const messageFormatModule = '@inlang/plugin-message-format/dist/index.js';

function readSettings(projectPath) {
  const settingsPath = path.join(projectPath, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid Inlang settings: ${error.message}`);
  }

  if (
    !settings ||
    typeof settings !== 'object' ||
    typeof settings.baseLocale !== 'string' ||
    !Array.isArray(settings.locales) ||
    !settings.locales.every((locale) => typeof locale === 'string')
  ) {
    throw new Error('invalid Inlang settings: baseLocale and locales are required');
  }
  if (
    !Array.isArray(settings.modules) ||
    !settings.modules.some(
      (module) => typeof module === 'string' && module.endsWith(messageFormatModule),
    )
  ) {
    throw new Error('invalid Inlang settings: the local message-format plugin is required');
  }
  if (
    typeof settings['plugin.inlang.messageFormat']?.pathPattern !== 'string' ||
    !settings['plugin.inlang.messageFormat'].pathPattern.includes('{locale}')
  ) {
    throw new Error('invalid Inlang settings: message-format pathPattern must include {locale}');
  }
  return settings;
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function patternContract(pattern) {
  const placeholders = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'variable-reference') placeholders.add(`variable:${value.name}`);
    if (value.type?.startsWith('markup-')) placeholders.add(`markup:${value.name}`);
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === 'object') visit(nested);
    }
  }

  pattern.forEach(visit);
  return [...placeholders].sort().join(',');
}

function hasContent(pattern) {
  return pattern.some(
    (element) =>
      element.type === 'expression' ||
      element.type === 'markup-standalone' ||
      (element.type === 'text' && element.value.trim() !== ''),
  );
}

function matchSignature(matches) {
  return matches
    .map((match) =>
      match.type === 'catchall-match' ? `${match.key}=*` : `${match.key}=${match.value}`,
    )
    .sort()
    .join(',');
}

function fallbackSignatures(message, declarations) {
  const declarationsByName = new Map(
    declarations.map((declaration) => [declaration.name, declaration]),
  );
  let signatures = [[]];
  for (const { name } of message.selectors) {
    const declaration = declarationsByName.get(name);
    const values =
      declaration?.type === 'local-variable' && declaration.value.annotation?.name === 'plural'
        ? [`${name}=other`, `${name}=*`]
        : [`${name}=*`];
    signatures = signatures.flatMap((signature) => values.map((value) => [...signature, value]));
  }
  return signatures.map((signature) => signature.sort().join(','));
}

function formatErrors(errors) {
  return errors.map((error) => error?.message ?? String(error)).join('; ');
}

export async function validateCatalogs({
  projectPath,
  expectedLocales,
  expectedBaseLocale = expectedLocales[0],
}) {
  const settings = readSettings(projectPath);
  const problems = [];

  if (!sameList(settings.locales, expectedLocales)) {
    problems.push(
      `configured locales must exactly match the core UI locale allowlist (${expectedLocales.join(', ')})`,
    );
  }
  if (settings.baseLocale !== expectedBaseLocale) {
    problems.push(
      `configured base locale must match the core UI default (${expectedBaseLocale}): ${settings.baseLocale}`,
    );
  }

  let project;
  try {
    project = await loadProjectFromDirectory({ path: projectPath, fs });
    const projectErrors = await project.errors.get();
    if (projectErrors.length > 0) {
      throw new Error(`Inlang project could not be loaded: ${formatErrors(projectErrors)}`);
    }

    const [bundles, messages, variants] = await Promise.all([
      project.db.selectFrom('bundle').selectAll().execute(),
      project.db.selectFrom('message').selectAll().execute(),
      project.db.selectFrom('variant').selectAll().execute(),
    ]);
    if (bundles.length === 0 || messages.length === 0) {
      throw new Error('Inlang project loaded no catalog messages');
    }

    const bundlesById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
    const variantsByMessage = new Map();
    for (const variant of variants) {
      const list = variantsByMessage.get(variant.messageId) ?? [];
      list.push(variant);
      variantsByMessage.set(variant.messageId, list);
    }
    const messagesByLocale = new Map(
      expectedLocales.map((locale) => [
        locale,
        new Map(
          messages
            .filter((message) => message.locale === locale)
            .map((message) => [message.bundleId, message]),
        ),
      ]),
    );
    const baseMessages = messagesByLocale.get(settings.baseLocale) ?? new Map();
    const baseKeys = new Set(baseMessages.keys());

    for (const locale of expectedLocales) {
      const localeMessages = messagesByLocale.get(locale) ?? new Map();
      const missing = [...baseKeys].filter((key) => !localeMessages.has(key));
      const extra = [...localeMessages.keys()].filter((key) => !baseKeys.has(key));
      if (missing.length > 0) problems.push(`${locale} missing keys: ${missing.sort().join(', ')}`);
      if (extra.length > 0) problems.push(`${locale} extra keys: ${extra.sort().join(', ')}`);

      for (const [key, message] of localeMessages) {
        if (!baseKeys.has(key)) continue;
        const bundle = bundlesById.get(key);
        const messageVariants = variantsByMessage.get(message.id) ?? [];
        if (
          messageVariants.length === 0 ||
          messageVariants.some(({ pattern }) => !hasContent(pattern))
        ) {
          problems.push(`${locale} empty translation: ${key}`);
          continue;
        }

        const baseMessage = baseMessages.get(key);
        const baseVariants = variantsByMessage.get(baseMessage.id) ?? [];
        if (
          !sameList(
            message.selectors.map(({ name }) => name),
            baseMessage.selectors.map(({ name }) => name),
          )
        ) {
          problems.push(`${locale} selector contract differs: ${key}`);
          continue;
        }

        const baseContracts = new Map(
          baseVariants.map((variant) => [
            matchSignature(variant.matches),
            patternContract(variant.pattern),
          ]),
        );
        const fallbacks = fallbackSignatures(message, bundle.declarations);
        const sourceFallbackContract = fallbacks
          .map((signature) => baseContracts.get(signature))
          .find((contract) => contract !== undefined);
        const localeContracts = new Map(
          messageVariants.map((variant) => [
            matchSignature(variant.matches),
            patternContract(variant.pattern),
          ]),
        );
        const localeFallbackContract = fallbacks
          .map((signature) => localeContracts.get(signature))
          .find((contract) => contract !== undefined);
        if (message.selectors.length > 0 && localeFallbackContract === undefined) {
          problems.push(`${locale} required fallback is missing: ${key}`);
        }
        for (const [signature, contract] of localeContracts) {
          const expected = baseContracts.get(signature) ?? sourceFallbackContract;
          if (expected !== undefined && contract !== expected) {
            problems.push(
              `${locale} placeholder contract differs: ${key} (${signature || 'default'})`,
            );
          }
        }
        for (const [signature, contract] of baseContracts) {
          const actual = localeContracts.get(signature) ?? localeFallbackContract;
          if (actual !== undefined && actual !== contract) {
            problems.push(
              `${locale} placeholder contract differs: ${key} (${signature || 'default'})`,
            );
          }
        }
      }
    }
  } finally {
    await project?.close();
  }

  if (problems.length > 0) {
    throw new Error(`catalog validation failed:\n- ${[...new Set(problems)].join('\n- ')}`);
  }
}
