import config from 'virtual:handover/config';
import type { Role } from '@handover/core';
import {
  accountFacts,
  activityPage,
  demoteOwner,
  heldEntries,
  logActivity,
  memberApi,
  memberList,
  releaseLocks,
} from '@handover/core';
import { createAuth, mailer } from '../../auth.js';
import { entryTitle } from './content.js';
import type { RequestContext } from './context.js';
import { missingMailer } from './environment.js';

/**
 * The signed-in person's own account, and the only two facts the page cannot work out for
 * itself: whether a password exists, and where else they are signed in. Everything else it
 * does — the name, changing a password, signing out everywhere — is a Better Auth endpoint
 * the browser calls directly.
 */
export async function account(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  return Response.json(await accountFacts('default', ctx.db(), session.user.id, session.sessionId));
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
export async function setPassword(
  ctx: RequestContext,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  const { newPassword } = (await request.json()) as { newPassword?: unknown };
  if (typeof newPassword !== 'string')
    return Response.json({ error: 'No password was sent' }, { status: 400 });
  try {
    await createAuth(url, cfContext).api.setPassword({
      body: { newPassword },
      headers: request.headers,
    });
    await logActivity('default', ctx.db(), {
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
export async function activityLog(
  ctx: RequestContext,
  url: URL,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  const asked = url.searchParams;
  return Response.json(
    await activityPage(
      'default',
      ctx.db(),
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
export async function members(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const database = ctx.db();
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
export async function invite(
  ctx: RequestContext,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
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
  const auth = createAuth(url, cfContext, { invite: true });
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
    await logActivity('default', ctx.db(), {
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
      body: { email, callbackURL: `${(config.i18n.base ?? '').replace(/\/+$/, '')}/admin/account` },
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
export async function resendInvite(
  ctx: RequestContext,
  id: string,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  // The list rather than one row, because `pending` is computed from three tables and this is
  // the one place that knows how. A members table is tens of rows, not thousands.
  const member = (await memberList('default', ctx.db())).find((row) => row.id === id);
  if (!member) return new Response('Not found', { status: 404 });
  if (!member.pending)
    return Response.json({ error: 'They have already signed in' }, { status: 400 });
  const send = mailer();
  if (!send) return Response.json({ error: missingMailer() }, { status: 503 });
  try {
    await memberApi('default', createAuth(url, cfContext, { invite: true })).signInMagicLink({
      body: {
        email: member.email,
        callbackURL: `${(config.i18n.base ?? '').replace(/\/+$/, '')}/admin/account`,
      },
      headers: request.headers,
    });
  } catch {
    return Response.json({ error: 'invite-not-sent', to: member.email }, { status: 502 });
  }
  return Response.json({ ok: true, to: member.email });
}

/**
 * Owner ↔ editor. Two rules are this site's and not Better Auth's: nobody changes their own
 * role, since an owner who demotes themselves has just locked themselves out of the screen that
 * could undo it, and the last owner may not be demoted, since `setRole` will happily leave a
 * site with nobody who can manage it.
 */
export async function setMemberRole(
  ctx: RequestContext,
  id: string,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  if (id === session.user.id)
    return Response.json({ error: 'You cannot change your own role' }, { status: 400 });
  const role = roleIn(await request.json().catch(() => ({})));
  if (!role) return Response.json({ error: 'That is not a role' }, { status: 400 });
  const database = ctx.db();
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
      await memberApi('default', createAuth(url, cfContext)).setRole({
        body: { userId: id, role },
        headers: request.headers,
      });
    } catch (err) {
      return refused(err);
    }
  }
  // Named in the row as well as by id: the dashboard draws these without the member list, which
  // only an owner is given, and a member since renamed or removed still reads as themselves.
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'role-change',
    subject: id,
    detail: { role, name: member.name || member.email },
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
export async function removeMember(
  ctx: RequestContext,
  id: string,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  if (id === session.user.id)
    return Response.json({ error: 'You cannot remove yourself' }, { status: 400 });
  const database = ctx.db();
  const member = (await memberList('default', database)).find((row) => row.id === id);
  if (!member) return new Response('Not found', { status: 404 });
  // The same statement, used as the claim: an owner is taken out of the count before they are
  // taken out of the table, so two owners removing each other cannot both win. If the delete
  // then fails they are an editor rather than an owner, which is the safe direction to fail in.
  if (member.role === 'owner' && !(await demoteOwner('default', database, id)))
    return Response.json({ error: 'There must be at least one owner' }, { status: 400 });
  try {
    await memberApi('default', createAuth(url, cfContext)).removeUser({
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
