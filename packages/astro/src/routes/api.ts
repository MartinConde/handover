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
  ResourceLimitError,
  RevertConflictError,
  UploadRefusedError,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { createAuth } from '../auth.js';
import { formSchema } from '../index.js';
import { bodyErrorResponse, readJson } from './api/body.js';
import { tabOf } from './api/content.js';
import { dashboard, globalsList, listEntries, pendingList, pickList } from './api/dashboard.js';
import { autosave, hold, lockState } from './api/entries/editing.js';
import { discard, duplicate, remove, rename } from './api/entries/lifecycle.js';
import {
  address,
  changeEntrySource,
  offering,
  reconcile,
  setStatus,
} from './api/entries/locales.js';
import { deletedList, getEntry } from './api/entries/reading.js';
import { requestContext } from './api/environment.js';
import {
  activityDiff,
  conflictView,
  entryDiff,
  entryHistory,
  resolve,
  restore,
  restoreVersion,
  revert,
  translatedFromView,
  versionDiff,
} from './api/history.js';
import {
  askUpload,
  deleteAsset,
  describeMedia,
  finishUpload,
  ingestUpload,
  library,
  UPLOAD_KEY,
} from './api/media.js';
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
import { buildStatus, prepublishChecks, publish } from './api/publishing.js';
import { addRedirect, changeRedirect, redirectList, removeRedirect } from './api/redirects.js';
import {
  clearIntegration,
  connection,
  diagnostics,
  integrations,
  setIntegration,
  simulateConflict,
  testEmail,
} from './api/settings.js';
import { recordSources, sourcesList } from './api/sources.js';
import { createEntry, saveTemplate } from './api/templates.js';
import { createTranslation, machineTranslate } from './api/translation.js';

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
const ENTRY_SOURCE = entryRoute('entries/<segment>/<segment>/source');
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

// Every group in these patterns is required, so a match fills each one.
const groups = (path: string | undefined, re: RegExp) =>
  path?.match(re) as [string, string, string, string] | null | undefined;

// The middleware exempts Better Auth's paths, so this is the only thing in front of the login.
const mounted = (pathname: string) =>
  pathname.startsWith(`${(config.i18n.base ?? '').replace(/\/+$/, '')}${AUTH_BASE_PATH}/`);

export const GET: APIRoute = async ({ params, request, url, locals }) => {
  const session = locals.handover;
  const ctx = requestContext();
  if (mounted(url.pathname)) return createAuth(url, locals.cfContext).handler(request);
  if (params.path === 'account') return account(ctx, session);
  if (params.path === 'activity') return activityLog(ctx, url, session);
  if (params.path === 'activity/diff') return activityDiff(ctx, url, session);
  if (params.path === 'members') return members(ctx, session);
  if (params.path === 'ping') {
    const response = Response.json({
      ok: true,
      collections: Object.keys(config.collections),
      collectionLabels: Object.fromEntries(
        Object.entries(config.collections).flatMap(([name, { label, singular }]) =>
          label || singular ? [[name, { label, singular }]] : [],
        ),
      ),
      // The middleware has already asserted a session by the time any of this runs.
      user: session?.user,
      role: session?.role,
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
      // Drawn as sidebar links before any screen loads; no `roles` means both of them.
      screens: Object.entries(config.admin?.screens ?? {}).map(([key, { label, roles }]) => ({
        key,
        label,
        ...(roles ? { roles } : {}),
      })),
    });
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
  if (params.path === 'entries') return pickList(ctx);
  const removed = groups(params.path, DELETED);
  if (removed) return answering(() => deletedList(ctx, removed[1]));
  if (params.path === 'media') return library(ctx, url);
  if (params.path === 'globals') return globalsList(ctx);
  if (params.path === 'redirects') return answering(() => redirectList(ctx));
  if (params.path === 'drafts') return pendingList(ctx);
  if (params.path === 'dashboard') return dashboard(ctx);
  if (params.path === 'build') return buildStatus(ctx);
  if (params.path === 'diagnostics') return diagnostics(session);
  if (params.path === 'sources') return answering(() => sourcesList(ctx, session));
  if (params.path === 'settings') return answering(() => integrations(ctx, session));
  const held = groups(params.path, LOCK);
  if (held)
    return lockState(ctx, held[1], held[2], session, 'read', url.searchParams.get('tab') ?? '');
  const changed = groups(params.path, DIFF);
  if (changed) return answering(() => entryDiff(ctx, changed[1], changed[2]));
  const translatedFrom = groups(params.path, SOURCE);
  if (translatedFrom)
    return answering(() =>
      translatedFromView(ctx, translatedFrom[1], translatedFrom[2], translatedFrom[3]),
    );
  const version = groups(params.path, VERSION);
  if (version) return answering(() => versionDiff(ctx, version[1], version[2], url));
  const past = groups(params.path, HISTORY);
  if (past) return answering(() => entryHistory(ctx, past[1], past[2], url));
  const against = groups(params.path, CONFLICT);
  if (against)
    return answering(() => conflictView(ctx, against[1], against[2]), {
      repository: 'CONFLICT_REPOSITORY_UNAVAILABLE',
    });
  const entry = groups(params.path, ENTRY);
  if (entry) return answering(() => getEntry(ctx, entry[1], entry[2]));
  const list = groups(params.path, ENTRIES);
  if (list) return listEntries(ctx, list[1]);
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const session = locals.handover;
  const staging = groups(params.path, UPLOAD_KEY);
  if (staging) return ingestUpload(requestContext(), staging[0], request, session);
  const invalidBody = await bodyErrorResponse(request);
  if (invalidBody) return invalidBody;
  const ctx = requestContext();
  const setting = groups(params.path, SETTING);
  if (setting) return setIntegration(ctx, setting[1], request, session);
  const translated = groups(params.path, TRANSLATION);
  if (translated)
    return answering(() =>
      autosave(ctx, translated[1], translated[2], request, session, translated[3]),
    );
  const draft = groups(params.path, DRAFT);
  if (draft) return answering(() => autosave(ctx, draft[1], draft[2], request, session));
  const uploaded = groups(params.path, MEDIA);
  if (uploaded) return answering(() => finishUpload(ctx, uploaded[1], request, session));
  const rule = groups(params.path, REDIRECT);
  if (rule) return answering(() => changeRedirect(ctx, rule[1], request, session));
  return new Response('Not found', { status: 404 });
};

// The one verb that changes an asset without changing its bytes, which are named by their hash.
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const session = locals.handover;
  const invalidBody = await bodyErrorResponse(request);
  if (invalidBody) return invalidBody;
  const ctx = requestContext();
  const asset = groups(params.path, MEDIA);
  if (asset) return describeMedia(ctx, asset[1], request, session);
  return new Response('Not found', { status: 404 });
};

// Every route answers the same way when git refuses, whether it was reading or committing.
type AnswerCodes = Partial<{
  conflict: string;
  finalization: string;
  refMoved: string;
  repository: string;
}>;

async function answering(
  work: () => Promise<Response>,
  codes: AnswerCodes = {},
): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // The repository is out of reach for every path, so 503 with the message rather than a 404.
    if (err instanceof RepoUnreachableError)
      return codes.repository
        ? Response.json({ code: codes.repository, error: err.message }, { status: 503 })
        : new Response(err.message, { status: 503 });
    // A conflict names its files as data so the drawer can badge those rows.
    if (err instanceof DraftConflictError)
      return Response.json(
        {
          ...(codes.conflict ? { code: codes.conflict } : {}),
          error: err.message,
          paths: err.paths,
        },
        { status: 409 },
      );
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
    if (err instanceof RefMovedError)
      return codes.refMoved
        ? Response.json({ code: codes.refMoved, error: err.message }, { status: 409 })
        : new Response(err.message, { status: 409 });
    if (err instanceof OperationFinalizationError)
      return Response.json(
        {
          ...(codes.finalization ? { code: codes.finalization } : {}),
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
    if (err instanceof ResourceLimitError)
      return Response.json({ code: 'RESOURCE_LIMIT', error: err.message }, { status: 429 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const session = locals.handover;
  if (mounted(url.pathname)) {
    const invalidBody = await bodyErrorResponse(request, true);
    return invalidBody ?? createAuth(url, locals.cfContext).handler(request);
  }
  const invalidBody = await bodyErrorResponse(request);
  if (invalidBody) return invalidBody;
  const ctx = requestContext();
  const checked = groups(params.path, CHECK);
  if (checked) {
    const name = checked[1];
    if (name === 'email') return testEmail(session);
    if (name === 'conflict') return answering(() => simulateConflict(ctx, session));
    // Not `answering`: every branch catches for itself.
    return connection(ctx, name, session);
  }
  if (params.path === 'account/set-password')
    return setPassword(ctx, request, url, locals.cfContext, session);
  if (params.path === 'members') return invite(ctx, request, url, locals.cfContext, session);
  const roled = groups(params.path, MEMBER_ROLE);
  if (roled) return setMemberRole(ctx, roled[1], request, url, locals.cfContext, session);
  const resent = groups(params.path, MEMBER_INVITE);
  if (resent) return resendInvite(ctx, resent[1], request, url, locals.cfContext, session);
  if (params.path === 'media') return answering(() => askUpload(ctx, request, session));
  if (params.path === 'redirects') return answering(() => addRedirect(ctx, request, session));
  if (params.path === 'publish/checks')
    return answering(() => prepublishChecks(ctx, request), {
      repository: 'PUBLISH_CHECKS_FAILED',
    });
  if (params.path === 'publish')
    return answering(() => publish(ctx, request, session), {
      conflict: 'PUBLISH_CONFLICT',
      finalization: 'PUBLISH_FINALIZATION_PENDING',
      refMoved: 'PUBLISH_REF_MOVED',
      repository: 'PUBLISH_REPOSITORY_UNAVAILABLE',
    });
  if (params.path === 'revert') return answering(() => revert(ctx, request, session));
  if (params.path === 'sources')
    return answering(() => recordSources(ctx, request, session), {
      refMoved: 'SOURCES_CHANGED',
    });
  if (params.path === 'restore') return answering(() => restore(ctx, request, session));
  const beat = groups(params.path, LOCK);
  if (beat) {
    const body = (await readJson(request)) as { take?: unknown } | undefined;
    return answering(() =>
      lockState(ctx, beat[1], beat[2], session, body?.take === true ? 'take' : 'beat', tabOf(body)),
    );
  }
  const holding = groups(params.path, HOLD);
  if (holding) return answering(() => hold(ctx, holding[1], holding[2], request, session));
  const showing = groups(params.path, STATUS);
  if (showing) return answering(() => setStatus(ctx, showing[1], request, session));
  const filling = groups(params.path, TRANSLATE);
  if (filling)
    return answering(() =>
      machineTranslate(ctx, filling[1], filling[2], filling[3], request, session),
    );
  const made = groups(params.path, TRANSLATION);
  if (made) return answering(() => createTranslation(ctx, made[1], made[2], made[3]));
  const addressed = groups(params.path, ADDRESS);
  if (addressed)
    return answering(() =>
      address(ctx, addressed[1], addressed[2], addressed[3], request, session),
    );
  const offered = groups(params.path, LOCALES);
  if (offered) return answering(() => offering(ctx, offered[1], offered[2], request, session));
  const sourced = groups(params.path, ENTRY_SOURCE);
  if (sourced)
    return answering(() => changeEntrySource(ctx, sourced[1], sourced[2], request, session));
  const restored = groups(params.path, RESTORE_VERSION);
  if (restored)
    return answering(() => restoreVersion(ctx, restored[1], restored[2], request, session));
  const settling = groups(params.path, CONFLICT);
  if (settling)
    return answering(() => resolve(ctx, settling[1], settling[2], request), {
      repository: 'CONFLICT_REPOSITORY_UNAVAILABLE',
    });
  const answered = groups(params.path, DRIFT);
  if (answered) return answering(() => reconcile(ctx, answered[1], answered[2], request, session));
  const renamed = groups(params.path, RENAME);
  if (renamed) return answering(() => rename(ctx, renamed[1], renamed[2], request, session));
  const copied = groups(params.path, DUPLICATE);
  if (copied) return answering(() => duplicate(ctx, copied[1], copied[2], request, session));
  const templated = groups(params.path, TEMPLATE);
  if (templated)
    return answering(() => saveTemplate(ctx, templated[1], templated[2], request, session));
  const created = groups(params.path, ENTRIES);
  if (created) return answering(() => createEntry(ctx, created[1], request));
  return new Response('Not found', { status: 404 });
};

export const DELETE: APIRoute = async ({ params, request, url, locals }) => {
  const session = locals.handover;
  const invalidBody = await bodyErrorResponse(request);
  if (invalidBody) return invalidBody;
  const ctx = requestContext();
  const setting = groups(params.path, SETTING);
  if (setting) return clearIntegration(ctx, setting[1], session);
  const member = groups(params.path, MEMBER);
  if (member) return removeMember(ctx, member[1], request, url, locals.cfContext, session);
  const draft = groups(params.path, DRAFT);
  if (draft) return answering(() => discard(ctx, draft[1], draft[2], session));
  const asset = groups(params.path, MEDIA);
  if (asset) return answering(() => deleteAsset(ctx, asset[1], session));
  const rule = groups(params.path, REDIRECT);
  if (rule) return answering(() => removeRedirect(ctx, rule[1], session));
  const entry = groups(params.path, ENTRY);
  if (entry) return answering(() => remove(ctx, entry[1], entry[2], request, session));
  return new Response('Not found', { status: 404 });
};
