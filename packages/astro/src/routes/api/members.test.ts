import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { DELETE, GET, POST } from '../api.js';
import {
  calls,
  ctx,
  demoted,
  editor,
  fakeMailer,
  logged,
  type MemberRow,
  owner,
  released,
  sent,
  state,
} from './harness.fixture.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./harness.fixture.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../../auth.js', async (original) =>
  authMock((await original()) as Record<string, unknown>),
);
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

test('the account route refuses a caller with no session', async () => {
  const res = await GET(ctx('account', undefined, {}));
  expect(res.status).toBe(401);
});

// The path carries no id, and neither may the answer.
test("the account route reads the session's own user, never the request's", async () => {
  const url = new URL('https://x/admin/api/account?userId=u9&sessionId=s9');
  const res = await GET({
    params: { path: 'account' },
    url,
    locals: { handover: { ...owner, sessionId: 's1' } },
  } as unknown as APIContext);

  expect(res.status).toBe(200);
  expect(state.asked).toEqual(['u1', 's1']);
});

// The page offers the form only when Better Auth has the change mounted, or it could only fail.
test('the account route offers an email change only when the site can mail the links', async () => {
  const offered = async () =>
    (
      (await (
        await GET(ctx('account', undefined, { handover: { ...owner, sessionId: 's1' } }))
      ).json()) as { canChangeEmail: boolean }
    ).canChangeEmail;
  state.siteMailer = fakeMailer;
  expect(await offered()).toBe(false);

  state.baseUrl = 'https://demo.example';

  expect(await offered()).toBe(true);
});

const setting = (body: string) =>
  POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', { method: 'POST', body }),
      { handover: { ...owner, sessionId: 's1' } },
    ),
  );

test('setting a password with nothing in the body says so', async () => {
  const res = await setting('{}');
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('No password was sent');
});

// The account page shows the sentence, so which rule was broken has to survive the route.
test("a refused password comes back in Better Auth's own words", async () => {
  state.setPassword = async () => {
    throw { body: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } };
  };
  const res = await setting(JSON.stringify({ newPassword: 'beach' }));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'Password too short', code: 'PASSWORD_TOO_SHORT' });
});

test('a password Better Auth accepts answers ok', async () => {
  const res = await setting(JSON.stringify({ newPassword: 'a-brand-new-password' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

// A throw with no code is not Better Auth refusing.
test('an error that is not a refusal is not turned into one', async () => {
  state.setPassword = async () => {
    throw new Error('D1 is unreachable');
  };
  await expect(setting(JSON.stringify({ newPassword: 'a-brand-new-password' }))).rejects.toThrow(
    'D1 is unreachable',
  );
});

// Member routes.

const member = (
  id: string,
  email: string,
  role: string,
  extra: Partial<MemberRow> = {},
): MemberRow => ({
  id,
  name: '',
  email,
  role,
  pending: false,
  method: 'link',
  lastSignIn: 1,
  invitedAt: 0,
  ...extra,
});

const memberPost = (path: string, body: unknown, session?: unknown) =>
  POST(
    ctx(
      path,
      new Request(`https://x/admin/api/${path}`, { method: 'POST', body: JSON.stringify(body) }),
      {
        handover: session,
      },
    ),
  );
const memberDelete = (path: string, session?: unknown) =>
  DELETE(
    ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'DELETE' }), {
      handover: session,
    }),
  );

test("the members list is the owner's and nobody else's", async () => {
  state.memberRows = [member('u1', 'martin@example.com', 'owner')];

  const asOwner = await GET(ctx('members', undefined, { handover: owner }));
  const asEditor = await GET(ctx('members', undefined, { handover: editor }));

  expect(asOwner.status).toBe(200);
  expect(await asOwner.json()).toEqual({
    members: [{ ...state.memberRows[0], editing: [] }],
  });
  expect(asEditor.status).toBe(403);
});

test('the members list says what each of them is editing, by the name on the entry', async () => {
  state.memberRows = [member('u1', 'martin@example.com', 'owner')];
  state.editing = { u1: ['listings/seaview-cottage', 'listings/nowhere'] };

  const res = await GET(ctx('members', undefined, { handover: owner }));

  // The index knows the first and has never seen the second.
  expect(((await res.json()) as { members: { editing: string[] }[] }).members[0]?.editing).toEqual([
    'Seaview Cottage',
    'nowhere',
  ]);
});

test('an editor cannot invite, change a role, resend an invite or remove anybody', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];
  state.siteMailer = fakeMailer;

  const invited = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, editor);
  const roled = await memberPost('members/u2/role', { role: 'owner' }, editor);
  const resent = await memberPost('members/u2/invite', {}, editor);
  const removed = await memberDelete('members/u2', editor);

  expect([invited.status, roled.status, resent.status, removed.status]).toEqual([
    403, 403, 403, 403,
  ]);
  expect(calls.createUser).toEqual([]);
  expect(calls.setRole).toEqual([]);
  expect(calls.removeUser).toEqual([]);
  expect(sent).toEqual([]);
});

test('an invite creates one row and mails exactly one address', async () => {
  state.siteMailer = fakeMailer;

  const res = await memberPost('members', { email: ' Lea@Example.com ', role: 'editor' }, owner);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, to: 'lea@example.com' });
  expect(calls.createUser).toEqual([
    { body: { email: 'Lea@Example.com', name: '', role: 'editor' }, invite: true },
  ]);
  expect(calls.signInMagicLink).toEqual([
    { body: { email: 'lea@example.com', callbackURL: '/admin/account' }, invite: true },
  ]);
});

// The endpoint also takes a `data` record that writes user columns directly.
test('an invite carries the three values it is allowed to and nothing else the body holds', async () => {
  state.siteMailer = fakeMailer;

  const res = await memberPost(
    'members',
    {
      email: 'lea@example.com',
      role: 'editor',
      data: { role: 'owner', banned: true },
      name: 'Lea',
    },
    owner,
  );

  expect(res.status).toBe(200);
  expect(calls.createUser?.[0]?.body).toEqual({
    email: 'lea@example.com',
    name: '',
    role: 'editor',
  });
});

// `setRole` takes an array and stores it joined with commas.
test('a role sent as an array is refused rather than stored', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];
  state.siteMailer = fakeMailer;

  const invited = await memberPost(
    'members',
    { email: 'lea@example.com', role: ['owner', 'editor'] },
    owner,
  );
  const roled = await memberPost('members/u2/role', { role: ['owner', 'editor'] }, owner);

  expect([invited.status, roled.status]).toEqual([400, 400]);
  expect(calls.createUser).toEqual([]);
  expect(calls.setRole).toEqual([]);
});

test('an invite with no mailer names the credential that is missing and writes nothing', async () => {
  state.siteMailer = { provider: 'resend', from: 'Handover <admin@example.com>' };

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('RESEND_API_KEY');
  expect(calls.createUser).toEqual([]);
});

// The row is written before the mail is tried.
test('an invite whose mail fails leaves the row, and names no link', async () => {
  state.siteMailer = fakeMailer;
  state.magicLinkRefusal = new Error(
    'Resend refused the message (403): https://demo.example/x?token=abc',
  );

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);
  const body = (await res.json()) as { error: string; to: string };

  expect(res.status).toBe(502);
  expect(body).toEqual({ error: 'invite-not-sent', to: 'lea@example.com' });
  expect(calls.createUser ?? []).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain('token=');
});

test("an invite to somebody who is already a member comes back in Better Auth's own words", async () => {
  state.siteMailer = fakeMailer;
  state.createUserRefusal = {
    body: {
      code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      message: 'User already exists. Use another email.',
    },
  };

  const res = await memberPost('members', { email: 'anna@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    error: 'User already exists. Use another email.',
  });
  expect(calls.signInMagicLink).toEqual([]);
});

test('an invite is only resent to somebody who has never signed in', async () => {
  state.memberRows = [
    member('u2', 'anna@example.com', 'editor'),
    member('u3', 'lea@example.com', 'editor', { pending: true, method: null, lastSignIn: null }),
  ];
  state.siteMailer = fakeMailer;

  const active = await memberPost('members/u2/invite', {}, owner);
  const pending = await memberPost('members/u3/invite', {}, owner);
  const nobody = await memberPost('members/u9/invite', {}, owner);

  expect([active.status, pending.status, nobody.status]).toEqual([400, 200, 404]);
  expect(calls.signInMagicLink).toEqual([
    { body: { email: 'lea@example.com', callbackURL: '/admin/account' }, invite: true },
  ]);
});

test('the last owner cannot be demoted', async () => {
  // Somebody else's row: the caller's own would trip the self-change rule before the count.
  state.memberRows = [
    member('u2', 'anna@example.com', 'owner'),
    member('u3', 'ben@example.com', 'editor'),
  ];

  const res = await memberPost('members/u2/role', { role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    code: 'MEMBER_LAST_OWNER',
    error: 'There must be at least one owner',
  });
  expect(calls.setRole).toEqual([]);
});

test('demoting an owner goes through the statement that holds the rule', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberPost('members/u2/role', { role: 'editor' }, owner);

  expect(res.status).toBe(200);
  expect(demoted).toEqual(['u2']);
  // Not `setRole`: it would write the column behind a count another request can change.
  expect(calls.setRole).toEqual([]);
});

test('an owner cannot change their own role, even when they are not the last one', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberPost('members/u1/role', { role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('You cannot change your own role');
  expect(demoted).toEqual([]);
  expect(calls.setRole).toEqual([]);
});

test('promoting an editor is still Better Auth setting the role', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberPost('members/u2/role', { role: 'owner' }, owner);

  expect(res.status).toBe(200);
  expect(calls.setRole).toEqual([{ body: { userId: 'u2', role: 'owner' }, invite: false }]);
  expect(demoted).toEqual([]);
});

// The guard, aimed at directly.
test('the last owner is refused even to a caller who is not them', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u1', { ...owner, user: { ...owner.user, id: 'u2' } });

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('There must be at least one owner');
  expect(calls.removeUser).toEqual([]);
});

test('an owner cannot remove themselves, even when they are not the last one', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberDelete('members/u1', owner);

  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('You cannot remove yourself');
  expect(calls.removeUser).toEqual([]);
});

test('removing somebody else takes their sessions and accounts with them', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u2', owner);

  expect(res.status).toBe(200);
  expect(calls.removeUser).toEqual([{ body: { userId: 'u2' }, invite: false }]);
  // The entries they had open go quiet with the account, rather than two minutes later.
  expect(released).toEqual(['u2']);
  // An editor is nobody's last owner, so nothing is taken out of the count first.
  expect(demoted).toEqual([]);
});

// The removal asks for the owner slot before it asks for the row.
test('removing an owner takes them out of the count before it deletes them', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'owner'),
  ];

  const res = await memberDelete('members/u2', owner);

  expect(res.status).toBe(200);
  expect(demoted).toEqual(['u2']);
  expect(calls.removeUser).toEqual([{ body: { userId: 'u2' }, invite: false }]);
});

test('a member id the request made up is a 404, not a 500', async () => {
  state.memberRows = [member('u1', 'martin@example.com', 'owner')];

  const roled = await memberPost('members/u9/role', { role: 'editor' }, owner);
  const removed = await memberDelete('members/u9', owner);

  expect([roled.status, removed.status]).toEqual([404, 404]);
});

// Activity log effects.

test('an invite is an invite event naming who invited whom', async () => {
  state.siteMailer = fakeMailer;

  await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'invite',
      subject: 'new',
      detail: { email: 'lea@example.com', role: 'editor' },
    },
  ]);
});

// The row exists whether or not the message went, so the log says so too.
test('an invite whose mail fails is still an invite event, and carries no link', async () => {
  state.siteMailer = fakeMailer;
  state.magicLinkRefusal = new Error(
    'https://x/admin/api/auth/magic-link/verify?token=SECRET_TOKEN',
  );

  const res = await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(res.status).toBe(502);
  expect(logged.map((e) => e.kind)).toEqual(['invite']);
  expect(JSON.stringify(logged)).not.toContain('SECRET_TOKEN');
});

test('an invite that was refused is no event at all', async () => {
  state.siteMailer = fakeMailer;
  state.createUserRefusal = {
    body: { code: 'USER_ALREADY_EXISTS', message: 'User already exists' },
  };

  await memberPost('members', { email: 'lea@example.com', role: 'editor' }, owner);

  expect(logged).toEqual([]);
});

test('promoting somebody is a role-change event', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  await memberPost('members/u2/role', { role: 'owner' }, owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'role-change',
      subject: 'u2',
      detail: { role: 'owner', name: 'anna@example.com' },
    },
  ]);
});

// Demotion is the branch that goes through `demoteOwner` rather than `setRole`.
test('demoting an owner is a role-change event too', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'kim@example.com', 'owner'),
  ];

  await memberPost('members/u2/role', { role: 'editor' }, owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'role-change',
      subject: 'u2',
      detail: { role: 'editor', name: 'kim@example.com' },
    },
  ]);
});

test('a role change the last-owner rule refuses is no event', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberPost('members/u1/role', { role: 'editor' }, owner);

  expect(res.status).toBe(400);
  expect(logged).toEqual([]);
});

test('setting a first password is a password-set event for the person who set it', async () => {
  await POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'a-password-of-twelve' }),
      }),
      { handover: editor },
    ),
  );

  expect(logged).toEqual([{ userId: 'u2', kind: 'password-set', detail: { how: 'first' } }]);
});

test('a password Better Auth refused is no event', async () => {
  state.setPassword = async () => {
    throw { body: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } };
  };

  await POST(
    ctx(
      'account/set-password',
      new Request('https://x/admin/api/account/set-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'short' }),
      }),
      { handover: editor },
    ),
  );

  expect(logged).toEqual([]);
});

// `params.path` is the route's own segment and the filters ride on the query string.
const activityGet = (query: string, session?: unknown) =>
  GET({
    params: { path: 'activity' },
    request: undefined,
    url: new URL(`https://x/admin/api/activity${query}`),
    locals: { handover: session },
  } as unknown as APIContext);

// The whole of `editor sees only their own`.
test('the activity log is read as the signed-in person, whoever the query string names', async () => {
  await activityGet('?user=u1', editor);

  expect(state.read[0]).toEqual({ id: 'u2', role: 'editor' });
});

test('an editor may read the activity log', async () => {
  const res = await activityGet('', editor);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ events: [], cursor: null });
});

test('the filters and the cursor are passed on as they were asked for', async () => {
  await activityGet(
    '?group=Accounts&user=u3&entry=src/content/pages/en/about.yaml&cursor=5000.abc',
    owner,
  );

  expect(state.read[1]).toEqual({
    group: 'Accounts',
    user: 'u3',
    entry: 'src/content/pages/en/about.yaml',
    cursor: '5000.abc',
  });
});

// The row is gone by the time anybody reads this, so the address is in the event or it is nowhere.
test('removing a member is an event naming who was removed', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  await memberDelete('members/u2', owner);

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'member-removed',
      subject: 'u2',
      detail: { email: 'anna@example.com', role: 'editor', pending: false },
    },
  ]);
});

test('revoking an invite nobody opened says it was still pending', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u3', 'lea@example.com', 'editor', { pending: true, method: null, lastSignIn: null }),
  ];

  await memberDelete('members/u3', owner);

  expect(logged[0]?.detail).toEqual({ email: 'lea@example.com', role: 'editor', pending: true });
});

test('a removal the last-owner rule refuses is no event', async () => {
  state.memberRows = [
    member('u1', 'martin@example.com', 'owner'),
    member('u2', 'anna@example.com', 'editor'),
  ];

  const res = await memberDelete('members/u1', { ...owner, user: { ...owner.user, id: 'u9' } });

  expect(res.status).toBe(400);
  expect(logged).toEqual([]);
});

test('removing somebody who is not there is no event', async () => {
  state.memberRows = [member('u1', 'martin@example.com', 'owner')];

  const res = await memberDelete('members/u9', owner);

  expect(res.status).toBe(404);
  expect(logged).toEqual([]);
});
