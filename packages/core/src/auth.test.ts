import { hashPassword } from 'better-auth/crypto';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { AUTH_BASE_PATH, createAuth } from './auth.js';
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

const auth = (secureCookies = true) =>
  createAuth(db, { secret: 'a-secret-long-enough-for-better-auth-32', secureCookies });

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
 * What `handover init` will seed and what hazard 3's `wrangler d1 execute` writes by hand:
 * a credential account is keyed on the user's own id, and its issuer is the synthetic
 * `local:credential` — a row missing either is a password nothing can sign in with.
 */
async function seed(email: string, password: string, role: string) {
  const id = `usr_${email}`;
  await binding
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, 0, 0)`,
    )
    .bind(id, 'Seeded Owner', email, role)
    .run();
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
