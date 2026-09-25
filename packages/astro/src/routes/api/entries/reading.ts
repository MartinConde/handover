import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import {
  collectionEntries,
  deletedEntries,
  driftReport,
  entryKey,
  isLive,
  overlayRows,
  readRedirects,
  staleLocales,
} from '@handover/core';
import type { RequestContext } from '../../../environment.js';
import { entryProblems } from '../../../problems.js';
import {
  type entryLocales,
  entryPath,
  entrySourceFor,
  formFor,
  globalLabel,
  globalOf,
  localeData,
  offeredIn,
  siteSeoDefaults,
  sourceRefusal,
  translator,
} from '../content.js';

/** Committed and draft rules are both read; empty means the client answered "nowhere". */
async function hideTargets(
  ctx: RequestContext,
  collection: string,
  slug: string,
  loaded: Awaited<ReturnType<typeof entryLocales>>,
): Promise<Record<string, string>> {
  // Read at the branch tip `entryLocales` read from, so both sides of the match are one commit.
  const committed = await readRedirects('default', ctx.git());
  const key = `${collection}/${slug}`;
  const rules = [...committed, ...Object.values(loaded).flatMap((l) => l.redirects)].filter(
    (rule) => rule.reason === 'hidden' && rule.entry === key,
  );
  return Object.fromEntries(
    Object.entries(loaded).flatMap(([locale, l]) => {
      const to = rules.find((rule) => rule.from === l.url)?.to;
      return to ? [[locale, to]] : [];
    }),
  );
}

// The draft wins over the file; no sha goes to the browser, bases are compared server-side.
export const entryNotFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'x-handover-error-code': 'ENTRY_NOT_FOUND' },
  });

export async function getEntry(
  ctx: RequestContext,
  collection: string,
  slug: string,
): Promise<Response> {
  const collected = config.collections[collection];
  const global = globalOf(collection, slug);
  if (!collected && !global) return entryNotFound();
  const schema = global ?? collected?.schema;
  if (!schema) return entryNotFound();
  // One read of every language answers drift, staleness and pending drafts alike.
  const { loaded, source: answer } = await entrySourceFor(ctx, collection, slug, true);
  if (!answer) return entryNotFound();
  if ('problem' in answer) return sourceRefusal(answer, localeData(loaded));
  const source = answer.locale;
  const data = loaded[source]?.data;
  const hidden = !isLive('default', data);
  const form = formFor(collection, slug);
  const offer = offeredIn(data, Object.keys(loaded));
  const languages = localeData(loaded);
  const translations = Object.fromEntries(
    Object.entries(languages).filter(([locale]) => locale !== source),
  );
  return Response.json({
    ...form,
    data,
    // From the same read, so a second column is not a request of its own.
    translations,
    revisions: Object.fromEntries(
      Object.entries(loaded).map(([locale, file]) => [locale, file.revision]),
    ),
    // A translation drafted on its own is the entry's to publish too.
    pending: config.i18n.locales.filter((locale) => loaded[locale]?.pending),
    // The hold is written per file but holds the whole entry back.
    held: Object.values(loaded).some((l) => l.held),
    problems: entryProblems(schema, data),
    // Only an entry with an SEO panel pays the globals read.
    ...(form.fields.some((f) => f.type === 'seo')
      ? { seoDefaults: await siteSeoDefaults(ctx) }
      : {}),
    // `_status` is the entry's, not one language's.
    hidden,
    ...(hidden ? { redirects: await hideTargets(ctx, collection, slug, loaded) } : {}),
    titleField: collected?.titleField,
    // A global has nothing to hide, rename or duplicate; it is drawn under the dev's label.
    ...(global
      ? {
          singleton: true,
          label: globalLabel(slug, global).label,
          labels: globalLabel(slug, global).labels,
        }
      : {}),
    // Decides whether the editor draws the multi-language controls at all.
    locales: config.i18n.locales,
    // The site's, which is what says whether a language's URLs carry its segment.
    defaultLocale: config.i18n.defaultLocale,
    // The entry's own, which is the site default only where that file exists.
    sourceLocale: source,
    // A language not offered is turned off, not missing.
    offered: offer.offered,
    // Reported rather than acted on, so the list and the form read the same thing.
    offerProblems: offer.problems,
    drift: driftReport('default', form, languages),
    // A warning next to the language, never a reason to refuse anything.
    stale: await staleLocales('default', form, languages, source),
    // With nothing configured the Translate buttons are not drawn.
    translator: (await translator(ctx)) !== undefined,
    // The languages the repository has a file for; the rest only the preview can show.
    published: config.i18n.locales.filter((locale) => loaded[locale]?.live),
    // What the editor builds the address row from.
    route: collected?.route,
    index: collected?.index,
    prefixDefaultLocale: config.i18n.prefixDefaultLocale ?? false,
    // Empty where a language serves it under the file name; absent draws no address row.
    ...(collected?.localizedSlugs
      ? {
          localizedSlugs: true,
          addresses: Object.fromEntries(
            Object.entries(languages).map(([locale, file]) => [
              locale,
              (file as { slug?: unknown })?.slug ?? '',
            ]),
          ),
        }
      : {}),
  });
}

/** A query against the log: a deleted entry is in neither the index nor the draft rows. */
export async function deletedList(ctx: RequestContext, collection: string): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const events = await deletedEntries('default', database, collection);
  const rows = await overlayRows('default', database, index);
  const here = new Set(
    collectionEntries('default', index, collection, rows).flatMap((e) =>
      Object.values(e.locales).map((l) => l.path),
    ),
  );
  return Response.json({
    deleted: events.flatMap((event) => {
      const slug = entryKey(event.subject ?? '')?.split('/')[1];
      if (!slug) return [];
      const detail = event.detail as { locales?: unknown } | null;
      const locales = Array.isArray(detail?.locales) ? detail.locales.map(String) : [];
      const taken = locales
        .map((locale) => entryPath(collection, slug, locale))
        .filter((path) => here.has(path));
      return [
        {
          id: event.id,
          at: event.at,
          by: event.user?.name || event.user?.email || null,
          slug,
          locales,
          // The whole entry, or one language of one.
          whole: event.kind === 'entry-delete',
          commit_sha: event.commitSha,
          blocked: taken.length
            ? `There is a file at ${taken.join(', ')} again, so this cannot be put back over it.`
            : undefined,
        },
      ];
    }),
  });
}
