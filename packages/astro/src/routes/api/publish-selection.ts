import config from 'virtual:handover/config';
import type { Draft } from '@handover/core';
import {
  entryKey,
  entrySource,
  parseEntry,
  readyDrafts,
  refErrors,
  yamlErrors,
} from '@handover/core';
import { ENTRY_FILE, entryPath, object, schemaOf } from '../../content.js';
import type { RequestContext } from '../../environment.js';
import { entryProblems } from '../../problems.js';
import { readBodyText, readJson } from './body.js';
import { codedError } from './respond.js';

const ENTRY_KEY = /^[\w-]+\/[\w-]+$/;
const EXCLUSION = /^([\w-]+\/[\w-]+):([\w-]+)$/;

// Both publish routes take this; only an empty body means everything.
function selection(
  raw: string,
  body: unknown,
): { chosen?: string[]; without: string[] } | Response {
  if (raw === '') return { without: [] };
  if (body === undefined)
    return codedError(400, 'PUBLISH_SELECTION_INVALID', 'Invalid publish JSON');
  const named = object(body) ? body : undefined;
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

// An entry's files at `head` with its pending drafts over them, and whose language it is.
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
        data: contents === undefined ? undefined : contents ? parseEntry(contents) : {},
      };
    }),
  );
  const effective = Object.fromEntries(
    files.flatMap(({ locale, data }) => (data === undefined ? [] : [[locale, data]])),
  );
  const source = entrySource(config.i18n, effective);
  return { files, source: source && 'locale' in source ? source.locale : undefined };
}

// Only a file the repository does not have at `head` can wait, and never the entry's own language.
export const whyKept = (at: Awaited<ReturnType<typeof entryAt>>, locale: string) =>
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

// What the build refuses that no schema sees comes first: it would fail every deploy after this one.
export const problemsOf = (row: Pick<Draft, 'path' | 'contents'>) => {
  if (!row.contents) return [];
  const unbuildable = [
    ...yamlErrors(row.path, row.contents),
    ...refErrors(row.path, row.contents, Object.keys(config.globals ?? {})),
  ].map((message) => ({ path: '', message }));
  const schema = schemaFor(row.path);
  return schema
    ? [...unbuildable, ...entryProblems(schema, parseEntry(row.contents))]
    : unbuildable;
};

// One resolver for the checks and the commit, so the lint is over exactly what goes out.
export async function resolveSelection(ctx: RequestContext, request: Request, readiness = false) {
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
