import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { CheckEntry, ContentIndex, SeoDefaultsValue } from '@handover/core';
import {
  clearPublished,
  collapseRedirects,
  collectionEntries,
  commitBuild,
  commitScope,
  DraftConflictError,
  driftReport,
  editRedirects,
  entryKey,
  entryOffer,
  heldDrafts,
  lastCommit,
  lastHiddenLong,
  logActivity,
  parseEntry,
  pendingDrafts,
  publishDrafts,
  type RedirectRule,
  RefMovedError,
  readRedirects,
  readyDrafts,
  redirectError,
  redirectRule,
  restoreCommit,
  revertCommit,
  runChecks,
  setEntryLocales,
} from '@handover/core';
import { entryProblems } from '../../problems.js';
import {
  ENTRY_FILE,
  entryLocales,
  entryPath,
  entrySubject,
  formFor,
  heldByAnother,
  localeData,
  pickable,
  schemaOf,
  sitePages,
  siteSeoDefaults,
  sourceOf,
} from './content.js';
import type { RequestContext } from './context.js';
import { mediaStore, workerBuilds } from './environment.js';

/** Committed rules in file order, then the rules waiting on an entry's draft, flagged. */
export async function redirectList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [committed, waiting, entries] = await Promise.all([
    readRedirects('default', ctx.git()),
    pendingDrafts('default', database),
    pickable(ctx),
  ]);
  const titles = new Map(entries.map((e) => [e.path, e.title || e.path]));
  // Keyed by id: a row read twice would otherwise list the same rule twice.
  const pending = new Map(
    waiting.flatMap((row) => (row.pendingRedirects ?? []).map((rule) => [rule._id, rule] as const)),
  );
  const named = (rule: RedirectRule, unpublished?: true) => ({
    ...rule,
    ...(rule.entry ? { title: titles.get(rule.entry) ?? rule.entry } : {}),
    ...(unpublished ? { pending: true } : {}),
  });
  return Response.json({
    rules: [
      ...committed.map((rule) => named(rule)),
      ...[...pending.values()].map((rule) => named(rule, true)),
    ],
  });
}

/** A rule the entry owns: hiding wrote it and showing the entry again takes it back out. */
const MANAGED =
  'This redirect belongs to the entry that is hidden. Show that entry again and the redirect goes with it.';

const typedRule = async (request: Request) => {
  const body = (await request.json().catch(() => undefined)) as
    | { from?: unknown; to?: unknown; status?: unknown }
    | undefined;
  return {
    from: typeof body?.from === 'string' ? body.from.trim() : '',
    to: typeof body?.to === 'string' ? body.to.trim() : '',
    status: body?.status === 302 ? (302 as const) : (301 as const),
  };
};

/** Committed on add: a rule with no entry to ride on has nowhere to wait for a publish. */
export async function addRedirect(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const typed = await typedRule(request);
  const git = ctx.git();
  const [rules, entries] = await Promise.all([readRedirects('default', git), pickable(ctx)]);
  const bad = redirectError('default', typed, { pages: sitePages(entries), rules });
  if (bad) return Response.json(bad, { status: 422 });
  const typed_ = redirectRule('default', { ...typed, reason: 'manual' }, Date.now());
  // Read back from the file: a destination that already forwarded is collapsed onto its target.
  let rule = typed_;
  const { commit_sha } = await editRedirects('default', git, `Add redirect ${rule.from}`, (all) => {
    const written = collapseRedirects(all, [typed_]);
    rule = written.find((r) => r._id === typed_._id) ?? typed_;
    return written;
  });
  await logActivity('default', ctx.db(), {
    userId: session?.user.id,
    kind: 'redirect-added',
    subject: rule._id,
    commitSha: commit_sha,
    detail: { from: rule.from, to: rule.to },
  });
  return Response.json({ rule });
}

/** A hidden entry's rule is refused for the reason a delete of it is. */
export async function changeRedirect(
  ctx: RequestContext,
  id: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const typed = await typedRule(request);
  const git = ctx.git();
  const [rules, entries] = await Promise.all([readRedirects('default', git), pickable(ctx)]);
  const found = rules.find((rule) => rule._id === id);
  if (!found) return new Response('Not found', { status: 404 });
  if (found.reason === 'hidden') return Response.json({ error: MANAGED }, { status: 409 });
  const bad = redirectError('default', typed, { pages: sitePages(entries), rules }, id);
  if (bad) return Response.json(bad, { status: 422 });
  const { commit_sha } = await editRedirects('default', git, `Edit redirect ${found.from}`, (all) =>
    collapseRedirects(all, [{ ...found, ...typed }]),
  );
  await logActivity('default', ctx.db(), {
    userId: session?.user.id,
    kind: 'redirect-changed',
    subject: id,
    commitSha: commit_sha,
    detail: { from: typed.from, to: typed.to },
  });
  return Response.json({});
}

/** A hidden entry's rule is refused: it would come back at the next publish anyway. */
export async function removeRedirect(
  ctx: RequestContext,
  id: string,
  session: App.Locals['handover'],
): Promise<Response> {
  const git = ctx.git();
  const rules = await readRedirects('default', git);
  const found = rules.find((rule) => rule._id === id);
  if (!found) return new Response('Not found', { status: 404 });
  if (found.reason === 'hidden') return Response.json({ error: MANAGED }, { status: 409 });
  const { commit_sha } = await editRedirects(
    'default',
    git,
    `Delete redirect ${found.from}`,
    (all) => all.filter((rule) => rule._id !== id),
  );
  await logActivity('default', ctx.db(), {
    userId: session?.user.id,
    kind: 'redirect-deleted',
    subject: id,
    commitSha: commit_sha,
    detail: { from: found.from, to: found.to },
  });
  return Response.json({ deleted: id });
}

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
  // The one moment the Worker learns the build went green, so the published rows go here.
  if (last && status.state === 'live' && status.commit_sha === last.sha)
    await clearPublished('default', database, last.sha);
  // `committed_at` only while the answer is about our commit, or the pill counts from another.
  return Response.json(last && status.commit_sha ? { ...status, committed_at: last.at } : status);
}

/** Any admin commit, not only the last; 409 with paths when one of its files has moved since. */
export async function revert(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const sha = await undoing(request);
  if (!sha) return new Response('A commit_sha is needed to revert', { status: 400 });
  const database = ctx.db();
  const scope = await commitScope('default', database, sha);
  if (scope.kind.startsWith('redirect-') && session?.role !== 'owner')
    return new Response('Forbidden', { status: 403 });
  const result = await revertCommit('default', database, ctx.git(), sha, undoPath(session));
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'revert',
    detail: { of: sha, files: result.paths.length },
    commitSha: result.commit_sha,
  });
  // The commit and the paths, never the whole result: it carries the restored file contents.
  return Response.json({ commit_sha: result.commit_sha, paths: result.paths });
}

/** Redirect-only changes require an owner; content paths must be configured editable files. */
const undoPath = (_session: App.Locals['handover']) => (path: string) => {
  if (path === 'src/content/redirects.yaml') return true;
  const match = /^src\/content\/([\w-]+)\/([\w-]+)\/([\w-]+)\.yaml$/.exec(path);
  return Boolean(
    match &&
      config.i18n.locales.includes(match[2] ?? '') &&
      schemaOf(match[1] ?? '', match[3] ?? ''),
  );
};

async function undoing(request: Request): Promise<string> {
  const body = (await request.json().catch(() => undefined)) as
    | { commit_sha?: unknown }
    | undefined;
  return typeof body?.commit_sha === 'string' ? body.commit_sha : '';
}

/** A revert plus the draft marks and hidden rows only D1 knows; 409 when a file has moved since. */
export async function restore(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const sha = await undoing(request);
  if (!sha) return new Response('A commit_sha is needed to restore', { status: 400 });
  const database = ctx.db();
  const git = ctx.git();
  await commitScope('default', database, sha, true);
  // Asked before undoing: somebody may have the name open again and a restore would overwrite it.
  const about = entryKey((await git.getCommit(sha)).paths.find((p) => entryKey(p)) ?? '');
  if (about) {
    const [collection = '', slug = ''] = about.split('/');
    const held = await heldByAnother(ctx, collection, slug, session, 'restored');
    if (held) return held;
  }
  const result = await restoreCommit('default', database, git, sha, undoPath(session));
  // A draft-only language was never in the turn-off commit, so the inverse cannot put it back.
  const entry = entryKey(result.paths[0] ?? '');
  const [collection = '', slug = ''] = entry ? entry.split('/') : [];
  if (config.collections[collection]) {
    const loaded = await entryLocales(ctx, collection, slug, config.i18n.locales);
    const written = Object.entries(loaded).filter(([, l]) => l.live);
    const { offered } = entryOffer(
      'default',
      config.i18n.locales,
      (written[0]?.[1].data as { _locales?: unknown } | undefined)?._locales,
      written.map(([locale]) => locale),
    );
    const drafted = Object.entries(loaded)
      .filter(([, l]) => !l.live)
      .map(([locale]) => entryPath(collection, slug, locale));
    if (drafted.length)
      await setEntryLocales('default', database, git, drafted, offered, config.i18n.locales);
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'revert',
    // `restore` is what tells this row from a revert on screen: both are the same inverse commit.
    subject: result.paths[0] ?? null,
    detail: { of: sha, files: result.paths.length, restore: true },
    commitSha: result.commit_sha,
  });
  return Response.json({ commit_sha: result.commit_sha, paths: result.paths });
}

// redirects.yaml belongs to no collection; a global's schema is keyed by the file name.
const schemaFor = (path: string) => {
  const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
  return schemaOf(collection, slug);
};

/** A file whose structure disagrees with its other languages is not committed. */
async function driftedPaths(ctx: RequestContext, paths: string[]): Promise<string[]> {
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
    // A path nothing owns — redirects.yaml — has no schema, so no form and no structure.
    const schema = schemaOf(collection, slug);
    if (!schema) continue;
    const form = formFor(collection, slug);
    const locales = localeData(await entryLocales(ctx, collection, slug, config.i18n.locales));
    if (driftReport('default', form, locales).length) drifted.push(...files);
  }
  return drifted;
}

/** A request of its own so the pass gets its own CPU budget; nothing here refuses anything. */
export async function prepublishChecks(ctx: RequestContext, request: Request): Promise<Response> {
  const database = ctx.db();
  const body = (await request.json().catch(() => undefined)) as { entries?: unknown } | undefined;
  const chosen = Array.isArray(body?.entries)
    ? body.entries.filter((e): e is string => typeof e === 'string')
    : undefined;
  const rows = await readyDrafts('default', database, chosen);
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
            const file = await git.getFile(path);
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
  const raw = await request.text();
  let chosen: string[] | undefined;
  if (raw !== '') {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response('Invalid publish JSON', { status: 400 });
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'entries') ||
      !('entries' in body) ||
      !Array.isArray(body.entries) ||
      body.entries.some((key: unknown) => typeof key !== 'string' || !/^[\w-]+\/[\w-]+$/.test(key))
    )
      return new Response('Publish requires an array of entry keys', { status: 400 });
    chosen = [...new Set(body.entries as string[])];
  }
  // Held to the schema before anything is written, over exactly the set the commit is made of.
  const pending = await readyDrafts('default', database, chosen);
  // Who was holding what, read while the holds are still there: the publish releases them.
  const holders = chosen?.length ? await heldDrafts('default', database) : {};
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
  const drifted = await driftedPaths(
    ctx,
    pending.map((row) => row.path),
  );
  if (drifted.length) {
    return Response.json(
      {
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
      (path) => sourceOf(ctx, path),
      chosen,
      pending,
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
  // A released hold is logged as the same event the toggle writes.
  for (const entry of result?.released ?? []) {
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
  return Response.json(result ?? { paths: [] });
}

/** Capped at what the dashboard draws: the log's `detail` is small json. */
const publishedKeys = (paths: readonly string[]) =>
  [...new Set(paths.flatMap((path) => entryKey(path) ?? []))].slice(0, 8);
