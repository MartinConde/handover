import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { openDb } from './db.js';
import { readSetting, removeSetting, settingFacts, writeSetting } from './settings.js';
import * as tables from './tables.js';
import { settings } from './tables.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default {}',
  d1Databases: { DB: ':memory:' },
});
afterAll(() => mf.dispose());

let binding: Awaited<ReturnType<typeof mf.getD1Database>>;
beforeAll(async () => {
  binding = await mf.getD1Database('DB');
  const ddl = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
});

const db = () => openDb('default', binding);
afterEach(async () => {
  await db().delete(settings);
});

// Two secrets a test can tell apart, each 32 bytes as base64 — what `openssl rand -base64 32`
// prints.
const base64 = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const SECRET = base64(7);
const OTHER = base64(9);
const KEY = 'fx-8d2a7b1c-4e5f-0000-9a3b-12x7Kq';

test('a key written under the secret reads back as itself', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  expect(await readSetting('default', db(), SECRET, 'deepl')).toBe(KEY);
});

/** The bytes of the one row there is, or none at all: a missing row reads as empty here. */
const written = async () => (await db().select().from(settings))[0]?.ciphertext ?? new Uint8Array();

test('what the row holds is not the key', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  const bytes = await written();
  expect(new TextDecoder().decode(bytes)).not.toContain('x7Kq');
  // 12 bytes of IV, the key's own 32, and GCM's 16-byte tag.
  expect(bytes.length).toBe(12 + KEY.length + 16);
  expect((await settingFacts('default', db()))[0]?.hint).toBe('x7Kq');
});

test('the same key written twice is stored twice differently', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  const first = await written();
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  expect(await db().select().from(settings)).toHaveLength(1);
  expect([...(await written())]).not.toEqual([...first]);
});

test('replacing a key answers with the new one', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  await writeSetting('default', db(), SECRET, 'deepl', 'second-key', 'usr_anna');
  expect(await readSetting('default', db(), SECRET, 'deepl')).toBe('second-key');
  const [row] = await db().select().from(settings);
  expect(row?.updatedBy).toBe('usr_anna');
});

// The state every site starts in, and the one the hot path meets: nothing stored, and no
// secret either. It must not be an error.
test('a key nothing was written for reads as nothing without a secret', async () => {
  expect(await readSetting('default', db(), undefined, 'deepl')).toBeUndefined();
});

test('a stored key with no secret to read it names the secret to set', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, null);
  await expect(readSetting('default', db(), undefined, 'deepl')).rejects.toThrow(
    'HANDOVER_SETTINGS_KEY',
  );
});

test('a secret that is not 32 bytes says so rather than failing to decrypt', async () => {
  await expect(writeSetting('default', db(), btoa('short'), 'deepl', KEY, null)).rejects.toThrow(
    '32 bytes',
  );
});

test('a key written under a different secret says the secret changed', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, null);
  await expect(readSetting('default', db(), OTHER, 'deepl')).rejects.toThrow(
    'a different HANDOVER_SETTINGS_KEY',
  );
});

test('removing one key leaves the other where it is', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, null);
  await writeSetting('default', db(), SECRET, 'assist', 'ai-key', null);
  await removeSetting('default', db(), 'deepl');
  expect(await readSetting('default', db(), SECRET, 'deepl')).toBeUndefined();
  expect(await readSetting('default', db(), SECRET, 'assist')).toBe('ai-key');
});

// What the screen is drawn from: enough to recognise a key, and no secret needed to ask.
test('what is set is readable without the secret, and the value never is', async () => {
  await writeSetting('default', db(), SECRET, 'deepl', KEY, 'usr_martin');
  expect(await settingFacts('default', db())).toEqual([
    { key: 'deepl', hint: 'x7Kq', updatedAt: expect.any(Number), updatedBy: 'usr_martin' },
  ]);
});
