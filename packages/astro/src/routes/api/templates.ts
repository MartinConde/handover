import config from 'virtual:handover/config';
import { templates } from 'virtual:handover/index';
import type { Db } from '@handover/core';
import {
  beginOperation,
  createDraft,
  entryName,
  entrySource,
  FORMAT_VERSION,
  finalizeOperation,
  findOperation,
  formOf,
  logActivity,
  markOperationCommitted,
  OperationFinalizationError,
  operationMessage,
  parseEntry,
  recoverOperationCommit,
  regenerateIds,
  savedTemplates,
  stringifyEntry,
  withSource,
} from '@handover/core';
import type { RequestContext } from '../../environment.js';
import { formSchema } from '../../index.js';
import { readJson } from './body.js';
import { entryFiles, entryPath, takenNames } from './content.js';

/** The baseline order: which published file a template copies where the files disagree about their source. */
const sourceOrder = () => [...new Set([config.i18n.defaultLocale, ...config.i18n.locales])];

const templatePath = (collection: string, name: string) =>
  `src/content/_templates/${collection}/${name}.yaml`;

// Identity keys stay out, or every entry made from the template would share one address.
async function startedFrom(
  ctx: RequestContext,
  collection: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const built = templates[collection]?.find((t) => t.name === name)?.data;
  const file =
    built === undefined ? await ctx.git().getFile(templatePath(collection, name)) : undefined;
  const data = built ?? (file && parseEntry('default', file.contents));
  if (data === undefined) return undefined;
  const values = regenerateIds('default', data) as Record<string, unknown>;
  for (const key of ['_i18n', '_locales', '_source', '_status', 'slug']) delete values[key];
  return values;
}

// Every `_id` taken out: creating from the template stamps fresh ones.
const withoutIds = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutIds)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== '_id')
            .map(([k, v]) => [k, withoutIds(v)]),
        )
      : value;

// The starters the dialog offers: the build's, and the ones saved from the admin since it ran.
export async function templateNames(collection: string, database: Db): Promise<string[]> {
  const built = (templates[collection] ?? []).map((t) => t.name);
  const saved = await savedTemplates('default', database, collection);
  return [...new Set([...built, ...saved])].sort((a, b) => a.localeCompare(b));
}

/** Committed now so the next build offers it, and logged so the dialog offers it before then. */
export async function saveTemplate(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const body = (await readJson(request)) as { to?: unknown } | undefined;
  const git = ctx.git();
  const database = ctx.db();
  const files = await entryFiles(git, collection, slug);
  // The language it is written in, judged by what is published; the baseline order where files disagree.
  const answer = entrySource(
    'default',
    config.i18n,
    Object.fromEntries(
      files.flatMap((f) => (f.file ? [[f.locale, parseEntry('default', f.file.contents)]] : [])),
    ),
  );
  const from = [...(answer && 'locale' in answer ? [answer.locale] : []), ...sourceOrder()]
    .map((locale) => files.find((f) => f.locale === locale && f.file))
    .find(Boolean);
  if (!from?.file)
    return new Response('Publish this entry before saving it as a template', { status: 409 });
  const wanted = typeof body?.to === 'string' && body.to ? body.to : slug;
  const name = entryName('default', wanted, await templateNames(collection, database));
  const retryKey = `template-saved:${collection}/${slug}:${name}`;
  const existing = await findOperation('default', database, retryKey);
  const completed = existing?.result as { commit_sha?: unknown; name?: unknown } | null;
  if (
    existing?.state === 'finalized' &&
    typeof completed?.commit_sha === 'string' &&
    completed.name === name
  )
    return Response.json({ name });
  const values = withoutIds(parseEntry('default', from.file.contents)) as Record<string, unknown>;
  for (const key of ['_i18n', '_locales', '_source', '_status', '_machine', 'slug'])
    delete values[key];
  const baseSha = existing?.baseSha ?? (await git.getHead());
  const path = templatePath(collection, name);
  const operation =
    existing ??
    (await beginOperation('default', database, {
      retryKey,
      kind: 'template-saved',
      paths: [path],
      baseSha,
      userId: session?.user.id,
      subject: from.path,
      detail: { template: name },
    }));
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha)
    ({ commit_sha } = await git.publish(
      [{ path: templatePath(collection, name), contents: stringifyEntry('default', values) }],
      {
        base_sha: operation.baseSha,
        message: operationMessage(
          `Save ${collection}/${slug} as the template ${name}`,
          operation.id,
        ),
      },
    ));
  await markOperationCommitted('default', database, operation.id, commit_sha, {
    commit_sha,
    name,
  });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'template-saved',
    subject: from.path,
    detail: { template: name },
    commitSha: commit_sha,
  });
  return Response.json({ name });
}

/** A draft, not a commit: the name stays editable and an abandoned entry stays out of git. */
export async function createEntry(
  ctx: RequestContext,
  collection: string,
  request: Request,
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as
    | { title?: unknown; template?: unknown; locale?: unknown }
    | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const { defaultLocale, locales } = config.i18n;
  // The language the entry is written in from here on, so it is refused before anything is written.
  const first = body?.locale === undefined ? defaultLocale : body.locale;
  if (typeof first !== 'string' || !locales.includes(first))
    return new Response(`${String(first)} is not a language this site declares`, { status: 400 });
  const starter =
    typeof body?.template === 'string' && body.template
      ? await startedFrom(ctx, collection, body.template)
      : {};
  if (!starter) return new Response('No such template', { status: 404 });
  const database = ctx.db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(collected.schema));
  // The field the collection lists by is the one the title typed into the dialog belongs in.
  const named = collected.titleField ?? 'title';
  const values: Record<string, unknown> = { ...starter, _version: FORMAT_VERSION };
  if (fields.some((f) => f.path[0] === named && f.type === 'text')) values[named] = title;
  // The language chosen in the dialog, which is also the entry's source from its first file on.
  const path = entryPath(collection, slug, first);
  await createDraft(
    'default',
    database,
    ctx.git(),
    path,
    locales.length > 1 ? withSource('default', values, first) : values,
  );
  return Response.json({ slug });
}
