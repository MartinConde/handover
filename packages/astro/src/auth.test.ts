import { expect, test, vi } from 'vitest';
import { isAuthorized, login } from './auth.js';

const mocked = vi.hoisted(() => ({
  env: { ADMIN_PASSWORD: 'hunter2' } as Record<string, unknown>,
}));
vi.mock('cloudflare:workers', () => mocked);

const req = (headers: Record<string, string>) =>
  new Request('https://x/admin/api/ping', { headers });
// sha256("hunter2")
const TOKEN = 'f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7';

test('bearer matching ADMIN_PASSWORD is authorized', async () => {
  expect(await isAuthorized(req({ authorization: 'Bearer hunter2' }))).toBe(true);
});

test('wrong bearer is refused even when a valid cookie is present', async () => {
  const r = req({ authorization: 'Bearer hunter', cookie: `handover_session=${TOKEN}` });
  expect(await isAuthorized(r)).toBe(false);
});

test('the session cookie is the digest of the password, not the password', async () => {
  expect(await isAuthorized(req({ cookie: `other=1; handover_session=${TOKEN}` }))).toBe(true);
  expect(await isAuthorized(req({ cookie: 'handover_session=hunter2' }))).toBe(false);
});

test('no credentials is refused', async () => {
  expect(await isAuthorized(req({}))).toBe(false);
});

test('login with the right password sets the HttpOnly session cookie', async () => {
  const res = await login('hunter2');
  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toBe(
    `handover_session=${TOKEN}; Path=/admin; HttpOnly; Secure; SameSite=Strict`,
  );
});

test('login with the wrong password is 401 without a cookie', async () => {
  const res = await login('');
  expect(res.status).toBe(401);
  expect(res.headers.get('set-cookie')).toBeNull();
});

test('an unset secret fails loudly instead of open', async () => {
  mocked.env.ADMIN_PASSWORD = undefined;
  await expect(isAuthorized(req({ authorization: 'Bearer x' }))).rejects.toThrow(
    'ADMIN_PASSWORD is not set',
  );
  mocked.env.ADMIN_PASSWORD = 'hunter2';
});
