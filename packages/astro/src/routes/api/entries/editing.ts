import config from 'virtual:handover/config';
import type { Form, LocaleSeed } from '@handover/core';
import {
  claimLock,
  DraftRevisionError,
  driftReport,
  holdEntry,
  isDraftRace,
  isMediaRace,
  lockHolder,
  logActivity,
  resolveFieldTarget,
  saveDraft,
  takeLock,
} from '@handover/core';
import { entryProblems } from '../../../problems.js';
import { readJson } from '../body.js';
import {
  entryPath,
  entrySourceFor,
  entrySubject,
  formFor,
  isHolder,
  localeData,
  schemaOf,
  siblingPaths,
  sourceRefusal,
  tabOf,
  translationSource,
} from '../content.js';
import type { RequestContext } from '../environment.js';

/** One lock per entry: `read` never takes it, `beat` extends ours, `take` moves it. */
export async function lockState(
  ctx: RequestContext,
  collection: string,
  slug: string,
  session: App.Locals['handover'],
  mode: 'read' | 'beat' | 'take',
  tab: string,
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  const entry = `${collection}/${slug}`;
  if (mode === 'take')
    return Response.json(await takeOver(ctx, collection, slug, entry, session, tab));
  const taken =
    mode === 'beat' ? await claimLock('default', database, entry, session.user.id, tab) : undefined;
  const holder = taken ? undefined : await lockHolder('default', database, entry);
  return Response.json({
    held_by: holder ? { id: holder.userId, name: holder.name } : null,
    // The lock belongs to the tab, so a second tab of the same person sees `mine` false.
    mine: taken !== undefined || isHolder(holder, session, tab),
    expires_at: taken ?? holder?.expiresAt ?? null,
  });
}

/** Logged only when it moves between people; an unheld entry is not a take-over. */
async function takeOver(
  ctx: RequestContext,
  collection: string,
  slug: string,
  entry: string,
  session: NonNullable<App.Locals['handover']>,
  tab: string,
) {
  const database = ctx.db();
  const holder = await lockHolder('default', database, entry);
  const expiresAt = await takeLock('default', database, entry, session.user.id, tab);
  if (holder && holder.userId !== session.user.id) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'lock-takeover',
      subject: await entrySubject(ctx, collection, slug),
      detail: { from: holder.name },
    });
  }
  return {
    held_by: null,
    mine: true,
    expires_at: expiresAt,
  };
}

// For the routes that write without reading the entry; a one-language site still reads nothing.
export async function unresolvedSource(ctx: RequestContext, collection: string, slug: string) {
  if (config.i18n.locales.length < 2) return undefined;
  const { loaded, source } = await entrySourceFor(ctx, collection, slug);
  return source && 'problem' in source ? sourceRefusal(source, localeData(loaded)) : undefined;
}

/** Every possible language in one statement; a language with no draft has no row to hit. */
export async function hold(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const refused = await unresolvedSource(ctx, collection, slug);
  if (refused) return refused;
  const body = (await readJson(request)) as { hold?: unknown } | undefined;
  const held = body?.hold === true;
  const database = ctx.db();
  await holdEntry(
    'default',
    database,
    config.i18n.locales.map((locale) => entryPath(collection, slug, locale)),
    held ? session.user.id : null,
  );
  // Only the release is logged: that is the half the other person wants to read about.
  if (!held) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'hold-released',
      subject: await entrySubject(ctx, collection, slug),
      detail: null,
    });
  }
  return Response.json({ held });
}

// A browser posting `_status` must not set it: the `_` keys are read off the file as it stands.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

type StructuralSave = {
  containers: string[];
  revisions: Record<string, string>;
  seeds: Record<string, LocaleSeed[]>;
};

export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const rowField = (type: string) => type === 'blocks' || type === 'array' || type === 'menus';

// Structural history may restore locale-owned rows, but never arbitrary entry metadata.
function structuralSave(
  value: unknown,
  form: Form,
  data: Record<string, unknown>,
  source: string,
): StructuralSave | undefined {
  if (!object(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => ['containers', 'revisions', 'seeds'].includes(key)))
    return undefined;
  const containers = value.containers;
  if (
    !Array.isArray(containers) ||
    !containers.length ||
    containers.some((address) => typeof address !== 'string' || !address) ||
    new Set(containers).size !== containers.length
  )
    return undefined;
  for (const address of containers) {
    const resolved = resolveFieldTarget('default', form, address, data);
    if (
      !resolved.ok ||
      resolved.target.address !== address ||
      !rowField(resolved.target.field.type)
    )
      return undefined;
  }

  if (!object(value.revisions)) return undefined;
  const revisionEntries = Object.entries(value.revisions);
  if (
    !revisionEntries.length ||
    !revisionEntries.some(([locale]) => locale === source) ||
    revisionEntries.some(
      ([locale, revision]) =>
        !config.i18n.locales.includes(locale) || typeof revision !== 'string' || !revision,
    )
  )
    return undefined;
  const revisions = Object.fromEntries(revisionEntries) as Record<string, string>;

  if (!object(value.seeds)) return undefined;
  const seeds: Record<string, LocaleSeed[]> = {};
  for (const [locale, candidates] of Object.entries(value.seeds)) {
    if (
      locale === source ||
      !config.i18n.locales.includes(locale) ||
      !(locale in value.revisions) ||
      !Array.isArray(candidates)
    )
      return undefined;
    const seen = new Set<string>();
    seeds[locale] = [];
    for (const candidate of candidates) {
      if (!object(candidate)) return undefined;
      const seedKeys = Object.keys(candidate);
      if (
        !seedKeys.every((key) => ['address', 'value', 'machine'].includes(key)) ||
        !seedKeys.includes('address') ||
        !seedKeys.includes('value') ||
        typeof candidate.address !== 'string' ||
        !candidate.address ||
        !object(candidate.value) ||
        typeof candidate.value._id !== 'string' ||
        !candidate.value._id ||
        '_machine' in candidate.value ||
        seen.has(candidate.address)
      )
        return undefined;
      const suffix = `[_id=${candidate.value._id}]`;
      const container = candidate.address.endsWith(suffix)
        ? candidate.address.slice(0, -suffix.length)
        : undefined;
      const resolved = resolveFieldTarget('default', form, candidate.address, data);
      if (
        !container ||
        !containers.includes(container) ||
        !resolved.ok ||
        resolved.target.address !== candidate.address ||
        !rowField(resolved.target.field.type)
      )
        return undefined;
      if (
        candidate.machine !== undefined &&
        (!Array.isArray(candidate.machine) ||
          new Set(candidate.machine).size !== candidate.machine.length ||
          candidate.machine.some(
            (path) => typeof path !== 'string' || !path.startsWith(`${candidate.address}.`),
          ))
      )
        return undefined;
      seen.add(candidate.address);
      seeds[locale].push({
        address: candidate.address,
        value: candidate.value,
        ...(candidate.machine === undefined ? {} : { machine: candidate.machine as string[] }),
      });
    }
  }
  return { containers: containers as string[], revisions, seeds };
}

/** Drafts keep what was typed whether the schema accepts it or not; publish decides. */
export async function autosave(
  ctx: RequestContext,
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
  locale?: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || (locale !== undefined && !config.i18n.locales.includes(locale)))
    return new Response('Not found', { status: 404 });
  // The lock is enforced here: a tab that lost a take-over keeps typing and finds out on save.
  const holder = await lockHolder('default', ctx.db(), `${collection}/${slug}`);
  const body = (await readJson(request)) as
    | { data?: unknown; tab?: unknown; revision?: unknown; structure?: unknown }
    | undefined;
  if (holder && !isHolder(holder, session, tabOf(body)))
    return Response.json(
      {
        held_by: { id: holder.userId, name: holder.name },
        mine: false,
        expires_at: holder.expiresAt,
      },
      { status: 409 },
    );
  const data = editable(body?.data);
  if (!data) return new Response('Bad request', { status: 400 });
  if (typeof body?.revision !== 'string' || !body.revision)
    return Response.json(
      { error: 'Reopen this entry before saving.', reason: 'revision' },
      { status: 409 },
    );

  // The server works out the source language; a stale tab may believe an outranked one.
  const many = config.i18n.locales.length > 1;
  const read = many ? await entrySourceFor(ctx, collection, slug) : undefined;
  const answer = read ? read.source : { locale: config.i18n.defaultLocale, recorded: false };
  if (!answer) return new Response('Not found', { status: 404 });
  if ('problem' in answer) return sourceRefusal(answer, localeData(read?.loaded ?? {}));
  const source = answer.locale;
  const at = locale ?? source;
  // Only a source-language save carries structure into the sibling files.
  const translation = at !== source;
  const managed = config.collections[collection]?.localizedSlugs ? ['slug'] : [];
  const provenance = translation
    ? await translationSource(ctx, collection, slug, source)
    : undefined;
  if (translation && !provenance) return new Response('Not found', { status: 404 });
  if (translation && body?.structure !== undefined)
    return new Response('Bad request', { status: 400 });
  const structure =
    body?.structure === undefined
      ? undefined
      : structuralSave(body.structure, formFor(collection, slug), data, source);
  if (body?.structure !== undefined && !structure)
    return new Response('Bad request', { status: 400 });
  if (!translation && read) {
    // Read at dispatch: a tab may have opened before external drift appeared.
    // Intentional locale-only rows and entries with one file produce no report and keep saving.
    if (driftReport('default', formFor(collection, slug), localeData(read.loaded)).length)
      return Response.json(
        {
          error:
            "This entry's languages disagree about which blocks it has. Reconcile them before editing.",
          reason: 'drift',
        },
        { status: 409 },
      );
  }
  const siblings = translation ? {} : siblingPaths(collection, slug, source);
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft(
      'default',
      ctx.db(),
      ctx.git(),
      entryPath(collection, slug, at),
      data,
      translation || managed.length || Object.keys(siblings).length || structure
        ? {
            form: formFor(collection, slug),
            locale: at,
            siblings,
            translation,
            ...(managed.length ? { managed } : {}),
            ...(provenance ? { source: provenance } : {}),
            // An unrecorded entry stays unrecorded until a translation or turn-off freezes it.
            ...(answer.recorded ? { stamp: source } : {}),
            ...(structure
              ? { restoration: { revisions: structure.revisions, seeds: structure.seeds } }
              : {}),
          }
        : undefined,
      session?.user.id,
      body.revision,
    );
  } catch (err) {
    if (err instanceof DraftRevisionError || isDraftRace(err))
      return Response.json(
        { error: new DraftRevisionError().message, reason: 'revision' },
        { status: 409 },
      );
    if (isMediaRace(err))
      return Response.json(
        {
          error: 'That media item is being deleted. Choose another file before saving.',
          reason: 'media',
        },
        { status: 409 },
      );
    // A shape the serialiser cannot write (a nested array) is refused with its reason.
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}
