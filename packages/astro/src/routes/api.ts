import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { Db, EntryLocation, GitClient } from '@handover/core';
import {
  blobSha,
  collectionEntries,
  createDraft,
  createGitClient,
  DraftConflictError,
  deleteEntry,
  discardDraft,
  driftReport,
  entryName,
  FORMAT_VERSION,
  formOf,
  loadDraft,
  openDb,
  overlayRows,
  parseEntry,
  pendingDrafts,
  publishDrafts,
  RefMovedError,
  RepoUnreachableError,
  recordDelete,
  recordRename,
  renameEntry,
  resolveDrift,
  saveDraft,
  staleLocales,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { login } from '../auth.js';
import { formSchema } from '../index.js';
import { entryProblems } from '../problems.js';

function gitClient(): GitClient {
  const e = env as Record<string, string | undefined>;
  const [owner, repo] = (e.GITHUB_REPO ?? '').split('/');
  if (!e.GITHUB_APP_ID || !e.GITHUB_INSTALLATION_ID || !e.GITHUB_PRIVATE_KEY || !owner || !repo) {
    throw new Error(
      'GitHub App is not configured: set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY and GITHUB_REPO (owner/repo) with `wrangler secret put`',
    );
  }
  return createGitClient('default', {
    appId: e.GITHUB_APP_ID,
    installationId: e.GITHUB_INSTALLATION_ID,
    privateKey: e.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
    owner,
    repo,
    branch: e.GITHUB_BRANCH,
  });
}

function db(): Db {
  return openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
}

// The admin draws the default language's file; the others are kept in step behind it.
const entryPath = (collection: string, slug: string, locale = config.i18n.defaultLocale) =>
  `src/content/${collection}/${locale}/${slug}.yaml`;

// One entry's other languages, locale → path. Empty on a site that declares one language,
// which is what keeps that site's save exactly the write it was.
const siblingPaths = (collection: string, slug: string) =>
  Object.fromEntries(
    config.i18n.locales
      .filter((locale) => locale !== config.i18n.defaultLocale)
      .map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

// Every file one entry is made of. A rename or a delete commits all of them, so all of them
// have to be recorded in D1 too, or a draft left at the old path publishes the file back.
const entryFiles = async (git: GitClient, collection: string, slug: string) => {
  const locales = config.i18n.locales;
  const files = await Promise.all(
    locales.map((locale) => git.getFile(entryPath(collection, slug, locale))),
  );
  return locales.map((locale, i) => ({
    locale,
    path: entryPath(collection, slug, locale),
    file: files[i],
  }));
};

// One entry as the editor has it, language by language: its draft where there is one, the
// repository where there is not, and no key at all for a language it has no file in. What
// `driftReport` compares — a structure two files disagree about is a hand edit or a bad merge.
async function entryLocales(
  collection: string,
  slug: string,
  locales: string[],
): Promise<Record<string, unknown>> {
  const git = gitClient();
  const database = db();
  const loaded = await Promise.all(
    locales.map(async (locale) => {
      const path = entryPath(collection, slug, locale);
      const [file, row] = await Promise.all([
        git.getFile(path),
        loadDraft('default', database, path),
      ]);
      const contents = row?.contents || file?.contents;
      return contents ? ([locale, parseEntry('default', contents)] as const) : undefined;
    }),
  );
  return Object.fromEntries(loaded.filter((l) => l !== undefined));
}

// The draft is what the editor was last looking at, so it wins over the file. No sha goes
// to the browser: a publish commits the stored bytes and compares the bases server-side.
async function getEntry(collection: string, slug: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const schema = collected.schema;
  const path = entryPath(collection, slug);
  const [file, draft] = await Promise.all([
    gitClient().getFile(path),
    loadDraft('default', db(), path),
  ]);
  const contents = draft?.contents ?? file?.contents;
  if (contents === undefined) return new Response('Not found', { status: 404 });
  const data = parseEntry('default', contents);
  const form = formOf('default', formSchema(schema));
  const others = config.i18n.locales.filter((locale) => locale !== config.i18n.defaultLocale);
  // The other languages, and nothing on a site that declares one: an entry with a single file
  // has nothing to have drifted from or been translated ahead of, and reads nothing to find out.
  const translations = await entryLocales(collection, slug, others);
  const languages = { [config.i18n.defaultLocale]: data, ...translations };
  return Response.json({
    ...form,
    data,
    // The same read the drift and staleness answers come from, so editing a second language
    // beside the first is this one response and not a request per column.
    translations,
    pending: draft ? (await blobSha(draft.contents)) !== file?.blob_sha : false,
    problems: entryProblems(schema, data),
    titleField: collected.titleField,
    // The languages the site declares, which is what says whether the editor draws any of the
    // controls that are about having more than one, and which of them this response is of.
    locales: config.i18n.locales,
    defaultLocale: config.i18n.defaultLocale,
    drift: driftReport('default', form, languages),
    // Which of them were translated from an English that has moved on since. A warning the
    // editor draws next to the language, never a reason to refuse anything.
    stale: await staleLocales('default', form, languages),
  });
}

// The `_` keys belong to the file, not to the form: `mergeEntry` reads them off the entry as
// it stands, so a browser posting `_status` must not be able to set it.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

/**
 * Autosave of the default language, and of the structure every language shares: a block
 * added, moved or removed goes into the other languages' files in the same write, values
 * they own untouched.
 *
 * A draft holds what the editor typed, whether the schema accepts it yet or not: a new entry
 * in a collection with a required `reference` has no way to satisfy it from a form whose
 * widget is read-only, and refusing the write would throw the typed text away. What is missing
 * comes back named instead, and the publish is where the schema decides.
 *
 * No base comes from the browser: saveDraft reads it from git the first time it writes a row
 * and keeps it afterwards.
 */
async function autosave(
  collection: string,
  slug: string,
  request: Request,
  locale = config.i18n.defaultLocale,
): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const data = editable(body?.data);
  if (!data) return new Response('Bad request', { status: 400 });
  // A translation writes its own words into its own file and moves nothing; the default
  // language is the one that carries the structure into the others. A site that declares one
  // language does neither, so its save is exactly the write it always was.
  const translation = locale !== config.i18n.defaultLocale;
  const siblings = translation ? {} : siblingPaths(collection, slug);
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft(
      'default',
      db(),
      gitClient(),
      entryPath(collection, slug, locale),
      data,
      translation || Object.keys(siblings).length
        ? { form: formOf('default', formSchema(schema)), locale, siblings, translation }
        : undefined,
    );
  } catch (err) {
    // A shape the serialiser cannot write back — a nested array above all — leaves nothing to
    // store, so this one is still a refusal, with the reason rather than "Bad request".
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

/**
 * The answers to one entry's structural drift, one per block its languages disagree about.
 * They belong here and not in an autosave: that one carries the default language's values and
 * has no way to say a block comes out of German. Nothing is marked resolved — the entry is read
 * again afterwards, and the banner goes because the next report is empty.
 */
async function reconcile(collection: string, slug: string, request: Request): Promise<Response> {
  const schema = config.collections[collection]?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { choices?: unknown } | undefined;
  const choices = (Array.isArray(body?.choices) ? body.choices : []).filter(
    (choice): choice is { path: string; locales: string[] } =>
      typeof choice?.path === 'string' &&
      Array.isArray(choice.locales) &&
      choice.locales.every((locale: unknown) => typeof locale === 'string'),
  );
  const form = formOf('default', formSchema(schema));
  const locales = await entryLocales(collection, slug, config.i18n.locales);
  const drift = new Set(driftReport('default', form, locales).map((row) => row.path));
  // A row the languages agree about has nothing to answer: the report moved on under the tab.
  if (!choices.length || choices.some((choice) => !drift.has(choice.path)))
    return new Response("Those are not the blocks this entry's languages disagree about", {
      status: 409,
    });
  await resolveDrift(
    'default',
    db(),
    gitClient(),
    form,
    config.i18n.locales,
    Object.fromEntries(Object.keys(locales).map((l) => [l, entryPath(collection, slug, l)])),
    choices,
  );
  return Response.json({});
}

// The titles come from the build, the pending edits from D1. Nothing here touches GitHub:
// listing a collection through the contents API is one request per file.
async function listEntries(collection: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const rows = await overlayRows('default', db(), index);
  return Response.json({
    entries: collectionEntries('default', index, collection, rows, collected.titleField),
    // Which languages the list draws a column for, and in which order — one language, no column.
    locales: config.i18n.locales,
  });
}

/** Every name the collection already uses, published or only drafted. */
async function takenNames(collection: string, database: Db): Promise<string[]> {
  const rows = await overlayRows('default', database, index);
  return collectionEntries('default', index, collection, rows).map((e) => e.id);
}

// An entry is its file in every declared language: a rename or a delete moves all of them.
const locationOf = (collection: string): EntryLocation => ({
  collection,
  route: config.collections[collection]?.route,
  locales: config.i18n.locales,
});

/**
 * A new entry is a draft, not a commit: nothing is in the repository until it is published,
 * which is what lets the file name stay editable and keeps an abandoned entry out of git.
 * It starts empty apart from its title — a field the schema requires is left absent rather
 * than guessed at, and the editor is shown what is still missing until the publish.
 */
async function createEntry(collection: string, request: Request): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { title?: unknown } | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const database = db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(collected.schema));
  // The field the collection lists by is the one the title typed into the dialog belongs in.
  const named = collected.titleField ?? 'title';
  const values: Record<string, unknown> = { _version: FORMAT_VERSION };
  if (fields.some((f) => f.path[0] === named && f.type === 'text')) values[named] = title;
  await createDraft('default', database, gitClient(), entryPath(collection, slug), values);
  return Response.json({ slug });
}

// The new name goes through the same derivation as a new entry's, so a rename can never
// produce a file name the CMS could not have created.
async function rename(collection: string, slug: string, request: Request): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { to?: unknown } | undefined;
  const database = db();
  const git = gitClient();
  const files = await entryFiles(git, collection, slug);
  if (!files.some((f) => f.file))
    return new Response('Publish this entry before renaming it', { status: 409 });
  const taken = (await takenNames(collection, database)).filter((id) => id !== slug);
  const to = entryName('default', typeof body?.to === 'string' ? body.to : '', taken);
  if (to === slug) return Response.json({ slug });
  const { commit_sha } = await renameEntry('default', git, locationOf(collection), slug, to);
  for (const { locale, path, file } of files) {
    if (!file) continue;
    await recordRename(
      'default',
      database,
      path,
      entryPath(collection, to, locale),
      file.contents,
      commit_sha,
    );
  }
  return Response.json({ slug: to, commit_sha });
}

// An entry that was never published has nothing to remove from the repository and no URL
// anyone could have followed, so it goes without a commit and without a redirect.
async function remove(collection: string, slug: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const git = gitClient();
  const database = db();
  const files = await entryFiles(git, collection, slug);
  if (!files.some((f) => f.file)) {
    for (const { path } of files) await discardDraft('default', database, path);
    return Response.json({});
  }
  const result = await deleteEntry('default', git, locationOf(collection), slug, collected.index);
  for (const { path, file } of files)
    if (file) await recordDelete('default', database, path, result.commit_sha);
  return Response.json(result);
}

// The way out of a publish conflict: the entry gives up its draft and is read from the
// repository again on the next open. Taking theirs whole — picking field by field is later.
async function discard(collection: string, slug: string): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const database = db();
  // Every language of it: the others hold the structure this edit gave them.
  for (const locale of config.i18n.locales)
    await discardDraft('default', database, entryPath(collection, slug, locale));
  return Response.json({});
}

const ENTRIES = /^entries\/([\w-]+)$/;
const ENTRY = /^entries\/([\w-]+)\/([\w-]+)$/;
const DRAFT = /^drafts\/([\w-]+)\/([\w-]+)$/;
const TRANSLATION = /^drafts\/([\w-]+)\/([\w-]+)\/([\w-]+)$/;
const RENAME = /^entries\/([\w-]+)\/([\w-]+)\/rename$/;
const DRIFT = /^drift\/([\w-]+)\/([\w-]+)$/;

export const GET: APIRoute = async ({ params }) => {
  if (params.path === 'ping') {
    return Response.json({ ok: true, collections: Object.keys(config.collections) });
  }
  if (params.path === 'drafts') {
    const rows = await pendingDrafts('default', db());
    return Response.json({
      files: rows.map((r) => ({ path: r.path, updated_at: r.updatedAt })),
    });
  }
  const entry = params.path?.match(ENTRY);
  if (entry) return answering(() => getEntry(entry[1] ?? '', entry[2] ?? ''));
  const list = params.path?.match(ENTRIES);
  if (list) return listEntries(list[1] ?? '');
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request }) => {
  const translated = params.path?.match(TRANSLATION);
  if (translated)
    return answering(() =>
      autosave(translated[1] ?? '', translated[2] ?? '', request, translated[3]),
    );
  const draft = params.path?.match(DRAFT);
  if (draft) return answering(() => autosave(draft[1] ?? '', draft[2] ?? '', request));
  return new Response('Not found', { status: 404 });
};

// `src/content/<collection>/<locale>/<slug>.yaml`. redirects.yaml and the globals share the
// prefix and belong to no collection: there is no schema to hold them to.
const schemaFor = (path: string) => config.collections[path.split('/')[2] ?? '']?.schema;

const ENTRY_FILE = /^src\/content\/([a-z0-9-]+)\/([^/]+)\/([^/]+)\.yaml$/;

/**
 * Which language a file this publish is about to commit was translated from: the entry's
 * default-language file and the form that says which of its values a translation is made from.
 * Nothing for the default language's own file, and nothing for a path no collection owns — a
 * global has no schema, so no form. On a site that declares one language it is always nothing.
 */
const sourceOf = (path: string) => {
  const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(path) ?? [];
  const schema = config.collections[collection]?.schema;
  if (!schema || !locale || locale === config.i18n.defaultLocale) return undefined;
  return {
    locale: config.i18n.defaultLocale,
    path: entryPath(collection, slug),
    form: formOf('default', formSchema(schema)),
  };
};

/**
 * Which of these files belong to an entry whose languages have drifted apart. The one refusal
 * besides the schema: the structure is shared, so committing a file that disagrees with its
 * other languages would bake the difference into git, and which side is right is a decision
 * somebody makes. A site with one language never has a second file to disagree with.
 */
async function driftedPaths(paths: string[]): Promise<string[]> {
  if (config.i18n.locales.length < 2) return [];
  // One entry is one check, however many of its languages are waiting to be published.
  const entries = new Map<string, string[]>();
  for (const path of paths) {
    const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
    if (!collection) continue;
    const key = `${collection}/${slug}`;
    entries.set(key, [...(entries.get(key) ?? []), path]);
  }
  const drifted: string[] = [];
  for (const [key, files] of entries) {
    const [collection = '', slug = ''] = key.split('/');
    // A path no collection owns — a global — has no schema, so no form and no structure.
    const schema = config.collections[collection]?.schema;
    if (!schema) continue;
    const form = formOf('default', formSchema(schema));
    const locales = await entryLocales(collection, slug, config.i18n.locales);
    if (driftReport('default', form, locales).length) drifted.push(...files);
  }
  return drifted;
}

/**
 * One commit for every draft that differs from the repository, then the rows are gone:
 * nothing keeps them, since the next open reads the file the publish just wrote.
 *
 * The schema decides here rather than at every keystroke, so a blank new entry cannot commit
 * a file the site's own content schema rejects and break the build behind it. The set is read
 * again inside publishDrafts; a draft written between the two reads is a window this phase
 * accepts, since the entry it belongs to is the one whose tab is doing the publishing.
 */
async function publish(): Promise<Response> {
  const database = db();
  const pending = await pendingDrafts('default', database);
  const unready = pending.filter((row) => {
    const schema = schemaFor(row.path);
    return schema && row.contents
      ? entryProblems(schema, parseEntry('default', row.contents)).length > 0
      : false;
  });
  if (unready.length) {
    const paths = unready.map((r) => r.path);
    return Response.json(
      {
        error:
          paths.length === 1
            ? `${paths[0]} is missing something the schema needs`
            : `${paths.length} files are missing something the schema needs — ${paths.join(', ')}`,
        paths,
      },
      { status: 422 },
    );
  }
  const drifted = await driftedPaths(pending.map((row) => row.path));
  if (drifted.length) {
    return Response.json(
      {
        error:
          drifted.length === 1
            ? `${drifted[0]} has drifted apart from the entry's other languages — resolve it in the editor`
            : `${drifted.length} files have drifted apart from their entries' other languages — ${drifted.join(', ')}`,
        paths: drifted,
        // Which 409 this is: the drawer's way out of a conflict is Discard, and this one's is
        // the editor.
        reason: 'drift',
      },
      { status: 409 },
    );
  }
  const result = await publishDrafts('default', database, gitClient(), sourceOf);
  return Response.json(result ?? { paths: [] });
}

// Every route answers the same way when git refuses, whether it was reading or committing.
async function answering(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // The repository is out of reach for every path, so this is about the installation and
    // not about whatever entry happened to be open — hence the message rather than a 404.
    if (err instanceof RepoUnreachableError) return new Response(err.message, { status: 503 });
    // A conflict names its files as data as well as prose: the drawer badges those rows and
    // offers each one the way out. A ref that moved has no file to name.
    if (err instanceof DraftConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  if (params.path === 'login') {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    return login(typeof body.password === 'string' ? body.password : '');
  }
  if (params.path === 'publish') return answering(publish);
  const answered = params.path?.match(DRIFT);
  if (answered) return answering(() => reconcile(answered[1] ?? '', answered[2] ?? '', request));
  const renamed = params.path?.match(RENAME);
  if (renamed) return answering(() => rename(renamed[1] ?? '', renamed[2] ?? '', request));
  const created = params.path?.match(ENTRIES);
  if (created) return answering(() => createEntry(created[1] ?? '', request));
  return new Response('Not found', { status: 404 });
};

export const DELETE: APIRoute = async ({ params }) => {
  const draft = params.path?.match(DRAFT);
  if (draft) return discard(draft[1] ?? '', draft[2] ?? '');
  const entry = params.path?.match(ENTRY);
  if (entry) return answering(() => remove(entry[1] ?? '', entry[2] ?? ''));
  return new Response('Not found', { status: 404 });
};
