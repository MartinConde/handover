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

/**
 * The redirects table: the file's rules in the order the file has them — which is the order
 * `_redirects` serves them in — and after them the rules waiting on an entry's draft, flagged.
 * Those are the only unpublished ones there are: a rule the client adds here is committed as
 * it is added, since `redirects.yaml` never gets a draft row of its own.
 */
export async function redirectList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [committed, waiting, entries] = await Promise.all([
    readRedirects('default', ctx.git()),
    pendingDrafts('default', database),
    pickable(ctx),
  ]);
  const titles = new Map(entries.map((e) => [e.path, e.title || e.path]));
  // One hide owes a rule per language and writes each on that language's row, so the same rule
  // is never on two rows — but a row read twice would still double it.
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

/** `from`, `to` and how permanent it is, as the dialog sends them. */
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

/**
 * A rule the client writes by hand. It is committed as it is added rather than waiting in the
 * drawer: the file is assembled at publish out of the rules of the *selected* entries
 * ([drafts-and-publishing.md](../../../../docs/features/drafts-and-publishing.md)), so a rule
 * with no entry to ride on has nowhere to wait. The same is true of a rename and a delete.
 */
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
  // As the file has it: a destination that already forwarded lands where that forwards.
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

/** One rule rewritten. A hidden entry's is refused here for the reason it is refused a delete. */
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

/**
 * One rule taken out. Deleting a redirect is allowed — it is a rule and not the client's
 * content — and the dialog warns about a young one rather than refusing it. The one refusal is
 * the entry's own rule: unhiding removes it in the same commit, so taking it out from here
 * would leave the pair inconsistent and the rule would come back at the next publish.
 */
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

/**
 * Where the last commit the admin made has got to. **The state is the server's**, read from the
 * activity log rather than kept in the drawer: a publish redeploys the Worker serving `/admin`,
 * so the tab that pressed Publish may be reloaded before the build finishes and whatever it was
 * holding would go with it. Every screen asks this and gets the same answer.
 *
 * `{}` where the site has no token — the pill is not drawn at all rather than drawn as an
 * unknown, since a site without build status is an ordinary site. A site that has **published
 * nothing yet** does get an answer, from the worker's newest build: there is no commit of ours to
 * ask about, but the site is still serving something and a blank top bar is the wrong reading of
 * it. That answer carries no `commit_sha`, so nothing offers to revert a developer's own deploy.
 */
export async function buildStatus(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const last = await lastCommit('default', database);
  const builds = workerBuilds();
  if (!builds) return Response.json({});
  let status: Awaited<ReturnType<typeof commitBuild>>;
  try {
    status = await commitBuild(builds, last);
  } catch (err) {
    // A token that cannot ask is the site's configuration, not a state the site is in. It is
    // said once in the log the deploy reads and answered as no pill at all.
    console.error('build status: the Workers Builds API could not be asked', err);
    return Response.json({});
  }
  // Rule 3 of "your own publish must not look like a conflict" runs here, because this is the
  // one moment the Worker learns the build went green: the rows go once nobody is in the entry.
  if (last && status.state === 'live' && status.commit_sha === last.sha)
    await clearPublished('default', database, last.sha);
  // Only where the answer is still about that commit: `committed_at` is what the pill counts
  // from, and hanging it on the worker's newest build is a counter running from another commit.
  return Response.json(last && status.commit_sha ? { ...status, committed_at: last.at } : status);
}

/**
 * One commit undone. `commit_sha` is the body's, so this works over any commit the admin made
 * and not only the last one; `409` with `{ error, paths }` when one of its files has moved on
 * since, which is the one thing an inverse composed against HEAD cannot decide on its own.
 */
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

/** Which commit the body names, or the empty string. Both undo routes read the same one key. */
async function undoing(request: Request): Promise<string> {
  const body = (await request.json().catch(() => undefined)) as
    | { commit_sha?: unknown }
    | undefined;
  return typeof body?.commit_sha === 'string' ? body.commit_sha : '';
}

/**
 * A delete undone, over the commit the log recorded it with. The same inverse a revert is, plus
 * what only D1 knows: the marks a turn-off wrote into the open drafts of the files that stayed,
 * and the rows that were keeping the restored paths off the entry list.
 *
 * `409` with `{ error, paths }` when a file the restore would write has moved since — a name
 * somebody has taken again, or an entry already put back — because writing over it would be
 * undoing somebody else's work in the name of undoing your own.
 */
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
  // Which entry the commit took away, asked before anything is undone: somebody may have it open
  // again under the same name, and a restore would write over what they are typing.
  const about = entryKey((await git.getCommit(sha)).paths.find((p) => entryKey(p)) ?? '');
  if (about) {
    const [collection = '', slug = ''] = about.split('/');
    const held = await heldByAnother(ctx, collection, slug, session, 'restored');
    if (held) return held;
  }
  const result = await restoreCommit('default', database, git, sha, undoPath(session));
  // A language that stays with only a draft behind it was never in the turn-off commit — the
  // mark went into its row rather than into a file — so the inverse commit cannot put it back.
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
    // What was put back, and which the log's own row it undoes. `restore` is what tells the
    // two apart on screen: both are the same inverse commit.
    subject: result.paths[0] ?? null,
    detail: { of: sha, files: result.paths.length, restore: true },
    commitSha: result.commit_sha,
  });
  return Response.json({ commit_sha: result.commit_sha, paths: result.paths });
}

// `src/content/<collection>/<locale>/<slug>.yaml`. redirects.yaml belongs to no collection and
// has no schema to be held to; a global's is its own, keyed by the file name.
const schemaFor = (path: string) => {
  const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
  return schemaOf(collection, slug);
};

/**
 * Which of these files belong to an entry whose languages have drifted apart. The one refusal
 * besides the schema: the structure is shared, so committing a file that disagrees with its
 * other languages would bake the difference into git, and which side is right is a decision
 * somebody makes. A site with one language never has a second file to disagree with.
 */
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

/**
 * The lint the drawer runs over the set it is about to commit: the entries the body names, or
 * everything pending that is not on hold — the same body and the same set `POST
 * /admin/api/publish` reads.
 *
 * **A request of its own on purpose.** The pass then has its own ten milliseconds of CPU, so a
 * publish too heavily cross-linked to read in one go costs a check result and never the commit;
 * and nothing here refuses anything, since the drawer's Publish button and the entry header's
 * dialog are where an error stops somebody ([pre-publish-checks.md](../../../docs/pending-changes.md)).
 */
export async function prepublishChecks(ctx: RequestContext, request: Request): Promise<Response> {
  const database = ctx.db();
  const body = (await request.json().catch(() => undefined)) as { entries?: unknown } | undefined;
  const chosen = Array.isArray(body?.entries)
    ? body.entries.filter((e): e is string => typeof e === 'string')
    : undefined;
  const rows = await readyDrafts('default', database, chosen);
  // The built index with **these** drafts over it and no others: what a link is checked against
  // is the site as this publish would leave it, and a draft nobody selected is not going out.
  // Overlaying the rest would call a link to a page only an unselected draft creates good.
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
    // A file this publish removes is not a file to lint; the overlay above has already taken
    // the page it was off the index.
    if (!collection || !row.contents || !schemaOf(collection, slug)) continue;
    const files = going.get(`${collection}/${slug}`) ?? {};
    files[locale] = row.contents;
    going.set(`${collection}/${slug}`, files);
  }
  const git = ctx.git();
  const entries: CheckEntry[] = await Promise.all(
    [...going].map(async ([key, drafted]) => {
      const [collection = '', slug = ''] = key.split('/');
      // The languages this publish is not committing are read from the repository: a
      // translation is judged stale against the file it was made from, which is often one of
      // them, and a file that is not going out is never reported on.
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
  // Named by the entry as well as by the file: the drawer lists entries, and which of an
  // entry's languages a result is about is the file it carries.
  return Response.json({
    results: results.map((result) => ({ ...result, entry: entryKey(result.path) ?? result.path })),
  });
}

/**
 * One commit, of every draft that differs from the repository or of the entries the body names.
 * The rows it committed are re-seeded on it rather than deleted, so an editor who carries on
 * typing is measured against what was published and not against whatever HEAD is by then.
 *
 * The schema decides here rather than at every keystroke, so a blank new entry cannot commit
 * a file the site's own content schema rejects and break the build behind it. The captured
 * rows are passed to publishDrafts, so validation and the commit use the same versions.
 */
export async function publish(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const database = ctx.db();
  // Only a genuinely empty body means all. A malformed selection must never widen scope.
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
  // The same set the commit will be made of, held to the schema before anything is written: an
  // entry nobody chose is not in this commit, so it is not this commit's job to hold it to the
  // schema either — and a held entry that *was* chosen is, since it is going out.
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
        // Which 409 this is: the drawer's way out of a conflict is Discard, and this one's is
        // the editor.
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
    // A publish the repository refused is somebody else's work getting in the way of this one —
    // the file that moved, or the branch that did — and that is what an owner reads the log for.
    // A schema or a drift refusal is not: it is the state of this person's own drafts, and it is
    // answered to them in the same response.
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
  // A hold this publish went through is released, and that is the half the person who set it
  // would want to read about afterwards — the same event the toggle writes.
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
  // Only a commit is an event. A Publish click with nothing pending is not one, and spending a
  // D1 write on it is how one busy editor costs a site its day's budget.
  if (result?.commit_sha) {
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'publish',
      // One file is an entry somebody can open; a batch is the commit, and the paths are not
      // small json — the entries are, and they are what the dashboard reads back. The draft
      // rows go once the build is live, so this row is the only record that a published entry
      // was ever edited.
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

/**
 * The entries a publish carried, for the row recording it. Capped at what the dashboard draws:
 * a publish of two hundred pages is one commit, and the log's `detail` is small json.
 */
const publishedKeys = (paths: readonly string[]) =>
  [...new Set(paths.flatMap((path) => entryKey(path) ?? []))].slice(0, 8);
