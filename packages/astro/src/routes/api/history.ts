import config from 'virtual:handover/config';
import type { Answer, CommitPage, FileCommit, GitClient, I18nMark } from '@handover/core';
import {
  commitAuthors,
  diffEntry,
  entryConflict,
  entryKey,
  formOf,
  loadDraft,
  logActivity,
  mergeFileCommits,
  migrateDocument,
  parseEntry,
  renamedFrom,
  resolveConflict,
  restoreDraft,
  sourceChanges,
} from '@handover/core';
import { formSchema } from '../../index.js';
import {
  entryLocales,
  entryPath,
  entryPaths,
  entrySubject,
  formFor,
  heldByAnother,
  NAME,
  pendingLocales,
  SHA,
  schemaOf,
} from './content.js';
import type { RequestContext } from './context.js';

/** The draft against HEAD, not the commit it was loaded from: the row says what goes out next. */
export async function entryDiff(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const read = await Promise.all(
    Object.entries(entryPaths(collection, slug)).map(async ([locale, path]) => {
      const [file, row] = await Promise.all([
        git.getFile(path, head),
        loadDraft('default', database, path),
      ]);
      return file || row ? { locale, file, row } : undefined;
    }),
  );
  const found = read.filter((f) => f !== undefined);
  const parsed = (contents: string | undefined) => parseEntry('default', contents ?? '');
  return Response.json({
    groups: diffEntry(
      'default',
      formFor(collection, slug),
      Object.fromEntries(found.map((f) => [f.locale, parsed(f.file?.contents)])),
      Object.fromEntries(found.map((f) => [f.locale, parsed(f.row?.contents ?? f.file?.contents)])),
    ),
    // The redirects an address change owes ride in the same commit, so they belong in the diff.
    redirects: found
      .flatMap((f) => f.row?.pendingRedirects ?? [])
      .map(({ from, to }) => ({ from, to })),
  });
}

/** `{}` rather than a 404 when there is nothing to compare: the marker is simply not drawn. */
export async function translatedFromView(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const loaded = await entryLocales(ctx, collection, slug, config.i18n.locales);
  const mark = (loaded[locale]?.data as { _i18n?: Partial<I18nMark> } | undefined)?._i18n;
  const from = typeof mark?.sourceLocale === 'string' ? mark.sourceLocale : undefined;
  const blob = typeof mark?.sourceBlob === 'string' ? mark.sourceBlob : undefined;
  if (!from || !blob || from === locale || !(from in loaded)) return Response.json({ changed: {} });
  const was = await ctx.git().getBlob(blob);
  if (was === undefined) return Response.json({ changed: {} });
  return Response.json({
    from,
    translatedAt: typeof mark?.translatedAt === 'string' ? mark.translatedAt : undefined,
    changed: sourceChanges(
      'default',
      formFor(collection, slug),
      parseEntry('default', was),
      loaded[from]?.data,
    ),
  });
}

const HISTORY_PAGE = 30;

// How many renames back a history is followed; each is a read per page per language.
const RENAMES = 3;

// Read from the top each time: the merge across languages cuts the list below a per-path cursor.
async function commitsFor(git: GitClient, path: string, pages: number) {
  const commits: FileCommit[] = [];
  let more = false;
  for (let page = 1; page <= pages; page++) {
    const got = await git.fileCommits(path, { perPage: HISTORY_PAGE, page });
    commits.push(...got);
    more = got.length === HISTORY_PAGE;
    if (!more) break;
  }
  return { commits, more };
}

// The commits API has no `--follow`, so the rename commit's message says what the file was called.
async function commitsUnder(
  git: GitClient,
  collection: string,
  slug: string,
  locale: string,
  pages: number,
): Promise<CommitPage[]> {
  const found: CommitPage[] = [];
  let name = slug;
  for (let hop = 0; hop <= RENAMES; hop++) {
    const read = await commitsFor(git, entryPath(collection, name, locale), pages);
    found.push({ locale, ...read, ...(name !== slug ? { name } : {}) });
    const was = read.more
      ? undefined
      : renamedFrom('default', read.commits.at(-1)?.message ?? '', collection, name);
    if (!was) break;
    name = was;
  }
  return found;
}

/** Who made a version comes from the activity log, since git names the App for admin commits. */
export async function entryHistory(
  ctx: RequestContext,
  collection: string,
  slug: string,
  url: URL,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const asked = Number(url.searchParams.get('page') ?? 1);
  // Every page is one request per language file, and the Free plan allows fifty subrequests.
  const pages = Math.min(Math.max(Number.isSafeInteger(asked) ? asked : 1, 1), 10);
  const git = ctx.git();
  const read = await Promise.all(
    config.i18n.locales.map((locale) => commitsUnder(git, collection, slug, locale, pages)),
  );
  // Current name's pages first: the rename commit is in both logs and the first page met names it.
  const { versions, more } = mergeFileCommits([
    ...read.flatMap((pages) => pages.filter((p) => !p.name)),
    ...read.flatMap((pages) => pages.filter((p) => p.name)),
  ]);
  const authors = await commitAuthors(
    'default',
    ctx.db(),
    versions.map((v) => v.sha),
  );
  return Response.json({
    versions: versions.map((version) => {
      const author = authors[version.sha] ?? version.author;
      return {
        sha: version.sha,
        date: version.date,
        // The body only lists the files written, which the row's languages already say.
        summary: version.message.split('\n')[0] ?? '',
        locales: version.locales,
        ...(author ? { author } : {}),
        // A diff or restore of this version reads the files under the name they had then.
        ...(version.name ? { name: version.name } : {}),
      };
    }),
    more,
  });
}

/** `from` defaults to HEAD, so the fields marked are the ones a restore would change. */
export async function versionDiff(
  ctx: RequestContext,
  collection: string,
  slug: string,
  url: URL,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const to = url.searchParams.get('to') ?? '';
  const asked = url.searchParams.get('from');
  if (!SHA.test(to) || (asked !== null && !SHA.test(asked)))
    return Response.json({ error: 'a version is named by its commit' }, { status: 400 });
  const name = url.searchParams.get('name') ?? slug;
  const fromName = url.searchParams.get('fromName') ?? slug;
  if (!NAME.test(name) || !NAME.test(fromName))
    return Response.json({ error: 'a version is named by its commit' }, { status: 400 });
  const git = ctx.git();
  const from = asked ?? (await git.getHead());
  const [before, after] = await Promise.all([
    entryAt(git, collection, slug, from, fromName),
    entryAt(git, collection, slug, to, name),
  ]);
  return Response.json({ groups: diffEntry('default', formFor(collection, slug), before, after) });
}

// `name` is what the files were called at that commit, where a rename has moved them since.
async function entryAt(git: GitClient, collection: string, slug: string, ref: string, name = slug) {
  const read = await Promise.all(
    Object.entries(entryPaths(collection, name)).map(async ([locale, path]) => {
      const file = await git.getFile(path, ref);
      return file ? ([locale, parseEntry('default', file.contents)] as const) : undefined;
    }),
  );
  return Object.fromEntries(read.filter((f) => f !== undefined));
}

/** Read on opening a row, never with the page: fifty publishes would be a hundred git reads. */
export async function activityDiff(
  ctx: RequestContext,
  url: URL,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  const sha = url.searchParams.get('sha') ?? '';
  if (!SHA.test(sha))
    return Response.json({ error: 'a publish is named by its commit' }, { status: 400 });
  const git = ctx.git();
  const commit = await git.getCommit(sha);
  const keys = [...new Set(commit.paths.flatMap((path) => entryKey(path) ?? []))].filter((key) => {
    const [collection = '', slug = ''] = key.split('/');
    return schemaOf(collection, slug) !== undefined;
  });
  // Each entry is two reads per language, and a request on the Free plan has fifty subrequests.
  const shown = keys.slice(0, 8);
  const entries = await Promise.all(
    shown.map(async (key) => {
      const [collection = '', slug = ''] = key.split('/');
      const [before, after] = await Promise.all([
        // A root commit was made on nothing, so everything in it is new.
        commit.parent ? entryAt(git, collection, slug, commit.parent) : {},
        entryAt(git, collection, slug, sha),
      ]);
      return { key, groups: diffEntry('default', formFor(collection, slug), before, after) };
    }),
  );
  return Response.json({ entries, more: keys.length - shown.length });
}

/** Never a rewrite of git: the version goes into the draft rows and publishes forward. */
export async function restoreVersion(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as
    | { commit_sha?: unknown; name?: unknown }
    | undefined;
  const sha = typeof body?.commit_sha === 'string' ? body.commit_sha : '';
  if (!SHA.test(sha)) return new Response('A commit_sha is needed to restore', { status: 400 });
  // Read under the name the files had then, written under the current one: a restore never renames.
  const name = typeof body?.name === 'string' ? body.name : slug;
  if (!NAME.test(name)) return new Response('That is not a name this entry had', { status: 400 });
  const held = await heldByAnother(ctx, collection, slug, session, 'restored');
  if (held) return held;
  const git = ctx.git();
  const read = await Promise.all(
    config.i18n.locales.map(async (locale) => {
      const file = await git.getFile(entryPath(collection, name, locale), sha);
      const entry = file ? parseEntry('default', file.contents) : undefined;
      // An empty file at that commit parses to nothing, which is not a version of anything.
      return entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { path: entryPath(collection, slug, locale), entry: entry as Record<string, unknown> }
        : undefined;
    }),
  );
  const found = read.filter((f) => f !== undefined);
  if (!found.length) return new Response('That version has no file of this entry', { status: 409 });
  let files: typeof found;
  try {
    files = found.map((f) => ({ ...f, entry: migrateDocument('default', f.entry) }));
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'That version cannot be read', {
      status: 409,
    });
  }
  // The whole form, `slug` included: `formFor` strips the address but the file writes it.
  const form = formOf('default', formSchema(schema));
  const database = ctx.db();
  const pending = await pendingLocales(collection, slug, database);
  const { paths } = await restoreDraft('default', database, git, form, files, session?.user.id);
  // A closed draft goes with this write unrefused, so the log says whose words were put over.
  const went = pending.filter((locale) => paths.includes(entryPath(collection, slug, locale)));
  if (went.length)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'draft-discard',
      subject: await entrySubject(ctx, collection, slug),
      detail: { locales: went, restore: sha },
    });
  return Response.json({ paths });
}

/** 409 when nothing has moved in the repository: the conflict is already settled. */
export async function conflictView(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const found = await entryConflict(
    'default',
    ctx.db(),
    ctx.git(),
    formFor(collection, slug),
    entryPaths(collection, slug),
  );
  if (!found) return new Response(SETTLED, { status: 409 });
  return Response.json({
    head: found.head,
    version: found.version,
    questions: found.questions,
    merged: found.merged,
    files: Object.values(found.conflicted).map((c) => c.path),
  });
}

const SETTLED = 'This entry has not changed in the repository since it was opened';

/** All questions answered or none: a half-answered entry would silently take HEAD's values. */
export async function resolve(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as
    | { answers?: unknown; version?: unknown }
    | undefined;
  const answers = (Array.isArray(body?.answers) ? body.answers : []).filter(
    (answer): answer is Answer =>
      typeof answer?.path === 'string' &&
      (answer.side === 'ours' || answer.side === 'theirs') &&
      (answer.locale === undefined || typeof answer.locale === 'string'),
  );
  const form = formFor(collection, slug);
  const found = await entryConflict(
    'default',
    ctx.db(),
    ctx.git(),
    form,
    entryPaths(collection, slug),
  );
  if (!found) return new Response(SETTLED, { status: 409 });
  if (!found.version || body?.version !== found.version)
    return new Response('This conflict changed. Reload it and review the new values.', {
      status: 409,
    });
  const answering = (question: { path: string; locale?: string }) =>
    answers.filter((a) => a.path === question.path && (a.locale ?? '') === (question.locale ?? ''));
  if (
    answers.length !== found.questions.length ||
    found.questions.some((q) => answering(q).length !== 1)
  )
    return new Response('Those are not the fields this entry disagrees about', { status: 409 });
  await resolveConflict('default', ctx.db(), form, found, answers);
  return Response.json({});
}
