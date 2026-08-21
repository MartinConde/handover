// Phase 0 password gate. Phase 3 deletes this file (and middleware.ts) for Better Auth.
import { env } from 'cloudflare:workers';

const COOKIE = 'handover_session';

function secret(): string {
  const value = (env as { ADMIN_PASSWORD?: string }).ADMIN_PASSWORD;
  if (!value)
    throw new Error('ADMIN_PASSWORD is not set: run `wrangler secret put ADMIN_PASSWORD`');
  return value;
}

// The cookie carries a digest rather than the password so it never echoes the secret.
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function equal(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return diff === 0;
}

export async function isAuthorized(request: Request): Promise<boolean> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return equal(bearer, secret());
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)handover_session=([^;]*)/)?.[1];
  return cookie ? equal(cookie, await digest(secret())) : false;
}

export async function login(password: string): Promise<Response> {
  if (!equal(password, secret())) {
    return Response.json({ error: 'Wrong password' }, { status: 401 });
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        'set-cookie': `${COOKIE}=${await digest(secret())}; Path=/admin; HttpOnly; Secure; SameSite=Strict`,
      },
    },
  );
}
