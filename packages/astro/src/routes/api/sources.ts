import config from 'virtual:handover/config';
import type { ContentFile, Operation } from '@handover/core';
import {
  beginOperation,
  blobSha,
  draftFiles,
  entryParts,
  entrySource,
  finalizeOperation,
  findOperation,
  lockHolders,
  logActivity,
  markOperationCommitted,
  OperationFinalizationError,
  operationMessage,
  parseEntry,
  provenance,
  recentOperations,
  recordSource,
  recoverOperationCommit,
  stringifyEntry,
  withSource,
} from '@handover/core';
import { entryHref, entryPath, formFor } from './content.js';
import type { RequestContext } from './context.js';
import { entryTitles } from './entries.js';

const KIND = 'sources-recorded';

interface Unrecorded {
  key: string;
  source: string;
  /** Every language with an effective file, in configured order. */
  locales: string[];
  drafts: boolean;
  /** Translations whose mark still names another language once the source is recorded. */
  stale: { locale: string; from: string }[];
  /** The repository files this commit writes, as they were and as they will be. */
  files: { path: string; was: string; contents: string }[];
}

type Data = Record<string, unknown>;
const asData = (contents: string): Data => {
  const data = parseEntry('default', contents);
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Data) : {};
};
// Only a complete mark is judged stale, as in core's `staleLocales`.
const namedSource = (data: Data | undefined) => {
  const mark = data?._i18n as Record<string, unknown> | undefined;
  return mark &&
    ['sourceLocale', 'sourceBlob', 'sourceHash', 'translatedAt'].every(
      (key) => typeof mark[key] === 'string',
    )
    ? (mark.sourceLocale as string)
    : undefined;
};
const withMark = (data: Data, mark: unknown): Data => {
  const { _i18n, ...rest } = data;
  return mark === undefined ? rest : { ...data, _i18n: mark };
};

const known = (collection: string, slug: string) =>
  collection === 'globals' ? Boolean(config.globals?.[slug]) : collection in config.collections;

/** What recording would write: the rule-6 answer of every unmarked entry with two or more files. */
async function unrecorded(
  published: readonly ContentFile[],
  drafted: readonly ContentFile[],
): Promise<Unrecorded[]> {
  const { locales } = config.i18n;
  if (locales.length < 2) return [];
  const byEntry = new Map<
    string,
    { published: Record<string, string>; drafted: Record<string, string> }
  >();
  const collect = (rows: readonly ContentFile[], side: 'published' | 'drafted') => {
    for (const { path, contents } of rows) {
      const parts = entryParts(path);
      if (!parts || !locales.includes(parts.locale) || !known(parts.collection, parts.name))
        continue;
      const key = `${parts.collection}/${parts.name}`;
      const found = byEntry.get(key) ?? { published: {}, drafted: {} };
      found[side][parts.locale] = contents;
      byEntry.set(key, found);
    }
  };
  collect(published, 'published');
  collect(drafted, 'drafted');
  const at = new Date().toISOString();
  const found: Unrecorded[] = [];
  for (const [key, entry] of [...byEntry].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [collection = '', slug = ''] = key.split('/');
    // A draft row with no bytes is a deletion, so its language has no effective file.
    const present = locales.filter((l) =>
      l in entry.drafted ? entry.drafted[l] !== '' : l in entry.published,
    );
    const effective = Object.fromEntries(
      present.map((l) => [l, asData(entry.drafted[l] || entry.published[l] || '')]),
    );
    const answer = entrySource('default', config.i18n, effective);
    if (present.length < 2 || !answer || 'problem' in answer || answer.recorded) continue;
    const source = answer.locale;
    // A source that is only a draft is recorded when it publishes, or the commit would name a missing file.
    if (!(source in entry.published)) continue;
    const committed = present.filter((l) => l in entry.published);
    const data = Object.fromEntries(committed.map((l) => [l, asData(entry.published[l] ?? '')]));
    const stamped = stringifyEntry('default', withSource('default', data[source], source));
    const blob = await blobSha(stamped);
    const form = formFor(collection, slug);
    const marks: Record<string, unknown> = {};
    const others = committed.filter((l) => l !== source);
    for (const from of new Set(others.map((l) => namedSource(data[l])))) {
      if (!from || from === source) continue;
      const out = await provenance('default', form, data, { from, to: source, blob, at });
      for (const l of others) if (namedSource(data[l]) === from) marks[l] = out[l];
    }
    const next = Object.fromEntries(
      committed.map((l) => [l, l in marks ? withMark(data[l] ?? {}, marks[l]) : data[l]]),
    );
    // What each language reads after `recordSource` moved its draft: see the rule there.
    const after = (l: string) => {
      const draft = entry.drafted[l];
      if (!draft) return next[l];
      const own = asData(draft);
      return l in data && JSON.stringify(own._i18n) === JSON.stringify(data[l]?._i18n)
        ? next[l]
        : own;
    };
    const stale = present.flatMap((l) => {
      const from = l === source ? undefined : namedSource(after(l));
      return from && from !== source ? [{ locale: l, from }] : [];
    });
    found.push({
      key,
      source,
      locales: present,
      drafts: present.some((l) => entry.drafted[l]),
      stale,
      files: committed.map((l) => ({
        path: entryPath(collection, slug, l),
        was: entry.published[l] ?? '',
        contents:
          l === source
            ? stamped
            : stringifyEntry('default', withSource('default', next[l], source)),
      })),
    });
  }
  return found;
}

/** Owner only: it commits, and it is the upgrade step of the site, not an editor's task. */
export async function sourcesList(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const database = ctx.db();
  // One head for the read and the answer, so the POST compares what the dialog showed.
  const base = await ctx.git().getHead();
  const [published, drafted] = await Promise.all([
    ctx.git().contentFiles(base),
    draftFiles('default', database),
  ]);
  const found = await unrecorded(published, drafted);
  const titles = entryTitles(
    found.map((entry) => entry.key),
    drafted,
  );
  return Response.json({
    base,
    entries: found.map(({ key, source, locales, drafts, stale }) => ({
      key,
      collection: key.split('/')[0],
      title: titles.get(key) || key.split('/')[1],
      href: entryHref(key),
      source,
      locales,
      drafts,
      stale,
    })),
  });
}

const changed = () =>
  Response.json(
    {
      code: 'SOURCES_CHANGED',
      error: 'The repository changed while this was open. Nothing was recorded — review it again.',
    },
    { status: 409 },
  );

export async function recordSources(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const body = (await request.json().catch(() => undefined)) as { base?: unknown } | undefined;
  if (typeof body?.base !== 'string' || !body.base)
    return new Response('Bad request', { status: 400 });
  const database = ctx.db();
  const git = ctx.git();
  const retryKey = `${KIND}:${body.base}`;
  const existing = await findOperation('default', database, retryKey);
  if (existing?.state === 'finalized') return Response.json(existing.result);
  if (existing) {
    // Throws when the base moved and no commit of this operation is found: nothing was written.
    const commitSha = await recoverOperationCommit('default', database, git, existing);
    if (commitSha) return finish(ctx, { ...existing, commitSha }, session);
  } else {
    // A record whose drafts were not moved yet is finished first, whatever base this one read.
    const unfinished = (await recentOperations('default', database, KIND)).find(
      (op) => op.state === 'committed',
    );
    if (unfinished) return finish(ctx, unfinished, session);
  }
  if ((await git.getHead()) !== body.base) return changed();
  const [published, drafted] = await Promise.all([
    git.contentFiles(body.base),
    draftFiles('default', database),
  ]);
  const found = await unrecorded(published, drafted);
  if (!found.length) return Response.json({ entries: 0, stale: 0, sources: {} });
  const holders = await lockHolders('default', database);
  const held = found.flatMap(({ key }) => {
    const holder = holders[key];
    return holder && holder.id !== session.user.id ? [{ key, name: holder.name }] : [];
  });
  if (held.length)
    return Response.json(
      {
        code: 'SOURCES_LOCKED',
        error: `${held.map((h) => h.name ?? 'Somebody else').join(', ')} ${held.length === 1 ? 'is' : 'are'} editing an entry this would record. Nothing was recorded — try again once they are done.`,
        held,
      },
      { status: 409 },
    );
  const sources: Record<string, number> = {};
  for (const { source } of found) sources[source] = (sources[source] ?? 0) + 1;
  const detail: Detail = {
    entries: found.length,
    stale: found.reduce((sum, entry) => sum + entry.stale.length, 0),
    sources,
    recorded: found.map(({ key, source }) => ({ key, source })),
  };
  const files = found.flatMap((entry) => entry.files);
  const operation =
    existing ??
    (await beginOperation('default', database, {
      retryKey,
      kind: KIND,
      paths: files.map((file) => file.path),
      baseSha: body.base,
      userId: session.user.id,
      detail,
    }));
  const { commit_sha } = await git.publish(
    files.map(({ path, contents }) => ({ path, contents })),
    {
      base_sha: body.base,
      message: operationMessage(
        `Record source languages for ${found.length} ${found.length === 1 ? 'entry' : 'entries'}`,
        operation.id,
      ),
    },
  );
  await markOperationCommitted('default', database, operation.id, commit_sha, {
    commit_sha,
    ...summary(detail),
  });
  return finish(
    ctx,
    { ...operation, commitSha: commit_sha, detail },
    session,
    new Map(files.map((file) => [file.path, file])),
  );
}

type Detail = {
  entries: number;
  stale: number;
  sources: Record<string, number>;
  recorded: { key: string; source: string }[];
};
const summary = ({ entries, stale, sources }: Detail) => ({ entries, stale, sources });

/** Moves each open draft onto the commit; a retry reads both sides of it from the repository. */
async function finish(
  ctx: RequestContext,
  operation: Operation,
  session: App.Locals['handover'],
  known?: Map<string, { was: string; contents: string }>,
): Promise<Response> {
  const database = ctx.db();
  const git = ctx.git();
  const commit_sha = operation.commitSha ?? '';
  const detail = operation.detail as Detail;
  const result = { commit_sha, ...summary(detail) };
  try {
    let sides = known;
    if (!sides) {
      const [before, after] = await Promise.all([
        git.contentFiles(operation.baseSha),
        git.contentFiles(commit_sha),
      ]);
      const was = new Map(before.map((file) => [file.path, file.contents]));
      sides = new Map(
        after
          .filter((file) => operation.paths.includes(file.path))
          .map((file) => [file.path, { was: was.get(file.path) ?? '', contents: file.contents }]),
      );
    }
    for (const { key, source } of detail.recorded) {
      const [collection = '', slug = ''] = key.split('/');
      for (const locale of config.i18n.locales) {
        const path = entryPath(collection, slug, locale);
        const side = sides.get(path);
        await recordSource(
          'default',
          database,
          path,
          source,
          side && { sha: commit_sha, was: side.was, contents: side.contents },
        );
      }
    }
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: KIND,
    detail: summary(detail),
    commitSha: commit_sha,
  });
  return Response.json(result);
}
