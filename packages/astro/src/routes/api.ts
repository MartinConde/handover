import config from 'virtual:handover/config';
import { preview, site } from 'virtual:handover/index';
import {
  AUTH_BASE_PATH,
  CommitScopeError,
  DraftConflictError,
  DraftRevisionError,
  ENTRY_SEGMENT_SOURCE,
  formOf,
  imagePresets,
  isDraftRace,
  isMediaRace,
  MediaInUseError,
  MediaUnavailableError,
  OperationFinalizationError,
  RefMovedError,
  RenameCollisionError,
  RepoUnreachableError,
  RevertConflictError,
  UploadRefusedError,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { createAuth } from '../auth.js';
import { formSchema } from '../index.js';
import { tabOf } from './api/content.js';
import { requestContext } from './api/context.js';
import {
  address,
  autosave,
  createEntry,
  createTranslation,
  dashboard,
  deletedList,
  discard,
  duplicate,
  getEntry,
  globalsList,
  hold,
  listEntries,
  lockState,
  machineTranslate,
  offering,
  pendingList,
  pickList,
  reconcile,
  remove,
  rename,
  saveTemplate,
  setStatus,
} from './api/entries.js';
import {
  activityDiff,
  conflictView,
  entryDiff,
  entryHistory,
  resolve,
  restoreVersion,
  translatedFromView,
  versionDiff,
} from './api/history.js';
import { askUpload, deleteAsset, describeMedia, finishUpload, library } from './api/media.js';
import {
  account,
  activityLog,
  invite,
  members,
  removeMember,
  resendInvite,
  setMemberRole,
  setPassword,
} from './api/members.js';
import {
  addRedirect,
  buildStatus,
  changeRedirect,
  prepublishChecks,
  publish,
  redirectList,
  removeRedirect,
  restore,
  revert,
} from './api/publishing.js';
import {
  clearIntegration,
  connection,
  diagnostics,
  integrations,
  setIntegration,
  simulateConflict,
  testEmail,
} from './api/settings.js';

export { db, gitClient, mediaStore } from './api/environment.js';

const MEMBER = /^members\/([\w-]+)$/;
const MEMBER_ROLE = /^members\/([\w-]+)\/role$/;
const MEMBER_INVITE = /^members\/([\w-]+)\/invite$/;
const entryRoute = (path: string) =>
  new RegExp(`^${path.replaceAll('<segment>', `(${ENTRY_SEGMENT_SOURCE})`)}$`);
const ENTRIES = entryRoute('entries/<segment>');
const DELETED = entryRoute('deleted/<segment>');
const ENTRY = entryRoute('entries/<segment>/<segment>');
const DRAFT = entryRoute('drafts/<segment>/<segment>');
const TRANSLATION = entryRoute('drafts/<segment>/<segment>/<segment>');
const RENAME = entryRoute('entries/<segment>/<segment>/rename');
const DUPLICATE = entryRoute('entries/<segment>/<segment>/duplicate');
const TEMPLATE = entryRoute('entries/<segment>/<segment>/template');
const LOCALES = entryRoute('entries/<segment>/<segment>/locales');
const ADDRESS = entryRoute('entries/<segment>/<segment>/address/<segment>');
const DRIFT = entryRoute('drift/<segment>/<segment>');
const DIFF = entryRoute('diff/<segment>/<segment>');
const HISTORY = entryRoute('history/<segment>/<segment>');
const RESTORE_VERSION = entryRoute('history/<segment>/<segment>/restore');
const VERSION = entryRoute('history/<segment>/<segment>/diff');
const CONFLICT = entryRoute('conflict/<segment>/<segment>');
const LOCK = entryRoute('locks/<segment>/<segment>');
const HOLD = entryRoute('hold/<segment>/<segment>');
const STATUS = entryRoute('status/<segment>');
const MEDIA = /^media\/([0-9a-f]{64})$/;
const CHECK = /^checks\/([\w-]+)$/;
const SETTING = /^settings\/([\w-]+)$/;
const REDIRECT = /^redirects\/([\w-]+)$/;
const TRANSLATE = entryRoute('translate/<segment>/<segment>/<segment>');
const SOURCE = entryRoute('source/<segment>/<segment>/<segment>');

// The middleware exempts Better Auth's paths, so this is the only thing in front of the login.
const mounted = (pathname: string) =>
  pathname.startsWith(`${(config.i18n.base ?? '').replace(/\/+$/, '')}${AUTH_BASE_PATH}/`);

export const GET: APIRoute = async ({ params, request, url, locals }) => {
  const ctx = requestContext();
  if (mounted(url.pathname)) return createAuth(url, locals.cfContext).handler(request);
  if (params.path === 'account') return account(ctx, locals.handover);
  if (params.path === 'activity') return activityLog(ctx, url, locals.handover);
  if (params.path === 'activity/diff') return activityDiff(ctx, url, locals.handover);
  if (params.path === 'members') return members(ctx, locals.handover);
  if (params.path === 'ping') {
    return Response.json({
      ok: true,
      collections: Object.keys(config.collections),
      // The middleware has already asserted a session by the time any of this runs.
      user: locals.handover?.user,
      role: locals.handover?.role,
      // Where a media key is served from, for values already in a content file.
      mediaBase: config.media?.publicBase?.replace(/\/$/, ''),
      // Every crop the site renders, for the focal picker; it cannot change while a tab is open.
      presets: imagePresets(
        [
          ...Object.values(config.collections).map((c) => c.schema),
          ...Object.values(config.globals ?? {}),
        ].map((schema) => formOf('default', formSchema(schema))),
      ),
      // `/_preview` does not exist without the flag, so the editor asks before framing a 404.
      preview,
      // `site` from astro.config; absent rather than guessed, so the SEO panel draws no preview.
      site: site || undefined,
    });
  }
  if (params.path === 'entries') return pickList(ctx);
  const removed = params.path?.match(DELETED);
  if (removed) return answering(() => deletedList(ctx, removed[1] ?? ''));
  if (params.path === 'media') return library(ctx, url);
  if (params.path === 'globals') return globalsList(ctx);
  if (params.path === 'redirects') return answering(() => redirectList(ctx));
  if (params.path === 'drafts') return pendingList(ctx);
  if (params.path === 'dashboard') return dashboard(ctx);
  if (params.path === 'build') return buildStatus(ctx);
  if (params.path === 'diagnostics') return diagnostics(locals.handover);
  if (params.path === 'settings') return answering(() => integrations(ctx, locals.handover));
  const held = params.path?.match(LOCK);
  if (held)
    return lockState(
      ctx,
      held[1] ?? '',
      held[2] ?? '',
      locals.handover,
      'read',
      url.searchParams.get('tab') ?? '',
    );
  const changed = params.path?.match(DIFF);
  if (changed) return answering(() => entryDiff(ctx, changed[1] ?? '', changed[2] ?? ''));
  const translatedFrom = params.path?.match(SOURCE);
  if (translatedFrom)
    return answering(() =>
      translatedFromView(
        ctx,
        translatedFrom[1] ?? '',
        translatedFrom[2] ?? '',
        translatedFrom[3] ?? '',
      ),
    );
  const version = params.path?.match(VERSION);
  if (version) return answering(() => versionDiff(ctx, version[1] ?? '', version[2] ?? '', url));
  const past = params.path?.match(HISTORY);
  if (past) return answering(() => entryHistory(ctx, past[1] ?? '', past[2] ?? '', url));
  const against = params.path?.match(CONFLICT);
  if (against) return answering(() => conflictView(ctx, against[1] ?? '', against[2] ?? ''));
  const entry = params.path?.match(ENTRY);
  if (entry) return answering(() => getEntry(ctx, entry[1] ?? '', entry[2] ?? ''));
  const list = params.path?.match(ENTRIES);
  if (list) return listEntries(ctx, list[1] ?? '');
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const ctx = requestContext();
  const setting = params.path?.match(SETTING);
  if (setting) return setIntegration(ctx, setting[1] ?? '', request, locals.handover);
  const translated = params.path?.match(TRANSLATION);
  if (translated)
    return answering(() =>
      autosave(
        ctx,
        translated[1] ?? '',
        translated[2] ?? '',
        request,
        locals.handover,
        translated[3],
      ),
    );
  const draft = params.path?.match(DRAFT);
  if (draft)
    return answering(() => autosave(ctx, draft[1] ?? '', draft[2] ?? '', request, locals.handover));
  const uploaded = params.path?.match(MEDIA);
  if (uploaded)
    return answering(() => finishUpload(ctx, uploaded[1] ?? '', request, locals.handover));
  const rule = params.path?.match(REDIRECT);
  if (rule) return answering(() => changeRedirect(ctx, rule[1] ?? '', request, locals.handover));
  return new Response('Not found', { status: 404 });
};

// The one verb that changes an asset without changing its bytes, which are named by their hash.
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const ctx = requestContext();
  const asset = params.path?.match(MEDIA);
  if (asset) return describeMedia(ctx, asset[1] ?? '', request, locals.handover);
  return new Response('Not found', { status: 404 });
};

// Every route answers the same way when git refuses, whether it was reading or committing.
async function answering(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // The repository is out of reach for every path, so 503 with the message rather than a 404.
    if (err instanceof RepoUnreachableError) return new Response(err.message, { status: 503 });
    // A conflict names its files as data so the drawer can badge those rows.
    if (err instanceof DraftConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof CommitScopeError) return new Response(err.message, { status: 403 });
    if (err instanceof DraftRevisionError || isDraftRace(err))
      return Response.json(
        { error: new DraftRevisionError().message, reason: 'revision' },
        { status: 409 },
      );
    if (err instanceof MediaInUseError || err instanceof MediaUnavailableError || isMediaRace(err))
      return Response.json(
        {
          error: err instanceof Error ? err.message : new MediaUnavailableError().message,
          reason: 'media',
        },
        { status: 409 },
      );
    // A refused revert names its files the way a publish's conflict does.
    if (err instanceof RevertConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof RenameCollisionError) return new Response(err.message, { status: 409 });
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    if (err instanceof OperationFinalizationError)
      return Response.json(
        {
          error: err.message,
          reason: 'needs-finalization',
          operation_id: err.operationId,
          commit_sha: err.commitSha,
        },
        { status: 503 },
      );
    // A refused upload is the chooser's own file, so it is answered to them by the rule it broke.
    if (err instanceof UploadRefusedError)
      return Response.json({ error: err.message }, { status: 422 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const ctx = requestContext();
  if (mounted(url.pathname)) return createAuth(url, locals.cfContext).handler(request);
  const checked = params.path?.match(CHECK);
  if (checked) {
    const name = checked[1] ?? '';
    if (name === 'email') return testEmail(locals.handover);
    if (name === 'conflict') return answering(() => simulateConflict(ctx, locals.handover));
    // Not `answering`: every branch catches for itself.
    return connection(ctx, name, locals.handover);
  }
  if (params.path === 'account/set-password')
    return setPassword(ctx, request, url, locals.cfContext, locals.handover);
  if (params.path === 'members')
    return invite(ctx, request, url, locals.cfContext, locals.handover);
  const roled = params.path?.match(MEMBER_ROLE);
  if (roled)
    return setMemberRole(ctx, roled[1] ?? '', request, url, locals.cfContext, locals.handover);
  const resent = params.path?.match(MEMBER_INVITE);
  if (resent)
    return resendInvite(ctx, resent[1] ?? '', request, url, locals.cfContext, locals.handover);
  if (params.path === 'media') return answering(() => askUpload(ctx, request));
  if (params.path === 'redirects')
    return answering(() => addRedirect(ctx, request, locals.handover));
  if (params.path === 'publish/checks') return answering(() => prepublishChecks(ctx, request));
  if (params.path === 'publish') return answering(() => publish(ctx, request, locals.handover));
  if (params.path === 'revert') return answering(() => revert(ctx, request, locals.handover));
  if (params.path === 'restore') return answering(() => restore(ctx, request, locals.handover));
  const beat = params.path?.match(LOCK);
  if (beat) {
    const body = (await request.json().catch(() => undefined)) as { take?: unknown } | undefined;
    return lockState(
      ctx,
      beat[1] ?? '',
      beat[2] ?? '',
      locals.handover,
      body?.take === true ? 'take' : 'beat',
      tabOf(body),
    );
  }
  const holding = params.path?.match(HOLD);
  if (holding) return hold(ctx, holding[1] ?? '', holding[2] ?? '', request, locals.handover);
  const showing = params.path?.match(STATUS);
  if (showing) return answering(() => setStatus(ctx, showing[1] ?? '', request, locals.handover));
  const filling = params.path?.match(TRANSLATE);
  if (filling)
    return answering(() =>
      machineTranslate(
        ctx,
        filling[1] ?? '',
        filling[2] ?? '',
        filling[3] ?? '',
        request,
        locals.handover,
      ),
    );
  const made = params.path?.match(TRANSLATION);
  if (made)
    return answering(() => createTranslation(ctx, made[1] ?? '', made[2] ?? '', made[3] ?? ''));
  const addressed = params.path?.match(ADDRESS);
  if (addressed)
    return answering(() =>
      address(
        ctx,
        addressed[1] ?? '',
        addressed[2] ?? '',
        addressed[3] ?? '',
        request,
        locals.handover,
      ),
    );
  const offered = params.path?.match(LOCALES);
  if (offered)
    return answering(() =>
      offering(ctx, offered[1] ?? '', offered[2] ?? '', request, locals.handover),
    );
  const restored = params.path?.match(RESTORE_VERSION);
  if (restored)
    return answering(() =>
      restoreVersion(ctx, restored[1] ?? '', restored[2] ?? '', request, locals.handover),
    );
  const settling = params.path?.match(CONFLICT);
  if (settling) return answering(() => resolve(ctx, settling[1] ?? '', settling[2] ?? '', request));
  const answered = params.path?.match(DRIFT);
  if (answered)
    return answering(() =>
      reconcile(ctx, answered[1] ?? '', answered[2] ?? '', request, locals.handover),
    );
  const renamed = params.path?.match(RENAME);
  if (renamed)
    return answering(() =>
      rename(ctx, renamed[1] ?? '', renamed[2] ?? '', request, locals.handover),
    );
  const copied = params.path?.match(DUPLICATE);
  if (copied)
    return answering(() =>
      duplicate(ctx, copied[1] ?? '', copied[2] ?? '', request, locals.handover),
    );
  const templated = params.path?.match(TEMPLATE);
  if (templated)
    return answering(() =>
      saveTemplate(ctx, templated[1] ?? '', templated[2] ?? '', request, locals.handover),
    );
  const created = params.path?.match(ENTRIES);
  if (created) return answering(() => createEntry(ctx, created[1] ?? '', request));
  return new Response('Not found', { status: 404 });
};

export const DELETE: APIRoute = async ({ params, request, url, locals }) => {
  const ctx = requestContext();
  const setting = params.path?.match(SETTING);
  if (setting) return clearIntegration(ctx, setting[1] ?? '', locals.handover);
  const member = params.path?.match(MEMBER);
  if (member)
    return removeMember(ctx, member[1] ?? '', request, url, locals.cfContext, locals.handover);
  const draft = params.path?.match(DRAFT);
  if (draft) return discard(ctx, draft[1] ?? '', draft[2] ?? '', locals.handover);
  const asset = params.path?.match(MEDIA);
  if (asset) return answering(() => deleteAsset(ctx, asset[1] ?? '', locals.handover));
  const rule = params.path?.match(REDIRECT);
  if (rule) return answering(() => removeRedirect(ctx, rule[1] ?? '', locals.handover));
  const entry = params.path?.match(ENTRY);
  if (entry)
    return answering(() => remove(ctx, entry[1] ?? '', entry[2] ?? '', request, locals.handover));
  return new Response('Not found', { status: 404 });
};
