import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { CheckEntry, ContentIndex, SeoDefaultsValue } from '@handover/core';
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
  publishDrafts,
  RefMovedError,
  runChecks,
} from '@handover/core';
import {
  ENTRY_FILE,
  entryLocales,
  entryPath,
  entrySubject,
  formFor,
  localeData,
  publishSources,
  schemaOf,
  siteSeoDefaults,
} from '../../content.js';
import type { RequestContext } from '../../environment.js';
import { mediaStore, workerBuilds } from '../../environment.js';
import { problemsOf, resolveSelection, whyKept } from './publish-selection.js';
import { codedError } from './respond.js';

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
  // Reconcile against what is serving, even while a newer build is running or has failed.
  if (status.deployedSha) await clearPublished('default', database, status.deployedSha, ctx.git());
  const visible = {
    ...(status.commitSha ? { commit_sha: status.commitSha } : {}),
    state: status.state,
    ...(status.startedAt ? { started_at: status.startedAt } : {}),
    ...(status.liveAt ? { live_at: status.liveAt } : {}),
  };
  // `committed_at` only while the answer is about our commit, or the pill counts from another.
  return Response.json(last && status.commitSha ? { ...visible, committed_at: last.at } : visible);
}

// A file whose structure disagrees with its other languages is not committed.
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
    const source = entrySource(config.i18n, locales);
    if (source && 'problem' in source) unresolved.push(...files);
    else if (driftReport(form, locales).length) drifted.push(...files);
  }
  return { drifted, unresolved };
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
      collectionEntries(index, name, overlay, config.collections[name]?.titleField),
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
    return codedError(
      422,
      'PUBLISH_INCOMPLETE',
      paths.length === 1
        ? `${paths[0]} is missing something the schema needs`
        : `${paths.length} files are missing something the schema needs — ${paths.join(', ')}`,
      { paths },
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
    return codedError(
      409,
      'PUBLISH_DRIFT',
      drifted.length === 1
        ? `${drifted[0]} has drifted apart from the entry's other languages — resolve it in the editor`
        : `${drifted.length} files have drifted apart from their entries' other languages — ${drifted.join(', ')}`,
      {
        paths: drifted, // Which 409 this is: a conflict's way out is Discard, drift's is the editor.
        reason: 'drift',
      },
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
  if (result?.commitSha) {
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
      commitSha: result.commitSha,
    });
  }
  return Response.json(
    result
      ? {
          commit_sha: result.commitSha,
          paths: result.paths,
          released: excluded.length ? released : result.released,
        }
      : { paths: [] },
  );
}

// Capped at what the dashboard draws: the log's `detail` is small json.
const publishedKeys = (paths: readonly string[]) =>
  [...new Set(paths.flatMap((path) => entryKey(path) ?? []))].slice(0, 8);
