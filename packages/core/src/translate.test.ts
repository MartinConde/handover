import { afterEach, expect, test, vi } from 'vitest';
import { deeplTranslate, fieldAddress, keptMachine, machineFilled } from './translate.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// The DeepL boundary. Every call made is kept so a test can read what was sent.
function stubFetch(reply: (body: { text: string[] }) => Response) {
  const calls: { url: string; init: RequestInit; body: { text: string[]; target_lang: string } }[] =
    [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, init, body });
      return reply(body);
    }),
  );
  return calls;
}

const translated = (body: { text: string[] }) =>
  Response.json({ translations: body.text.map((t) => ({ text: `[de] ${t}` })) });

test('DeepL is called with the texts, the languages and the key, and answers in order', async () => {
  const calls = stubFetch(translated);
  const out = await deeplTranslate('default', 'key-123')(['One', 'Two'], 'en', 'de');
  expect(out).toEqual(['[de] One', '[de] Two']);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://api.deepl.com/v2/translate');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('DeepL-Auth-Key key-123');
  expect(calls[0]?.body).toEqual({ text: ['One', 'Two'], source_lang: 'EN', target_lang: 'DE' });
});

test('a free key goes to the free host, and a regional code keeps its region', async () => {
  const calls = stubFetch(translated);
  await deeplTranslate('default', 'key-123:fx')(['One'], 'en', 'pt-br');
  expect(calls[0]?.url).toBe('https://api-free.deepl.com/v2/translate');
  expect(calls[0]?.body.target_lang).toBe('PT-BR');
});

test('more texts than one request takes are sent in several, still in order', async () => {
  const calls = stubFetch(translated);
  const texts = Array.from({ length: 120 }, (_, i) => `Text ${i}`);
  const out = await deeplTranslate('default', 'key')(texts, 'en', 'de');
  expect(calls.map((c) => c.body.text.length)).toEqual([50, 50, 20]);
  expect(out).toHaveLength(120);
  expect(out[119]).toBe('[de] Text 119');
});

test("DeepL's own message is what a refused translation says", async () => {
  stubFetch(() =>
    Response.json({ message: 'Value for target_lang not supported.' }, { status: 400 }),
  );
  await expect(deeplTranslate('default', 'key')(['One'], 'en', 'xx')).rejects.toThrow(
    'DeepL refused the translation (400): Value for target_lang not supported.',
  );
});

const page = {
  title: 'Home',
  blocks: [
    { _type: 'hero', _id: 'k3nf9a2p', heading: 'Welcome' },
    { _type: 'quote', _id: 'q1w2e3r4', body: 'A line' },
  ],
};

test('a machine fill writes the values it was given and names them in _machine', () => {
  const filled = machineFilled('default', page, {
    title: 'Startseite',
    'blocks[_id=k3nf9a2p].heading': 'Willkommen',
  });
  expect(filled.title).toBe('Startseite');
  expect((filled.blocks as { heading?: string }[])[0]?.heading).toBe('Willkommen');
  expect(filled._machine).toEqual(['title', 'blocks[_id=k3nf9a2p].heading']);
  // The file it was made from is not touched.
  expect(page.title).toBe('Home');
});

test('a second fill adds to the paths a machine already wrote', () => {
  const once = machineFilled('default', page, { title: 'Startseite' });
  const twice = machineFilled('default', once, { 'blocks[_id=q1w2e3r4].body': 'Eine Zeile' });
  expect(twice._machine).toEqual(['title', 'blocks[_id=q1w2e3r4].body']);
});

test('a path whose value a person typed over is no longer machine-written', () => {
  const before = { ...page, _machine: ['title', 'blocks[_id=k3nf9a2p].heading'] };
  const after = {
    ...page,
    blocks: [{ ...page.blocks[0], heading: 'Willkommen!' }, page.blocks[1]],
  };
  expect(keptMachine('default', before, after)).toEqual(['title']);
});

test('a save that changes nothing leaves every machine-written path where it was', () => {
  const before = { ...page, _machine: ['title', 'blocks[_id=k3nf9a2p].heading'] };
  expect(keptMachine('default', before, structuredClone(page))).toEqual([
    'title',
    'blocks[_id=k3nf9a2p].heading',
  ]);
});

test('a path whose block is gone is not kept', () => {
  const before = { ...page, _machine: ['blocks[_id=k3nf9a2p].heading'] };
  expect(keptMachine('default', before, { ...page, blocks: [page.blocks[1]] })).toEqual([]);
});

test('a field is addressed by the ids of the rows above it, not by their positions', () => {
  expect(fieldAddress('default', ['title'], page)).toBe('title');
  expect(fieldAddress('default', ['blocks', '1', 'body'], page)).toBe('blocks[_id=q1w2e3r4].body');
  // An array row with no `_id` — a template's blocks — is its position.
  expect(fieldAddress('default', ['tags', '2'], { tags: ['a', 'b', 'c'] })).toBe('tags[2]');
});

test('a fill makes the group it needs, and names no path it could not write', () => {
  const filled = machineFilled('default', page, {
    'seo.description': 'Ein Haus',
    'blocks[_id=nosuchid].heading': 'Nowhere',
  });
  expect(filled.seo).toEqual({ description: 'Ein Haus' });
  expect(filled._machine).toEqual(['seo.description']);
});
