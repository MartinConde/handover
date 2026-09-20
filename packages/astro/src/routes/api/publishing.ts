import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type { CheckEntry, ContentIndex, Draft, SeoDefaultsValue } from '@handover/core';
import {
  beginOperation,
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
  entrySource,
  finalizeOperation,
  heldDrafts,
  lastCommit,
  lastHiddenLong,
  logActivity,
  markOperationCommitted,
  OperationFinalizationError,
  parseEntry,
  pendingDrafts,
  publishDrafts,
  type RedirectRule,
  RefMovedError,
  readRedirects,
  readyDrafts,
  recentOperations,
  recoverOperationCommit,
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
  publishSources,
  schemaOf,
  sitePages,
  siteSeoDefaults,
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

const ruleDetail = (value: unknown): RedirectRule | undefined => {
  if (!value || typeof value !== 'object' || !('rule' in value)) return undefined;
  const rule = value.rule;
  return rule && typeof rule === 'object' && '_id' in rule ? (rule as RedirectRule) : undefined;
};

const sameTypedRule = (
  rule: RedirectRule | undefined,
  typed: { from: string; to: string; status: 301 | 302 },
) => rule?.from === typed.from && rule.to === typed.to && rule.status === typed.status;

/** Committed on add: a rule with no entry to ride on has nowhere to wait for a publish. */
export async function addRedirect(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const typed = await typedRule(request);
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-added')).find(
    (operation) => {
      const rule = ruleDetail(operation.detail);
      return (
        sameTypedRule(rule, typed) &&
        (operation.state !== 'finalized' ||
          current.some(
            (candidate) => candidate._id === rule?._id && sameTypedRule(candidate, typed),
          ))
      );
    },
  );
  const baseSha = prior?.baseSha ?? head;
  const [rules, entries] = await Promise.all([
    prior ? readRedirects('default', git, baseSha) : current,
    pickable(ctx),
  ]);
  const bad = redirectError('default', typed, {
    pages: sitePages(entries),
    rules,
    base: config.i18n.base,
  });
  if (bad) return Response.json(bad, { status: 422 });
  const typed_ =
    ruleDetail(prior?.detail) ??
    redirectRule('default', { ...typed, reason: 'manual' }, Date.now());
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-added:${baseSha}:${typed_.from}:${typed_.to}:${typed_.status}`,
      kind: 'redirect-added',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: typed_._id,
      detail: { rule: typed_ },
    }));
  const completed = operation.result as { commit_sha?: unknown; rule?: unknown } | null;
  if (operation.state === 'finalized' && completed?.rule)
    return Response.json({ rule: completed.rule });
  // Read back from the file: a destination that already forwarded is collapsed onto its target.
  let rule = typed_;
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Add redirect ${rule.from}`,
      (all) => {
        const written = collapseRedirects(all, [typed_]);
        rule = written.find((candidate) => candidate._id === typed_._id) ?? typed_;
        return written;
      },
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  } else {
    rule =
      (await readRedirects('default', git, commit_sha)).find(
        (candidate) => candidate._id === typed_._id,
      ) ?? typed_;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha, rule });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
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
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-changed')).find(
    (operation) =>
      operation.subject === id &&
      sameTypedRule(ruleDetail(operation.detail), typed) &&
      (operation.state !== 'finalized' ||
        current.some((rule) => rule._id === id && sameTypedRule(rule, typed))),
  );
  const baseSha = prior?.baseSha ?? head;
  const [rules, entries] = await Promise.all([
    prior ? readRedirects('default', git, baseSha) : current,
    pickable(ctx),
  ]);
  const found = rules.find((rule) => rule._id === id);
  if (!found)
    return Response.json({ code: 'REDIRECT_NOT_FOUND', error: 'Not found' }, { status: 404 });
  if (found.reason === 'hidden')
    return Response.json({ code: 'REDIRECT_MANAGED', error: MANAGED }, { status: 409 });
  const bad = redirectError(
    'default',
    typed,
    { pages: sitePages(entries), rules, base: config.i18n.base },
    id,
  );
  if (bad) return Response.json(bad, { status: 422 });
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-changed:${baseSha}:${id}:${typed.from}:${typed.to}:${typed.status}`,
      kind: 'redirect-changed',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: id,
      detail: { rule: { ...found, ...typed } },
    }));
  if (operation.state === 'finalized') return Response.json({});
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Edit redirect ${found.from}`,
      (all) => collapseRedirects(all, [{ ...found, ...typed }]),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
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
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-deleted')).find(
    (operation) =>
      operation.subject === id &&
      (operation.state !== 'finalized' || !current.some((rule) => rule._id === id)),
  );
  if (prior?.state === 'finalized') return Response.json({ deleted: id });
  const baseSha = prior?.baseSha ?? head;
  const rules = prior ? await readRedirects('default', git, baseSha) : current;
  const found = rules.find((rule) => rule._id === id);
  if (!found)
    return Response.json({ code: 'REDIRECT_NOT_FOUND', error: 'Not found' }, { status: 404 });
  if (found.reason === 'hidden')
    return Response.json({ code: 'REDIRECT_MANAGED', error: MANAGED }, { status: 409 });
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-deleted:${baseSha}:${id}`,
      kind: 'redirect-deleted',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: id,
      detail: { rule: found },
    }));
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Delete redirect ${found.from}`,
      (all) => all.filter((rule) => rule._id !== id),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
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
  const { deployed_sha, ...visible } = status;
  // Reconcile against what is serving, even while a newer build is running or has failed.
  if (deployed_sha) await clearPublished('default', database, deployed_sha, ctx.git());
  // `committed_at` only while the answer is about our commit, or the pill counts from another.
  return Response.json(
    last && visible.commit_sha ? { ...visible, committed_at: last.at } : visible,
  );
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
  const result = await revertCommit('default', database, ctx.git(), sha, undoPath(session), false, {
    userId: session?.user.id,
  });
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
  const result = await restoreCommit('default', database, git, sha, undoPath(session), {
    userId: session?.user.id,
  });
  // A draft-only language was never in the turn-off commit, so the inverse cannot put it back.
  const entry = entryKey(result.paths[0] ?? '');
  const [collection = '', slug = ''] = entry ? entry.split('/') : [];
  try {
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
    if (result.operation_id) await finalizeOperation('default', database, result.operation_id);
  } catch (cause) {
    if (result.operation_id)
      throw new OperationFinalizationError(result.operation_id, result.commit_sha, { cause });
    throw cause;
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

const refused = (status: number, code: string, error: string, paths?: string[]) =>
  Response.json(
    { code, error, ...(paths ? { paths } : {}) },
    { status, headers: { 'x-handover-error-code': code } },
  );

const ENTRY_KEY = /^[\w-]+\/[\w-]+$/;
const EXCLUSION = /^([\w-]+\/[\w-]+):([\w-]+)$/;

/** Both publish routes take this; only an empty body means everything. */
function selection(raw: string): { chosen?: string[]; without: string[] } | Response {
  if (raw === '') return { without: [] };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refused(400, 'PUBLISH_SELECTION_INVALID', 'Invalid publish JSON');
  }
  const named = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  if (
    !named ||
    Object.keys(named).some((key) => key !== 'entries' && key !== 'without') ||
    !('entries' in named) ||
    !Array.isArray(named.entries) ||
    named.entries.some((key: unknown) => typeof key !== 'string' || !ENTRY_KEY.test(key))
  )
    return refused(400, 'PUBLISH_SELECTION_INVALID', 'Publish requires an array of entry keys');
  const chosen = [...new Set(named.entries as string[])];
  const without = 'without' in named ? named.without : [];
  const bad = (item: unknown) => {
    const [, key = '', locale = ''] = (typeof item === 'string' && EXCLUSION.exec(item)) || [];
    return !chosen.includes(key) || !config.i18n.locales.includes(locale);
  };
  if (!Array.isArray(without) || without.some(bad))
    return refused(
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
async function resolveSelection(ctx: RequestContext, raw: string, readiness = false) {
  const asked = selection(raw);
  if (asked instanceof Response) return asked;
  const { chosen, without } = asked;
  const pending = await readyDrafts('default', ctx.db(), chosen);
  const left = new Set(without.map(draftPath));
  const missing = [...left].filter((path) => !pending.some((row) => row.path === path));
  if (missing.length)
    return refused(
      400,
      'PUBLISH_EXCLUDE_NOT_PENDING',
      `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no unpublished changes to leave out`,
      missing,
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
      return refused(
        422,
        'PUBLISH_EXCLUDE_PUBLISHED',
        `${draftPath(item)} is already published; its languages publish together`,
        [draftPath(item)],
      );
    if (why === 'source')
      return refused(
        422,
        'PUBLISH_EXCLUDE_SOURCE',
        `${draftPath(item)} is the language the entry is written in and publishes with it`,
        [draftPath(item)],
      );
  }
  const retained = pending.filter((row) => !left.has(row.path));
  if (left.size && !retained.length)
    return refused(400, 'PUBLISH_EXCLUDE_ALL', 'Leaving these files out leaves nothing to publish');
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
  const resolved = await resolveSelection(ctx, await request.text(), true);
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
  const resolved = await resolveSelection(ctx, await request.text());
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
    return Response.json(
      {
        code: 'PUBLISH_SOURCE_UNRESOLVED',
        error: `${unresolved.join(', ')} belong to entries whose files disagree about the language they are written in — make their _source agree in the repository`,
        paths: unresolved,
      },
      { status: 409, headers: { 'x-handover-error-code': 'PUBLISH_SOURCE_UNRESOLVED' } },
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
