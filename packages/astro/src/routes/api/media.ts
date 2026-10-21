import config from 'virtual:handover/config';
import index, { uses } from 'virtual:handover/index';
import type { MediaRow } from '@handover/core';
import {
  deleteMedia,
  draftFiles,
  findMedia,
  logActivity,
  mediaList,
  mediaUsage,
  namedBy,
  setMediaDetails,
} from '@handover/core';
import { entryHref, entryTitle } from '../../content.js';
import type { RequestContext } from '../../environment.js';
import { mediaStore, NO_BUCKET } from '../../environment.js';
import { readJson } from './body.js';
import { codedError } from './respond.js';

// The key a content file stores, and where the asset is served from.
export function mediaItem(row: MediaRow) {
  const base = config.media?.publicBase?.replace(/\/$/, '');
  return {
    id: row.id,
    src: row.r2Key,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    // Centre is what an unframed picture looks like and what the column defaults to, on purpose.
    focal: [row.focalX ?? 0.5, row.focalY ?? 0.5],
    ...(base ? { url: `${base}/${row.r2Key}` } : {}),
  };
}

// The asset as the library knows it; an upload's answer has none of this yet.
function libraryItem(row: MediaRow, used: readonly string[] = []) {
  return {
    ...mediaItem(row),
    alt: row.alt,
    tags: row.tags ?? [],
    archived: row.archived === 1,
    createdAt: row.createdAt,
    // Addressed the way the sidebar addresses it, so the client can go from picture to page.
    uses: used.map((entry) => ({ entry, title: entryTitle(entry), href: entryHref(entry) })),
  };
}

/** Usage counts come from the build's map with today's drafts over it. */
export async function library(ctx: RequestContext, url: URL): Promise<Response> {
  const database = ctx.db();
  const kind = url.searchParams.get('kind') === 'files' ? 'files' : 'images';
  // Only the library shows what has been put away; a field is never offered it.
  const withArchived = url.searchParams.get('archived') === '1';
  const [rows, drafts] = await Promise.all([
    mediaList('default', database, {
      kind,
      q: url.searchParams.get('q') ?? undefined,
      withArchived,
    }),
    draftFiles('default', database, index),
  ]);
  const used = mediaUsage(uses, drafts);
  return Response.json({ media: rows.map((row) => libraryItem(row, used[row.r2Key])) });
}

/** None of this is content, so it goes on the row; archiving is never gated on usage. */
export async function describeMedia(
  ctx: RequestContext,
  id: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const body = (await readJson(request)) as
    | { tags?: unknown; alt?: unknown; archived?: unknown; focal?: unknown }
    | undefined;
  const tags = Array.isArray(body?.tags)
    ? [
        ...new Set(
          body.tags
            .filter((t): t is string => typeof t === 'string' && !!t.trim())
            .map((t) => t.trim()),
        ),
      ]
    : undefined;
  const alt = typeof body?.alt === 'string' ? body.alt.trim() : undefined;
  const archived = typeof body?.archived === 'boolean' ? body.archived : undefined;
  // A focal point outside 0..1 would crop off the photograph, so it is refused rather than clamped.
  const point = body?.focal;
  const focal =
    Array.isArray(point) &&
    point.length === 2 &&
    point.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
      ? ([point[0], point[1]] as [number, number])
      : undefined;
  if (point !== undefined && !focal)
    return codedError(400, 'MEDIA_METADATA_INVALID', 'a focal point is [x, y], each 0 to 1');
  if (tags === undefined && alt === undefined && archived === undefined && focal === undefined)
    return codedError(
      400,
      'MEDIA_METADATA_INVALID',
      'send { tags }, { alt }, { archived } or { focal }',
    );
  const database = ctx.db();
  const row = await setMediaDetails('default', database, id, { tags, alt, archived, focal });
  if (!row) return codedError(404, 'MEDIA_NOT_FOUND', 'Not found');
  // Putting an asset away is a decision about what the site offers, so only that is logged.
  if (archived !== undefined)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'media-archive',
      subject: id,
      detail: { archived, name: row.filename },
    });
  const drafts = await draftFiles('default', database, index);
  const used = mediaUsage(uses, drafts);
  return Response.json({ media: libraryItem(row, used[row.r2Key]) });
}

const places = (uses: readonly string[]) =>
  uses.length === 1 ? '1 place' : `${uses.length} places`;

/** Protect drafts, fresh repository content, and the snapshot this running bundle serves. */
export async function deleteAsset(
  ctx: RequestContext,
  id: string,
  session: App.Locals['handover'],
): Promise<Response> {
  const store = mediaStore();
  if (!store) return codedError(503, 'MEDIA_STORAGE_UNAVAILABLE', NO_BUCKET);
  const database = ctx.db();
  const row = await findMedia('default', database, id);
  if (!row || row.state === 'deleted') return codedError(404, 'MEDIA_NOT_FOUND', 'Not found');
  const [tree, drafts] = await Promise.all([
    ctx.git().contentFiles(),
    draftFiles('default', database, index),
  ]);
  // Keep the current-content refusal distinct from usage only the repository/deployment has.
  const drafted = new Set(drafts.map((d) => d.path));
  const now = namedBy(row.r2Key, [...tree.filter((f) => !drafted.has(f.path)), ...drafts]);
  const live = [
    ...new Set([...namedBy(row.r2Key, tree), ...(mediaUsage(uses, [])[row.r2Key] ?? [])]),
  ].sort();
  if (now.length)
    return codedError(
      409,
      'MEDIA_IN_USE',
      `This is used in ${places(now)} and cannot be deleted. Archive it instead — that hides it from the picker and keeps every page working.`,
      { uses: now },
    );
  if (live.length)
    return codedError(
      409,
      'MEDIA_PUBLISHED_IN_USE',
      `The published site still uses this in ${places(live)}. Publish the change that takes it out and wait for that deployment to be live, then it can be deleted.`,
      { uses: live },
    );
  await deleteMedia('default', database, store, row);
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'media-delete',
    subject: id,
    detail: { name: row.filename, bytes: row.bytes },
  });
  return Response.json({ deleted: id });
}
