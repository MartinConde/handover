import { expect, test } from 'vitest';
import { createGitClient } from './git.js';

// A real key pair so the fake token endpoint can verify the JWT the client signs.
const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString(
  'base64',
);
const privateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;

const app = { appId: '12345', privateKey, installationId: '67890', owner: 'acme', repo: 'site' };

async function verifyJwt(header: string | null): Promise<{ iss: string; exp: number }> {
  const jwt = header?.replace(/^Bearer /, '') ?? '';
  const [h, p, s] = jwt.split('.');
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    keys.publicKey,
    Buffer.from(s ?? '', 'base64url'),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) throw new Error('bad signature');
  return JSON.parse(Buffer.from(p ?? '', 'base64url').toString());
}

// A fake GitHub: mints a token when the JWT verifies, serves one file, records every call.
function fakeGitHub(files: Record<string, string>) {
  const calls: string[] = [];
  let minted = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const auth = new Headers(init.headers).get('authorization');
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url === 'https://api.github.com/app/installations/67890/access_tokens') {
      const claims = await verifyJwt(auth);
      if (claims.iss !== '12345') return new Response('{}', { status: 401 });
      minted += 1;
      return Response.json(
        {
          token: `ghs_${minted}`,
          expires_at: new Date(claims.exp * 1000 + 3_000_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (auth !== `token ghs_${minted}`) return new Response('{}', { status: 401 });
    const m = url.match(
      /^https:\/\/api\.github\.com\/repos\/acme\/site\/contents\/(.+)\?ref=main$/,
    );
    const name = decodeURIComponent(m?.[1] ?? '');
    const body = files[name];
    if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    return Response.json({
      sha: `sha-of-${name}`,
      encoding: 'base64',
      content: `${Buffer.from(body).toString('base64').slice(0, 10)}\n${Buffer.from(body).toString('base64').slice(10)}\n`,
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, minted: () => minted };
}

test('getFile returns decoded contents and the blob sha', async () => {
  const gh = fakeGitHub({ 'src/content/listings/en/mill-house.yaml': 'title: Mühlenhaus\n' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  const file = await git.getFile('src/content/listings/en/mill-house.yaml');

  expect(file).toEqual({
    contents: 'title: Mühlenhaus\n',
    blob_sha: 'sha-of-src/content/listings/en/mill-house.yaml',
  });
});

test('getFile returns undefined for a missing path', async () => {
  const gh = fakeGitHub({});
  const git = createGitClient('default', app, { fetch: gh.fetch });

  expect(await git.getFile('nope.yaml')).toBeUndefined();
});

test('getFile throws on any other GitHub error', async () => {
  const fetch = (async () =>
    new Response('{"message":"boom"}', { status: 500 })) as typeof globalThis.fetch;
  const git = createGitClient('default', app, { fetch });

  await expect(git.getFile('a.yaml')).rejects.toThrow(/500/);
});

test('the installation token is minted once and reused while valid', async () => {
  const gh = fakeGitHub({ 'a.yaml': 'a', 'b.yaml': 'b' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await git.getFile('a.yaml');
  await git.getFile('b.yaml');

  expect(gh.minted()).toBe(1);
});

test('an expired installation token is minted again', async () => {
  const gh = fakeGitHub({ 'a.yaml': 'a' });
  let now = Date.parse('2026-08-21T10:00:00Z');
  const git = createGitClient('default', app, { fetch: gh.fetch, now: () => now });

  await git.getFile('a.yaml');
  now += 2 * 60 * 60 * 1000;
  await git.getFile('a.yaml');

  expect(gh.minted()).toBe(2);
});
