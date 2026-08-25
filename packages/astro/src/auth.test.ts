import { AUTH_BASE_PATH, memberApi } from '@handover/core';
import { hashPassword } from 'better-auth/crypto';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// What the Worker holds, per test. This file is about the three answers this layer gives that
// core cannot: where an emailed link points, who is worth mailing, and when the send happens.
let baseUrl: string | undefined;
let clientId: string | undefined;
let clientSecret: string | undefined;
let resendKey: string | undefined;
const sent: { to: string; subject: string; text: string }[] = [];
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

// The site hands in its own `Mailer`, which is the union's other half and the cheapest way to
// read what was actually sent.
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { locales: ['en'], defaultLocale: 'en' },
    collections: {},
    mailer: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
      return { id: 'fake-1' };
    },
  },
}));

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
    }),
  );
});

beforeEach(async () => {
  baseUrl = 'https://demo.example';
  clientId = undefined;
  clientSecret = undefined;
  resendKey = undefined;
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
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, 'local:credential', ?, 'credential', ?, ?, 0, 0)`,
    )
    .bind(`acc_${email}`, `usr_${email}`, `usr_${email}`, await hashPassword(password))
    .run();
}

/**
 * A request as it really arrives — its own `Host`, which is the value this file exists to keep
 * out of an email. `origin` matches it, since a browser sends the one it is on.
 */
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

// The whole reason the base URL is stated rather than read off the request: the link in this
// email is a working credential, and `Host` is a value the caller writes. Better Auth's origin
// check refuses a request whose `Origin` is untrusted, so the case left to defend is a forged
// `Host` behind a trusted `Origin` — which is what a proxy or a routing mistake looks like.
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

// `/sign-in/magic-link` answers the same for every address, which is what keeps it from
// confirming who has an account — and mails one regardless unless something stops it.
test('an address with no account is mailed nothing, and gets the same answer', async () => {
  await seedUser('owner@example.com');

  const known = await askForLink('owner@example.com');
  const unknown = await askForLink('stranger@example.com');

  expect(unknown.status).toBe(known.status);
  expect(sent.map((m) => m.to)).toEqual(['owner@example.com']);
});

// `baseURL` and the cookie's `Secure` come from one string, so they cannot disagree about a
// request: a site that says it is https gets a Secure cookie however the request reached it.
// A request whose `Origin` is nobody's business here does not get as far as minting anything.
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

// ─── the invite's own link ───────────────────────────────────────────────────────────────

/**
 * What the members screen does after it has written the row: the same endpoint the login uses,
 * on the instance that mints a longer-lived link and says something else in the mail.
 */
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
