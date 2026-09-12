import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { SCHEMA_VERSION, schemaVersionError } from '@handover/core';
import type { Env } from './index.js';
import { writeMigrationMarker } from './migrate.js';
import { CHECKLIST, cmsConfig, collectionsOf, i18nOf, starter } from './scaffold.js';

/** The bindings the site needs; also what init prints when the config file is not its own. */
const bindings = (
  name: string,
  account: string,
  database: string,
) => `  // Not secrets: an account id and a bucket name. The keys that sign an upload are.
  "vars": { "R2_ACCOUNT_ID": "${account}", "R2_BUCKET": "${name}-media" },
  "d1_databases": [
    { "binding": "DB", "database_name": "${name}", "database_id": "${database}" }
  ]`;

const bindingSnippet = (file: string, name: string, account: string, database: string) =>
  file.endsWith('.toml')
    ? `[vars]
R2_ACCOUNT_ID = "${account}"
R2_BUCKET = "${name}-media"

[[d1_databases]]
binding = "DB"
database_name = "${name}"
database_id = "${database}"`
    : bindings(name, account, database);

const wranglerJsonc = (name: string, account: string, database: string) => `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "main": "./src/worker.ts",
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "binding": "ASSETS", "directory": "./dist" },
${bindings(name, account, database)}
}
`;

// The site's own Worker rather than the adapter's, because Handover has jobs as well as routes.
const WORKER = `import handler from '@astrojs/cloudflare/entrypoints/server';
import { scheduled } from 'astro-handover/cron';

export default { ...handler, scheduled };
`;

const DRIZZLE = `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './node_modules/astro-handover/dist/schema.js',
  out: './migrations',
});
`;

const CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const INIT_STATE = '.handover-init.json';
const INIT_DRIZZLE = '.handover-drizzle.config.ts';
const INIT_MIGRATIONS = '.handover-migrations';

interface InitRecord {
  version: 1;
  siteName: string;
  accountId: string;
  databaseId?: string;
  bucketName: string;
  bucketReady: boolean;
  ownerEmail: string;
  ownerId: string;
}

interface WranglerConfig {
  file: string;
  vars?: Record<string, unknown>;
  databases?: Record<string, unknown>[];
}

export function init(env: Env, email: string): number {
  if (!/^[^\s'"@]+@[^\s'"@]+\.[^\s'"@]+$/.test(email))
    throw new Error(`${email} is not an email address`);
  const name = siteName(env.cwd);
  const saved = initRecord(env);
  validateInitRecord(saved, name, email);
  if (!saved && [INIT_DRIZZLE, INIT_MIGRATIONS].some((path) => existsSync(join(env.cwd, path))))
    throw new Error(
      `${INIT_DRIZZLE} or ${INIT_MIGRATIONS}/ already exists without an initialization record. Nothing changed.`,
    );
  if (existsSync(join(env.cwd, 'migrations')) && !saved)
    throw new Error(
      'migrations/ is already here without a Handover initialization record. Nothing changed; keep it and follow docs/deploy.md by hand.',
    );

  try {
    // Validate local prerequisites and user-owned config before remote resources can be created.
    env.capture(['drizzle-kit', '--version']);
    env.capture(['wrangler', '--version']);
    const config = wranglerConfig(env);
    validateDrizzleConfig(env);
    const expectedBucket = `${name}-media`;
    if (config) validateWranglerConfig(config, name, expectedBucket);

    // Every local file comes before provisioning. Existing files are verified or left alone.
    scaffold(env);
    put(env, 'src/worker.ts', WORKER);
    put(env, 'drizzle.config.ts', DRIZZLE);
    validateDrizzleConfig(env);

    const account = accountId(env);
    if (saved && saved.accountId !== account)
      throw new Error(
        `Initialization belongs to Cloudflare account ${saved.accountId}, not ${account}. Restore that CLOUDFLARE_ACCOUNT_ID; no resources were changed.`,
      );
    if (config) validateWranglerConfig(config, name, expectedBucket, account);
    const record: InitRecord = saved ?? {
      version: 1,
      siteName: name,
      accountId: account,
      bucketName: expectedBucket,
      bucketReady: false,
      ownerEmail: email,
      ownerId: randomUUID(),
    };
    saveInitRecord(env, record);

    record.databaseId = provisionDatabase(
      env,
      record,
      config ? configuredDatabaseId(config) : undefined,
    );
    saveInitRecord(env, record);
    provisionBucket(env, record);
    saveInitRecord(env, record);

    const configFile = config?.file;
    if (!configFile) put(env, 'wrangler.jsonc', wranglerJsonc(name, account, record.databaseId));
    const ready = wranglerConfig(env);
    if (!ready) throw new Error('wrangler.jsonc was not written');
    const missing = validateWranglerConfig(ready, name, expectedBucket, account, record.databaseId);
    if (missing.length) {
      throw new Error(
        `${ready.file} is yours; add or merge these values before migrations can run:\n${bindingSnippet(ready.file, name, account, record.databaseId)}\nThen continue with:\n  npx handover init ${email}`,
      );
    }

    const marker = migrationMarker(env);
    const error =
      marker?.schemaVersion === undefined ? undefined : schemaVersionError(JSON.stringify(marker));
    if (error) throw new Error(error);
    if (marker?.schemaVersion !== SCHEMA_VERSION) generateInitialMigrations(env);
    cleanupInitialGeneration(env);

    for (const where of ['--local', '--remote'])
      env.run(['wrangler', 'd1', 'migrations', 'apply', name, where]);

    // Re-running this promotes the same row and cannot create a duplicate owner.
    const seed = `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('${record.ownerId}', '${email.split('@')[0]}', '${email}', 1, 'owner', 0, 0) ON CONFLICT(email) DO UPDATE SET role = 'owner'`;
    for (const where of ['--local', '--remote'])
      env.run(['wrangler', 'd1', 'execute', name, where, '--command', seed]);
    if (existsSync(join(env.cwd, INIT_STATE))) unlinkSync(join(env.cwd, INIT_STATE));

    env.log(
      `${email} is an owner. They sign in with an emailed link and set a password on their account page, which needs a mailer and HANDOVER_BASE_URL; a site with neither gives them a password by hand instead (docs/auth.md).`,
    );
    env.log(`\n${CHECKLIST}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`npx handover init ${email}`)) throw error;
    throw new Error(
      `${message}\nAfter correcting the problem, continue safely with:\n  npx handover init ${email}`,
    );
  }
}

function initRecord(env: Env): InitRecord | undefined {
  return readJson(join(env.cwd, INIT_STATE)) as InitRecord | undefined;
}

function validateInitRecord(record: InitRecord | undefined, name: string, email: string): void {
  if (!record) return;
  if (
    record.version !== 1 ||
    record.siteName !== name ||
    record.bucketName !== `${name}-media` ||
    record.ownerEmail !== email ||
    typeof record.accountId !== 'string' ||
    (record.databaseId !== undefined && typeof record.databaseId !== 'string') ||
    typeof record.bucketReady !== 'boolean' ||
    typeof record.ownerId !== 'string' ||
    !record.ownerId
  )
    throw new Error(
      `The interrupted initialization belongs to ${record.siteName}/${record.ownerEmail}, not ${name}/${email}. Nothing changed.`,
    );
}

function saveInitRecord(env: Env, record: InitRecord): void {
  const path = join(env.cwd, INIT_STATE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function migrationMarker(env: Env): Record<string, unknown> | undefined {
  return readJson(join(env.cwd, 'migrations/handover.json'));
}

function generateInitialMigrations(env: Env): void {
  const migrations = join(env.cwd, 'migrations');
  if (existsSync(migrations)) {
    validateMigrationSet(migrations);
  } else {
    const staging = join(env.cwd, INIT_MIGRATIONS);
    const config = join(env.cwd, INIT_DRIZZLE);
    cleanupInitialGeneration(env);
    writeFileSync(config, DRIZZLE.replace("out: './migrations'", `out: './${INIT_MIGRATIONS}'`));
    env.run(['drizzle-kit', 'generate', '--config', INIT_DRIZZLE]);
    validateMigrationSet(staging);
    renameSync(staging, migrations);
    unlinkSync(config);
  }
  writeMigrationMarker(env, { schemaVersion: SCHEMA_VERSION });
  env.log(`migrations/handover.json records schema version ${SCHEMA_VERSION}`);
}

function cleanupInitialGeneration(env: Env): void {
  const staging = join(env.cwd, INIT_MIGRATIONS);
  const config = join(env.cwd, INIT_DRIZZLE);
  if (existsSync(staging)) rmSync(staging, { recursive: true });
  if (existsSync(config)) unlinkSync(config);
}

function validateMigrationSet(directory: string): void {
  const journalPath = join(directory, 'meta/_journal.json');
  const journal = readJson(journalPath) as { entries?: unknown } | undefined;
  if (!Array.isArray(journal?.entries) || !journal.entries.length)
    throw new Error(`${journalPath}: no generated migrations were recorded`);
  for (const entry of journal.entries) {
    const tag =
      entry && typeof entry === 'object' && 'tag' in entry
        ? (entry as { tag?: unknown }).tag
        : undefined;
    if (typeof tag !== 'string' || !existsSync(join(directory, `${tag}.sql`)))
      throw new Error(`${directory}: Drizzle recorded ${String(tag)} without its SQL file`);
  }
}

function provisionDatabase(env: Env, record: InitRecord, configuredId?: string): string {
  const databases = () => {
    const listed = JSON.parse(env.capture(['wrangler', 'd1', 'list', '--json'])) as {
      uuid?: unknown;
      name?: unknown;
    }[];
    if (!Array.isArray(listed)) throw new Error('wrangler d1 list did not return an array');
    return listed.filter(
      (database): database is { uuid: string; name: string } =>
        typeof database.uuid === 'string' && typeof database.name === 'string',
    );
  };
  const before = databases();
  if (record.databaseId) {
    const exact = before.find((database) => database.uuid === record.databaseId);
    if (exact?.name !== record.siteName)
      throw new Error(
        `D1 database ${record.databaseId} is not ${record.siteName} in account ${record.accountId}; nothing was created.`,
      );
    return record.databaseId;
  }
  if (configuredId) {
    const configured = before.find((database) => database.uuid === configuredId);
    if (configured?.name !== record.siteName)
      throw new Error(
        `The configured D1 database ${configuredId} is not ${record.siteName} in account ${record.accountId}; nothing was created.`,
      );
    return configuredId;
  }
  const matches = before.filter((database) => database.name === record.siteName);
  if (matches.length > 1)
    throw new Error(`wrangler lists more than one D1 database called ${record.siteName}`);
  if (matches[0]) return matches[0].uuid;
  env.run(['wrangler', 'd1', 'create', record.siteName]);
  const created = databases().find((database) => database.name === record.siteName)?.uuid;
  if (!created) throw new Error(`wrangler lists no database called ${record.siteName}`);
  return created;
}

function provisionBucket(env: Env, record: InitRecord): void {
  const argv = ['wrangler', 'r2', 'bucket', 'info', record.bucketName, '--json'];
  let output: string | undefined;
  if (env.probe) output = env.probe(argv);
  else {
    try {
      output = env.capture(argv);
    } catch {}
  }
  if (output !== undefined) {
    const info = JSON.parse(output) as { name?: unknown };
    if (info.name !== record.bucketName)
      throw new Error(`wrangler returned the wrong R2 bucket for ${record.bucketName}`);
    record.bucketReady = true;
    return;
  }
  if (record.bucketReady)
    throw new Error(
      `R2 bucket ${record.bucketName} was created earlier but Wrangler cannot verify it now; it was not recreated.`,
    );
  env.run(['wrangler', 'r2', 'bucket', 'create', record.bucketName]);
  record.bucketReady = true;
}

function wranglerConfig(env: Env): WranglerConfig | undefined {
  const files = CONFIGS.filter((file) => existsSync(join(env.cwd, file)));
  if (files.length > 1)
    throw new Error(
      `More than one Wrangler config exists (${files.join(', ')}); keep one before init.`,
    );
  const file = files[0];
  if (!file) return undefined;
  const text = readFileSync(join(env.cwd, file), 'utf8');
  if (file.endsWith('.toml')) return tomlWranglerConfig(file, text);
  let parsed: {
    vars?: unknown;
    d1_databases?: unknown;
  };
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as typeof parsed;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  return {
    file,
    vars:
      parsed.vars && typeof parsed.vars === 'object' && !Array.isArray(parsed.vars)
        ? (parsed.vars as Record<string, unknown>)
        : parsed.vars === undefined
          ? undefined
          : { __invalid: parsed.vars },
    databases: Array.isArray(parsed.d1_databases)
      ? (parsed.d1_databases as Record<string, unknown>[])
      : parsed.d1_databases === undefined
        ? undefined
        : [{ __invalid: parsed.d1_databases }],
  };
}

function stripJsonComments(text: string): string {
  let out = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += char;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    out += char;
  }
  return out;
}

function tomlWranglerConfig(file: string, text: string): WranglerConfig {
  const vars: Record<string, unknown> = {};
  const databases: Record<string, unknown>[] = [];
  let section = '';
  let database: Record<string, unknown> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const table = /^\[([^[][^\]]*)\]$/.exec(line)?.[1];
    const array = /^\[\[([^\]]+)\]\]$/.exec(line)?.[1];
    if (array) {
      section = array;
      database = array === 'd1_databases' ? {} : undefined;
      if (database) databases.push(database);
      continue;
    }
    if (table) {
      section = table;
      database = undefined;
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(["'])(.*?)\2$/.exec(line);
    if (!pair) continue;
    if (section === 'vars') vars[pair[1] as string] = pair[3];
    if (section === 'd1_databases' && database) database[pair[1] as string] = pair[3];
  }
  return {
    file,
    vars: Object.keys(vars).length ? vars : undefined,
    databases: databases.length ? databases : undefined,
  };
}

function validateWranglerConfig(
  config: WranglerConfig,
  name: string,
  bucket: string,
  account?: string,
  databaseId?: string,
): string[] {
  if (config.vars?.__invalid !== undefined)
    throw new Error(`${config.file}: vars must be an object/table`);
  if (config.databases?.[0]?.__invalid !== undefined)
    throw new Error(`${config.file}: d1_databases must be an array of bindings`);
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
    ...(database?.database_name === name && database.database_id === databaseId ? [] : ['DB']),
  ];
}

function configuredDatabases(config: WranglerConfig): Record<string, unknown>[] {
  return (config.databases ?? []).filter((database) => database.binding === 'DB');
}

function configuredDatabaseId(config: WranglerConfig): string | undefined {
  const id = configuredDatabases(config)[0]?.database_id;
  return typeof id === 'string' ? id : undefined;
}

function validateDrizzleConfig(env: Env): void {
  const path = join(env.cwd, 'drizzle.config.ts');
  if (!existsSync(path)) return;
  const text = stripSourceComments(readFileSync(path, 'utf8'));
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

function stripSourceComments(text: string): string {
  return stripJsonComments(text).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The site's own files. */
function scaffold(env: Env): void {
  const i18n = i18nOf(env.cwd);
  const theirs = join(env.cwd, 'src/content.config.ts');
  if (!existsSync(theirs)) {
    for (const [path, text] of Object.entries(starter(i18n))) put(env, path, text);
    const pages = { name: 'pages', schema: 'page', extra: `, route: '/[slug]', load: 'page'` };
    put(env, 'cms.config.ts', cmsConfig(i18n, [pages], true));
    return;
  }

  const collections = collectionsOf(readFileSync(theirs, 'utf8'));
  const inline = collections.filter((c) => !c.schema).map((c) => c.name);
  env.log(
    'src/content.config.ts is yours; its collections are read out of it and it is left alone',
  );
  if (inline.length)
    env.log(
      `${inline.join(', ')}: the schema is written inline there, so cms.config.ts cannot import it. Move it into src/content/schemas.ts and add the collection to cms.config.ts (docs/template-convention.md).`,
    );
  const named = collections.flatMap((c) => (c.schema ? [{ name: c.name, schema: c.schema }] : []));
  if (!named.length) {
    env.log(
      'No collection left to write, so no cms.config.ts. Write it by hand: docs/getting-started.md',
    );
    return;
  }
  put(env, 'cms.config.ts', cmsConfig(i18n, named, false));
  env.log(
    'Nothing in it has a route, an index or a load yet, and a collection without them is listed in the admin but renders nowhere: docs/configuration.md.',
  );
}

function siteName(cwd: string): string {
  let name = basename(cwd);
  try {
    name = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name as string) || name;
  } catch {}
  return name
    .replace(/^@/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
}

/** Require an account choice to avoid creating resources in the wrong place. */
function accountId(env: Env): string {
  const accounts = (JSON.parse(env.capture(['wrangler', 'whoami', '--json'])).accounts ?? []) as {
    id: string;
    name: string;
  }[];
  const wanted = process.env.CLOUDFLARE_ACCOUNT_ID;
  const chosen = wanted ? accounts.find((a) => a.id === wanted) : accounts[0];
  if (!chosen || (!wanted && accounts.length !== 1))
    throw new Error(
      `Set CLOUDFLARE_ACCOUNT_ID to one of these and run init again:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')}`,
    );
  return chosen.id;
}

function put(env: Env, path: string, text: string): void {
  const full = join(env.cwd, path);
  if (existsSync(full)) {
    env.log(`${path} is already here; left alone`);
    return;
  }
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  env.log(`Wrote ${path}`);
}
