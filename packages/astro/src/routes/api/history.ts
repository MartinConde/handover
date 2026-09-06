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

/**
 * What one entry would put in the next commit, field by field: the drawer's expanded row. The
 * draft against the file at HEAD and not against the commit it was loaded from — the question
 * the row answers is what is about to go out, which is measured against what is there now.
 */
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
    // The rules an address change owes ride in the same commit, so they belong in the diff and
    // not in the list: a consequence of this entry, not a file anybody chose.
    redirects: found
      .flatMap((f) => f.row?.pendingRedirects ?? [])
      .map(({ from, to }) => ({ from, to })),
  });
}

/**
 * What one language's source has said since it was translated, field by field — the amber marker
 * a target-language field carries beside its label, and the before/after opening it shows.
 *
 * The entry response already says *which* languages are stale, off one hash over the whole file;
 * a hash cannot say which field moved, so this is the read that answers the second question. The
 * older source is fetched by the blob id the translation itself names, which is why it survives
 * however many commits later somebody asks — [`_i18n.sourceBlob`](../../../core/src/content.ts).
 *
 * `{}` rather than a 404 wherever there is nothing to compare — no mark, a mark naming a language
 * this entry has no file in, or bytes git has since collected. The marker simply is not drawn,
 * which is what an editor should see on a field nobody can say anything about.
 */
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

/**
 * One language file's commits down to the page asked for, and whether GitHub still had older
 * ones. The pages are read from the top each time rather than carried on from where the last
 * one stopped, because the merge across languages cuts the list and a per-path cursor would
 * then start below the cut — see `mergeFileCommits`.
 */
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

/**
 * One language's commits under the name the entry has and, once that log is read to its start,
 * under the names it had before: the commit that started the log is the rename that made it,
 * when there was one, and its message says what the file was called — no `--follow`, which the
 * commits API has none of, and no read that a never-renamed entry pays for.
 */
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

/**
 * One entry's versions: the commits of every language file it has, merged, newest first. A read
 * of the branch and nothing else — nothing this derived is written down, so history costs the
 * same on every open.
 *
 * **Who made a version is the log's answer, not git's.** A commit the admin makes is the
 * installation's, so git names the App; the person who pressed Publish is in the activity row
 * that carries the same sha, and a commit somebody pushed themselves keeps the name git has.
 */
export async function entryHistory(
  ctx: RequestContext,
  collection: string,
  slug: string,
  url: URL,
): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const asked = Number(url.searchParams.get('page') ?? 1);
  // Every page is one request per language file, so the depth is capped rather than trusted:
  // fifty subrequests is what the Free plan allows a request in total.
  const pages = Math.min(Math.max(Number.isSafeInteger(asked) ? asked : 1, 1), 10);
  const git = ctx.git();
  const read = await Promise.all(
    config.i18n.locales.map((locale) => commitsUnder(git, collection, slug, locale, pages)),
  );
  // The current name's pages first, whatever the language: the rename commit is in both logs
  // and the merge names a version by the first page it meets it on.
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
        // The first line only: a commit body is the list of files it wrote, and the row beside
        // it already says which languages those were.
        summary: version.message.split('\n')[0] ?? '',
        locales: version.locales,
        ...(author ? { author } : {}),
        // The name the files had then, where it is not the one they have now: a diff or a
        // restore of this version reads them under it.
        ...(version.name ? { name: version.name } : {}),
      };
    }),
    more,
  });
}

/**
 * What one version says that another does not, field by field, in the drawer's own diff.
 * `from` is what is live now unless the caller names a commit, so the fields marked are the
 * ones restoring this version would change — which is the question somebody reading a version
 * is asking.
 */
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
  // The names the files had at each side, where a rename has moved them since (`entryHistory`).
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

/**
 * One entry as a commit has it, language by language — a diff's before or its after. `name` is
 * what its files were called at that commit, where a rename has moved them since.
 */
async function entryAt(git: GitClient, collection: string, slug: string, ref: string, name = slug) {
  const read = await Promise.all(
    Object.entries(entryPaths(collection, name)).map(async ([locale, path]) => {
      const file = await git.getFile(path, ref);
      return file ? ([locale, parseEntry('default', file.contents)] as const) : undefined;
    }),
  );
  return Object.fromEntries(read.filter((f) => f !== undefined));
}

/**
 * The log's publish row, opened: what the commit changed against the commit it was made on,
 * one entry at a time. Read when the row is opened and never with the page — fifty publishes
 * on a page would be a hundred git reads for rows nobody looks into.
 */
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
  // The dashboard's cap. Each entry is two reads per language, and a request on the Free plan
  // has fifty subrequests in it.
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

/**
 * One version of an entry back as unpublished changes. Never a rewrite of git: the version's
 * files go into the draft rows the editor is already working through, and publishing them is
 * the ordinary forward commit every other edit makes — the version being restored stays in the
 * list, and so does everything after it.
 *
 * A file older than the format this package reads is migrated in memory on the way past, so a
 * pre-migration version never reaches the editor unmigrated; one written by a newer package is
 * refused with the reason rather than drawn as a shape the form does not know.
 */
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
  // The name the files had at that commit, where a rename has moved them since: read under it,
  // written under the name the entry has now — a restore never moves the entry back.
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
  // The whole form, `slug` included: `formFor` takes the address out of what the client types
  // into, but it is a key the schema declares and the file writes it where it says.
  const form = formOf('default', formSchema(schema));
  const database = ctx.db();
  const pending = await pendingLocales(collection, slug, database);
  const { paths } = await restoreDraft('default', database, git, form, files, session?.user.id);
  // The lock only refuses somebody editing right now; a draft typed yesterday and closed goes
  // with this write, so the log says whose words a version was put over.
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

/**
 * The three-way view: what both sides started from, what only one of them changed and is
 * merged without asking, and the fields somebody has to answer. `409` when nothing of the
 * entry has moved in the repository, which is a drawer asking about a conflict already
 * settled — the same shape the drift answer's refusal has.
 */
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

/**
 * The answers to one entry's conflict, one per question the report asked. Every question is
 * answered or none of them are: a half-answered entry would be written with the repository's
 * value in the fields nobody had reached, which is not what leaving a question alone means.
 */
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
