import { expect, test, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from '../api.js';
import {
  commitBuild,
  createDraft,
  ctx,
  editor,
  fakeMailer,
  getHead,
  logged,
  owner,
  publish,
  saveDraft,
  sent,
  smtpCalls,
  state,
  stored,
  translate,
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

const testEmail = (session?: unknown) =>
  POST(
    ctx('checks/email', new Request('https://x/admin/api/checks/email', { method: 'POST' }), {
      handover: session,
    }),
  );

test('a test email goes to the signed-in owner and answers with the id it was given', async () => {
  state.siteMailer = fakeMailer;
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    code: 'DIAGNOSTIC_EMAIL_SENT',
    to: 'martin@example.com',
    id: 'fake-1',
  });
  // Nobody else can be named: the recipient is the session's, not the request's.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe('martin@example.com');
});

// The diagnostics screen's own endpoints.
const check = (name: string, session?: unknown) =>
  POST(
    ctx(`checks/${name}`, new Request(`https://x/admin/api/checks/${name}`, { method: 'POST' }), {
      handover: session,
    }),
  );
const body = async (res: Response) => (await res.json()) as Record<string, string>;

test('the diagnostics page reads the configuration back as the site resolved it', async () => {
  state.siteMailer = { provider: 'resend', from: 'Handover <hello@example.com>' };
  state.locales = ['en', 'de'];
  const res = await GET(ctx('diagnostics', undefined, { handover: owner }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    collections: [
      { name: 'pages' },
      { name: 'listings', route: '/listings/[slug]' },
      { name: 'presenters' },
      { name: 'posts', route: '/blog/[slug]' },
      { name: 'notices', route: '/notices/[slug]' },
    ],
    locales: ['en', 'de'],
    defaultLocale: 'en',
    mediaBase: 'https://media.example.com',
    mailer: { provider: 'resend', from: 'Handover <hello@example.com>' },
    preview: true,
    // What the build mode is, and under vitest that is development.
    dev: true,
  });
});

test('a mailer the site handed in itself is named as its own rather than as a provider', async () => {
  state.siteMailer = async () => ({ id: 'x' });
  expect(
    (await body(await GET(ctx('diagnostics', undefined, { handover: owner })))).mailer,
  ).toEqual({ provider: 'custom' });
});

test("the configuration is the owner's, not an editor's", async () => {
  expect((await GET(ctx('diagnostics', undefined, { handover: editor }))).status).toBe(403);
});

test('the repository check names the repository and the commit it read', async () => {
  getHead.mockResolvedValueOnce('15db5481068f69ac8e283707ec6ddb7f4d59744a');
  const res = await check('github', owner);
  expect(res.status).toBe(200);
  // Shortened: the whole forty characters is noise on a page somebody reads out loud.
  expect(await res.json()).toEqual({
    ok: true,
    code: 'DIAGNOSTIC_GITHUB_OK',
    detail: 'acme/site — the app minted a token and read 15db548.',
    repository: 'acme/site',
    revision: '15db548',
  });
});

test('a bucket the site was never told about answers with the four values to set', async () => {
  state.bucketed = false;
  const res = await check('storage', owner);
  expect(res.status).toBe(503);
  expect((await body(res.clone())).code).toBe('DIAGNOSTIC_UNAVAILABLE');
  expect((await body(res)).error).toContain('R2_ACCOUNT_ID');
});

test('a bucket that refuses the round trip answers with what refused it', async () => {
  state.storeRefusal = new Error('The bucket refused the upload (403)');
  const res = await check('storage', owner);
  expect(res.status).toBe(502);
  expect((await body(res.clone())).code).toBe('DIAGNOSTIC_REFUSED');
  expect((await body(res)).error).toBe('The bucket refused the upload (403)');
});

test('a bucket that takes the round trip says an upload would work', async () => {
  const res = await check('storage', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toContain('site-media');
});

test('a site with no translator says translation is off rather than failing', async () => {
  state.translator = undefined;
  state.locales = ['en', 'de'];
  const res = await check('translation', owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    off: true,
    code: 'DIAGNOSTIC_TRANSLATION_OFF',
    detail:
      'No DeepL key in Settings, no DEEPL_API_KEY and no translate hook, so the Translate button is hidden.',
  });
});

test("a translator is checked by translating a word into the site's other language", async () => {
  state.locales = ['en', 'de'];
  const res = await check('translation', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toBe('It translated "Hello" into de.');
  expect(translate).toHaveBeenCalledWith(['Hello'], 'en', 'de');
});

test('a one-language site has nothing to translate into and says that instead', async () => {
  const res = await check('translation', owner);
  expect(await res.json()).toEqual({
    off: true,
    code: 'DIAGNOSTIC_TRANSLATION_SINGLE_LANGUAGE',
    detail: 'This site has one language, so nothing is translated.',
  });
});

test('a site with no Cloudflare token says the build pill is off, not broken', async () => {
  state.cloudflareToken = undefined;
  const res = await check('build', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).off).toBe(true);
  expect(commitBuild).not.toHaveBeenCalled();
});

test('the build check asks the host about the worker rather than about a commit', async () => {
  const res = await check('build', owner);
  expect(res.status).toBe(200);
  expect((await body(res)).detail).toContain('acct/handover-demo');
  // No commit: what is being checked is the token.
  expect(commitBuild).toHaveBeenCalledWith(
    { worker: 'acct/handover-demo', token: 'cf-token' },
    undefined,
  );
});

test('a token the host refuses is a failing check and says so', async () => {
  commitBuild.mockRejectedValueOnce(new Error('Cloudflare builds failed: 403'));
  const res = await check('build', owner);
  expect(res.status).toBe(502);
  expect((await body(res)).error).toBe('Cloudflare builds failed: 403');
});

test('the database check answers with the schema version the tables are at', async () => {
  const res = await check('database', owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    code: 'DIAGNOSTIC_DATABASE_OK',
    detail: "The database answered — the admin's tables are there. Schema version 11.",
    version: 11,
  });
});

test('a site with no D1 binding answers with the binding to add', async () => {
  state.dbRefusal = new Error('The D1 binding DB is not configured: add a d1_databases entry');
  const res = await check('database', owner);
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('d1_databases');
});

test("every check is the owner's", async () => {
  for (const name of ['github', 'storage', 'translation', 'build', 'database']) {
    expect((await check(name, editor)).status).toBe(403);
  }
});

test('a check nobody has heard of is not found', async () => {
  expect((await check('nonsense', owner)).status).toBe(404);
});

// The one writable section of the settings screen.
const settings = (session?: unknown) => GET(ctx('settings', undefined, { handover: session }));
const setKey = (key: string, value: unknown, session: unknown = owner) =>
  PUT(
    ctx(
      `settings/${key}`,
      new Request(`https://x/admin/api/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
      { handover: session },
    ),
  );
const clearKey = (key: string, session: unknown = owner) =>
  DELETE(
    ctx(
      `settings/${key}`,
      new Request(`https://x/admin/api/settings/${key}`, { method: 'DELETE' }),
      {
        handover: session,
      },
    ),
  );

test("the keys the client owns are the owner's, not an editor's", async () => {
  expect((await settings(editor)).status).toBe(403);
  expect((await setKey('deepl', 'k', editor)).status).toBe(403);
  expect((await clearKey('deepl', editor)).status).toBe(403);
  expect(stored.deepl).toBeUndefined();
});

test('a key set here is named by its last four and by who set it', async () => {
  state.memberRows = [
    {
      id: 'u1',
      name: 'Martin',
      email: 'martin@example.com',
      role: 'owner',
      pending: false,
      method: 'password',
      lastSignIn: null,
      invitedAt: 0,
    },
  ];
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1755864000000, updatedBy: 'u1' };
  state.translator = undefined;
  const res = await settings(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    integrations: [
      {
        key: 'deepl',
        source: 'settings',
        // The empty setting proves Remove disables translation.
        fallback: 'off',
        hint: 'x7Kq',
        updatedAt: 1755864000000,
        by: 'Martin',
      },
      { key: 'assist', source: 'off', fallback: 'off', hint: null, updatedAt: null, by: null },
    ],
  });
});

test("a key only the environment has is named as the site's own", async () => {
  state.translator = undefined;
  state.deeplKey = 'env-key';
  const { integrations } = (await (await settings(owner)).json()) as {
    integrations: { key: string; source: string; hint: string | null }[];
  };
  expect(integrations[0]).toEqual({
    key: 'deepl',
    source: 'env',
    fallback: 'env',
    hint: null,
    updatedAt: null,
    by: null,
  });
});

test('a key set here says what removing it would fall back to', async () => {
  state.translator = undefined;
  state.deeplKey = 'env-key';
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: null };
  const { integrations } = (await (await settings(owner)).json()) as {
    integrations: { source: string; fallback: string }[];
  };
  expect(integrations[0]).toMatchObject({ source: 'settings', fallback: 'env' });
});

test('a site that translates with its own code is not translated by a key pasted here', async () => {
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1755864000000, updatedBy: null };
  const res = await settings(owner);
  const [deepl] = ((await res.json()) as { integrations: { source: string; hint: string }[] })
    .integrations;
  // The hook is above both keys in the resolution, so the card cannot claim to be in charge.
  expect(deepl?.source).toBe('code');
  expect(deepl?.hint).toBe('x7Kq');
});

test('a key is tried against DeepL before it is stored, and a refusal stores nothing', async () => {
  state.locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ message: 'Wrong endpoint' }, { status: 403 })),
  );
  const res = await setKey('deepl', 'wrong-key');
  expect(res.status).toBe(502);
  expect((await body(res.clone())).code).toBe('DIAGNOSTIC_REFUSED');
  expect((await body(res)).error).toContain('403');
  expect(stored.deepl).toBeUndefined();
  expect(logged).toEqual([]);
});

test('a key that answers is stored, and the answer never carries it back', async () => {
  state.locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ translations: [{ text: 'Hallo' }] })),
  );
  const res = await setKey('deepl', '  fx-0000-x7Kq  ');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    code: 'INTEGRATION_KEY_TESTED',
    detail: 'It translated "Hello" into de.',
    locale: 'de',
  });
  // Trimmed: a pasted key carries whitespace, and the service would refuse it later.
  expect(stored.deepl?.value).toBe('fx-0000-x7Kq');
});

test('what the log records is the name of the key and what happened to it', async () => {
  state.locales = ['en', 'de'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ translations: [{ text: 'Hallo' }] })),
  );
  await setKey('deepl', 'fx-0000-x7Kq');
  await setKey('deepl', 'fx-1111-9zQp');
  await clearKey('deepl');
  expect(logged).toEqual([
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'set' } },
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'replaced' } },
    { userId: 'u1', kind: 'setting-changed', subject: 'deepl', detail: { how: 'removed' } },
  ]);
  expect(JSON.stringify(logged)).not.toContain('9zQp');
});

test('a key outside the allow-list is not found, whatever it is called', async () => {
  expect((await setKey('github', 'ghp_x')).status).toBe(404);
  expect((await clearKey('resend')).status).toBe(404);
  expect(stored.github).toBeUndefined();
});

test('an empty key is refused before anything is asked or stored', async () => {
  const empty = await setKey('deepl', '   ');
  expect(empty.status).toBe(400);
  expect((await body(empty)).code).toBe('INTEGRATION_KEY_REQUIRED');
  expect((await setKey('deepl', 42)).status).toBe(400);
  expect(stored.deepl).toBeUndefined();
});

test('a site with no secret to encrypt under names the secret rather than storing it', async () => {
  state.settingsSecret = undefined;
  const res = await setKey('assist', 'ai-key');
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('HANDOVER_SETTINGS_KEY');
  expect(stored.assist).toBeUndefined();
});

test('removing a key takes it out and leaves the other one where it is', async () => {
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: 'u1' };
  stored.assist = { value: 'ai-key', hint: '-key', updatedAt: 1, updatedBy: 'u1' };
  const res = await clearKey('deepl');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, code: 'INTEGRATION_KEY_REMOVED' });
  expect(stored.deepl).toBeUndefined();
  expect(stored.assist).toBeDefined();
});

test('a stored key the secret can no longer open is a sentence on the settings screen', async () => {
  state.translator = undefined;
  state.locales = ['en', 'de'];
  stored.deepl = { value: 'fx-0000-x7Kq', hint: 'x7Kq', updatedAt: 1, updatedBy: 'u1' };
  state.settingsSecret = undefined;
  const res = await check('translation', owner);
  expect(res.status).toBe(503);
  expect((await body(res)).error).toContain('HANDOVER_SETTINGS_KEY');
});

test('an editor cannot send a test email', async () => {
  state.siteMailer = fakeMailer;
  const res = await testEmail(editor);
  expect(res.status).toBe(403);
  expect(sent).toEqual([]);
});

test('a site that configured no mailer says so instead of failing', async () => {
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('cms.config.ts');
});

test('a site whose provider has no key names the key', async () => {
  state.siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('RESEND_API_KEY');
});

test('the named provider sends through Resend on the key the Worker holds', async () => {
  state.siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  state.resendKey = 're_123';
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ id: 'e1b2c3d4' });
    }),
  );
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    code: 'DIAGNOSTIC_EMAIL_SENT',
    to: 'martin@example.com',
    id: 'e1b2c3d4',
  });
  expect(calls[0]).toMatchObject({
    from: 'Handover <onboarding@resend.dev>',
    to: 'martin@example.com',
  });
});

test("the provider's own refusal is what a failed test email says", async () => {
  state.siteMailer = { provider: 'resend', from: 'Handover <onboarding@resend.dev>' };
  state.resendKey = 're_123';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { message: 'The onboarding@resend.dev domain is for testing.' },
        { status: 403 },
      ),
    ),
  );
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Resend refused the message (403): The onboarding@resend.dev domain is for testing.',
  );
});

test('a site on smtp with no login names both halves of it', async () => {
  state.siteMailer = {
    provider: 'smtp',
    from: 'Handover <admin@example.com>',
    host: 'smtp.example.com',
  };
  state.smtpUser = 'resend';
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain('SMTP_USER');
  expect(error).toContain('SMTP_PASS');
});

test('a site on cloudflare with no binding names the binding', async () => {
  state.siteMailer = { provider: 'cloudflare', from: 'Handover <admin@example.com>' };
  const res = await testEmail(owner);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain('send_email');
});

test('smtp sends over implicit TLS with the sender split, and reports no id', async () => {
  state.siteMailer = {
    provider: 'smtp',
    from: 'Handover <admin@dev.martinconde.de>',
    host: 'smtp.resend.com',
  };
  state.smtpUser = 'resend';
  state.smtpPass = 're_secret_123';
  const res = await testEmail(owner);
  expect(res.status).toBe(200);
  // No `id`: SMTP hands back nothing a person could look the message up by.
  expect(await res.json()).toEqual({
    ok: true,
    code: 'DIAGNOSTIC_EMAIL_SENT',
    to: 'martin@example.com',
  });
  expect(smtpCalls).toHaveLength(1);
  expect(smtpCalls[0]?.options).toMatchObject({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    startTls: false,
    authType: ['plain', 'login'],
    credentials: { username: 'resend', password: 're_secret_123' },
  });
  expect(smtpCalls[0]?.email).toMatchObject({
    to: 'martin@example.com',
    from: { name: 'Handover', email: 'admin@dev.martinconde.de' },
  });
});

test('a refused smtp send tells the owner nothing about the password', async () => {
  state.siteMailer = {
    provider: 'smtp',
    from: 'Handover <admin@dev.martinconde.de>',
    host: 'smtp.resend.com',
  };
  state.smtpUser = 'resend';
  state.smtpPass = 're_secret_123';
  state.smtpRefusal = new Error('Failed to plain authentication: 535 Authentication failed');
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  const { error } = (await res.json()) as { error: string };
  expect(error).toBe(
    'smtp.resend.com did not take the message: Failed to plain authentication: 535 Authentication failed',
  );
  expect(error).not.toContain('re_secret_123');
  expect(error).not.toContain(btoa('\0resend\0re_secret_123'));
});

test("Cloudflare's refusal reaches the owner naming the rule that was broken", async () => {
  state.siteMailer = { provider: 'cloudflare', from: 'Handover <admin@not-onboarded.example.com>' };
  state.emailBinding = {
    send: () =>
      Promise.reject(
        new Error(
          'email from not-onboarded.example.com not allowed because domain is not owned by the same account',
        ),
      ),
  };
  const res = await testEmail(owner);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Cloudflare refused the message: email from not-onboarded.example.com not allowed because domain is not owned by the same account',
  );
});

// "Simulate conflict": the diagnostics button's endpoint.
test('the simulated conflict is made in a collection its schema can be filled in', async () => {
  publish.mockClear();

  const res = await POST(ctx('checks/conflict', undefined, { handover: owner }));

  expect(res.status).toBe(200);
  const body = (await res.json()) as { entry: string; path: string };
  // Named after the commit it is made against.
  expect(body.entry).toBe('listings/conflict-check-head789');
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    body.path,
    expect.objectContaining({ title: 'Conflict check', rooms: 0 }),
  );
  // The draft says one thing and the commit that follows it says another: that is the conflict.
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    body.path,
    // Two fields both sides write, so the answers can differ from each other.
    expect.objectContaining({ title: 'Your version', location: 'Yours here too' }),
  );
  expect(publish).toHaveBeenCalledWith(
    [
      {
        path: body.path,
        contents: expect.stringMatching(/The version in the code[\s\S]*And the code here too/),
      },
    ],
    expect.objectContaining({ base_sha: 'def456' }),
  );
});

test("simulating a conflict is the owner's, not an editor's", async () => {
  publish.mockClear();

  expect((await POST(ctx('checks/conflict', undefined, { handover: editor }))).status).toBe(403);
  expect(publish).not.toHaveBeenCalled();
});
