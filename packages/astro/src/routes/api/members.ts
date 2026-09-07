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

/** Only the facts the page cannot work out itself; everything else is a Better Auth endpoint. */
export async function account(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (!session) return new Response('Unauthorized', { status: 401 });
  return Response.json(await accountFacts('default', ctx.db(), session.user.id, session.sessionId));
}

/** Better Auth's own refusal; anything without a code is not its answer and is rethrown. */
function refused(err: unknown): Response {
  const body = (err as { body?: { code?: string; message?: string } }).body;
  if (!body?.code) throw err;
  return Response.json({ error: body.message ?? body.code }, { status: 400 });
}

/** Better Auth's `setPassword` is server-only and refuses when a password already exists. */
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

/** Filtered per role, not gated: an editor's id comes off the session, never the query string. */
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

/** Owner-only, asserted here rather than trusted from the sidebar. */
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
  // Named rather than counted: the remove dialog says which entries go quiet.
  return Response.json({
    members: rows.map((row) => ({ ...row, editing: (held[row.id] ?? []).map(entryTitle) })),
  });
}

/** Two literals only: the admin plugin joins an array with commas and grants on any segment. */
const roleIn = (body: unknown): Role | undefined => {
  const { role } = (body ?? {}) as { role?: unknown };
  return role === 'owner' || role === 'editor' ? role : undefined;
};

/** The row is written before the mail is tried, so a failed send leaves a resendable invite. */
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
    // Three named values: a spread body could reach the `data` record that writes user columns.
    const created = await memberApi('default', auth).createUser({
      body: { email: body.email.trim(), name: '', role },
      headers: request.headers,
    });
    email = created.user.email;
    // Before the send: an invite whose mail failed is the one the owner most needs a record of.
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
    // The person reading this screen is told what to do; the provider's words are in the log.
    return Response.json({ error: 'invite-not-sent', to: email }, { status: 502 });
  }
  return Response.json({ ok: true, to: email });
}

/** Only for somebody who has never signed in; a member who has wants the login's own link. */
export async function resendInvite(
  ctx: RequestContext,
  id: string,
  request: Request,
  url: URL,
  cfContext: App.Locals['cfContext'],
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  // The list rather than one row: `pending` is computed from three tables, and only here.
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

/** Two rules are this site's: nobody changes their own role, and the last owner stays. */
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
  // Demoting an owner runs in the statement that holds the rule, not `setRole` behind a count.
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
  // Named as well as by id: the dashboard draws these without the member list.
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'role-change',
    subject: id,
    detail: { role, name: member.name || member.email },
  });
  return Response.json({ ok: true });
}

/** Sessions and accounts go with the row; drafts stay, since a draft belongs to the site. */
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
  // An owner leaves the count before the table, so two owners removing each other can't both win.
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
  // Their sessions went with the row; release their entries so nobody waits on them.
  await releaseLocks('default', database, id);
  // The `user` row is gone by the time anybody reads this, so the address lives in the event.
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'member-removed',
    subject: id,
    detail: { email: member.email, role: member.role, pending: member.pending },
  });
  return Response.json({ ok: true });
}
