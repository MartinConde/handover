import { hashPassword } from 'better-auth/crypto';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AUTH_BASE_PATH, accountFacts, createAuth, memberList, ownerCount } from './auth.js';
import type { Db } from './db.js';
import * as tables from './tables.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
let db: Db;
let ddl: string[];
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  db = drizzle(binding, { schema: { drafts: tables.drafts } }) as unknown as Db;
  ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
});

// Every test gets its own database, so one test's failed sign-ins cannot spend another's
// rate-limit budget or leave a user row behind.
beforeEach(async () => {
  const rows = (await binding.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
    .results as { name: string }[];
  for (const { name } of rows.filter((r) => !/^(sqlite_|_cf_)/.test(r.name))) {
    await binding.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

// What the site is configured with, per test. Left as it was for the password-only tests:
// the two emailing methods are not mounted until a site has both a base URL and a sender.
const SITE = 'https://demo.example';
let baseURL: string | undefined;
let github: { clientId: string; clientSecret: string } | undefined;
const magicLinks: { email: string; url: string }[] = [];
const resetLinks: { email: string; url: string }[] = [];
let sending = false;

beforeEach(() => {
  baseURL = undefined;
  github = undefined;
  sending = false;
  magicLinks.length = 0;
  resetLinks.length = 0;
});

const auth = (secureCookies = true) =>
  createAuth(db, {
    secret: 'a-secret-long-enough-for-better-auth-32',
    secureCookies,
    baseURL,
    ...(github ? { github } : {}),
    ...(sending
      ? {
          sendMagicLink: async (data) => {
            magicLinks.push(data);
          },
          sendPasswordReset: async (data) => {
            resetLinks.push(data);
          },
        }
      : {}),
  });

/** A site with every method a mailer and a base URL make possible. */
function emailing() {
  baseURL = SITE;
  sending = true;
}

// Following a link out of an email: a plain GET, no body, no origin header, exactly as a
// mail client opens it.
afterEach(() => vi.unstubAllGlobals());

const open = (url: string, cookie = '') =>
  auth().handler(
    new Request(url, {
      headers: { 'cf-connecting-ip': '203.0.113.200', ...(cookie ? { cookie } : {}) },
    }),
  );

/** Every cookie a response set, as one request header. */
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

// Each request declares its own client address: the limiter buckets on `cf-connecting-ip`,
// so without one every test in the file would share the three attempts per ten seconds.
let caller = 0;
function call(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  secureCookies = true,
) {
  caller += 1;
  return auth(secureCookies).handler(
    new Request(`https://demo.example${AUTH_BASE_PATH}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://demo.example',
        'cf-connecting-ip': `203.0.113.${caller}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

const userRows = async () =>
  (await binding.prepare('SELECT email, role FROM user').all()).results as {
    email: string;
    role: string | null;
  }[];

/**
 * An invited person before they have ever signed in: a row and nothing else. `handover init`
 * will seed the first owner this way once there is a mailer to send them a link.
 */
async function seedUser(email: string, role: string) {
  const id = `usr_${email}`;
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, 0, 0)`,
    )
    .bind(id, 'Seeded Owner', email, role)
    .run();
  return id;
}

/**
 * What `handover init` will seed and what hazard 3's `wrangler d1 execute` writes by hand:
 * a credential account is keyed on the user's own id, and its issuer is the synthetic
 * `local:credential` — a row missing either is a password nothing can sign in with.
 */
async function seed(email: string, password: string, role: string) {
  const id = await seedUser(email, role);
  await binding
    .prepare(
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, 'local:credential', ?, 'credential', ?, ?, 0, 0)`,
    )
    .bind(`acc_${email}`, id, id, await hashPassword(password))
    .run();
  return id;
}

test('the password sign-up endpoint refuses an unknown email and creates no user', async () => {
  const res = await call('/sign-up/email', {
    email: 'stranger@example.com',
    password: 'a-password-of-twelve',
    name: 'Stranger',
  });

  expect(res.status).toBe(400);
  expect(await userRows()).toEqual([]);
});

test('the admin plugin refuses to create a user for a caller with no session', async () => {
  const res = await call('/admin/create-user', {
    email: 'stranger@example.com',
    password: 'a-password-of-twelve',
    name: 'Stranger',
    role: 'owner',
  });

  expect(res.status).toBe(401);
  expect(await userRows()).toEqual([]);
});

test('a seeded owner signs in with their password', async () => {
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/sign-in/email', {
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toMatch(/better-auth\.session_token=/);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe('owner');
});

test('a wrong password is refused', async () => {
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/sign-in/email', {
    email: 'owner@example.com',
    password: 'wrong-horse-battery',
  });

  expect(res.status).toBe(401);
});

test('an editor session cannot create a user', async () => {
  await seed('editor@example.com', 'correct-horse-battery', 'editor');
  const signedIn = await call('/sign-in/email', {
    email: 'editor@example.com',
    password: 'correct-horse-battery',
  });
  const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const res = await call(
    '/admin/create-user',
    { email: 'stranger@example.com', password: 'a-password-of-twelve', name: 'Stranger' },
    { cookie },
  );

  expect(res.status).toBe(403);
  expect((await userRows()).map((r) => r.email)).toEqual(['editor@example.com']);
});

// Better Auth infers this from `NODE_ENV` when no baseURL is set, and a Worker has none — so
// left alone the deployed site hands out a session cookie any plaintext request can carry.
test('the session cookie is marked Secure when the request came over https', async () => {
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/sign-in/email', {
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  });

  expect(res.headers.get('set-cookie')).toMatch(/Secure/);
});

test('a request over plain http gets no Secure cookie, so localhost still signs in', async () => {
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call(
    '/sign-in/email',
    { email: 'owner@example.com', password: 'correct-horse-battery' },
    {},
    false,
  );

  expect(res.headers.get('set-cookie')).not.toMatch(/Secure/);
});

// ─── magic link ──────────────────────────────────────────────────────────────────────────

// A site with a mailer but no base URL still has no way to say where a link should point, so
// the method is absent rather than mailing one built from whatever `Host` the request carried.
test('a mailer alone does not mount the magic link — the base URL does', async () => {
  sending = true;
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/sign-in/magic-link', { email: 'owner@example.com' });

  expect(res.status).toBe(404);
  expect(magicLinks).toEqual([]);
});

test('a mailer alone does not enable the password reset either', async () => {
  sending = true;
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/request-password-reset', { email: 'owner@example.com' });

  expect(res.status).toBe(400);
  expect(resetLinks).toEqual([]);
});

test('a seeded user signs in by opening the link that was mailed to them', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');
  await call('/sign-in/magic-link', { email: 'owner@example.com', callbackURL: '/admin' });

  const res = await open(magicLinks[0]?.url ?? '');

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(`${SITE}/admin`);
  expect(res.headers.get('set-cookie')).toMatch(/better-auth\.session_token=/);
});

test('the same link a second time signs nobody in', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');
  await call('/sign-in/magic-link', { email: 'owner@example.com', callbackURL: '/admin' });
  const url = magicLinks[0]?.url ?? '';
  await open(url);

  const res = await open(url);

  expect(res.headers.get('location')).toBe(`${SITE}/admin?error=INVALID_TOKEN`);
  expect(res.headers.get('set-cookie')).toBeNull();
});

// The property `features/auth.md` names: not a status, a row. 1.7.1 answers the POST with
// `{status: true}` for every address, which is what keeps the form from confirming who has an
// account — so the link is the only place the refusal can be seen.
test('a magic link for an unknown email creates no user', async () => {
  emailing();
  const sent = await call('/sign-in/magic-link', { email: 'stranger@example.com' });

  const res = await open(magicLinks[0]?.url ?? '');

  expect(await userRows()).toEqual([]);
  expect(sent.status).toBe(200);
  expect(res.headers.get('location')).toBe(`${SITE}/?error=new_user_signup_disabled`);
});

// ─── password reset ──────────────────────────────────────────────────────────────────────

test('a reset link is mailed to the address that asked for it', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/request-password-reset', {
    email: 'owner@example.com',
    redirectTo: `${SITE}/admin/reset`,
  });

  expect(res.status).toBe(200);
  expect(resetLinks).toHaveLength(1);
  expect(resetLinks[0]?.email).toBe('owner@example.com');
  expect(resetLinks[0]?.url).toContain(`${SITE}${AUTH_BASE_PATH}/reset-password/`);
});

test('a reset for an unknown email answers the same and mails nothing', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/request-password-reset', {
    email: 'stranger@example.com',
    redirectTo: `${SITE}/admin/reset`,
  });

  expect(res.status).toBe(200);
  expect(resetLinks).toEqual([]);
});

// The *Done when*: an invited row has no `account` at all, and the reset is what gives it one.
test('an invited user with no account row sets a password and signs in with it', async () => {
  emailing();
  await seedUser('invited@example.com', 'editor');
  await call('/request-password-reset', {
    email: 'invited@example.com',
    redirectTo: `${SITE}/admin/reset`,
  });
  const token = (resetLinks[0]?.url ?? '').split('/reset-password/')[1]?.split('?')[0] ?? '';

  const set = await call('/reset-password', { token, newPassword: 'a-brand-new-password' });
  const signedIn = await call('/sign-in/email', {
    email: 'invited@example.com',
    password: 'a-brand-new-password',
  });

  expect(set.status).toBe(200);
  expect(signedIn.status).toBe(200);
});

test('a new password under twelve characters is refused', async () => {
  emailing();
  await seedUser('invited@example.com', 'editor');
  await call('/request-password-reset', {
    email: 'invited@example.com',
    redirectTo: `${SITE}/admin/reset`,
  });
  const token = (resetLinks[0]?.url ?? '').split('/reset-password/')[1]?.split('?')[0] ?? '';

  const res = await call('/reset-password', { token, newPassword: 'beach' });

  expect(res.status).toBe(400);
});

// ─── the account page's two facts ────────────────────────────────────────────────────────

test('an invited user has no password and no session anywhere', async () => {
  const id = await seedUser('invited@example.com', 'editor');

  expect(await accountFacts(db, id, 'none')).toEqual({ hasPassword: false, sessions: [] });
});

test('a signed-in user has a password and sees the session that asked marked as theirs', async () => {
  const id = await seed('owner@example.com', 'correct-horse-battery', 'owner');
  await call('/sign-in/email', {
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  });
  const [row] = (await binding.prepare('SELECT id FROM session').all()).results as { id: string }[];

  const facts = await accountFacts(db, id, row?.id ?? '');

  expect(facts.hasPassword).toBe(true);
  expect(facts.sessions).toHaveLength(1);
  expect(facts.sessions[0]?.current).toBe(true);
});

// Better Auth's own /list-sessions answers with each session's token. Nothing the browser is
// shown here can revoke anything, so an XSS on the account page steals no session but its own.
test('no session token reaches the account page', async () => {
  const id = await seed('owner@example.com', 'correct-horse-battery', 'owner');
  await call('/sign-in/email', {
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  });

  const facts = await accountFacts(db, id, 'whichever');

  expect(Object.keys(facts.sessions[0] ?? {}).sort()).toEqual([
    'current',
    'id',
    'lastUsed',
    'userAgent',
  ]);
});

// ─── GitHub ──────────────────────────────────────────────────────────────────────────────

/**
 * GitHub's three endpoints, so the callback can be walked without one. Everything else in
 * these two tests is the real provider, the real callback and the real database.
 */
function stubGitHub(profile: { login: string; email: string; verified: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const href = String(input instanceof Request ? input.url : input);
      if (href.startsWith('https://github.com/login/oauth/access_token'))
        return Response.json({ access_token: 'gho_token', token_type: 'bearer', scope: 'user' });
      if (href === 'https://api.github.com/user')
        return Response.json({ id: 42, login: profile.login, name: 'Martin', email: null });
      if (href === 'https://api.github.com/user/emails')
        return Response.json([{ email: profile.email, primary: true, verified: profile.verified }]);
      throw new Error(`unstubbed fetch: ${href}`);
    }),
  );
}

/** Start the flow, read the `state` Better Auth minted, and come back with it. */
async function githubCallback(profile: Parameters<typeof stubGitHub>[0]) {
  const started = await call('/sign-in/social', {
    provider: 'github',
    callbackURL: '/admin',
    errorCallbackURL: '/admin',
    disableRedirect: true,
  });
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state') ?? '';
  stubGitHub(profile);
  // 1.7 keeps the OAuth state in an encrypted cookie, not in `verification`, so the callback
  // is only itself when it carries the one `/sign-in/social` set.
  return open(
    `${SITE}${AUTH_BASE_PATH}/callback/github?code=gh_code&state=${encodeURIComponent(state)}`,
    cookiesOf(started),
  );
}

test('a GitHub account whose email has no user row creates no user', async () => {
  emailing();
  github = { clientId: 'gh_id', clientSecret: 'gh_secret' };

  const res = await githubCallback({
    login: 'stranger',
    email: 'stranger@example.com',
    verified: true,
  });

  expect(await userRows()).toEqual([]);
  expect(res.headers.get('location')).toBe('/admin?error=signup_disabled');
});

test('a GitHub account signs in against the row that already carries its verified email', async () => {
  emailing();
  github = { clientId: 'gh_id', clientSecret: 'gh_secret' };
  await seedUser('owner@example.com', 'owner');

  const res = await githubCallback({ login: 'martin', email: 'owner@example.com', verified: true });

  expect(res.headers.get('location')).toBe('/admin');
  expect(res.headers.get('set-cookie')).toMatch(/better-auth\.session_token=/);
  expect((await userRows()).map((r) => r.email)).toEqual(['owner@example.com']);
});

// ─── setting a first password ────────────────────────────────────────────────────────────

/** Sign in by password and keep the cookie, which is how a server-only call proves who asks. */
async function sessionCookie(email: string, password: string) {
  const res = await call('/sign-in/email', { email, password });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

test('an invited user sets a first password from their account and signs in with it', async () => {
  emailing();
  await seedUser('invited@example.com', 'editor');
  await call('/sign-in/magic-link', { email: 'invited@example.com', callbackURL: '/admin' });
  const opened = await open(magicLinks[0]?.url ?? '');
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  await auth().api.setPassword({
    body: { newPassword: 'a-brand-new-password' },
    headers: new Headers({ cookie }),
  });
  const signedIn = await call('/sign-in/email', {
    email: 'invited@example.com',
    password: 'a-brand-new-password',
  });

  expect(signedIn.status).toBe(200);
});

// Otherwise it would be a way past `/change-password`, which asks for the old one.
test('setting a password refuses when one already exists', async () => {
  await seed('owner@example.com', 'correct-horse-battery', 'owner');
  const cookie = await sessionCookie('owner@example.com', 'correct-horse-battery');

  const refused = await auth()
    .api.setPassword({
      body: { newPassword: 'another-password-entirely' },
      headers: new Headers({ cookie }),
    })
    .catch((err: { body?: { code?: string } }) => err);

  expect((refused as { body?: { code?: string } }).body?.code).toBe('PASSWORD_ALREADY_SET');
});

// An emailed link that establishes a session and then bounces the person somewhere else is a
// session handed to whoever asked for it. 1.7.1 refuses the address before minting anything;
// this is here so an upgrade that loosened it would not pass quietly.
test('a magic link cannot be pointed off the site, and mails nothing when it is tried', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/sign-in/magic-link', {
    email: 'owner@example.com',
    callbackURL: 'https://example.com/x',
  });

  expect(res.status).toBe(403);
  expect(magicLinks).toEqual([]);
});

test('a GitHub sign-in cannot be pointed off the site either', async () => {
  emailing();
  github = { clientId: 'gh_id', clientSecret: 'gh_secret' };

  const res = await call('/sign-in/social', {
    provider: 'github',
    callbackURL: 'https://example.com/x',
    disableRedirect: true,
  });

  expect(res.status).toBe(403);
});

test('a reset link cannot be pointed off the site either', async () => {
  emailing();
  await seed('owner@example.com', 'correct-horse-battery', 'owner');

  const res = await call('/request-password-reset', {
    email: 'owner@example.com',
    redirectTo: 'https://example.com/x',
  });

  expect(res.status).toBe(403);
  expect(resetLinks).toEqual([]);
});

// Five minutes is all the OAuth state gets, and a first trip through GitHub's consent screen can
// take longer. The callback cannot read where to go back to out of a state that is gone, so it
// falls back — and the fallback has to be the login rather than Better Auth's own error page.
test('a GitHub callback whose state has expired lands on the login, not on an error page', async () => {
  emailing();
  github = { clientId: 'gh_id', clientSecret: 'gh_secret' };

  const res = await open(`${SITE}${AUTH_BASE_PATH}/callback/github?code=gh_code&state=long_gone`);

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/admin?error=state_mismatch');
});

// ─── the members list's two computed facts ───────────────────────────────────────────────

/** An invite as `createUser` writes one: a row, no password, and an unproven address. */
async function seedInvite(email: string, role: string, at = 1_000) {
  const id = `usr_${email}`;
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, '', ?, 0, ?, ?, ?)`,
    )
    .bind(id, email, role, at, at)
    .run();
  return id;
}

async function seedGithub(userId: string, accountId: string) {
  await binding
    .prepare(
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
       VALUES (?, 'local:oauth:github', ?, 'github', ?, 0, 0)`,
    )
    .bind(`acc_gh_${userId}`, accountId, userId)
    .run();
}

async function seedSession(userId: string, at: number) {
  await binding
    .prepare(
      `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(`ses_${userId}_${at}`, at + 604_800_000, `tok_${userId}_${at}`, at, at, userId)
    .run();
}

test('somebody with a password signs in with a password and an email link', async () => {
  const id = await seed('anna@example.com', 'correct-horse-battery', 'editor');
  await seedSession(id, 2_000);

  const [anna] = await memberList(db);

  expect(anna?.method).toBe('password');
  expect(anna?.pending).toBe(false);
});

test('somebody with no account row at all signs in by email link only', async () => {
  const id = await seedUser('jonas@example.com', 'editor');
  await seedSession(id, 2_000);

  const [jonas] = await memberList(db);

  expect(jonas?.method).toBe('link');
});

test('a credential row with no password is not a password', async () => {
  const id = await seedUser('anna@example.com', 'editor');
  // What `auth.md` warns a hand-seeded account can be: the row exists and the hash does not.
  await binding
    .prepare(
      `INSERT INTO account (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('acc_empty', 'local:credential', ?, 'credential', ?, 0, 0)`,
    )
    .bind(id, id)
    .run();
  await seedSession(id, 2_000);

  expect((await memberList(db))[0]?.method).toBe('link');
});

test('a linked GitHub account is what the list names, whatever else the person holds', async () => {
  const id = await seed('martin@example.com', 'correct-horse-battery', 'owner');
  await seedGithub(id, '34409953');
  await seedSession(id, 2_000);

  const [martin] = await memberList(db);

  expect(martin?.method).toBe('github');
});

test('an invite nobody has opened is pending and has no sign-in method', async () => {
  await seedInvite('lea@example.com', 'editor');

  const [lea] = await memberList(db);

  expect(lea?.pending).toBe(true);
  expect(lea?.method).toBe(null);
  expect(lea?.lastSignIn).toBe(null);
});

test('an invite stops being pending the moment its address is proved', async () => {
  const id = await seedInvite('lea@example.com', 'editor');
  await seedSession(id, 5_000);

  const [lea] = await memberList(db);

  expect(lea?.pending).toBe(false);
  expect(lea?.lastSignIn).toBe(5_000);
});

test('the list is newest sign-in first, with the people who never signed in last', async () => {
  const anna = await seedUser('anna@example.com', 'editor');
  await seedSession(anna, 2_000);
  const martin = await seedUser('martin@example.com', 'owner');
  await seedSession(martin, 9_000);
  await seedInvite('lea@example.com', 'editor');

  expect((await memberList(db)).map((m) => m.email)).toEqual([
    'martin@example.com',
    'anna@example.com',
    'lea@example.com',
  ]);
});

test('the newest of several sessions is the one the list reports', async () => {
  const id = await seedUser('anna@example.com', 'editor');
  await seedSession(id, 2_000);
  await seedSession(id, 8_000);
  await seedSession(id, 4_000);

  expect((await memberList(db))[0]?.lastSignIn).toBe(8_000);
});

test('a role the package does not recognise reads as editor', async () => {
  await seedUser('anna@example.com', 'admin');

  expect((await memberList(db))[0]?.role).toBe('editor');
});

test('the owners are counted by the column, not by who has an account', async () => {
  await seedUser('martin@example.com', 'owner');
  await seedInvite('kim@example.com', 'owner');
  await seedUser('anna@example.com', 'editor');

  expect(await ownerCount(db)).toBe(2);
});
