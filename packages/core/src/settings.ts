import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db.js';
import { settings } from './tables.js';

/**
 * The keys a client may set for themselves, fixed here and nowhere else. Everything that keeps
 * the admin running — the GitHub App, the bucket, the mailer, the session secret — stays in the
 * environment, because a wrong value there locks the client out of the screen that fixes it.
 */
export const INTEGRATIONS = ['deepl', 'assist'] as const;
export type Integration = (typeof INTEGRATIONS)[number];

/** What the screen may know about a stored key: enough to recognise it, never enough to use it. */
export interface SettingFact {
  key: Integration;
  /** Last four characters of the key itself — "is this the one I pasted?" and nothing more. */
  hint: string | null;
  updatedAt: number;
  updatedBy: string | null;
}

const UNSET =
  'HANDOVER_SETTINGS_KEY is not set, so keys cannot be stored here or read back: make one with `openssl rand -base64 32`, set it with `wrangler secret put HANDOVER_SETTINGS_KEY`, and put the same line in .dev.vars for local development';
const WRONG_SIZE =
  'HANDOVER_SETTINGS_KEY is not 32 bytes of base64: make one with `openssl rand -base64 32`';

/**
 * AES-256-GCM under the Worker's own secret. D1 encrypts its disk, which is not the same as a
 * dumped row or a Time Travel restore, so what is written is already unreadable.
 */
async function aesKey(secret: string | undefined) {
  if (!secret) throw new Error(UNSET);
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(WRONG_SIZE);
  }
  if (raw.length !== 32) throw new Error(WRONG_SIZE);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Read as hex rather than as a blob: Drizzle maps a blob column through `Buffer`, which is not
// there without `nodejs_compat`, and what D1 hands back for one differs between the Worker and
// the local proxy. A string is a string in both.
const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** A new IV every write: the same key stored twice must not be the same row twice. */
export async function writeSetting(
  siteId: string,
  db: Db,
  secret: string | undefined,
  key: Integration,
  value: string,
  userId: string | null,
): Promise<void> {
  const aes = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(value)),
  );
  const ciphertext = new Uint8Array(iv.length + sealed.length);
  ciphertext.set(iv);
  ciphertext.set(sealed, iv.length);
  const row = {
    ciphertext,
    hint: value.slice(-4),
    updatedAt: Date.now(),
    updatedBy: userId,
  };
  await db
    .insert(settings)
    .values({ siteId, key, ...row })
    .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: row });
}

/**
 * The key in force, or nothing. A site with no row never touches the secret — which is most
 * sites, and the path an entry opening asks this on.
 */
export async function readSetting(
  siteId: string,
  db: Db,
  secret: string | undefined,
  key: Integration,
): Promise<string | undefined> {
  const [row] = await db
    .select({ hex: sql<string>`hex(${settings.ciphertext})` })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, key)));
  if (!row) return undefined;
  const aes = await aesKey(secret);
  const bytes = bytesOf(row.hex);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      aes,
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Rotating the secret leaves rows nothing can open. Say that, rather than reporting the
    // service as broken: the fix is to paste the key again.
    throw new Error(
      `The stored ${key} key was encrypted with a different HANDOVER_SETTINGS_KEY and cannot be read: replace it in Settings, or put the old secret back`,
    );
  }
}

export async function removeSetting(siteId: string, db: Db, key: Integration): Promise<void> {
  await db.delete(settings).where(and(eq(settings.siteId, siteId), eq(settings.key, key)));
}

/** What is set, without reading any of it — no secret is needed to draw the screen. */
export async function settingFacts(siteId: string, db: Db): Promise<SettingFact[]> {
  const rows = await db
    .select({
      key: settings.key,
      hint: settings.hint,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(eq(settings.siteId, siteId));
  return rows.map((row) => ({ ...row, key: row.key as Integration }));
}
