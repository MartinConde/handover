import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
  stripComments,
} from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type { Env } from './index.js';

const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

export interface I18n {
  locales: string[];
  defaultLocale: string;
  prefixDefaultLocale?: boolean;
  /** Astro's normalized base path; absent when the site is served from root. */
  base?: string;
}

interface WranglerConfig {
  file: string;
  vars?: Record<string, unknown>;
  databases?: Record<string, unknown>[];
  buckets?: Record<string, unknown>[];
}

const ASTRO_CONFIGS = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.mts',
];

/** Blanks strings and comments while preserving offsets, so delimiters in them are harmless. */
function structure(text: string): string {
  const out = text.split('');
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
  for (let i = 0; i < out.length; i += 1) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'line';
        i += 1;
      } else if (char === '/' && next === '*') {
        out[i] = out[i + 1] = ' ';
        state = 'block';
        i += 1;
      } else if (char === "'") {
        out[i] = ' ';
        state = 'single';
      } else if (char === '"') {
        out[i] = ' ';
        state = 'double';
      } else if (char === '`') {
        out[i] = ' ';
        state = 'template';
      }
      continue;
    }
    out[i] = char === '\n' ? '\n' : ' ';
    if (state === 'line' && char === '\n') state = 'code';
    else if (state === 'block' && char === '*' && next === '/') {
      out[i + 1] = ' ';
      state = 'code';
      i += 1;
    } else if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      let escapes = 0;
      for (let at = i - 1; at >= 0 && text[at] === '\\'; at -= 1) escapes += 1;
      if (escapes % 2 === 0) state = 'code';
    }
  }
  return out.join('');
}

/** Reads only a direct property of an object literal. */
function property(text: string, name: string): string | undefined {
  const clean = structure(text);
  if (clean.trimStart()[0] !== '{') return undefined;
  let curly = 0;
  let square = 0;
  let paren = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i] as string;
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (curly === 1 && square === 0 && paren === 0 && /[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(clean.slice(i));
      const key = match?.[0] ?? '';
      let colon = i + key.length;
      while (/\s/.test(clean[colon] ?? '')) colon += 1;
      if (key !== name || clean[colon] !== ':') {
        i += Math.max(0, key.length - 1);
        continue;
      }
      let start = colon + 1;
      while (/\s/.test(text[start] ?? '')) start += 1;
      let nestedCurly = 0;
      let nestedSquare = 0;
      let nestedParen = 0;
      for (let end = start; end < clean.length; end += 1) {
        const valueChar = clean[end] as string;
        if (valueChar === '{') nestedCurly += 1;
        else if (valueChar === '[') nestedSquare += 1;
        else if (valueChar === '(') nestedParen += 1;
        else if (valueChar === '}' && nestedCurly > 0) nestedCurly -= 1;
        else if (valueChar === ']' && nestedSquare > 0) nestedSquare -= 1;
        else if (valueChar === ')' && nestedParen > 0) nestedParen -= 1;
        else if (
          (valueChar === ',' || valueChar === '}') &&
          nestedCurly === 0 &&
          nestedSquare === 0 &&
          nestedParen === 0
        )
          return text.slice(start, end).trim();
      }
    }
  }
  return undefined;
}

function items(text: string): string[] | undefined {
  const clean = structure(text);
  if (!/^\s*\[/.test(clean) || !/]\s*$/.test(clean)) return undefined;
  const start = clean.indexOf('[') + 1;
  const end = clean.lastIndexOf(']');
  const parts: string[] = [];
  let curly = 0;
  let square = 0;
  let paren = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const char = clean[i] as string;
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === ',' && curly === 0 && square === 0 && paren === 0) {
      if (text.slice(from, i).trim()) parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (text.slice(from, end).trim()) parts.push(text.slice(from, end).trim());
  return parts;
}

const literal = (text: string): string | undefined => {
  const match = /^(['"])([A-Za-z0-9/_-]+)\1$/.exec(text.trim());
  return match?.[2];
};

function configObject(text: string, file: string): string {
  const clean = structure(text);
  const call = /\bdefineConfig\s*\(/.exec(clean);
  const after = call ? (call.index ?? 0) + call[0].length : -1;
  let start = after;
  while (start >= 0 && /\s/.test(clean[start] ?? '')) start += 1;
  if (start < 0 || clean[start] !== '{')
    throw new Error(
      `${file}: Handover can only scaffold from a literal defineConfig({ ... }). Create cms.config.ts and the page routes by hand, then rerun init.`,
    );
  let depth = 0;
  for (let end = start; end < clean.length; end += 1) {
    if (clean[end] === '{') depth += 1;
    else if (clean[end] === '}' && --depth === 0) return text.slice(start, end + 1);
  }
  throw new Error(`${file}: the defineConfig object is not complete.`);
}

function unsupported(file: string, setting: string, example: string): never {
  throw new Error(
    `${file}: i18n.${setting} is computed or uses an unsupported form. Write it as ${example}, then rerun init; or create cms.config.ts and the page routes by hand.`,
  );
}

/** Read from astro.config rather than guessed: a wrong route model fails the build just written. */
export function i18nOf(cwd: string): I18n {
  const path = ASTRO_CONFIGS.map((f) => join(cwd, f)).find((f) => existsSync(f));
  if (!path) return { locales: ['en'], defaultLocale: 'en', prefixDefaultLocale: false };
  const file = path.split('/').at(-1) as string;
  const root = configObject(readFileSync(path, 'utf8'), file);
  const i18n = property(root, 'i18n');
  if (!i18n?.trim().startsWith('{'))
    unsupported(
      file,
      'locales',
      "a literal i18n block such as { locales: ['en'], defaultLocale: 'en' }",
    );
  const listed = property(i18n, 'locales');
  const localeItems = listed ? items(listed) : undefined;
  if (!localeItems?.length)
    unsupported(file, 'locales', "a non-empty literal array such as ['en', 'de']");
  const locales = localeItems.map((item) => {
    const plain = literal(item);
    if (plain) return plain;
    if (!item.trim().startsWith('{'))
      unsupported(file, 'locales', "strings or { path: 'name', codes: ['code'] } objects");
    const pathValue = property(item, 'path');
    const codes = property(item, 'codes');
    const codeItems = codes ? items(codes) : undefined;
    if (!pathValue || !codeItems?.length || !codeItems.every((code) => literal(code)))
      unsupported(file, 'locales', "strings or { path: 'name', codes: ['code'] } objects");
    return (
      literal(pathValue) ??
      unsupported(
        file,
        'locales',
        "objects with a literal path, such as { path: 'de', codes: ['de'] }",
      )
    );
  });
  const statedRaw = property(i18n, 'defaultLocale');
  const stated = statedRaw ? literal(statedRaw) : undefined;
  if (!stated) unsupported(file, 'defaultLocale', "a literal locale path such as 'en'");
  if (!locales.includes(stated))
    throw new Error(
      `${file}: i18n.defaultLocale '${stated}' is not one of the locale paths ${JSON.stringify(locales)}. Fix astro.config and rerun init.`,
    );
  const routing = property(i18n, 'routing');
  let prefixDefaultLocale = false;
  if (routing !== undefined) {
    if (!routing.trim().startsWith('{'))
      unsupported(file, 'routing', '{ prefixDefaultLocale: true } or omit it');
    const prefix = property(routing, 'prefixDefaultLocale');
    if (prefix !== undefined) {
      if (prefix !== 'true' && prefix !== 'false')
        unsupported(file, 'routing.prefixDefaultLocale', 'the literal true or false');
      prefixDefaultLocale = prefix === 'true';
    }
  }
  const baseRaw = property(root, 'base');
  const statedBase = baseRaw === undefined ? undefined : literal(baseRaw);
  if (baseRaw !== undefined && statedBase === undefined)
    unsupported(file, 'base', "a literal path such as '/site'");
  if (statedBase !== undefined && statedBase !== '/' && !statedBase.startsWith('/'))
    unsupported(file, 'base', "a root-relative literal path such as '/site'");
  const normalizedBase = statedBase?.replace(/\/+$/, '') || undefined;
  return {
    locales,
    defaultLocale: stated,
    prefixDefaultLocale,
    ...(normalizedBase ? { base: normalizedBase } : {}),
  };
}

/** An inline `z.object` has no name to import, so it is reported for its owner to move. */
export function collectionsOf(text: string): { name: string; schema?: string }[] {
  const decl = /(['"]?)([A-Za-z][\w-]*)\1\s*:\s*defineCollection\(/g;
  const starts = [...text.matchAll(decl)];
  return starts
    .map((match, i) => {
      const body = text.slice(match.index, starts[i + 1]?.index ?? text.length);
      // `withReserved(listing)` and bare `listing` both name it; an inline `z.object` does not.
      const schema = /schema:\s*(?:\w+\()?\s*([A-Za-z_$][\w$]*)\s*[,)\n]/.exec(body)?.[1];
      return { name: match[2] as string, schema };
    })
    .filter((c) => c.name !== 'globals');
}

export function wranglerConfig(env: Env): WranglerConfig | undefined {
  const files = CONFIGS.filter((file) => existsSync(join(env.cwd, file)));
  if (files.length > 1)
    throw new Error(
      `More than one Wrangler config exists (${files.join(', ')}); keep one before init.`,
    );
  const file = files[0];
  if (!file) return undefined;
  const text = readFileSync(join(env.cwd, file), 'utf8');
  let parsed: Record<string, unknown>;
  try {
    if (file.endsWith('.toml')) {
      parsed = parseToml(text) as Record<string, unknown>;
    } else {
      const errors: ParseError[] = [];
      parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
      const [error] = errors;
      if (error) throw new Error(printParseErrorCode(error.error));
    }
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${file}: expected a configuration object`);
  const { vars, d1_databases: databases, r2_buckets: buckets } = parsed;
  if (vars !== undefined && (!vars || typeof vars !== 'object' || Array.isArray(vars)))
    throw new Error(`${file}: vars must be an object/table`);
  if (databases !== undefined && !Array.isArray(databases))
    throw new Error(`${file}: d1_databases must be an array of bindings`);
  if (buckets !== undefined && !Array.isArray(buckets))
    throw new Error(`${file}: r2_buckets must be an array of bindings`);
  return {
    file,
    vars: vars as Record<string, unknown> | undefined,
    databases: databases as Record<string, unknown>[] | undefined,
    buckets: buckets as Record<string, unknown>[] | undefined,
  };
}

export function validateWranglerConfig(
  config: WranglerConfig,
  name: string,
  bucket: string,
  account?: string,
  databaseId?: string,
): string[] {
  const uploads = (config.buckets ?? []).filter((item) => item.binding === 'MEDIA_UPLOADS');
  if (uploads.length > 1)
    throw new Error(`${config.file}: more than one R2 binding is named MEDIA_UPLOADS`);
  if (uploads[0]?.bucket_name !== undefined && uploads[0].bucket_name !== `${name}-uploads`)
    throw new Error(
      `${config.file}: MEDIA_UPLOADS must point to ${name}-uploads. Nothing changed.`,
    );
  const expected = { R2_ACCOUNT_ID: account, R2_BUCKET: bucket };
  for (const [key, value] of Object.entries(expected)) {
    const found = config.vars?.[key];
    if (found !== undefined && value !== undefined && found !== value)
      throw new Error(`${config.file}: ${key} is ${String(found)}, not ${value}. Nothing changed.`);
  }
  const configured = configuredDatabases(config);
  if (configured.length > 1)
    throw new Error(`${config.file}: more than one D1 binding is named DB`);
  const database = configured[0];
  if (database?.database_id !== undefined && typeof database.database_id !== 'string')
    throw new Error(`${config.file}: DB database_id must be a string`);
  if (database?.database_name !== undefined && database.database_name !== name)
    throw new Error(
      `${config.file}: DB points to ${String(database.database_name)}, not ${name}. Nothing changed.`,
    );
  if (database?.database_id !== undefined && databaseId && database.database_id !== databaseId)
    throw new Error(
      `${config.file}: DB uses database id ${String(database.database_id)}, not ${databaseId}. Nothing changed.`,
    );
  if (!account || !databaseId) return [];
  return [
    ...(config.vars?.R2_ACCOUNT_ID === account ? [] : ['R2_ACCOUNT_ID']),
    ...(config.vars?.R2_BUCKET === bucket ? [] : ['R2_BUCKET']),
    ...(uploads[0]?.bucket_name === `${name}-uploads` ? [] : ['MEDIA_UPLOADS']),
    ...(database?.database_name === name && database.database_id === databaseId ? [] : ['DB']),
  ];
}

function configuredDatabases(config: WranglerConfig): Record<string, unknown>[] {
  return (config.databases ?? []).filter((database) => database.binding === 'DB');
}

export function configuredDatabaseId(config: WranglerConfig): string | undefined {
  const id = configuredDatabases(config)[0]?.database_id;
  return typeof id === 'string' ? id : undefined;
}

export function validateDrizzleConfig(env: Env): void {
  const path = join(env.cwd, 'drizzle.config.ts');
  if (!existsSync(path)) return;
  const text = stripComments(readFileSync(path, 'utf8'));
  const literal = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"])(.*?)\\1`).exec(text)?.[2];
  const expected = {
    dialect: 'sqlite',
    schema: './node_modules/astro-handover/dist/schema.js',
    out: './migrations',
  };
  for (const [key, value] of Object.entries(expected))
    if (literal(key) !== value)
      throw new Error(`drizzle.config.ts: ${key} must be ${JSON.stringify(value)} before init.`);
}
