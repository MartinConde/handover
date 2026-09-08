import { afterEach, expect, test, vi } from 'vitest';
import type { Form } from './schema.js';
import {
  deeplTranslate,
  fieldAddress,
  fieldPosition,
  keptMachine,
  machineFilled,
  resolveFieldTarget,
} from './translate.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Keep every DeepL call for assertions.
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

test('an address is read back to where the form draws the field, wherever its row now sits', () => {
  expect(fieldPosition('default', 'blocks[_id=q1w2e3r4].body', page)).toEqual([
    'blocks',
    '1',
    'body',
  ]);
  const moved = { ...page, blocks: [page.blocks[1], page.blocks[0]] };
  expect(fieldPosition('default', 'blocks[_id=q1w2e3r4].body', moved)).toEqual([
    'blocks',
    '0',
    'body',
  ]);
  expect(fieldPosition('default', 'tags[2]', { tags: ['a', 'b', 'c'] })).toEqual(['tags', '2']);
});

test('an address whose row is gone has no position', () => {
  expect(
    fieldPosition('default', 'blocks[_id=q1w2e3r4].body', { ...page, blocks: [page.blocks[0]] }),
  ).toBeUndefined();
});

const nestedForm: Form = {
  fields: [
    {
      path: ['sections'],
      label: 'Sections',
      type: 'array',
      required: true,
      item: [
        { path: ['title'], label: 'Title', type: 'text', required: true },
        { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['quote'] },
      ],
    },
  ],
  blocks: {
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};

const nested = {
  sections: [
    {
      _id: 'section-a',
      title: 'First',
      blocks: [{ _id: 'quote-a', _type: 'quote', body: 'One' }],
    },
    {
      _id: 'section-b',
      title: 'Second',
      blocks: [{ _id: 'quote-b', _type: 'quote', body: 'Two' }],
    },
  ],
};

test('a schema-aware nested address survives reordering at every list level', () => {
  const address = fieldAddress(
    'default',
    ['sections', '1', 'blocks', '0', 'body'],
    nested,
    nestedForm,
  );
  expect(address).toBe('sections[_id=section-b].blocks[_id=quote-b].body');

  const moved = structuredClone(nested);
  moved.sections.reverse();
  moved.sections[0]?.blocks.reverse();
  expect(fieldPosition('default', address ?? '', moved, nestedForm)).toEqual([
    'sections',
    '0',
    'blocks',
    '0',
    'body',
  ]);
  expect(resolveFieldTarget('default', nestedForm, address ?? '', moved)).toMatchObject({
    ok: true,
    target: { path: ['sections', '0', 'blocks', '0', 'body'], field: { type: 'text' } },
  });
});

test('duplicate row ids are ambiguous rather than resolving to the first row', () => {
  const duplicate = structuredClone(nested);
  const second = duplicate.sections[1];
  if (!second) throw new Error('second section missing');
  second._id = 'section-a';
  const address = 'sections[_id=section-a].title';

  expect(
    fieldAddress('default', ['sections', '0', 'title'], duplicate, nestedForm),
  ).toBeUndefined();
  expect(fieldPosition('default', address, duplicate, nestedForm)).toBeUndefined();
  expect(resolveFieldTarget('default', nestedForm, address, duplicate)).toEqual({
    ok: false,
    reason: 'ambiguous',
  });
  expect(machineFilled('default', duplicate, { [address]: 'Do not guess' })).toEqual(duplicate);
});

test('deleted and non-schema targets have distinct resolution failures', () => {
  expect(resolveFieldTarget('default', nestedForm, 'sections[_id=missing].title', nested)).toEqual({
    ok: false,
    reason: 'deleted',
  });
  expect(
    resolveFieldTarget('default', nestedForm, 'sections[_id=section-a].unknown', nested),
  ).toEqual({ ok: false, reason: 'schema' });
});
