import { AUTH_BASE_PATH, memberApi } from '@handover/core';
import { hashPassword } from 'better-auth/crypto';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// This file is about what this layer adds to core: where a link points, who is mailed, and when.
let baseUrl: string | undefined;
let clientId: string | undefined;
let clientSecret: string | undefined;
let resendKey: string | undefined;
const sent: { to: string; subject: string; text: string }[] = [];
// A provider's refusal is the developer's to read in the log, not a person's to see.
let refuseSend: Error | undefined;
// A provider that takes its time: the send waits on this before it counts as sent.
let holdSend: Promise<void> | undefined;
let binding: Awaited<ReturnType<Miniflare['getD1Database']>>;

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

vi.mock('cloudflare:workers', () => ({
  env: {
    BETTER_AUTH_SECRET: 'a-secret-long-enough-for-better-auth-32',
    get HANDOVER_BASE_URL() {
      return baseUrl;
    },
    get GITHUB_CLIENT_ID() {
      return clientId;
    },
    get GITHUB_CLIENT_SECRET() {
      return clientSecret;
    },
    get RESEND_API_KEY() {
      return resendKey;
    },
    get DB() {
      return binding;
    },
  },
}));

// The site's own `Mailer` is the cheapest way to read what was actually sent.
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { locales: ['en'], defaultLocale: 'en' },
    collections: {},
    mailer: async (message: { to: string; subject: string; text: string }) => {
      if (refuseSend) throw refuseSend;
      await holdSend;
      sent.push(message);
      return { id: 'fake-1' };
    },
  },
}));

// `members.ts` reaches the content index through its imports; nothing here reads it.
vi.mock('virtual:handover/index', () => ({ default: {}, templates: {} }));

const { createAuth } = await import('./auth.js');

let ddl: string[];
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  const tables = await import('@handover/core');
  ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({
      user: tables.user,
      session: tables.session,
      account: tables.account,
      verification: tables.verification,
      rateLimit: tables.rateLimit,
      activity: tables.activity,
      locks: tables.locks,
    }),
  );
});

beforeEach(async () => {
  baseUrl = 'https://demo.example';
  clientId = undefined;
  clientSecret = undefined;
  resendKey = undefined;
  refuseSend = undefined;
  holdSend = undefined;
  sent.length = 0;
  const rows = (await binding.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
    .results as { name: string }[];
  for (const { name } of rows.filter((r) => !/^(sqlite_|_cf_)/.test(r.name))) {
    await binding.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

/** A row and nothing else: somebody who has been invited but has never signed in. */
const seedUser = (email: string) =>
  binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, 'Invited', ?, 1, 'editor', 0, 0)`,
    )
    .bind(`usr_${email}`, email)
    .run();

/** The same person, with a password to sign in by. */
async function seedCredentials(email: string, password: string) {
  await seedUser(email);
  await binding
    .prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, ?, 'credential', ?, ?, 0, 0)`,
    )
    .bind(`acc_${email}`, `usr_${email}`, `usr_${email}`, await hashPassword(password))
    .run();
}

/** A request with its own `Host`, which is the value this file exists to keep out of an email. */
function askForLink(
  email: string,
  host = 'https://demo.example',
  origin = 'https://demo.example',
  ctx?: { waitUntil(p: Promise<unknown>): void },
) {
  const url = new URL(`${host}${AUTH_BASE_PATH}/sign-in/magic-link`);
  return createAuth(url, ctx).handler(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'cf-connecting-ip': '203.0.113.7',
      },
      body: JSON.stringify({ email, callbackURL: '/admin' }),
    }),
  );
}

test('a mailer with no base URL offers no sign-in link at all', async () => {
  baseUrl = undefined;
  await seedUser('owner@example.com');

  const res = await askForLink('owner@example.com');

  expect(res.status).toBe(404);
  expect(sent).toEqual([]);
});

// The link is a credential and `Host` is the caller's to write, so the base URL is stated.
test('the emailed link points at the configured base URL, not at the request Host', async () => {
  await seedUser('owner@example.com');

  const res = await askForLink(
    'owner@example.com',
    'https://attacker.example',
    'https://demo.example',
  );

  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain('https://demo.example/admin/api/auth/magic-link/verify?token=');
  expect(sent[0]?.text).not.toContain('attacker.example');
});

// The endpoint answers the same for every address, so it must not confirm who has an account.
test('an address with no account is mailed nothing, and gets the same answer', async () => {
  await seedUser('owner@example.com');

  const known = await askForLink('owner@example.com');
  const unknown = await askForLink('stranger@example.com');

  expect(unknown.status).toBe(known.status);
  expect(sent.map((m) => m.to)).toEqual(['owner@example.com']);
});

// A request whose `Origin` is nobody's business does not get as far as minting anything.
test('a request from an untrusted origin is refused before a link is made', async () => {
  await seedUser('owner@example.com');

  const res = await askForLink(
    'owner@example.com',
    'https://demo.example',
    'https://attacker.example',
  );

  expect(res.status).toBe(403);
  expect(sent).toEqual([]);
});

// `baseURL` and the cookie's `Secure` come from one string, so they cannot disagree.
test('the session cookie is Secure on an https site even when the request arrived over http', async () => {
  await seedCredentials('owner@example.com', 'correct-horse-battery');
  const url = new URL(`http://localhost:4321${AUTH_BASE_PATH}/sign-in/email`);

  const res = await createAuth(url).handler(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://demo.example',
        'cf-connecting-ip': '203.0.113.8',
      },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
    }),
  );

  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toMatch(/Secure/);
});

// The invite's own link

/** The same endpoint the login uses, on the instance that mints a longer-lived link. */
function sendInvite(email: string, host = 'https://demo.example') {
  const url = new URL(`${host}${AUTH_BASE_PATH}/sign-in/magic-link`);
  return memberApi('default', createAuth(url, undefined, { invite: true })).signInMagicLink({
    body: { email, callbackURL: '/admin/account' },
    headers: new Headers({
      'content-type': 'application/json',
      origin: 'https://demo.example',
      'cf-connecting-ip': '203.0.113.8',
    }),
  });
}

const linkIn = (text: string) => text.match(/https:\/\/\S+magic-link\/verify\?\S+/)?.[0] ?? '';

test('an invite says it is an invite and lands the person on their account page', async () => {
  await seedUser('lea@example.com');

  await sendInvite('lea@example.com');

  expect(sent).toHaveLength(1);
  expect(sent[0]?.subject).toBe('You have been invited');
  expect(sent[0]?.text).toContain('You have been invited to help run https://demo.example');
  expect(linkIn(sent[0]?.text ?? '')).toContain('callbackURL=%2Fadmin%2Faccount');
});

test("an invite's link lives three days, where a sign-in link lives fifteen minutes", async () => {
  await seedUser('lea@example.com');
  await seedUser('owner@example.com');

  await sendInvite('lea@example.com');
  await askForLink('owner@example.com');

  const rows = (
    await binding.prepare('SELECT expires_at FROM verification ORDER BY created_at').all()
  ).results as { expires_at: number }[];
  const lives = rows.map((row) => Math.round((row.expires_at - Date.now()) / 60_000));
  expect(lives[0]).toBe(72 * 60);
  expect(lives[1]).toBe(15);
});

test('an invite link signs the person in once and no more', async () => {
  await seedUser('lea@example.com');
  await sendInvite('lea@example.com');
  const link = linkIn(sent[0]?.text ?? '');

  const first = await createAuth(new URL(link)).handler(new Request(link));
  const second = await createAuth(new URL(link)).handler(new Request(link));

  expect(first.headers.get('location')).toBe('https://demo.example/admin/account');
  expect(second.headers.get('location')).toBe(
    'https://demo.example/admin/account?error=INVALID_TOKEN',
  );
});

test('an invite to an address with no row mails nothing', async () => {
  await sendInvite('stranger@example.com');

  expect(sent).toEqual([]);
});

// A message that never went

/** Without a row the only record of a failed send is a log line the site's owner cannot read. */
const mailFailures = async () =>
  (await binding.prepare("SELECT * FROM activity WHERE kind = 'mail-failed'").all()).results as {
    user_id: string | null;
    detail: string;
  }[];

/** What the Worker keeps running after the answer: the sign-in mail goes out here. */
function background() {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void tasks.push(p),
    settled: () => Promise.all(tasks),
  };
}

// A 500 for a member and a 200 for a stranger would say who has an account.
test('a known address whose mail cannot be sent answers like an unknown one, and leaves a row', async () => {
  await seedUser('owner@example.com');
  refuseSend = new Error('resend refused: 403');
  const ctx = background();

  const known = await askForLink('owner@example.com', undefined, undefined, ctx);
  const unknown = await askForLink('stranger@example.com', undefined, undefined, ctx);
  await ctx.settled();

  expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
  expect(await mailFailures()).toEqual([
    expect.objectContaining({
      site_id: 'default',
      user_id: null,
      kind: 'mail-failed',
      subject: null,
      detail: '{"message":"sign-in link"}',
      commit_sha: null,
    }),
  ]);
});

// Waiting on the provider would make a member's address answer slower than a stranger's.
test('a known address is answered before a slow mailer has sent', async () => {
  await seedUser('owner@example.com');
  let release = () => {};
  holdSend = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = background();

  const answer = await Promise.race([
    askForLink('owner@example.com', undefined, undefined, ctx).then((res) => res.status),
    new Promise((resolve) => setTimeout(() => resolve('still waiting on the mailer'), 500)),
  ]);
  release();
  await ctx.settled();

  expect(answer).toBe(200);
  expect(sent.map((m) => m.to)).toEqual(['owner@example.com']);
});

test('an invite that could not be sent says it was an invite', async () => {
  await seedUser('lea@example.com');
  refuseSend = new Error('resend refused: 403');

  await expect(sendInvite('lea@example.com')).rejects.toThrow();

  expect((await mailFailures()).map((r) => r.detail)).toEqual(['{"message":"invite"}']);
});

test('a reset that could not be sent leaves a row, and no link in it', async () => {
  await seedCredentials('owner@example.com', 'correct-horse-battery');
  refuseSend = new Error('resend refused: 403');
  const url = new URL(`https://demo.example${AUTH_BASE_PATH}/request-password-reset`);

  const res = await createAuth(url).handler(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://demo.example',
        'cf-connecting-ip': '203.0.113.9',
      },
      body: JSON.stringify({
        email: 'owner@example.com',
        redirectTo: 'https://demo.example/admin/reset',
      }),
    }),
  );

  expect(res.status).toBe(200);
  const rows = await mailFailures();
  expect(rows.map((r) => (JSON.parse(r.detail) as { message: string }).message)).toEqual([
    'password reset',
  ]);
  // A reset stores its token in the clear, so the row this reads is the credential itself.
  const stored = (
    (await binding.prepare('SELECT identifier FROM verification').all()).results as {
      identifier: string;
    }[]
  )[0]?.identifier;
  const token = stored?.split(':')[1] ?? '';
  expect(token).not.toBe('');
  expect(JSON.stringify(rows)).not.toContain(token);
});

test('a message that went leaves no failure behind', async () => {
  await seedUser('owner@example.com');

  await askForLink('owner@example.com');

  expect(await mailFailures()).toEqual([]);
});

// Setting a first password

const { setPassword } = await import('./routes/api/members.js');
const { openDb } = await import('@handover/core');

/** Signed in by an emailed link, as an invited member with no password is. */
async function signInByLink(email: string) {
  sent.length = 0;
  await askForLink(email);
  const link = linkIn(sent[0]?.text ?? '');
  const res = await createAuth(new URL(link)).handler(new Request(link));
  sent.length = 0;
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

const setFirstPassword = (cookie: string) =>
  setPassword(
    { db: () => openDb('default', binding) } as never,
    new Request('https://demo.example/admin/api/account/set-password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://demo.example' },
      body: JSON.stringify({ newPassword: 'a-long-enough-password' }),
    }),
    new URL('https://demo.example/admin/api/account/set-password'),
    undefined,
    { user: { id: 'usr_lea@example.com' } } as never,
  );

const sessionOf = async (cookie: string) =>
  createAuth(new URL('https://demo.example/admin')).api.getSession({
    headers: new Headers({ cookie }),
  });

// A cookie lifted from an unattended browser must not turn into a password that outlives it.
test('a session older than a day cannot set a first password', async () => {
  await seedUser('lea@example.com');
  const cookie = await signInByLink('lea@example.com');
  await binding
    .prepare('UPDATE session SET created_at = ?')
    .bind(Date.now() - 2 * 24 * 60 * 60 * 1000)
    .run();

  const res = await setFirstPassword(cookie);
  const passwords = await binding
    .prepare('SELECT password FROM account WHERE password IS NOT NULL')
    .all();

  expect(res.status).toBe(403);
  expect(passwords.results).toEqual([]);
});

test('a first password ends every other session and is mailed to the account', async () => {
  await seedUser('lea@example.com');
  const elsewhere = await signInByLink('lea@example.com');
  const here = await signInByLink('lea@example.com');

  const res = await setFirstPassword(here);

  expect(res.status).toBe(200);
  expect(await sessionOf(elsewhere)).toBeNull();
  expect(await sessionOf(here)).not.toBeNull();
  expect(sent.map((m) => [m.to, m.subject])).toEqual([
    ['lea@example.com', 'A password was set for your account'],
  ]);
});

// Old invite links

const { removeMember, resendInvite } = await import('./routes/api/members.js');

const routeCtx = { db: () => openDb('default', binding) } as never;
const ownerSession = { user: { id: 'usr_owner@example.com' }, role: 'owner' } as never;

/** Whether opening the link signs anybody in. */
async function signsIn(link: string) {
  const res = await createAuth(new URL(link)).handler(new Request(link));
  return res.headers.getSetCookie().some((c) => c.includes('session_token=') && !c.includes('=;'));
}

// An invite sent to the wrong mailbox must stop working once the owner sends it again.
test('a resent invite leaves the earlier link signing nobody in', async () => {
  await seedUser('lea@example.com');
  await binding.prepare('UPDATE user SET email_verified = 0').run();
  await sendInvite('lea@example.com');
  const first = linkIn(sent[0]?.text ?? '');

  const res = await resendInvite(
    routeCtx,
    'usr_lea@example.com',
    new Request('https://demo.example/admin/api/members/x/invite', { method: 'POST' }),
    new URL('https://demo.example/admin/api/members/x/invite'),
    undefined,
    ownerSession,
  );

  expect(res.status).toBe(200);
  expect(await signsIn(first)).toBe(false);
});

test('a removed member invited again cannot use the link from before the removal', async () => {
  await seedUser('owner@example.com');
  await binding.prepare("UPDATE user SET role = 'owner'").run();
  const owner = await signInByLink('owner@example.com');
  await seedUser('lea@example.com');
  await sendInvite('lea@example.com');
  const old = linkIn(sent[0]?.text ?? '');

  const removed = await removeMember(
    routeCtx,
    'usr_lea@example.com',
    new Request('https://demo.example/admin/api/members/x', {
      method: 'DELETE',
      headers: { cookie: owner, origin: 'https://demo.example' },
    }),
    new URL('https://demo.example/admin/api/members/x'),
    undefined,
    ownerSession,
  );
  await seedUser('lea@example.com');

  expect(removed.status).toBe(200);
  expect(await signsIn(old)).toBe(false);
});
