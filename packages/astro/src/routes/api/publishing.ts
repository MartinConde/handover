import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { CheckEntry, ContentIndex, Draft, SeoDefaultsValue } from '@handover/core';
import {
  clearPublished,
  collectionEntries,
  commitBuild,
  DraftConflictError,
  driftReport,
  entryKey,
  entrySource,
  heldDrafts,
  lastCommit,
  lastHiddenLong,
  logActivity,
  parseEntry,
  publishDrafts,
  RefMovedError,
  readyDrafts,
  runChecks,
} from '@handover/core';
import { entryProblems } from '../../problems.js';
import { readBodyText, readJson } from './body.js';
import {
  codedError,
  ENTRY_FILE,
  entryLocales,
  entryPath,
  entrySubject,
  formFor,
  localeData,
  publishSources,
  schemaOf,
  siteSeoDefaults,
} from './content.js';
import type { RequestContext } from './environment.js';
import { mediaStore, workerBuilds } from './environment.js';

/** Read from the log: a publish redeploys the Worker, so the tab that pressed it may reload. */
export async function buildStatus(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const last = await lastCommit('default', database);
  const builds = workerBuilds();
  if (!builds) return Response.json({});
  let status: Awaited<ReturnType<typeof commitBuild>>;
  try {
    status = await commitBuild(builds, last);
  } catch (err) {
    // A token that cannot ask is configuration, not a site state: log once and draw no pill.
    console.error('build status: the Workers Builds API could not be asked', err);
    return Response.json({});
  }
  const { deployed_sha, ...visible } = status;
  // Reconcile against what is serving, even while a newer build is running or has failed.
  if (deployed_sha) await clearPublished('default', database, deployed_sha, ctx.git());
  // `committed_at` only while the answer is about our commit, or the pill counts from another.
  return Response.json(
    last && visible.commit_sha ? { ...visible, committed_at: last.at } : visible,
  );
}

/** A file whose structure disagrees with its other languages is not committed. */
async function refusedPaths(ctx: RequestContext, paths: string[]) {
  const drifted: string[] = [];
  const unresolved: string[] = [];
  if (config.i18n.locales.length < 2) return { drifted, unresolved };
  // One entry is one check, however many of its languages are waiting to be published.
  const entries = new Map<string, string[]>();
  for (const path of paths) {
    const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
    if (!collection) continue;
    const key = `${collection}/${slug}`;
    entries.set(key, [...(entries.get(key) ?? []), path]);
  }
  for (const [key, files] of entries) {
    const [collection = '', slug = ''] = key.split('/');
    // A path nothing owns — redirects.yaml — has no schema, so no form and no structure.
    const schema = schemaOf(collection, slug);
    if (!schema) continue;
    const form = formFor(collection, slug);
    const locales = localeData(await entryLocales(ctx, collection, slug, config.i18n.locales));
    const source = entrySource('default', config.i18n, locales);
    if (source && 'problem' in source) unresolved.push(...files);
    else if (driftReport('default', form, locales).length) drifted.push(...files);
  }
  return { drifted, unresolved };
}

const ENTRY_KEY = /^[\w-]+\/[\w-]+$/;
const EXCLUSION = /^([\w-]+\/[\w-]+):([\w-]+)$/;

/** Both publish routes take this; only an empty body means everything. */
function selection(
  raw: string,
  body: unknown,
): { chosen?: string[]; without: string[] } | Response {
  if (raw === '') return { without: [] };
  if (body === undefined)
    return codedError(400, 'PUBLISH_SELECTION_INVALID', 'Invalid publish JSON');
  const named = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  if (
    !named ||
    Object.keys(named).some((key) => key !== 'entries' && key !== 'without') ||
    !('entries' in named) ||
    !Array.isArray(named.entries) ||
    named.entries.some((key: unknown) => typeof key !== 'string' || !ENTRY_KEY.test(key))
  )
    return codedError(400, 'PUBLISH_SELECTION_INVALID', 'Publish requires an array of entry keys');
  const chosen = [...new Set(named.entries as string[])];
  const without = 'without' in named ? named.without : [];
  const bad = (item: unknown) => {
    const [, key = '', locale = ''] = (typeof item === 'string' && EXCLUSION.exec(item)) || [];
    return !chosen.includes(key) || !config.i18n.locales.includes(locale);
  };
  if (!Array.isArray(without) || without.some(bad))
    return codedError(
      400,
      'PUBLISH_SELECTION_INVALID',
      'without lists "collection/name:locale" items, each a declared language of an entry in entries',
    );
  return { chosen, without: [...new Set(without as string[])] };
}

const draftPath = (item: string) => {
  const [key = '', locale = ''] = item.split(':');
  const [collection = '', slug = ''] = key.split('/');
  return entryPath(collection, slug, locale);
};

/** An entry's files at `head` with its pending drafts over them, and whose language it is. */
async function entryAt(ctx: RequestContext, head: string, key: string, pending: Draft[]) {
  const [collection = '', slug = ''] = key.split('/');
  const git = ctx.git();
  const files = await Promise.all(
    config.i18n.locales.map(async (locale) => {
      const path = entryPath(collection, slug, locale);
      const draft = pending.find((row) => row.path === path);
      const file = await git.getFile(path, head);
      // An emptied draft is the file's deletion; an empty file is still the language's file.
      const contents = draft ? draft.contents || undefined : file ? file.contents : undefined;
      return {
        locale,
        draft,
        file,
        published: Boolean(file),
        data: contents === undefined ? undefined : contents ? parseEntry('default', contents) : {},
      };
    }),
  );
  const effective = Object.fromEntries(
    files.flatMap(({ locale, data }) => (data === undefined ? [] : [[locale, data]])),
  );
  const source = entrySource('default', config.i18n, effective);
  return { files, source: source && 'locale' in source ? source.locale : undefined };
}

/** Only a file the repository does not have at `head` can wait, and never the entry's own language. */
const whyKept = (at: Awaited<ReturnType<typeof entryAt>>, locale: string) =>
  at.files.find((file) => file.locale === locale)?.published
    ? ('published' as const)
    : at.source === undefined || at.source === locale
      ? ('source' as const)
      : undefined;

// redirects.yaml belongs to no collection; a global's schema is keyed by the file name.
const schemaFor = (path: string) => {
  const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
  return schemaOf(collection, slug);
};

const problemsOf = (row: Pick<Draft, 'path' | 'contents'>) => {
  const schema = schemaFor(row.path);
  return schema && row.contents ? entryProblems(schema, parseEntry('default', row.contents)) : [];
};

/** One resolver for the checks and the commit, so the lint is over exactly what goes out. */
async function resolveSelection(ctx: RequestContext, request: Request, readiness = false) {
  const raw = await readBodyText(request);
  const asked = selection(raw, await readJson(request));
  if (asked instanceof Response) return asked;
  const { chosen, without } = asked;
  const pending = await readyDrafts('default', ctx.db(), chosen);
  const left = new Set(without.map(draftPath));
  const missing = [...left].filter((path) => !pending.some((row) => row.path === path));
  if (missing.length)
    return codedError(
      400,
      'PUBLISH_EXCLUDE_NOT_PENDING',
      `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no unpublished changes to leave out`,
      { paths: missing },
    );
  const keys = new Set(without.map((item) => item.split(':')[0] ?? ''));
  if (readiness && chosen)
    for (const row of pending) {
      const key = entryKey(row.path);
      if (key && schemaFor(row.path)) keys.add(key);
    }
  // The commit is made on this head, so a file created after it cannot slip past as absent.
  const head = keys.size ? await ctx.git().getHead() : undefined;
  const read = new Map(
    await Promise.all(
      [...keys].map(async (key) => [key, await entryAt(ctx, head ?? '', key, pending)] as const),
    ),
  );
  for (const item of without) {
    const [key = '', locale = ''] = item.split(':');
    const at = read.get(key);
    const why = at && whyKept(at, locale);
    if (why === 'published')
      return codedError(
        422,
        'PUBLISH_EXCLUDE_PUBLISHED',
        `${draftPath(item)} is already published; its languages publish together`,
        { paths: [draftPath(item)] },
      );
    if (why === 'source')
      return codedError(
        422,
        'PUBLISH_EXCLUDE_SOURCE',
        `${draftPath(item)} is the language the entry is written in and publishes with it`,
        { paths: [draftPath(item)] },
      );
  }
  const retained = pending.filter((row) => !left.has(row.path));
  if (left.size && !retained.length)
    return codedError(
      400,
      'PUBLISH_EXCLUDE_ALL',
      'Leaving these files out leaves nothing to publish',
    );
  return {
    chosen,
    head: without.length ? head : undefined,
    retained,
    excluded: pending.filter((row) => left.has(row.path)),
    read,
  };
}

/** A request of its own so the pass gets its own CPU budget; nothing here refuses anything. */
export async function prepublishChecks(ctx: RequestContext, request: Request): Promise<Response> {
  const database = ctx.db();
  const resolved = await resolveSelection(ctx, request, true);
  if (resolved instanceof Response) return resolved;
  const { retained: rows, read } = resolved;
  // Per pending language, the draft as stored: what the dialog may offer to leave out.
  const readiness = Object.fromEntries(
    [...read].map(([key, at]) => [
      key,
      Object.fromEntries(
        at.files.flatMap(({ locale, draft }) => {
          if (!draft) return [];
          const why = whyKept(at, locale);
          return [
            [
              locale,
              {
                revision: draft.revision,
                problems: problemsOf(draft),
                excludable: !why,
                ...(why ? { reason: why } : {}),
              },
            ],
          ];
        }),
      ),
    ]),
  );
  // Overlay only the selected drafts: a link to a page only an unselected draft creates is bad.
  const overlay = rows.map(({ path, contents }) => ({ path, contents }));
  const overlaid: ContentIndex = Object.fromEntries(
    Object.keys(config.collections).map((name) => [
      name,
      collectionEntries('default', index, name, overlay, config.collections[name]?.titleField),
    ]),
  );
  const going = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(row.path) ?? [];
    // A file this publish removes is not linted; the overlay already took its page off the index.
    if (!collection || !row.contents || !schemaOf(collection, slug)) continue;
    const files = going.get(`${collection}/${slug}`) ?? {};
    files[locale] = row.contents;
    going.set(`${collection}/${slug}`, files);
  }
  const git = ctx.git();
  const entries: CheckEntry[] = await Promise.all(
    [...going].map(async ([key, drafted]) => {
      const [collection = '', slug = ''] = key.split('/');
      // Unpublished languages come from git: a translation is judged stale against its source.
      const rest = await Promise.all(
        config.i18n.locales
          .filter((locale) => !(locale in drafted))
          .map(async (locale) => {
            const path = entryPath(collection, slug, locale);
            // Readiness read the entry already; the drawer names every entry it lints.
            const file = read.has(key)
              ? read.get(key)?.files.find((at) => at.locale === locale)?.file
              : await git.getFile(path);
            return file ? ([locale, { path, contents: file.contents }] as const) : undefined;
          }),
      );
      return {
        key,
        form: formFor(collection, slug),
        publishing: Object.keys(drafted),
        files: {
          ...Object.fromEntries(rest.filter((l) => l !== undefined)),
          ...Object.fromEntries(
            Object.entries(drafted).map(([locale, contents]) => [
              locale,
              { path: entryPath(collection, slug, locale), contents },
            ]),
          ),
        },
      };
    }),
  );
  const results = await runChecks('default', database, {
    entries,
    site: { i18n: config.i18n, collections: config.collections },
    index: overlaid,
    seoDefaults: (await siteSeoDefaults(ctx)) as Record<string, SeoDefaultsValue>,
    store: mediaStore(),
    ignore: config.checks?.ignore,
    hiddenLong: await lastHiddenLong('default', database),
  });
  // The drawer lists entries; the file says which language a result is about.
  return Response.json({
    results: results.map((result) => ({ ...result, entry: entryKey(result.path) ?? result.path })),
    ...(resolved.chosen ? { readiness } : {}),
  });
}

/** Committed rows are re-seeded rather than deleted, so later typing is measured against them. */
export async function publish(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const database = ctx.db();
  // Only a genuinely empty body means all: a malformed selection must never widen scope.
  const resolved = await resolveSelection(ctx, request);
  if (resolved instanceof Response) return resolved;
  const { chosen, head, retained: pending, excluded } = resolved;
  // Who was holding what, read while the holds are still there: the publish releases them.
  const holders = chosen?.length ? await heldDrafts('default', database) : {};
  // Held to the schema before anything is written, over exactly the set the commit is made of.
  const unready = pending.filter((row) => problemsOf(row).length > 0);
  if (unready.length) {
    const paths = unready.map((r) => r.path);
    return Response.json(
      {
        code: 'PUBLISH_INCOMPLETE',
        error:
          paths.length === 1
            ? `${paths[0]} is missing something the schema needs`
            : `${paths.length} files are missing something the schema needs — ${paths.join(', ')}`,
        paths,
      },
      { status: 422 },
    );
  }
  const { drifted, unresolved } = await refusedPaths(
    ctx,
    pending.map((row) => row.path),
  );
  // The drawer's check says the same; a request that skips the drawer is held here.
  if (unresolved.length)
    return codedError(
      409,
      'PUBLISH_SOURCE_UNRESOLVED',
      `${unresolved.join(', ')} belong to entries whose files disagree about the language they are written in — make their _source agree in the repository`,
      { paths: unresolved },
    );
  if (drifted.length) {
    return Response.json(
      {
        code: 'PUBLISH_DRIFT',
        error:
          drifted.length === 1
            ? `${drifted[0]} has drifted apart from the entry's other languages — resolve it in the editor`
            : `${drifted.length} files have drifted apart from their entries' other languages — ${drifted.join(', ')}`,
        paths: drifted,
        // Which 409 this is: a conflict's way out is Discard, drift's is the editor.
        reason: 'drift',
      },
      { status: 409 },
    );
  }
  let result: Awaited<ReturnType<typeof publishDrafts>>;
  try {
    result = await publishDrafts(
      'default',
      database,
      ctx.git(),
      publishSources(ctx),
      chosen,
      pending,
      { userId: session?.user.id, ...(head ? { baseSha: head } : {}) },
    );
  } catch (err) {
    // Only a repository refusal is logged: a schema or drift refusal is this person's own drafts.
    const conflict = err instanceof DraftConflictError;
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: conflict ? 'publish-conflict' : 'publish-failed',
      // One file is an entry somebody can open; several are a list the 409 already carries.
      subject: conflict && err.paths.length === 1 ? (err.paths[0] ?? null) : null,
      detail: conflict
        ? { files: err.paths.length }
        : { files: pending.length, reason: err instanceof RefMovedError ? 'ref-moved' : 'refused' },
    });
    throw err;
  }
  // A held file left out keeps the entry on hold, so its hold was not released.
  const stillHeld = new Set(excluded.flatMap((row) => (row.heldBy && entryKey(row.path)) || []));
  const released = (result?.released ?? []).filter((entry) => !stillHeld.has(entry));
  // A released hold is logged as the same event the toggle writes.
  for (const entry of released) {
    const [collection = '', slug = ''] = entry.split('/');
    const from = holders[entry]?.name;
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'hold-released',
      subject: await entrySubject(ctx, collection, slug),
      detail: from ? { from } : null,
    });
  }
  // A Publish click with nothing pending is not an event; a D1 write per click adds up.
  if (result?.commit_sha) {
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'publish',
      // The draft rows go once the build is live, so this row is the only record of the edit.
      subject: result.paths.length === 1 ? (result.paths[0] ?? null) : null,
      detail: {
        files: result.paths.length,
        entries: publishedKeys(result.paths),
        paths: result.paths,
      },
      commitSha: result.commit_sha,
    });
  }
  return Response.json(
    result ? { ...result, ...(excluded.length ? { released } : {}) } : { paths: [] },
  );
}

/** Capped at what the dashboard draws: the log's `detail` is small json. */
const publishedKeys = (paths: readonly string[]) =>
  [...new Set(paths.flatMap((path) => entryKey(path) ?? []))].slice(0, 8);
