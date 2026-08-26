import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import index from 'virtual:handover/index';
import type {
  Answer,
  Db,
  EntryLocation,
  Form,
  GitClient,
  MediaRow,
  R2Store,
  Role,
  Translate,
  Upload,
} from '@handover/core';
import {
  AUTH_BASE_PATH,
  accountFacts,
  activityPage,
  addressError,
  blobSha,
  claimLock,
  clearPublished,
  collectionEntries,
  commitBuild,
  confirmUpload,
  createDraft,
  createGitClient,
  DraftConflictError,
  deeplTranslate,
  deleteEntry,
  deleteLocales,
  demoteOwner,
  diffEntry,
  discardDraft,
  driftReport,
  entryAddress,
  entryConflict,
  entryKey,
  entryName,
  entryOffer,
  entryUrl,
  FORMAT_VERSION,
  findMedia,
  formOf,
  heldDrafts,
  heldEntries,
  holdEntry,
  lastCommit,
  loadDraft,
  lockHolder,
  logActivity,
  mediaKey,
  mediaList,
  memberApi,
  memberList,
  openDb,
  overlayRows,
  parseEntry,
  pendingDrafts,
  presignUpload,
  publishDrafts,
  RefMovedError,
  RepoUnreachableError,
  RevertConflictError,
  readyDrafts,
  recordDelete,
  recordOffer,
  recordRename,
  releaseLocks,
  renameEntry,
  resolveConflict,
  resolveDrift,
  revertCommit,
  saveDraft,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  staleLocales,
  stringifyEntry,
  syncLocale,
  takeLock,
  translatableText,
  UploadRefusedError,
} from '@handover/core';
import type { APIRoute } from 'astro';
import { createAuth, mailer } from '../auth.js';
import { formSchema } from '../index.js';
import { entryProblems } from '../problems.js';

function gitClient(): GitClient {
  const e = env as Record<string, string | undefined>;
  const [owner, repo] = (e.GITHUB_REPO ?? '').split('/');
  if (!e.GITHUB_APP_ID || !e.GITHUB_INSTALLATION_ID || !e.GITHUB_PRIVATE_KEY || !owner || !repo) {
    throw new Error(
      'GitHub App is not configured: set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY and GITHUB_REPO (owner/repo) with `wrangler secret put`',
    );
  }
  return createGitClient('default', {
    appId: e.GITHUB_APP_ID,
    installationId: e.GITHUB_INSTALLATION_ID,
    privateKey: e.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
    owner,
    repo,
    branch: e.GITHUB_BRANCH,
  });
}

/**
 * What the Workers Builds API is asked with, or nothing where the site has not been told: build
 * status is optional the way DeepL is, and a site without it simply draws no pill.
 */
function workerBuilds(): { worker: string; token: string } | undefined {
  const e = env as Record<string, string | undefined>;
  return e.CLOUDFLARE_API_TOKEN && e.CLOUDFLARE_WORKER
    ? { worker: e.CLOUDFLARE_WORKER, token: e.CLOUDFLARE_API_TOKEN }
    : undefined;
}

/**
 * Where the site's uploads live, or nothing where it was never told. Two of the four are not
 * secrets — an account id and a bucket name — so they sit in wrangler.jsonc beside the two that
 * are, and a site with none of them simply has no media.
 */
export function mediaStore(): R2Store | undefined {
  const e = env as Record<string, string | undefined>;
  return e.R2_ACCOUNT_ID && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY
    ? {
        accountId: e.R2_ACCOUNT_ID,
        bucket: e.R2_BUCKET,
        accessKeyId: e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      }
    : undefined;
}

const NO_BUCKET =
  'No bucket is configured: set R2_ACCOUNT_ID and R2_BUCKET in wrangler.jsonc, and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY with `wrangler secret put`';

export function db(): Db {
  return openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
}

// What machine-translates a field: the site's own hook, or DeepL on the key the Worker holds.
// Neither is an ordinary state of a site — the admin draws no translate button at all — so it
// is a question the entry answers rather than something a route discovers on the way.
function translator(): Translate | undefined {
  const key = (env as Record<string, string | undefined>).DEEPL_API_KEY;
  return config.i18n.translate ?? (key ? deeplTranslate('default', key) : undefined);
}

/**
 * The one message the admin sends on its own account: proof to whoever pasted the key that it
 * works. It goes to the person who asked for it and to nobody else — a recipient the caller
 * names is a mail relay behind a login — and only an owner may ask, which is what the settings
 * screen it sits on is. Every way it can fail is answered in words the person who configured
 * the mailer can act on rather than as a status.
 */
/**
 * Why there is no mailer, in the words of the thing that has to be set. State 2 of the settings
 * screen is a person who has done half the wiring, so it names the half that is missing rather
 * than reporting that email is off.
 */
function missingMailer(): string {
  const configured = config.mailer;
  if (!configured || typeof configured === 'function')
    return 'No mailer is configured: add a `mailer` block to cms.config.ts';
  if (configured.provider === 'smtp')
    return 'SMTP_USER and SMTP_PASS are not both set: put them in .dev.vars, or set them with `wrangler secret put`';
  if (configured.provider === 'cloudflare')
    return 'No EMAIL binding: add `"send_email": [{ "name": "EMAIL" }]` to wrangler.jsonc and onboard the sending domain';
  if (configured.provider === 'resend')
    return 'RESEND_API_KEY is not set: put it in .dev.vars, or set it with `wrangler secret put RESEND_API_KEY`';
  return 'No mailer is configured: add a `mailer` block to cms.config.ts';
}

async function testEmail(session: App.Locals['handover']): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const send = mailer();
  if (!send) return Response.json({ error: missingMailer() }, { status: 503 });
  const to = session.user.email;
  try {
    const { id } = await send({
      to,
      subject: 'Handover test email',
      text: 'Your site can send email. Nothing else to do — this message was sent from the admin to check.',
    });
    return Response.json({ ok: true, to, id });
  } catch (err) {
    // The provider's own refusal, which names the rule that was broken — an unverified sending
    // domain above all — and is the whole use of the button.
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

/**
 * "Simulate conflict": the sequence from
 * [drafts-and-publishing.md](../../../docs/publishing.md) run against the real repository on a
 * scratch entry, so the three-way view can be exercised on a live site without hand-crafting
 * commits. It publishes an entry, edits the draft, and then commits a different edit to the
 * same file — which is exactly what a developer's push does to somebody's open draft.
 *
 * It writes to the repository, so it is the owner's and it names what it made: delete that
 * entry when the walk is over. `422` when no collection here can be filled in from its schema
 * alone — a scratch file the site's own content schema rejects would break the next build.
 */
async function simulateConflict(session: App.Locals['handover']): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const git = gitClient();
  const database = db();
  for (const [collection, collected] of Object.entries(config.collections)) {
    const form = formFor(collection, SCRATCH);
    const values = sampleValues(form.fields);
    const texts = form.fields.flatMap((f) => (f.type === 'text' ? (f.path[0] ?? []) : []));
    if (!values || !texts.length || entryProblems(collected.schema, values).length) continue;
    // Named after the commit it is made against, the way the integration tests name theirs: the
    // taken-names check reads the built index, which lags the repository by a build, so a plain
    // `conflict-check` would collide with the last run's entry on a site that has not rebuilt.
    const head = await git.getHead();
    const slug = entryName(
      'default',
      `${SCRATCH} ${head.slice(0, 7)}`,
      await takenNames(collection, database),
    );
    const path = entryPath(collection, slug, config.i18n.defaultLocale);
    await createDraft('default', database, git, path, { _version: FORMAT_VERSION, ...values });
    const seeded = await publishDrafts('default', database, git, sourceOf, [
      `${collection}/${slug}`,
    ]);
    if (!seeded) return new Response('The scratch entry could not be committed', { status: 502 });
    // Both sides write the first two text fields, so there is a question each and the answers
    // can differ; the two after them are one-sided, so there is something merged to read beside
    // them. A collection with fewer text fields than that simply asks fewer questions.
    const [first = '', second, third, fourth] = texts;
    const ours = { ...values, [first]: 'Your version' };
    const theirs = { ...values, [first]: 'The version in the code' };
    if (second) {
      ours[second] = 'Yours here too';
      theirs[second] = 'And the code here too';
    }
    if (third) theirs[third] = 'Changed in the code, and only there';
    if (fourth) ours[fourth] = 'Changed by you, and only you';
    await saveDraft('default', database, git, path, ours);
    const { commit_sha } = await git.publish(
      [{ path, contents: stringifyEntry('default', { _version: FORMAT_VERSION, ...theirs }) }],
      { base_sha: seeded.commit_sha, message: `Edit ${slug} in code` },
    );
    return Response.json({ entry: `${collection}/${slug}`, path, commit_sha });
  }
  return new Response(
    'No collection on this site can be filled in from its schema alone: a scratch entry needs a collection whose required fields are text, numbers, choices or true/false',
    { status: 422 },
  );
}

const SCRATCH = 'Conflict check';

/**
 * A file a collection's own schema accepts, filled from the field types alone. `undefined`
 * where the schema requires something no default can stand in for — a picture, a reference —
 * because the file this makes is committed and the site builds from it.
 */
function sampleValues(fields: Form['fields']): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    if (field.type === 'group') {
      const inner = sampleValues(field.fields);
      if (!inner) return undefined;
      out[key] = inner;
    } else if (field.type === 'text') out[key] = SCRATCH;
    else if (field.type === 'richtext') out[key] = 'A scratch entry, to try a conflict out.';
    else if (field.type === 'number') out[key] = 0;
    else if (field.type === 'boolean') out[key] = false;
    else if (field.type === 'select') out[key] = field.options[0];
    else if (field.type !== 'unsupported' && field.required) return undefined;
  }
  return out;
}

/**
 * The signed-in person's own account, and the only two facts the page cannot work out for
 * itself: whether a password exists, and where else they are signed in. Everything else it
 * does — the name, changing a password, signing out everywhere — is a Better Auth endpoint
 * the browser calls directly.
 */
async function account(session: App.Locals['handover']): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  return Response.json(await accountFacts('default', db(), session.user.id, session.sessionId));
}

/**
 * Better Auth's own refusal, in its own words: everything it declines carries a code and a
 * sentence a person can act on. Anything without a code is not its answer and is not ours to
 * dress up as one.
 */
function refused(err: unknown): Response {
  const body = (err as { body?: { code?: string; message?: string } }).body;
  if (!body?.code) throw err;
  return Response.json({ error: body.message ?? body.code }, { status: 400 });
}

/**
 * The first password for somebody who has never had one — an invited user who arrived by an
 * emailed link. Better Auth's `setPassword` is server-only, so reaching it needs a route; it
 * refuses when a password already exists rather than becoming a way past `/change-password`,
 * which asks for the old one.
 */
async function setPassword(
  request: Request,
  url: URL,
  ctx: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  const { newPassword } = (await request.json()) as { newPassword?: unknown };
  if (typeof newPassword !== 'string')
    return Response.json({ error: 'No password was sent' }, { status: 400 });
  try {
    await createAuth(url, ctx).api.setPassword({ body: { newPassword }, headers: request.headers });
    await logActivity('default', db(), {
      userId: session?.user.id,
      kind: 'password-set',
      detail: { how: 'first' },
    });
    return Response.json({ ok: true });
  } catch (err) {
    // Too short, or already set: either way the account page shows Better Auth's sentence.
    return refused(err);
  }
}

/**
 * The half of "who changed this?" that never reaches git. **The first route with a per-role
 * filter rather than a per-role gate**: an editor may read it, and sees only their own events
 * — their id comes off the session, so a `user` in the query string is not a way to somebody
 * else's. There is no `limit`: a caller-chosen page size is a scan somebody else pays for.
 */
async function activityLog(url: URL, session: App.Locals['handover']): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  const asked = url.searchParams;
  return Response.json(
    await activityPage(
      'default',
      db(),
      { id: session.user.id, role: session.role },
      {
        group: asked.get('group') ?? undefined,
        user: asked.get('user') ?? undefined,
        entry: asked.get('entry') ?? undefined,
        cursor: asked.get('cursor') ?? undefined,
      },
    ),
  );
}

/**
 * Who can sign in to this site. Owner-only, and asserted here rather than trusted from the
 * sidebar: an editor is not offered the screen, but hiding a link is presentation.
 */
async function members(session: App.Locals['handover']): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const database = db();
  const [rows, held] = await Promise.all([
    memberList('default', database),
    heldEntries('default', database),
  ]);
  // Named rather than counted: the remove dialog says which entries go quiet, and an id would
  // name somebody nothing on that screen can look up.
  return Response.json({
    members: rows.map((row) => ({ ...row, editing: (held[row.id] ?? []).map(entryTitle) })),
  });
}

// An entry as the list would show it: the title of whichever language the build read first, and
// the file name for one the index has never seen — a lock outlives the commit that removed it.
function entryTitle(entry: string): string {
  const [collection = '', slug = ''] = entry.split('/');
  const found = index[collection]?.find((e) => e.id === slug);
  return Object.values(found?.locales ?? {})[0]?.title ?? slug;
}

/**
 * The one role value a request is allowed to carry. The admin plugin takes a string *or an
 * array* and stores an array joined with commas, which `hasPermission` then splits and grants
 * on any segment — so `['owner', 'editor']` is stored as `owner,editor`, read as an owner by
 * Better Auth and as an editor by `roleOf`. Two literals or nothing.
 */
const roleIn = (body: unknown): Role | undefined => {
  const { role } = (body ?? {}) as { role?: unknown };
  return role === 'owner' || role === 'editor' ? role : undefined;
};

/**
 * The whole of an invite: a `user` row and a link mailed to it. There is no invite table and
 * no password — the person opens the link, which signs them in, and their account page offers
 * them a first password. The link lives longer than a sign-in link and says something else;
 * that is what the invite instance is for.
 *
 * The row is written before the mail is tried, so a send that fails leaves a pending invite
 * the owner can resend rather than nothing at all — which is what the screen's failure notice
 * tells them to do.
 */
async function invite(
  request: Request,
  url: URL,
  ctx: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const role = roleIn(body);
  if (typeof body.email !== 'string' || !body.email.trim())
    return Response.json({ error: 'No email address was sent' }, { status: 400 });
  if (!role) return Response.json({ error: 'That is not a role' }, { status: 400 });
  const send = mailer();
  if (!send) return Response.json({ error: missingMailer() }, { status: 503 });
  const auth = createAuth(url, ctx, { invite: true });
  let email: string;
  try {
    // Three values, named one at a time. The endpoint also takes a `data` record that writes
    // user columns directly, and a body spread into it would be a way to set any of them.
    const created = await memberApi('default', auth).createUser({
      body: { email: body.email.trim(), name: '', role },
      headers: request.headers,
    });
    email = created.user.email;
    // Before the send rather than after it: the row is what an invite is, and one whose mail
    // failed is the case the owner most needs a record of. The link is not minted here and is
    // in nothing this writes.
    await logActivity('default', db(), {
      userId: session.user.id,
      kind: 'invite',
      subject: created.user.id,
      detail: { email, role },
    });
  } catch (err) {
    // Already a member, or not an address: Better Auth's own sentence, which names which.
    return refused(err);
  }
  try {
    await memberApi('default', auth).signInMagicLink({
      body: { email, callbackURL: '/admin/account' },
      headers: request.headers,
    });
  } catch {
    // The row is there and the message is not. Nothing about the failure names the link, and
    // the provider's own words are the developer's to find in the log — the person reading
    // this screen is told what to do, not what broke.
    return Response.json({ error: 'invite-not-sent', to: email }, { status: 502 });
  }
  return Response.json({ ok: true, to: email });
}

/**
 * The same link again, for an invite that never arrived. Only for somebody who has never
 * signed in: a member who has would get a mail telling them they have been invited to a site
 * they already use, and the login's own *Email me a link* is what they want instead.
 */
async function resendInvite(
  id: string,
  request: Request,
  url: URL,
  ctx: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  // The list rather than one row, because `pending` is computed from three tables and this is
  // the one place that knows how. A members table is tens of rows, not thousands.
  const member = (await memberList('default', db())).find((row) => row.id === id);
  if (!member) return new Response('Not found', { status: 404 });
  if (!member.pending)
    return Response.json({ error: 'They have already signed in' }, { status: 400 });
  const send = mailer();
  if (!send) return Response.json({ error: missingMailer() }, { status: 503 });
  try {
    await memberApi('default', createAuth(url, ctx, { invite: true })).signInMagicLink({
      body: { email: member.email, callbackURL: '/admin/account' },
      headers: request.headers,
    });
  } catch {
    return Response.json({ error: 'invite-not-sent', to: member.email }, { status: 502 });
  }
  return Response.json({ ok: true, to: member.email });
}

/**
 * Owner ↔ editor. The last owner may not be demoted, which is a rule of this site's and not
 * Better Auth's: `setRole` will happily leave a site with nobody who can manage it.
 */
async function setMemberRole(
  id: string,
  request: Request,
  url: URL,
  ctx: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const role = roleIn(await request.json().catch(() => ({})));
  if (!role) return Response.json({ error: 'That is not a role' }, { status: 400 });
  const database = db();
  const member = (await memberList('default', database)).find((row) => row.id === id);
  if (!member) return new Response('Not found', { status: 404 });
  // Demoting an owner is the one role change that can break a rule, so it is done by the
  // statement that holds the rule rather than by `setRole` behind a count somebody else can
  // change in between. Promotions have nothing to race with and stay Better Auth's.
  if (role === 'editor' && member.role === 'owner') {
    if (!(await demoteOwner('default', database, id)))
      return Response.json({ error: 'There must be at least one owner' }, { status: 400 });
  } else {
    try {
      await memberApi('default', createAuth(url, ctx)).setRole({
        body: { userId: id, role },
        headers: request.headers,
      });
    } catch (err) {
      return refused(err);
    }
  }
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'role-change',
    subject: id,
    detail: { role },
  });
  return Response.json({ ok: true });
}

/**
 * Removing a member, and revoking an invite nobody opened: the same row and the same delete.
 * Better Auth takes their sessions and accounts with it, so access ends with the request.
 * Their drafts stay — a draft belongs to the site, not to whoever last typed in it.
 *
 * Two refusals are this site's, and both are rules rather than disabled buttons: nobody
 * removes themselves, and the last owner stays.
 */
async function removeMember(
  id: string,
  request: Request,
  url: URL,
  ctx: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  if (id === session.user.id)
    return Response.json({ error: 'You cannot remove yourself' }, { status: 400 });
  const database = db();
  const member = (await memberList('default', database)).find((row) => row.id === id);
  if (!member) return new Response('Not found', { status: 404 });
  // The same statement, used as the claim: an owner is taken out of the count before they are
  // taken out of the table, so two owners removing each other cannot both win. If the delete
  // then fails they are an editor rather than an owner, which is the safe direction to fail in.
  if (member.role === 'owner' && !(await demoteOwner('default', database, id)))
    return Response.json({ error: 'There must be at least one owner' }, { status: 400 });
  try {
    await memberApi('default', createAuth(url, ctx)).removeUser({
      body: { userId: id },
      headers: request.headers,
    });
  } catch (err) {
    return refused(err);
  }
  // Their sessions went with the row; the entries they were holding are let go here, so nobody
  // waits two minutes on somebody who no longer has an account.
  await releaseLocks('default', database, id);
  // The `user` row is gone by the time anybody reads this, so the address is in the event or
  // it is nowhere — an id on its own would name somebody nothing can look up. `pending` is
  // what makes this a revoked invite rather than somebody losing access they had.
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'member-removed',
    subject: id,
    detail: { email: member.email, role: member.role, pending: member.pending },
  });
  return Response.json({ ok: true });
}

// One file of one entry. No language is implied: which one an entry is written in is the
// entry's own answer, so every caller says which file it means.
const entryPath = (collection: string, slug: string, locale: string) =>
  `src/content/${collection}/${locale}/${slug}.yaml`;

/**
 * The language an entry's structure is edited in, and the one its translations are made from:
 * the site's default where the entry has that file, and otherwise the first language it does
 * have one in. It is the entry's property and not the site's — an entry written in German alone
 * is a German entry, not a broken English one. What stays the site's is the URL, since whether a
 * language carries its segment is the same answer for every entry.
 */
const sourceOrder = () => [...new Set([config.i18n.defaultLocale, ...config.i18n.locales])];

const sourceIn = (loaded: Record<string, unknown>) => sourceOrder().find((l) => l in loaded);

// The same answer for a route that has not read the entry: the languages are asked in order, so
// an ordinary entry costs one read and a site with one language costs none.
async function sourceFor(collection: string, slug: string): Promise<string | undefined> {
  if (config.i18n.locales.length < 2) return config.i18n.defaultLocale;
  const git = gitClient();
  const database = db();
  for (const locale of sourceOrder()) {
    const path = entryPath(collection, slug, locale);
    const [file, row] = await Promise.all([
      git.getFile(path),
      loadDraft('default', database, path),
    ]);
    if (row?.contents || file?.contents) return locale;
  }
  return undefined;
}

// One entry's other languages, locale → path. Empty on a site that declares one language,
// which is what keeps that site's save exactly the write it was.
const siblingPaths = (collection: string, slug: string, source: string) =>
  Object.fromEntries(
    config.i18n.locales
      .filter((locale) => locale !== source)
      .map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

// Every file one entry is made of. A rename or a delete commits all of them, so all of them
// have to be recorded in D1 too, or a draft left at the old path publishes the file back.
const entryFiles = async (git: GitClient, collection: string, slug: string) => {
  const locales = config.i18n.locales;
  const files = await Promise.all(
    locales.map((locale) => git.getFile(entryPath(collection, slug, locale))),
  );
  return locales.map((locale, i) => ({
    locale,
    path: entryPath(collection, slug, locale),
    file: files[i],
  }));
};

/**
 * A global rides the entry path: `globals` is the collection and the file name is the slug, so
 * one file per language at `src/content/globals/<locale>/<key>.yaml` — the same drafts, locks,
 * hold and one-commit publish as anything else. What it does not have is what a collection's
 * routes are about: no address, no rename, no delete, no turning a language off.
 */
const globalOf = (collection: string, slug: string) =>
  collection === 'globals' ? config.globals?.[slug] : undefined;

/** The schema one file of the CMS is held to: its collection's, or the global's own. */
const schemaOf = (collection: string, slug: string) =>
  globalOf(collection, slug) ?? config.collections[collection]?.schema;

/** What the site settings list calls a global, and what it says it is for. */
const globalLabel = (key: string, schema: Parameters<typeof formSchema>[0]) => {
  const root = formSchema(schema) as { label?: unknown; description?: unknown };
  return {
    key,
    label: typeof root.label === 'string' ? root.label : key,
    description: typeof root.description === 'string' ? root.description : undefined,
  };
};

/**
 * The form the CMS works one collection through. A collection with localized slugs keeps its
 * `slug` out of it: the address is edited in the entry header and not in the form, and a form
 * field would put it in front of the translator, into the staleness hash and into the words a
 * second column can type over. The schema still validates it — this is the form, not the file.
 */
function formFor(collection: string, slug: string): Form {
  const schema = schemaOf(collection, slug);
  if (!schema) throw new Error(`No collection ${collection}`);
  const form = formOf('default', formSchema(schema));
  if (!config.collections[collection]?.localizedSlugs) return form;
  return { ...form, fields: form.fields.filter((f) => f.path[0] !== 'slug') };
}

// The languages an entry is offered in, and what its `_locales` gets wrong: `written` is the
// languages it has a file in, and a file is the fact the mark has to agree with.
const offeredIn = (data: unknown, written: string[]) =>
  entryOffer(
    'default',
    config.i18n.locales,
    (data as { _locales?: unknown } | null)?._locales,
    written,
  );

// One entry as the editor has it, language by language: its draft where there is one, the
// repository where there is not, and no key at all for a language it has no file in. Each
// language also says whether what the editor has is ahead of the repository, which is what
// the entry's Publish is offered on. What `driftReport` compares — a structure two files
// disagree about is a hand edit or a bad merge.
async function entryLocales(
  collection: string,
  slug: string,
  locales: string[],
): Promise<Record<string, { data: unknown; pending: boolean; held: boolean }>> {
  const git = gitClient();
  const database = db();
  const loaded = await Promise.all(
    locales.map(async (locale) => {
      const path = entryPath(collection, slug, locale);
      const [file, row] = await Promise.all([
        git.getFile(path),
        loadDraft('default', database, path),
      ]);
      const contents = row?.contents || file?.contents;
      if (!contents) return undefined;
      const pending = row ? (await blobSha(row.contents)) !== file?.blob_sha : false;
      return [
        locale,
        { data: parseEntry('default', contents), pending, held: Boolean(row?.heldBy) },
      ] as const;
    }),
  );
  return Object.fromEntries(loaded.filter((l) => l !== undefined));
}

/** The words alone, for the readers that compare the languages rather than publish them. */
const localeData = (loaded: Record<string, { data: unknown }>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(loaded).map(([locale, l]) => [locale, l.data]));

// The draft is what the editor was last looking at, so it wins over the file. No sha goes
// to the browser: a publish commits the stored bytes and compares the bases server-side.
async function getEntry(collection: string, slug: string): Promise<Response> {
  const collected = config.collections[collection];
  const global = globalOf(collection, slug);
  if (!collected && !global) return new Response('Not found', { status: 404 });
  const schema = global ?? collected?.schema;
  if (!schema) return new Response('Not found', { status: 404 });
  // Every language in one pass, which is the read the drift, the staleness and the unpublished
  // drafts are all answered from. A site that declares one language reads the one file it
  // always read: it has nothing to have drifted from or been translated ahead of.
  const loaded = await entryLocales(collection, slug, config.i18n.locales);
  const source = sourceIn(loaded);
  if (!source) return new Response('Not found', { status: 404 });
  const data = loaded[source]?.data;
  const form = formFor(collection, slug);
  const offer = offeredIn(data, Object.keys(loaded));
  const languages = localeData(loaded);
  const translations = Object.fromEntries(
    Object.entries(languages).filter(([locale]) => locale !== source),
  );
  return Response.json({
    ...form,
    data,
    // The same read as the rest, so editing a second language beside the first is this one
    // response and not a request per column.
    translations,
    // Which languages the editor has ahead of the repository: a translation drafted on its own
    // — by Create from English, or waiting since last time — is the entry's to publish too.
    pending: config.i18n.locales.filter((locale) => loaded[locale]?.pending),
    // "Not ready yet", read off the entry rather than off one file: the flag is written to the
    // languages the editor was on, and it holds the whole entry back either way.
    held: Object.values(loaded).some((l) => l.held),
    problems: entryProblems(schema, data),
    titleField: collected?.titleField,
    // A global is the same screen with the collection half taken out: nothing to hide it from,
    // no name to change, no second copy of it. The name it is drawn under is the dev's label.
    ...(global ? { singleton: true, label: globalLabel(slug, global).label } : {}),
    // The languages the site declares, which is what says whether the editor draws any of the
    // controls that are about having more than one, and which of them this response is of.
    locales: config.i18n.locales,
    // The site's, which is what says whether a language's URLs carry its segment.
    defaultLocale: config.i18n.defaultLocale,
    // And the entry's own: the language its structure is edited in and its translations are
    // made from, which is the default language only where it has that file.
    sourceLocale: source,
    // And which of them this entry is offered in: the rest are not translated but turned off,
    // which is a decision and not a gap to fill.
    offered: offer.offered,
    // What its own `_locales` says that the files contradict. Reported rather than acted on:
    // the list and the form would otherwise each believe a different half of it.
    offerProblems: offer.problems,
    drift: driftReport('default', form, languages),
    // Which of them were translated from an English that has moved on since. A warning the
    // editor draws next to the language, never a reason to refuse anything.
    stale: await staleLocales('default', form, languages),
    // Whether anything can machine-translate: with nothing configured the buttons that offer
    // it are not drawn, the same rule the locale controls follow on a one-language site.
    translator: translator() !== undefined,
    // Where the site serves this entry and what stands above it: what the editor builds the
    // address row from, and what it names when a language that has a file is turned off.
    route: collected?.route,
    index: collected?.index,
    prefixDefaultLocale: config.i18n.prefixDefaultLocale ?? false,
    // The address each language serves this entry at, empty where it serves it under the file
    // name. Absent on a collection without localized slugs, which draws no address row at all.
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

/**
 * Who is editing this entry, and what each of its files was loaded against. One entry, every
 * language: the structure is shared, so a lock on one file would be a lock on none.
 *
 * `beat` takes an entry nobody is editing and pushes our own lock further out; `read` only ever
 * reads, so a tab watching one is not a way to take it. `take` is the one that moves an entry
 * between people, and it is a person pressing Take over — the holder hears about it when the
 * save their tab makes next is refused.
 */
async function lockState(
  collection: string,
  slug: string,
  session: App.Locals['handover'],
  mode: 'read' | 'beat' | 'take',
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = db();
  const entry = `${collection}/${slug}`;
  if (mode === 'take') return Response.json(await takeOver(collection, slug, entry, session));
  const taken =
    mode === 'beat' ? await claimLock('default', database, entry, session.user.id) : undefined;
  const holder = taken ? undefined : await lockHolder('default', database, entry);
  return Response.json({
    held_by: holder ? { id: holder.userId, name: holder.name } : null,
    mine: taken !== undefined || holder?.userId === session.user.id,
    expires_at: taken ?? holder?.expiresAt ?? null,
    base: await entryBases(collection, slug),
  });
}

/**
 * Take over: the lock moves whatever it says, and the log carries who it was taken from, since
 * that is the half the event would otherwise lose. Nobody holding it is not a take-over and is
 * not an event — the beat would have taken it anyway.
 */
async function takeOver(
  collection: string,
  slug: string,
  entry: string,
  session: NonNullable<App.Locals['handover']>,
) {
  const database = db();
  const holder = await lockHolder('default', database, entry);
  const expiresAt = await takeLock('default', database, entry, session.user.id);
  if (holder && holder.userId !== session.user.id) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'lock-takeover',
      subject: await entrySubject(collection, slug),
      detail: { from: holder.name },
    });
  }
  return {
    held_by: null,
    mine: true,
    expires_at: expiresAt,
    base: await entryBases(collection, slug),
  };
}

// Which file an event about the whole entry names: the one the entry is written in, so the log
// links to the language somebody would open.
async function entrySubject(collection: string, slug: string): Promise<string | null> {
  const source = await sourceFor(collection, slug);
  return source ? entryPath(collection, slug, source) : null;
}

/**
 * "Not ready yet" on the entry, or off it. Every language it could have, whether it has that
 * file or not: the write is one statement and a language nobody has drafted has no row to hit.
 */
async function hold(
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { hold?: unknown } | undefined;
  const held = body?.hold === true;
  const database = db();
  await holdEntry(
    'default',
    database,
    config.i18n.locales.map((locale) => entryPath(collection, slug, locale)),
    held ? session.user.id : null,
  );
  // Only the way off is an event: a hold is a promise to somebody else, and taking it off is
  // the half they would want to read about afterwards.
  if (!held) {
    await logActivity('default', database, {
      userId: session.user.id,
      kind: 'hold-released',
      subject: await entrySubject(collection, slug),
      detail: null,
    });
  }
  return Response.json({ held });
}

// What each of the entry's files was loaded against, path -> { sha, blob }: the rows in D1 and
// nothing from git, since a beat every 45 seconds per open tab is not a GitHub request. A
// language with no draft has no base of its own — the next save reads it.
async function entryBases(collection: string, slug: string) {
  const database = db();
  const found = await Promise.all(
    config.i18n.locales.map(async (locale) => {
      const path = entryPath(collection, slug, locale);
      const row = await loadDraft('default', database, path);
      return row ? ([path, { sha: row.baseSha, blob: row.baseBlob }] as const) : undefined;
    }),
  );
  return Object.fromEntries(found.filter((f) => f !== undefined));
}

// The `_` keys belong to the file, not to the form: `mergeEntry` reads them off the entry as
// it stands, so a browser posting `_status` must not be able to set it.
function editable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}

/**
 * Autosave of the default language, and of the structure every language shares: a block
 * added, moved or removed goes into the other languages' files in the same write, values
 * they own untouched.
 *
 * A draft holds what the editor typed, whether the schema accepts it yet or not: a new entry
 * in a collection with a required `reference` has no way to satisfy it from a form whose
 * widget is read-only, and refusing the write would throw the typed text away. What is missing
 * comes back named instead, and the publish is where the schema decides.
 *
 * No base comes from the browser: saveDraft reads it from git the first time it writes a row
 * and keeps it afterwards.
 */
async function autosave(
  collection: string,
  slug: string,
  request: Request,
  session: App.Locals['handover'],
  locale?: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || (locale !== undefined && !config.i18n.locales.includes(locale)))
    return new Response('Not found', { status: 404 });
  // The one write the lock enforces rather than draws, because it is the one that runs on its
  // own: after a take-over the tab that lost the entry keeps typing, and this is where it finds
  // out. The answer is the lock, so the screen can name who has it.
  const holder = await lockHolder('default', db(), `${collection}/${slug}`);
  if (holder && holder.userId !== session?.user.id)
    return Response.json(
      {
        held_by: { id: holder.userId, name: holder.name },
        mine: false,
        expires_at: holder.expiresAt,
      },
      { status: 409 },
    );
  const body = (await request.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const data = editable(body?.data);
  if (!data) return new Response('Bad request', { status: 400 });
  // Which file this is a save of: the second column names its language, and the form on screen
  // is the entry's own — which is not the site's default on an entry nobody wrote one in. The
  // server works it out rather than believing the tab, which may have been open since before
  // somebody else gave the entry a file in a language that outranks the one it is showing.
  const source = await sourceFor(collection, slug);
  if (!source) return new Response('Not found', { status: 404 });
  const at = locale ?? source;
  // A translation writes its own words into its own file and moves nothing; the language the
  // entry is written in is the one that carries the structure into the others. A site that
  // declares one language does neither, so its save is exactly the write it always was.
  const translation = at !== source;
  const siblings = translation ? {} : siblingPaths(collection, slug, source);
  let saved: Awaited<ReturnType<typeof saveDraft>>;
  try {
    saved = await saveDraft(
      'default',
      db(),
      gitClient(),
      entryPath(collection, slug, at),
      data,
      translation || Object.keys(siblings).length
        ? { form: formFor(collection, slug), locale: at, siblings, translation }
        : undefined,
    );
  } catch (err) {
    // A shape the serialiser cannot write back — a nested array above all — leaves nothing to
    // store, so this one is still a refusal, with the reason rather than "Bad request".
    return new Response(err instanceof Error ? err.message : 'Bad request', { status: 400 });
  }
  if (!saved) return new Response('Not found', { status: 404 });
  return Response.json({ ...saved, problems: entryProblems(schema, data) });
}

/**
 * Create from English: the missing language's file made from the one the entry is written in —
 * its structure and the values every language shares, none of its words. A draft like any
 * other, so nothing is in the repository until somebody publishes it.
 */
async function createTranslation(
  collection: string,
  slug: string,
  locale: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const loaded = await entryLocales(collection, slug, config.i18n.locales);
  // Including the language the entry is written in, which is the only guard that language now
  // needs: a missing default language is exactly what this route is for.
  if (loaded[locale]) return new Response('That language already has a file', { status: 409 });
  const source = sourceIn(loaded);
  const data = source === undefined ? undefined : loaded[source]?.data;
  if (data === undefined) return new Response('Not found', { status: 404 });
  const { offered, problems } = offeredIn(data, Object.keys(loaded));
  // A mark the files contradict is answered before the offer it would otherwise be read as.
  if (problems.length) return new Response(problems.join('\n'), { status: 409 });
  if (!offered.includes(locale))
    return new Response(`This entry is not offered in ${locale}`, { status: 409 });
  const form = formFor(collection, slug);
  const made = syncLocale('default', form, locale, { before: data, after: data }, {});
  if (offered.length < config.i18n.locales.length) made._locales = offered;
  await createDraft('default', db(), gitClient(), entryPath(collection, slug, locale), made);
  return Response.json({});
}

/**
 * A machine's first draft of one language, from the language the entry is written in. `paths`
 * names the fields to translate — one Translate button — and without it every field this
 * language has nothing in yet is filled, which is what pre-fill is.
 *
 * The answers land in `_machine`, so the badge stands until somebody types over the field: a
 * machine filling something and a person meaning it are different states of the same value.
 */
async function machineTranslate(
  collection: string,
  slug: string,
  locale: string,
  request: Request,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  // Before the entry is read at all: having nothing to translate with is about the site, so it
  // is the answer whatever else would have refused this one.
  const translate = translator();
  if (!translate)
    return new Response(
      'This site has nothing to translate with: set DEEPL_API_KEY, or an i18n.translate in cms.config.ts',
      { status: 409 },
    );
  const loaded = await entryLocales(collection, slug, config.i18n.locales);
  const from = sourceIn(loaded);
  const source = from === undefined ? undefined : loaded[from];
  if (!from || !source || from === locale || !loaded[locale])
    return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { paths?: unknown } | undefined;
  const named = Array.isArray(body?.paths) ? body.paths.map(String) : undefined;
  const form = formFor(collection, slug);
  // What this language has words in already: a pre-fill is for the gaps, and a Translate button
  // names the field it is on whether there is anything there or not.
  const written = new Set(
    translatableText('default', form, loaded[locale].data).map((v) => v.path),
  );
  const wanted = translatableText('default', form, source.data).filter((v) =>
    named ? named.includes(v.path) : !written.has(v.path),
  );
  if (wanted.length) {
    const answers = await translate(
      wanted.map((v) => v.text),
      from,
      locale,
    );
    await saveTranslated(
      'default',
      db(),
      gitClient(),
      entryPath(collection, slug, locale),
      Object.fromEntries(wanted.map((v, i) => [v.path, answers[i] ?? v.text])),
    );
  }
  // The column redraws from this rather than reloading the entry, so an edit in the other one
  // is not thrown away by a pre-fill.
  const after = await entryLocales(collection, slug, [locale]);
  return Response.json(after[locale] ?? {});
}

/**
 * The languages this entry is offered in. The mark goes into the files the entry does have, so
 * the entry list and the site read the decision out of the repository rather than out of D1.
 *
 * Turning off a language that has a file is a delete of that one file, and a delete commits:
 * the file goes, the mark goes into the files that stay, and the URL that language served sends
 * its readers to the collection's index, all in one commit. Turning off the last language an
 * entry has a file in is refused — that is a delete of the entry, and Delete is where the
 * redirect question is asked for all of it at once.
 */
async function offering(collection: string, slug: string, request: Request): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { locales?: unknown } | undefined;
  const wanted = Array.isArray(body?.locales) ? body.locales : [];
  const offered = config.i18n.locales.filter((locale) => wanted.includes(locale));
  const written = Object.keys(await entryLocales(collection, slug, config.i18n.locales));
  if (!written.length) return new Response('Not found', { status: 404 });
  const going = written.filter((locale) => !offered.includes(locale));
  const staying = written.filter((locale) => offered.includes(locale));
  const git = gitClient();
  const database = db();
  const files = going.length ? await entryFiles(git, collection, slug) : [];
  // What the entry is left with. A language whose file is only a draft cannot stand in for a
  // published one: discarding it afterwards would leave the entry with nothing, and this commit
  // has already taken the published file away.
  const published = files.filter((f) => f.file).map((f) => f.locale);
  const left = published.length ? published.filter((l) => !going.includes(l)) : staying;
  if (going.length && !left.length)
    return new Response(
      staying.length
        ? `Turning ${going.join(', ')} off would leave this entry with no published file: publish ${staying.join(', ')} first, or Delete the entry`
        : `Turning ${going.join(', ')} off would leave this entry with no file in any language: Delete the entry instead, which asks where its readers should go`,
      { status: 409 },
    );
  const pathsOf = (locales: string[]) => locales.map((l) => entryPath(collection, slug, l));
  if (published.some((locale) => going.includes(locale))) {
    const { commit_sha, kept } = await deleteLocales(
      'default',
      git,
      locationOf(collection),
      slug,
      going,
      offered,
      collected.index,
    );
    for (const { locale, path, file } of files) {
      if (!going.includes(locale)) continue;
      // A language that had a draft as well as a file loses both: the row would otherwise
      // publish the file the commit just removed.
      if (file) await recordDelete('default', database, path, commit_sha);
      else await discardDraft('default', database, path);
    }
    const offer = { offered, locales: config.i18n.locales, gone: going };
    for (const file of kept)
      await recordOffer('default', database, file.path, file.contents, offer, commit_sha);
    // A language that stays and has no file of its own yet — one Create from English drafted and
    // never published — is not in the commit, so its draft is where the mark goes.
    const drafted = staying.filter((l) => !files.some((f) => f.locale === l && f.file));
    if (drafted.length)
      await setEntryLocales(
        'default',
        database,
        git,
        pathsOf(drafted),
        offered,
        config.i18n.locales,
      );
    return Response.json({ commit_sha });
  }
  // Nothing that goes is in the repository, so there is nothing to commit and no URL anybody
  // could have followed: what Create from English left behind is thrown away, and the mark is
  // drafted the way it is for a language that never had a file.
  for (const { locale, path } of files)
    if (going.includes(locale)) await discardDraft('default', database, path);
  await setEntryLocales('default', database, git, pathsOf(staying), offered, config.i18n.locales);
  return Response.json({});
}

/**
 * Every address the collection could serve in this language, the entry's own left out. Each
 * other entry holds two: the address it has there, and its file name — which is what it falls
 * back to the moment somebody clears that address, so a name is never free to be taken.
 * Drafts count, exactly as they do for a file name.
 */
async function takenAddresses(collection: string, locale: string, slug: string): Promise<string[]> {
  const rows = await overlayRows('default', db(), index);
  return collectionEntries('default', index, collection, rows)
    .filter((entry) => entry.id !== slug)
    .flatMap((entry) => [entry.id, entry.locales[locale]?.slug ?? '']);
}

/**
 * The address one language serves this entry at: the `slug` key in that language's file, empty
 * putting it back under the file name. The file name does not move — it is the entry's id
 * across the languages, and renaming is the other action, with the other consequence.
 *
 * A published address that moves owes a redirect from where it was. It is stored against the
 * draft rather than committed now: the old URL is the live one until this is published.
 */
async function address(
  collection: string,
  slug: string,
  locale: string,
  request: Request,
): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected?.localizedSlugs || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { address?: unknown } | undefined;
  const wanted = typeof body?.address === 'string' ? body.address.trim() : '';
  const bad = addressError('default', wanted);
  if (bad) return new Response(bad, { status: 422 });
  const path = entryPath(collection, slug, locale);
  const git = gitClient();
  const [file, row] = await Promise.all([git.getFile(path), loadDraft('default', db(), path)]);
  if (!file && !row) return new Response('Not found', { status: 404 });
  // Empty falls back to the file name, so that is the address being claimed either way.
  const after = wanted || slug;
  if ((await takenAddresses(collection, locale, slug)).includes(after))
    return new Response(
      `${JSON.stringify(after)} is already the web address of another entry in ${collection} in ${locale}`,
      { status: 409 },
    );
  // Only a published address can have been followed, and only the collection's own route
  // gives it a URL to be followed at.
  const was = file ? entryAddress('default', parseEntry('default', file.contents), slug) : after;
  const from = entryUrl('default', config.i18n, collected.route, was, locale);
  const to = entryUrl('default', config.i18n, collected.route, after, locale);
  await setEntryAddress(
    'default',
    db(),
    git,
    // The whole form, `slug` included: `formFor` takes the address out of what the client
    // types into, but it is a key the schema declares and the file writes it where it says.
    formOf('default', formSchema(collected.schema)),
    path,
    wanted,
    from && to && from !== to ? { from, to, entry: `${collection}/${slug}` } : undefined,
  );
  return Response.json({});
}

/**
 * The answers to one entry's structural drift, one per block its languages disagree about.
 * They belong here and not in an autosave: that one carries the default language's values and
 * has no way to say a block comes out of German. Nothing is marked resolved — the entry is read
 * again afterwards, and the banner goes because the next report is empty.
 */
async function reconcile(collection: string, slug: string, request: Request): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { choices?: unknown } | undefined;
  const choices = (Array.isArray(body?.choices) ? body.choices : []).filter(
    (choice): choice is { path: string; locales: string[] } =>
      typeof choice?.path === 'string' &&
      Array.isArray(choice.locales) &&
      choice.locales.every((locale: unknown) => typeof locale === 'string'),
  );
  const form = formFor(collection, slug);
  const locales = localeData(await entryLocales(collection, slug, config.i18n.locales));
  const drift = new Set(driftReport('default', form, locales).map((row) => row.path));
  // A row the languages agree about has nothing to answer: the report moved on under the tab.
  if (!choices.length || choices.some((choice) => !drift.has(choice.path)))
    return new Response("Those are not the blocks this entry's languages disagree about", {
      status: 409,
    });
  await resolveDrift(
    'default',
    db(),
    gitClient(),
    form,
    config.i18n.locales,
    Object.fromEntries(Object.keys(locales).map((l) => [l, entryPath(collection, slug, l)])),
    choices,
  );
  return Response.json({});
}

/** Every language of one entry as a path, whether or not it has a file yet. */
const entryPaths = (collection: string, slug: string) =>
  Object.fromEntries(
    config.i18n.locales.map((locale) => [locale, entryPath(collection, slug, locale)]),
  );

/**
 * What one entry would put in the next commit, field by field: the drawer's expanded row. The
 * draft against the file at HEAD and not against the commit it was loaded from — the question
 * the row answers is what is about to go out, which is measured against what is there now.
 */
async function entryDiff(collection: string, slug: string): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const git = gitClient();
  const database = db();
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
 * The three-way view: what both sides started from, what only one of them changed and is
 * merged without asking, and the fields somebody has to answer. `409` when nothing of the
 * entry has moved in the repository, which is a drawer asking about a conflict already
 * settled — the same shape the drift answer's refusal has.
 */
async function conflictView(collection: string, slug: string): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const found = await entryConflict(
    'default',
    db(),
    gitClient(),
    formFor(collection, slug),
    entryPaths(collection, slug),
  );
  if (!found) return new Response(SETTLED, { status: 409 });
  return Response.json({
    head: found.head,
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
async function resolve(collection: string, slug: string, request: Request): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { answers?: unknown } | undefined;
  const answers = (Array.isArray(body?.answers) ? body.answers : []).filter(
    (answer): answer is Answer =>
      typeof answer?.path === 'string' &&
      (answer.side === 'ours' || answer.side === 'theirs') &&
      (answer.locale === undefined || typeof answer.locale === 'string'),
  );
  const form = formFor(collection, slug);
  const found = await entryConflict(
    'default',
    db(),
    gitClient(),
    form,
    entryPaths(collection, slug),
  );
  if (!found) return new Response(SETTLED, { status: 409 });
  const answering = (question: { path: string; locale?: string }) =>
    answers.filter((a) => a.path === question.path && (a.locale ?? '') === (question.locale ?? ''));
  if (
    answers.length !== found.questions.length ||
    found.questions.some((q) => answering(q).length !== 1)
  )
    return new Response('Those are not the fields this entry disagrees about', { status: 409 });
  await resolveConflict('default', db(), form, found, answers);
  return Response.json({});
}

// The titles come from the build, the pending edits from D1. Nothing here touches GitHub:
// listing a collection through the contents API is one request per file.
async function listEntries(collection: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const rows = await overlayRows('default', db(), index);
  // The same reading of `_locales` the editor does, so a language with a file is never struck
  // through in the list and typed in on the next screen.
  const entries = collectionEntries('default', index, collection, rows, collected.titleField).map(
    (entry) => {
      const { offered } = entryOffer(
        'default',
        config.i18n.locales,
        entry.offered,
        Object.keys(entry.locales),
      );
      // Absent when that is every language the site declares, as the built index has it.
      return {
        ...entry,
        offered: offered.length === config.i18n.locales.length ? undefined : offered,
      };
    },
  );
  return Response.json({
    entries,
    // Which languages the list draws a column for, and in which order — one language, no column.
    locales: config.i18n.locales,
  });
}

/**
 * The site settings screen: one card per global the site declares, in `cms.config.ts` order.
 * It costs what the entry list costs and nothing more — the built index with the draft rows
 * over it — because a global is an entry of the `globals` collection.
 */
async function globalsList(): Promise<Response> {
  const database = db();
  const [rows, waiting] = await Promise.all([
    overlayRows('default', database, index),
    pendingDrafts('default', database),
  ]);
  const pending = new Set(waiting.map((row) => row.path));
  const entries = collectionEntries('default', index, 'globals', rows);
  return Response.json({
    globals: Object.entries(config.globals ?? {}).map(([key, schema]) => {
      const found = entries.find((entry) => entry.id === key);
      const locales = Object.entries(found?.locales ?? {});
      return {
        ...globalLabel(key, schema),
        // Which languages have a file at all: the rest are the dashed chip that offers to make
        // one, the same answer the editor's own second column gives.
        locales: config.i18n.locales.filter((locale) => found?.locales[locale]),
        pending: locales.some(([, file]) => pending.has(file.path)),
      };
    }),
    locales: config.i18n.locales,
  });
}

/**
 * The drawer's list: one row per **entry**, never per file. Grouped and named here rather than
 * in the browser because a title comes from the build's content index, which only the Worker
 * can read — handing over paths would mean sending a title with each of them anyway.
 */
async function pendingList(): Promise<Response> {
  const database = db();
  const [rows, held, overlay] = await Promise.all([
    pendingDrafts('default', database),
    heldDrafts('default', database),
    overlayRows('default', database, index),
  ]);
  const titles = new Map<string, string>();
  // The entry list's own reading, so one entry is called the same thing on both screens: the
  // first language that has a title, whichever language that turns out to be.
  for (const collection of new Set(rows.flatMap((r) => ENTRY_FILE.exec(r.path)?.[1] ?? [])))
    for (const entry of collectionEntries(
      'default',
      index,
      collection,
      overlay,
      config.collections[collection]?.titleField,
    ))
      titles.set(
        `${collection}/${entry.id}`,
        config.i18n.locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
          Object.values(entry.locales)[0]?.title ||
          entry.id,
      );
  // A global has no title field to be named by, so it is named the way the site settings screen
  // names it — one entry, one name, on both screens.
  for (const [key, schema] of Object.entries(config.globals ?? {}))
    titles.set(`globals/${key}`, globalLabel(key, schema).label);
  type Row = {
    key: string;
    title: string;
    collection: string;
    locales: string[];
    files: string[];
    redirects?: number;
    updated_at: number;
    held_by: { id: string; name: string | null } | null;
  };
  const entries: Row[] = [];
  // Newest first, and the row that made an entry appear is the newest it has.
  for (const row of rows) {
    const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(row.path) ?? [];
    const key = entryKey(row.path) ?? row.path;
    let found = entries.find((e) => e.key === key);
    if (!found) {
      found = {
        key,
        title: titles.get(key) || slug || key,
        collection,
        locales: [],
        files: [],
        updated_at: row.updatedAt,
        held_by: held[key] ?? null,
      };
      entries.push(found);
    }
    found.files.push(row.path);
    if (locale) found.locales.push(locale);
    // What the entry owes for an address it moved. redirects.yaml is assembled at publish out
    // of the rules of the entries going out, so it is never a row of its own to list.
    const rules = row.pendingRedirects?.length ?? 0;
    if (rules) found.redirects = (found.redirects ?? 0) + rules;
  }
  for (const entry of entries)
    entry.locales = config.i18n.locales.filter((l) => entry.locales.includes(l));
  return Response.json({ entries });
}

/** Every name the collection already uses, published or only drafted. */
async function takenNames(collection: string, database: Db): Promise<string[]> {
  const rows = await overlayRows('default', database, index);
  return collectionEntries('default', index, collection, rows).map((e) => e.id);
}

// An entry is its file in every declared language: a rename or a delete moves all of them.
const locationOf = (collection: string): EntryLocation => ({
  collection,
  route: config.collections[collection]?.route,
  i18n: config.i18n,
  localizedSlugs: config.collections[collection]?.localizedSlugs,
});

/**
 * A new entry is a draft, not a commit: nothing is in the repository until it is published,
 * which is what lets the file name stay editable and keeps an abandoned entry out of git.
 * It starts empty apart from its title — a field the schema requires is left absent rather
 * than guessed at, and the editor is shown what is still missing until the publish.
 */
async function createEntry(collection: string, request: Request): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { title?: unknown } | undefined;
  const title = typeof body?.title === 'string' ? body.title : '';
  const database = db();
  const slug = entryName('default', title, await takenNames(collection, database));
  const { fields } = formOf('default', formSchema(collected.schema));
  // The field the collection lists by is the one the title typed into the dialog belongs in.
  const named = collected.titleField ?? 'title';
  const values: Record<string, unknown> = { _version: FORMAT_VERSION };
  if (fields.some((f) => f.path[0] === named && f.type === 'text')) values[named] = title;
  // The site's default language, and the one place it is still an entry's: a brand-new entry has
  // no file to be written in any other, so it starts in the language the site is written in.
  const path = entryPath(collection, slug, config.i18n.defaultLocale);
  await createDraft('default', database, gitClient(), path, values);
  return Response.json({ slug });
}

// The new name goes through the same derivation as a new entry's, so a rename can never
// produce a file name the CMS could not have created.
async function rename(collection: string, slug: string, request: Request): Promise<Response> {
  if (!config.collections[collection]) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { to?: unknown } | undefined;
  const database = db();
  const git = gitClient();
  const files = await entryFiles(git, collection, slug);
  if (!files.some((f) => f.file))
    return new Response('Publish this entry before renaming it', { status: 409 });
  const taken = (await takenNames(collection, database)).filter((id) => id !== slug);
  const to = entryName('default', typeof body?.to === 'string' ? body.to : '', taken);
  if (to === slug) return Response.json({ slug });
  const { commit_sha } = await renameEntry('default', git, locationOf(collection), slug, to);
  for (const { locale, path, file } of files) {
    if (!file) continue;
    await recordRename(
      'default',
      database,
      path,
      entryPath(collection, to, locale),
      file.contents,
      commit_sha,
    );
  }
  return Response.json({ slug: to, commit_sha });
}

// An entry that was never published has nothing to remove from the repository and no URL
// anyone could have followed, so it goes without a commit and without a redirect.
async function remove(collection: string, slug: string): Promise<Response> {
  const collected = config.collections[collection];
  if (!collected) return new Response('Not found', { status: 404 });
  const git = gitClient();
  const database = db();
  const files = await entryFiles(git, collection, slug);
  if (!files.some((f) => f.file)) {
    for (const { path } of files) await discardDraft('default', database, path);
    return Response.json({});
  }
  const result = await deleteEntry('default', git, locationOf(collection), slug, collected.index);
  for (const { path, file } of files)
    if (file) await recordDelete('default', database, path, result.commit_sha);
  return Response.json(result);
}

// The way out of a publish conflict: the entry gives up its draft and is read from the
// repository again on the next open. Taking theirs whole — picking field by field is later.
async function discard(collection: string, slug: string): Promise<Response> {
  if (!schemaOf(collection, slug)) return new Response('Not found', { status: 404 });
  const database = db();
  // Every language of it: the others hold the structure this edit gave them.
  for (const locale of config.i18n.locales)
    await discardDraft('default', database, entryPath(collection, slug, locale));
  return Response.json({});
}

/**
 * Where the last commit the admin made has got to. **The state is the server's**, read from the
 * activity log rather than kept in the drawer: a publish redeploys the Worker serving `/admin`,
 * so the tab that pressed Publish may be reloaded before the build finishes and whatever it was
 * holding would go with it. Every screen asks this and gets the same answer.
 *
 * `{}` where the site has no token — the pill is not drawn at all rather than drawn as an
 * unknown, since a site without build status is an ordinary site. A site that has **published
 * nothing yet** does get an answer, from the worker's newest build: there is no commit of ours to
 * ask about, but the site is still serving something and a blank top bar is the wrong reading of
 * it. That answer carries no `commit_sha`, so nothing offers to revert a developer's own deploy.
 */
async function buildStatus(): Promise<Response> {
  const database = db();
  const last = await lastCommit('default', database);
  const builds = workerBuilds();
  if (!builds) return Response.json({});
  let status: Awaited<ReturnType<typeof commitBuild>>;
  try {
    status = await commitBuild(builds, last?.sha);
  } catch (err) {
    // A token that cannot ask is the site's configuration, not a state the site is in. It is
    // said once in the log the deploy reads and answered as no pill at all.
    console.error('build status: the Workers Builds API could not be asked', err);
    return Response.json({});
  }
  // Rule 3 of "your own publish must not look like a conflict" runs here, because this is the
  // one moment the Worker learns the build went green: the rows go once nobody is in the entry.
  if (last && status.state === 'live') await clearPublished('default', database, last.sha);
  return Response.json(last ? { ...status, committed_at: last.at } : status);
}

/**
 * One commit undone. `commit_sha` is the body's, so this works over any commit the admin made
 * and not only the last one; `409` with `{ error, paths }` when one of its files has moved on
 * since, which is the one thing an inverse composed against HEAD cannot decide on its own.
 */
async function revert(request: Request, session: App.Locals['handover']): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as
    | { commit_sha?: unknown }
    | undefined;
  const sha = typeof body?.commit_sha === 'string' ? body.commit_sha : '';
  if (!sha) return new Response('A commit_sha is needed to revert', { status: 400 });
  const database = db();
  const result = await revertCommit('default', database, gitClient(), sha);
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'revert',
    detail: { of: sha, files: result.paths.length },
    commitSha: result.commit_sha,
  });
  return Response.json(result);
}

const MEMBER = /^members\/([\w-]+)$/;
const MEMBER_ROLE = /^members\/([\w-]+)\/role$/;
const MEMBER_INVITE = /^members\/([\w-]+)\/invite$/;
const ENTRIES = /^entries\/([\w-]+)$/;
const ENTRY = /^entries\/([\w-]+)\/([\w-]+)$/;
const DRAFT = /^drafts\/([\w-]+)\/([\w-]+)$/;
const TRANSLATION = /^drafts\/([\w-]+)\/([\w-]+)\/([\w-]+)$/;
const RENAME = /^entries\/([\w-]+)\/([\w-]+)\/rename$/;
const LOCALES = /^entries\/([\w-]+)\/([\w-]+)\/locales$/;
const ADDRESS = /^entries\/([\w-]+)\/([\w-]+)\/address\/([\w-]+)$/;
const DRIFT = /^drift\/([\w-]+)\/([\w-]+)$/;
const DIFF = /^diff\/([\w-]+)\/([\w-]+)$/;
const CONFLICT = /^conflict\/([\w-]+)\/([\w-]+)$/;
const LOCK = /^locks\/([\w-]+)\/([\w-]+)$/;
const HOLD = /^hold\/([\w-]+)\/([\w-]+)$/;
const MEDIA = /^media\/([0-9a-f]{64})$/;
const TRANSLATE = /^translate\/([\w-]+)\/([\w-]+)\/([\w-]+)$/;

// Better Auth owns everything under its base path. Both verbs go straight to its handler:
// the middleware exempts these paths, so this is the only thing in front of the login.
const mounted = (pathname: string) => pathname.startsWith(`${AUTH_BASE_PATH}/`);

export const GET: APIRoute = async ({ params, request, url, locals }) => {
  if (mounted(url.pathname)) return createAuth(url, locals.cfContext).handler(request);
  if (params.path === 'account') return account(locals.handover);
  if (params.path === 'activity') return activityLog(url, locals.handover);
  if (params.path === 'members') return members(locals.handover);
  if (params.path === 'ping') {
    return Response.json({
      ok: true,
      collections: Object.keys(config.collections),
      // Whether the site declares any site-wide content at all: with none there is nothing for
      // a Site settings screen to list, so the sidebar does not offer one.
      globals: Object.keys(config.globals ?? {}).length > 0,
      // The middleware has already asserted a session by the time any of this runs.
      user: locals.handover?.user,
      role: locals.handover?.role,
      // Where a media key is served from. The widgets need it for a value the picker did not
      // hand them — everything already in a content file.
      mediaBase: config.media?.publicBase?.replace(/\/$/, ''),
    });
  }
  if (params.path === 'media') return library(url);
  if (params.path === 'globals') return globalsList();
  if (params.path === 'drafts') return pendingList();
  if (params.path === 'build') return buildStatus();
  const held = params.path?.match(LOCK);
  if (held) return lockState(held[1] ?? '', held[2] ?? '', locals.handover, 'read');
  const changed = params.path?.match(DIFF);
  if (changed) return answering(() => entryDiff(changed[1] ?? '', changed[2] ?? ''));
  const against = params.path?.match(CONFLICT);
  if (against) return answering(() => conflictView(against[1] ?? '', against[2] ?? ''));
  const entry = params.path?.match(ENTRY);
  if (entry) return answering(() => getEntry(entry[1] ?? '', entry[2] ?? ''));
  const list = params.path?.match(ENTRIES);
  if (list) return listEntries(list[1] ?? '');
  return new Response('Not found', { status: 404 });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const translated = params.path?.match(TRANSLATION);
  if (translated)
    return answering(() =>
      autosave(translated[1] ?? '', translated[2] ?? '', request, locals.handover, translated[3]),
    );
  const draft = params.path?.match(DRAFT);
  if (draft)
    return answering(() => autosave(draft[1] ?? '', draft[2] ?? '', request, locals.handover));
  const uploaded = params.path?.match(MEDIA);
  if (uploaded) return answering(() => finishUpload(uploaded[1] ?? '', request, locals.handover));
  return new Response('Not found', { status: 404 });
};

// `src/content/<collection>/<locale>/<slug>.yaml`. redirects.yaml belongs to no collection and
// has no schema to be held to; a global's is its own, keyed by the file name.
const schemaFor = (path: string) => {
  const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
  return schemaOf(collection, slug);
};

const ENTRY_FILE = /^src\/content\/([a-z0-9-]+)\/([^/]+)\/([^/]+)\.yaml$/;

/**
 * Which language a file this publish is about to commit was translated from: the file of the
 * language its entry is written in, and the form that says which of its values a translation is
 * made from. Nothing for that language's own file, and nothing for a path no collection owns —
 * a global has no schema, so no form. On a site that declares one language it is always nothing,
 * which is what keeps such a site's publish the read-free write it always was.
 */
const sourceOf = async (path: string) => {
  const [, collection = '', locale = '', slug = ''] = ENTRY_FILE.exec(path) ?? [];
  const schema = schemaOf(collection, slug);
  if (!schema || !locale || config.i18n.locales.length < 2) return undefined;
  const source = await sourceFor(collection, slug);
  if (!source || source === locale) return undefined;
  return {
    locale: source,
    path: entryPath(collection, slug, source),
    form: formFor(collection, slug),
  };
};

/**
 * Which of these files belong to an entry whose languages have drifted apart. The one refusal
 * besides the schema: the structure is shared, so committing a file that disagrees with its
 * other languages would bake the difference into git, and which side is right is a decision
 * somebody makes. A site with one language never has a second file to disagree with.
 */
async function driftedPaths(paths: string[]): Promise<string[]> {
  if (config.i18n.locales.length < 2) return [];
  // One entry is one check, however many of its languages are waiting to be published.
  const entries = new Map<string, string[]>();
  for (const path of paths) {
    const [, collection = '', , slug = ''] = ENTRY_FILE.exec(path) ?? [];
    if (!collection) continue;
    const key = `${collection}/${slug}`;
    entries.set(key, [...(entries.get(key) ?? []), path]);
  }
  const drifted: string[] = [];
  for (const [key, files] of entries) {
    const [collection = '', slug = ''] = key.split('/');
    // A path nothing owns — redirects.yaml — has no schema, so no form and no structure.
    const schema = schemaOf(collection, slug);
    if (!schema) continue;
    const form = formFor(collection, slug);
    const locales = localeData(await entryLocales(collection, slug, config.i18n.locales));
    if (driftReport('default', form, locales).length) drifted.push(...files);
  }
  return drifted;
}

/**
 * One commit, of every draft that differs from the repository or of the entries the body names.
 * The rows it committed are re-seeded on it rather than deleted, so an editor who carries on
 * typing is measured against what was published and not against whatever HEAD is by then.
 *
 * The schema decides here rather than at every keystroke, so a blank new entry cannot commit
 * a file the site's own content schema rejects and break the build behind it. The set is read
 * again inside publishDrafts; a draft written between the two reads is a window this phase
 * accepts, since the entry it belongs to is the one whose tab is doing the publishing.
 */
async function publish(request: Request, session: App.Locals['handover']): Promise<Response> {
  const database = db();
  // The drawer's Publish sends no body at all, which is not a parse failure but is read as one.
  const body = (await request.json().catch(() => undefined)) as { entries?: unknown } | undefined;
  // The entries this publish is of, or nothing for all of them. Anything that is not a string is
  // not an entry key and would only ever match nothing.
  const chosen = Array.isArray(body?.entries)
    ? body.entries.filter((e): e is string => typeof e === 'string')
    : undefined;
  // The same set the commit will be made of, held to the schema before anything is written: an
  // entry nobody chose is not in this commit, so it is not this commit's job to hold it to the
  // schema either — and a held entry that *was* chosen is, since it is going out.
  const pending = await readyDrafts('default', database, chosen);
  // Who was holding what, read while the holds are still there: the publish releases them.
  const holders = chosen?.length ? await heldDrafts('default', database) : {};
  const unready = pending.filter((row) => {
    const schema = schemaFor(row.path);
    return schema && row.contents
      ? entryProblems(schema, parseEntry('default', row.contents)).length > 0
      : false;
  });
  if (unready.length) {
    const paths = unready.map((r) => r.path);
    return Response.json(
      {
        error:
          paths.length === 1
            ? `${paths[0]} is missing something the schema needs`
            : `${paths.length} files are missing something the schema needs — ${paths.join(', ')}`,
        paths,
      },
      { status: 422 },
    );
  }
  const drifted = await driftedPaths(pending.map((row) => row.path));
  if (drifted.length) {
    return Response.json(
      {
        error:
          drifted.length === 1
            ? `${drifted[0]} has drifted apart from the entry's other languages — resolve it in the editor`
            : `${drifted.length} files have drifted apart from their entries' other languages — ${drifted.join(', ')}`,
        paths: drifted,
        // Which 409 this is: the drawer's way out of a conflict is Discard, and this one's is
        // the editor.
        reason: 'drift',
      },
      { status: 409 },
    );
  }
  let result: Awaited<ReturnType<typeof publishDrafts>>;
  try {
    result = await publishDrafts('default', database, gitClient(), sourceOf, chosen);
  } catch (err) {
    // A publish the repository refused is somebody else's work getting in the way of this one —
    // the file that moved, or the branch that did — and that is what an owner reads the log for.
    // A schema or a drift refusal is not: it is the state of this person's own drafts, and it is
    // answered to them in the same response.
    const conflict = err instanceof DraftConflictError;
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: conflict ? 'publish-conflict' : 'publish-failed',
      // One file is an entry somebody can open; several are a list the 409 already carries.
      subject: conflict && err.paths.length === 1 ? (err.paths[0] ?? null) : null,
      detail: conflict
        ? { files: err.paths.length }
        : { files: pending.length, reason: err instanceof RefMovedError ? 'ref-moved' : 'refused' },
    });
    throw err;
  }
  // A hold this publish went through is released, and that is the half the person who set it
  // would want to read about afterwards — the same event the toggle writes.
  for (const entry of result?.released ?? []) {
    const [collection = '', slug = ''] = entry.split('/');
    const from = holders[entry]?.name;
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'hold-released',
      subject: await entrySubject(collection, slug),
      detail: from ? { from } : null,
    });
  }
  // Only a commit is an event. A Publish click with nothing pending is not one, and spending a
  // D1 write on it is how one busy editor costs a site its day's budget.
  if (result?.commit_sha) {
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'publish',
      // One file is an entry somebody can open; a batch is the commit, and the paths are not
      // small json.
      subject: result.paths.length === 1 ? (result.paths[0] ?? null) : null,
      detail: { files: result.paths.length },
      commitSha: result.commit_sha,
    });
  }
  return Response.json(result ?? { paths: [] });
}

/** What the browser is handed for one asset: the key a content file stores, and where it is served from. */
function mediaItem(row: MediaRow) {
  const base = config.media?.publicBase?.replace(/\/$/, '');
  return {
    id: row.id,
    src: row.r2Key,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    ...(base ? { url: `${base}/${row.r2Key}` } : {}),
  };
}

/** The library the picker browses, of the kind the field that opened it takes. */
async function library(url: URL): Promise<Response> {
  const kind = url.searchParams.get('kind') === 'files' ? 'files' : 'images';
  return Response.json({ media: (await mediaList('default', db(), kind)).map(mediaItem) });
}

/** The declaration both halves of an upload are made against; the url's hash wins over the body's. */
function declaredUpload(body: unknown, hash?: string): Upload | undefined {
  const sent = body as Record<string, unknown> | undefined;
  const id = hash ?? sent?.hash;
  if (typeof id !== 'string' || typeof sent?.bytes !== 'number' || typeof sent.mime !== 'string')
    return undefined;
  const size = (value: unknown) => (typeof value === 'number' ? value : undefined);
  return {
    hash: id,
    bytes: sent.bytes,
    mime: sent.mime,
    filename: typeof sent.filename === 'string' ? sent.filename : undefined,
    width: size(sent.width),
    height: size(sent.height),
  };
}

/**
 * "Do you have these bytes?", and where the site does not, the url to put them at. One question
 * rather than two: the answer to the first is what decides whether the second is worth asking,
 * and bytes the site already holds cost the client's uplink nothing at all.
 */
async function askUpload(request: Request): Promise<Response> {
  const store = mediaStore();
  if (!store) return Response.json({ error: NO_BUCKET }, { status: 503 });
  const upload = declaredUpload(await request.json().catch(() => undefined));
  if (!upload)
    return Response.json({ error: 'an upload declares { hash, bytes, mime }' }, { status: 400 });
  const known = await findMedia('default', db(), upload.hash);
  if (known) return Response.json({ media: mediaItem(known) });
  const key = mediaKey(upload);
  return Response.json({ upload: { key, url: await presignUpload(store, key) } });
}

/**
 * The upload is over: what arrived is held to what was declared, and only then is there a row.
 * The browser is not asked to be honest about any of it — the object is read from the bucket.
 */
async function finishUpload(
  hash: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const store = mediaStore();
  if (!store) return Response.json({ error: NO_BUCKET }, { status: 503 });
  const upload = declaredUpload(await request.json().catch(() => undefined), hash);
  if (!upload)
    return Response.json({ error: 'an upload declares { hash, bytes, mime }' }, { status: 400 });
  const database = db();
  const { media, created } = await confirmUpload('default', database, store, upload);
  // Bytes the site already had are a reuse, not an upload, and a row per re-pick would fill the
  // log with the same picture.
  if (created)
    await logActivity('default', database, {
      userId: session?.user.id,
      kind: 'upload',
      subject: media.id,
      detail: { name: media.filename, bytes: media.bytes },
    });
  return Response.json({ media: mediaItem(media) });
}

// Every route answers the same way when git refuses, whether it was reading or committing.
async function answering(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // The repository is out of reach for every path, so this is about the installation and
    // not about whatever entry happened to be open — hence the message rather than a 404.
    if (err instanceof RepoUnreachableError) return new Response(err.message, { status: 503 });
    // A conflict names its files as data as well as prose: the drawer badges those rows and
    // offers each one the way out. A ref that moved has no file to name.
    if (err instanceof DraftConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    // A revert refused over a file that moved names it the same way a publish's conflict does,
    // and the drawer says so on the panel the button sits on.
    if (err instanceof RevertConflictError)
      return Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof RefMovedError) return new Response(err.message, { status: 409 });
    // An upload the site will not take is the chooser's own file rather than somebody else's
    // work, so it is answered to them, named by the rule it broke.
    if (err instanceof UploadRefusedError)
      return Response.json({ error: err.message }, { status: 422 });
    throw err;
  }
}

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  if (mounted(url.pathname)) return createAuth(url, locals.cfContext).handler(request);
  if (params.path === 'checks/email') return testEmail(locals.handover);
  if (params.path === 'checks/conflict') return answering(() => simulateConflict(locals.handover));
  if (params.path === 'account/set-password')
    return setPassword(request, url, locals.cfContext, locals.handover);
  if (params.path === 'members') return invite(request, url, locals.cfContext, locals.handover);
  const roled = params.path?.match(MEMBER_ROLE);
  if (roled) return setMemberRole(roled[1] ?? '', request, url, locals.cfContext, locals.handover);
  const resent = params.path?.match(MEMBER_INVITE);
  if (resent) return resendInvite(resent[1] ?? '', request, url, locals.cfContext, locals.handover);
  if (params.path === 'media') return answering(() => askUpload(request));
  if (params.path === 'publish') return answering(() => publish(request, locals.handover));
  if (params.path === 'revert') return answering(() => revert(request, locals.handover));
  const beat = params.path?.match(LOCK);
  if (beat) {
    const body = (await request.json().catch(() => undefined)) as { take?: unknown } | undefined;
    return lockState(
      beat[1] ?? '',
      beat[2] ?? '',
      locals.handover,
      body?.take === true ? 'take' : 'beat',
    );
  }
  const holding = params.path?.match(HOLD);
  if (holding) return hold(holding[1] ?? '', holding[2] ?? '', request, locals.handover);
  const filling = params.path?.match(TRANSLATE);
  if (filling)
    return answering(() =>
      machineTranslate(filling[1] ?? '', filling[2] ?? '', filling[3] ?? '', request),
    );
  const made = params.path?.match(TRANSLATION);
  if (made) return answering(() => createTranslation(made[1] ?? '', made[2] ?? '', made[3] ?? ''));
  const addressed = params.path?.match(ADDRESS);
  if (addressed)
    return answering(() =>
      address(addressed[1] ?? '', addressed[2] ?? '', addressed[3] ?? '', request),
    );
  const offered = params.path?.match(LOCALES);
  if (offered) return answering(() => offering(offered[1] ?? '', offered[2] ?? '', request));
  const settling = params.path?.match(CONFLICT);
  if (settling) return answering(() => resolve(settling[1] ?? '', settling[2] ?? '', request));
  const answered = params.path?.match(DRIFT);
  if (answered) return answering(() => reconcile(answered[1] ?? '', answered[2] ?? '', request));
  const renamed = params.path?.match(RENAME);
  if (renamed) return answering(() => rename(renamed[1] ?? '', renamed[2] ?? '', request));
  const created = params.path?.match(ENTRIES);
  if (created) return answering(() => createEntry(created[1] ?? '', request));
  return new Response('Not found', { status: 404 });
};

export const DELETE: APIRoute = async ({ params, request, url, locals }) => {
  const member = params.path?.match(MEMBER);
  if (member) return removeMember(member[1] ?? '', request, url, locals.cfContext, locals.handover);
  const draft = params.path?.match(DRAFT);
  if (draft) return discard(draft[1] ?? '', draft[2] ?? '');
  const entry = params.path?.match(ENTRY);
  if (entry) return answering(() => remove(entry[1] ?? '', entry[2] ?? ''));
  return new Response('Not found', { status: 404 });
};
