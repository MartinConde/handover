import type { Drift, Form } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { createEntrySession } from './entry-session.svelte';

const form: Form = {
  fields: [
    {
      path: ['sections'],
      label: 'Sections',
      type: 'array',
      required: true,
      item: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
    },
  ],
  blocks: {},
};

const data = () => ({
  sections: [
    { _id: 'first', title: 'First' },
    { _id: 'second', title: '' },
  ],
});

const drift: Drift = {
  path: 'sections[_id=third]',
  in: ['de'],
  expected: ['en', 'de'],
  values: { de: ['Third'] },
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('every changed session command reports editing activity from one shared boundary', () => {
  const activity = vi.fn();
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {},
    form,
    onactivity: activity,
  });

  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Changed in Form or Canvas' }],
    }),
  ).toMatchObject({ ok: true, contentVersion: 1 });
  expect(activity).toHaveBeenCalledTimes(1);

  // A successful acknowledgement without a data change is not editing activity.
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 1,
      changes: [{ value: 'Changed in Form or Canvas' }],
    }),
  ).toMatchObject({ ok: true, contentVersion: 1 });
  expect(activity).toHaveBeenCalledTimes(1);

  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 1,
      operation: { type: 'move', from: 0, to: 1 },
    }),
  ).toMatchObject({ ok: true, contentVersion: 2 });
  expect(activity).toHaveBeenCalledTimes(2);

  expect(session.undo()).toMatchObject({ ok: true, contentVersion: 3 });
  expect(activity).toHaveBeenCalledTimes(3);
});

test('typing versions stay cheap until save materializes the latest snapshot once', async () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {},
    form,
  });
  const write = vi.fn(async () => true);
  session.configureAutosave(write);
  const stringify = vi.spyOn(JSON, 'stringify');

  for (const title of ['F', 'Fi', 'Final']) {
    const result = session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: session.contentVersion('en'),
      changes: [{ value: title }],
    });
    expect(result.ok).toBe(true);
    expect(session.unsaved('en')).toBe(true);
  }

  expect(stringify).not.toHaveBeenCalled();
  expect(await session.flush()).toBe(true);
  expect(stringify).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith('en', expect.stringContaining('Final'), undefined, 3);
  expect(session.unsaved('en')).toBe(false);
  expect(await session.flush()).toBe(true);
  expect(stringify).toHaveBeenCalledTimes(1);
  stringify.mockRestore();
});

test('ordinary source prose and no-op commands avoid unrelated document projection', () => {
  const source = data();
  const target = data();
  const targetFirst = target.sections[0];
  if (!targetFirst) throw new Error('first target section missing');
  targetFirst.title = 'Erste';
  const session = createEntrySession({
    sourceLocale: 'en',
    data: source,
    translations: { de: target },
    form,
  });
  let unrelatedReads = 0;
  const unrelated = {};
  Object.defineProperty(unrelated, 'deep', {
    enumerable: true,
    get: () => {
      unrelatedReads += 1;
      return 'untouched';
    },
  });
  const sourceSnapshot = session.snapshots.en;
  const targetSnapshot = session.snapshots.de;
  if (!sourceSnapshot || !targetSnapshot) throw new Error('locale snapshot missing');
  sourceSnapshot.unrelated = unrelated;
  unrelatedReads = 0;

  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Changed source words' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(unrelatedReads).toBe(0);
  expect((targetSnapshot.sections as { title: string }[])[0]?.title).toBe('Erste');
  expect(session.contentVersion('de')).toBe(0);

  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 1,
      changes: [{ value: 'Changed source words' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(unrelatedReads).toBe(0);
});

test('source field projection updates shared values without replacing translated words or markers', () => {
  const target = widgetData();
  target.title = 'Startseite';
  target.shared = 'Alte gemeinsame Bezeichnung';
  target.hero = { ...target.hero, alt: 'Küste' };
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: { de: { ...target, _machine: ['hero.alt'] } },
    form: widgetForm,
  });
  const targetSnapshot = session.snapshots.de;
  if (!targetSnapshot) throw new Error('target snapshot missing');

  expect(
    session.fieldCommand('en', {
      address: 'shared',
      contentVersion: 0,
      changes: [{ value: 'New shared label' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(targetSnapshot.shared).toBe('New shared label');
  expect(session.contentVersion('de')).toBe(1);

  expect(
    session.fieldCommand('en', {
      address: 'hero',
      contentVersion: 1,
      changes: [{ path: ['src'], value: 'media/new-hero.webp' }],
    }),
  ).toEqual({ ok: true, contentVersion: 2 });
  expect(targetSnapshot.hero).toEqual({
    src: 'media/new-hero.webp',
    alt: 'Küste',
    width: 1600,
    height: 900,
  });
  expect(targetSnapshot._machine).toEqual(['hero.alt']);

  expect(session.undo()).toMatchObject({ ok: true, contentVersion: 3 });
  expect((targetSnapshot.hero as { src: string }).src).toBe('media/hero.webp');
  expect(targetSnapshot._machine).toEqual(['hero.alt']);
  expect(session.redo()).toMatchObject({ ok: true, contentVersion: 4 });
  expect((targetSnapshot.hero as { src: string }).src).toBe('media/new-hero.webp');

  expect(
    session.fieldCommand('en', {
      address: 'hero',
      contentVersion: 4,
      changes: [{ value: undefined }],
    }),
  ).toEqual({ ok: true, contentVersion: 5 });
  expect(targetSnapshot.hero).toEqual({ alt: 'Küste' });
  expect(targetSnapshot._machine).toEqual(['hero.alt']);
});

test('validation problems follow nested rows after a local reorder', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {},
    form,
    problems: { en: [{ path: 'sections.1.title', message: 'Required' }] },
  });
  expect(session.problemAddresses('en')).toEqual({
    'sections[_id=second].title': 'Required',
  });
  session.listCommand('en', {
    address: 'sections',
    contentVersion: 0,
    operation: { type: 'move', from: 1, to: 0 },
  });
  expect(session.positionalProblems('en')).toEqual({ 'sections.0.title': 'Required' });
  expect(session.resolveField('en', 'sections[_id=second].title')).toMatchObject({
    ok: true,
    target: { path: ['sections', '0', 'title'], field: { type: 'text' } },
  });
});

test('a late validation response is discarded by content version', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {},
    form,
    problems: { en: [{ path: 'sections.1.title', message: 'Required' }] },
  });
  const sent = JSON.stringify(session.snapshot('en'));
  const sentVersion = session.contentVersion('en');

  session.fieldCommand('en', {
    address: 'sections[_id=second].title',
    contentVersion: sentVersion,
    changes: [{ value: 'Now valid' }],
  });

  expect(
    session.acceptProblems(
      'en',
      [{ path: 'sections.1.title', message: 'Stale error' }],
      sent,
      sentVersion,
    ),
  ).toBe(false);
  expect(session.problemAddresses('en')).toEqual({
    'sections[_id=second].title': 'Required',
  });
});

test('validation does not guess between duplicate ids', () => {
  const duplicate = data();
  const second = duplicate.sections[1];
  if (!second) throw new Error('second section missing');
  second._id = 'first';
  const session = createEntrySession({
    sourceLocale: 'en',
    data: duplicate,
    translations: {},
    form,
    problems: { en: [{ path: 'sections.0.title', message: 'Required' }] },
  });

  expect(session.problemAddresses('en')).toEqual({});
  expect(session.positionalProblems('en')).toEqual({});
  expect(session.resolveField('en', 'sections[_id=first].title')).toEqual({
    ok: false,
    reason: 'ambiguous',
  });
});

test('unresolved drift blocks field and list commands across the shared session', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
    drift: [drift],
  });

  expect(session.hasDrift()).toBe(true);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Changed' }],
    }),
  ).toEqual({ ok: false, reason: 'drift' });
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 0,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: false, reason: 'drift' });
  expect(session.snapshot('en')).toEqual(data());
});

test('reconciliation keeps navigation available and reloads the whole entry before editing resumes', async () => {
  const reload = vi.fn(async () => {});
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
    drift: [drift],
    onreconciled: reload,
  });

  expect(await session.flush()).toBe(true);
  await session.afterReconciliation();

  expect(reload).toHaveBeenCalledOnce();
  expect(session.hasSnapshot('en')).toBe(true);
  expect(session.hasSnapshot('de')).toBe(true);
});

const widgetForm: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['shared'],
      label: 'Shared label',
      type: 'text',
      required: false,
      i18n: 'duplicate',
    },
    { path: ['button'], label: 'Button', type: 'link', required: false },
    { path: ['hero'], label: 'Hero', type: 'image', required: false, preset: {} },
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: false, types: ['card'] },
  ],
  blocks: {
    card: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
  },
};

const widgetData = () => ({
  title: 'Home',
  shared: 'One label',
  button: { type: 'entry', ref: 'pages/contact', label: 'Contact' },
  hero: { src: 'media/hero.webp', alt: 'Coast', width: 1600, height: 900 },
  blocks: [{ _id: 'shared-card', _type: 'card', _ref: 'globals/card', heading: 'Shared' }],
});

test('one structured field command commits all of its property changes together', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  const result = session.fieldCommand('en', {
    address: 'button',
    contentVersion: 0,
    changes: [
      { path: ['type'], value: 'url' },
      { path: ['ref'], value: undefined },
      { path: ['href'], value: 'https://example.com/contact' },
    ],
  });

  expect(result).toEqual({ ok: true, contentVersion: 1 });
  expect(session.snapshot('en').button).toEqual({
    type: 'url',
    label: 'Contact',
    href: 'https://example.com/contact',
  });
});

test('field commands reject stale versions without touching the current snapshot', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 0,
    changes: [{ value: 'A newer edit' }],
  });

  expect(
    session.fieldCommand('en', {
      address: 'title',
      contentVersion: 0,
      changes: [{ value: 'Stale edit' }],
    }),
  ).toEqual({ ok: false, reason: 'stale' });
  expect(session.snapshot('en').title).toBe('A newer edit');
});

test('translated commands enforce field modes and translated widget properties', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: { de: widgetData() },
    form: widgetForm,
  });

  expect(
    session.fieldCommand('de', {
      address: 'shared',
      contentVersion: 0,
      changes: [{ value: 'Anderes Label' }],
    }),
  ).toEqual({ ok: false, reason: 'readonly' });
  expect(
    session.fieldCommand('de', {
      address: 'hero',
      contentVersion: 0,
      changes: [{ path: ['src'], value: 'media/other.webp' }],
    }),
  ).toEqual({ ok: false, reason: 'readonly' });
  expect(
    session.fieldCommand('de', {
      address: 'hero.alt',
      contentVersion: 0,
      changes: [{ value: 'Küste' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(session.snapshot('de').hero as { src: string; alt: string }).toMatchObject({
    src: 'media/hero.webp',
    alt: 'Küste',
  });
});

test('field commands cannot edit a referenced block descendant', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });

  expect(
    session.fieldCommand('en', {
      address: 'blocks[_id=shared-card].heading',
      contentVersion: 0,
      changes: [{ value: 'Local override' }],
    }),
  ).toEqual({ ok: false, reason: 'referenced' });
});

test('closing the save gate also refuses later field mutations', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  session.closeSaveGate();

  expect(
    session.fieldCommand('en', {
      address: 'title',
      contentVersion: 0,
      changes: [{ value: 'After lock loss' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });
  expect(session.snapshot('en').title).toBe('Home');
});

test('list commands insert, remove, and move within one resolved container', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {},
    form,
  });

  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 0,
      operation: { type: 'move', from: 0, to: 1 },
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 1,
      operation: {
        type: 'insert',
        index: 1,
        value: { _id: 'third', title: 'Third' },
      },
    }),
  ).toEqual({ ok: true, contentVersion: 2 });
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 2,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: true, contentVersion: 3 });
  expect(session.snapshot('en').sections).toEqual([
    { _id: 'third', title: 'Third' },
    { _id: 'first', title: 'First' },
  ]);
});

test('a block replacement is one structural command and one undoable history step', () => {
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  const before = JSON.parse(JSON.stringify((session.snapshot('en').blocks as unknown[])[0]));

  const result = session.listCommand('en', {
    address: 'blocks',
    contentVersion: session.contentVersion('en'),
    operation: {
      type: 'replace',
      index: 0,
      value: { _type: 'card', _id: 'replacement', heading: 'Replacement' },
    },
  });

  expect(result.ok).toBe(true);
  expect(session.snapshot('en').blocks).toEqual([
    { _type: 'card', _id: 'replacement', heading: 'Replacement' },
  ]);
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('en').blocks as unknown[])[0]).toEqual(before);
});

test('list commands reject stale, translated, and duplicate-id mutations without touching data', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
  });
  session.listCommand('en', {
    address: 'sections',
    contentVersion: 0,
    operation: { type: 'move', from: 1, to: 0 },
  });

  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 0,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: false, reason: 'stale' });
  expect(
    session.listCommand('de', {
      address: 'sections',
      contentVersion: session.contentVersion('de'),
      operation: { type: 'move', from: 0, to: 1 },
    }),
  ).toEqual({ ok: false, reason: 'readonly' });
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 1,
      operation: {
        type: 'insert',
        index: 0,
        value: { _id: 'first', title: 'Duplicate' },
      },
    }),
  ).toEqual({ ok: false, reason: 'ambiguous' });
  expect((session.snapshot('en').sections as { _id: string }[]).map((row) => row._id)).toEqual([
    'second',
    'first',
  ]);
  expect((session.snapshot('de').sections as { _id: string }[]).map((row) => row._id)).toEqual([
    'second',
    'first',
  ]);
});

test('a nested list resolves through stable parents and rejects referenced descendants', () => {
  const nestedForm: Form = {
    fields: [
      { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['card'] },
    ],
    blocks: {
      card: [
        {
          path: ['items'],
          label: 'Items',
          type: 'array',
          required: true,
          item: [{ path: ['title'], label: 'Title', type: 'text', required: true }],
        },
      ],
    },
  };
  const nestedData = {
    blocks: [
      {
        _id: 'card',
        _type: 'card',
        _ref: undefined as string | undefined,
        items: [
          { _id: 'one', title: 'One' },
          { _id: 'two', title: 'Two' },
        ],
      },
    ],
  };
  const session = createEntrySession({
    sourceLocale: 'en',
    data: nestedData,
    translations: {},
    form: nestedForm,
  });

  expect(
    session.listCommand('en', {
      address: 'blocks[_id=card].items',
      contentVersion: 0,
      operation: { type: 'move', from: 0, to: 1 },
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(
    ((session.snapshot('en').blocks as typeof nestedData.blocks)[0]?.items ?? []).map(
      (row) => row._id,
    ),
  ).toEqual(['two', 'one']);

  const referencedData = structuredClone(nestedData);
  const card = referencedData.blocks[0];
  if (!card) throw new Error('card block missing');
  card._ref = 'globals/card';
  const referenced = createEntrySession({
    sourceLocale: 'en',
    data: referencedData,
    translations: {},
    form: nestedForm,
  });
  expect(
    referenced.listCommand('en', {
      address: 'blocks[_id=card].items',
      contentVersion: 0,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: false, reason: 'referenced' });
});

test('entry flush revisits a source edit made while a translation is saving', async () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
  });
  const writes: string[] = [];
  session.configureAutosave(async (locale) => {
    writes.push(locale);
    if (locale === 'de') {
      expect(
        session.fieldCommand('en', {
          address: 'sections[_id=second].title',
          contentVersion: session.contentVersion('en'),
          changes: [{ value: 'New source words' }],
        }),
      ).toMatchObject({ ok: true });
    }
    return true;
  });
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'First source words' }],
  });
  session.fieldCommand('de', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Erste Wörter' }],
  });

  expect(await session.flush()).toBe(true);
  expect(writes).toEqual(['en', 'de', 'en']);
  expect(session.unsaved()).toBe(false);
});

test('entry flush stops on a source refusal without writing its translation', async () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
  });
  const writes: string[] = [];
  session.configureAutosave(async (locale) => {
    writes.push(locale);
    return locale !== 'en';
  });
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Source words' }],
  });
  session.fieldCommand('de', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Zielwörter' }],
  });

  expect(await session.flush()).toBe(false);
  expect(writes).toEqual(['en']);
  expect(session.unsaved('en')).toBe(true);
  expect(session.unsaved('de')).toBe(true);
});

test('structural undo after autosave restores locale-owned rows through the scoped envelope', async () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: {
      de: {
        _machine: ['sections[_id=first].title'],
        sections: [
          { _id: 'first', title: 'Erste', legacyTheme: 'paper' },
          { _id: 'second', title: 'Zweite' },
        ],
      },
    },
    revisions: { en: 'source-1', de: 'target-1' },
    form,
  });
  const writes: { locale: string; structure?: unknown }[] = [];
  session.configureAutosave(async (locale, _snapshot, _revision, _version, structure) => {
    writes.push({ locale, structure });
    return true;
  });

  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 0,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(await session.flush()).toBe(true);
  expect(writes[0]).toEqual({
    locale: 'en',
    structure: {
      containers: ['sections'],
      revisions: { en: 'source-1', de: 'target-1' },
      seeds: {},
    },
  });

  session.setRevision('en', 'source-2');
  session.setRevision('de', 'target-2');
  expect(session.undo()).toEqual({ ok: true, contentVersion: 2 });
  expect(session.snapshot('de')).toMatchObject({
    _machine: ['sections[_id=first].title'],
    sections: [
      { _id: 'first', title: 'Erste', legacyTheme: 'paper' },
      { _id: 'second', title: 'Zweite' },
    ],
  });
  expect(await session.flush()).toBe(true);
  expect(writes.findLast((write) => write.locale === 'en')?.structure).toEqual({
    containers: ['sections'],
    revisions: { en: 'source-2', de: 'target-2' },
    seeds: {
      de: [
        {
          address: 'sections[_id=first]',
          value: { _id: 'first', title: 'Erste', legacyTheme: 'paper' },
          machine: ['sections[_id=first].title'],
        },
      ],
    },
  });
});

test('duplication remaps one selected locale subtree and redo reuses every generated id', () => {
  const duplicateForm: Form = {
    fields: [
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['columns'] },
    ],
    blocks: {
      columns: [
        {
          path: ['items'],
          label: 'Items',
          type: 'array',
          required: true,
          item: [
            { path: ['title'], label: 'Title', type: 'text', required: true },
            {
              path: ['details'],
              label: 'Details',
              type: 'array',
              required: true,
              item: [{ path: ['text'], label: 'Text', type: 'text', required: true }],
            },
          ],
        },
      ],
    },
  };
  const source = {
    _machine: ['title', 'blocks[_id=parent01].items[_id=child001].title'],
    title: 'Page',
    blocks: [
      {
        _id: 'parent01',
        _type: 'columns',
        items: [
          {
            _id: 'child001',
            title: 'First',
            details: [{ _id: 'grand001', text: 'Detail' }],
          },
        ],
      },
    ],
  };
  const target = structuredClone(source);
  const targetItem = target.blocks[0]?.items[0];
  if (!targetItem) throw new Error('target item missing');
  targetItem.title = 'Erste';
  const targetDetail = targetItem.details[0];
  if (!targetDetail) throw new Error('target detail missing');
  targetDetail.text = 'Detail DE';
  const session = createEntrySession({
    sourceLocale: 'en',
    data: source,
    translations: { de: target },
    form: duplicateForm,
  });

  expect(
    session.listCommand('en', {
      address: 'blocks[_id=parent01].items',
      contentVersion: 0,
      operation: { type: 'duplicate', index: 0 },
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  const sourceParent = (session.snapshot('en').blocks as typeof source.blocks)[0];
  const targetParent = (session.snapshot('de').blocks as typeof target.blocks)[0];
  if (!sourceParent || !targetParent) throw new Error('duplicated parent missing');
  const sourceCopy = sourceParent.items[1];
  const targetCopy = targetParent.items[1];
  if (!sourceCopy || !targetCopy) throw new Error('duplicated item missing');
  expect(sourceParent._id).toBe('parent01');
  expect(targetParent._id).toBe('parent01');
  expect(sourceCopy._id).toMatch(/^[0-9a-z]{8}$/);
  expect(sourceCopy._id).not.toBe('child001');
  expect(sourceCopy.details[0]?._id).toMatch(/^[0-9a-z]{8}$/);
  expect(sourceCopy.details[0]?._id).not.toBe('grand001');
  expect(targetCopy).toMatchObject({
    _id: sourceCopy._id,
    title: 'Erste',
    details: [{ _id: sourceCopy.details[0]?._id, text: 'Detail DE' }],
  });
  expect(session.snapshot('en')._machine).toEqual([
    'title',
    'blocks[_id=parent01].items[_id=child001].title',
    `blocks[_id=parent01].items[_id=${sourceCopy._id}].title`,
  ]);
  const generatedIds = [sourceCopy._id, sourceCopy.details[0]?._id];

  expect(session.undo()).toMatchObject({ ok: true, contentVersion: 2 });
  expect(sourceParent.items).toHaveLength(1);
  expect(session.snapshot('en')._machine).toEqual([
    'title',
    'blocks[_id=parent01].items[_id=child001].title',
  ]);
  expect(session.redo()).toMatchObject({ ok: true, contentVersion: 3 });
  expect(sourceParent.items[1]).toMatchObject({
    _id: generatedIds[0],
    details: [{ _id: generatedIds[1] }],
  });
  const redoneTarget = (session.snapshot('de').blocks as typeof target.blocks)[0];
  expect(redoneTarget?.items[1]).toMatchObject({
    _id: generatedIds[0],
    title: 'Erste',
    details: [{ _id: generatedIds[1], text: 'Detail DE' }],
  });
});

const translationSession = () =>
  createEntrySession({
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    revisions: { en: 'source-1', de: 'target-1' },
    form,
  });

test('final publish reserves all mutations, drains every locale, and stays closed through reload', async () => {
  const sourceSaved = deferred<boolean>();
  const committed = deferred<boolean>();
  const reloaded = deferred<void>();
  const order: string[] = [];
  const session = translationSession();
  session.configureAutosave(async (locale) => {
    order.push(`save:${locale}`);
    return locale === 'en' ? sourceSaved.promise : true;
  });
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Final source words' }],
  });
  session.fieldCommand('de', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Letzte Zielwörter' }],
  });
  const request = vi.fn(async () => {
    order.push('publish');
    return committed.promise;
  });
  const reload = vi.fn(async () => {
    order.push('reload');
    return reloaded.promise;
  });

  const publishing = session.finalPublish(request, reload);
  await vi.waitFor(() => expect(order).toEqual(['save:en']));
  expect(session.persistedActionPending()).toBe(true);
  expect(session.localeMutationBlocked('en')).toBe(true);
  expect(session.localeMutationBlocked('de')).toBe(true);
  expect(session.structureMutationBlocked()).toBe(true);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=second].title',
      contentVersion: 1,
      changes: [{ value: 'Cannot race final publish' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });
  expect(request).not.toHaveBeenCalled();

  sourceSaved.resolve(true);
  await vi.waitFor(() => expect(order).toEqual(['save:en', 'save:de', 'publish']));
  committed.resolve(true);
  await vi.waitFor(() => expect(order).toEqual(['save:en', 'save:de', 'publish', 'reload']));
  expect(session.persistedActionPending()).toBe(true);
  expect(session.localeMutationBlocked('en')).toBe(true);

  reloaded.resolve();
  expect(await publishing).toEqual({ ok: true });
  expect(session.persistedActionPending()).toBe(true);
  expect(reload).toHaveBeenCalledWith('published');
});

test('final publish never requests after a failed save and releases a refused operation', async () => {
  const session = translationSession();
  session.configureAutosave(async () => false);
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Keep this local edit' }],
  });
  const request = vi.fn(async () => true);
  const reload = vi.fn();

  expect(await session.finalPublish(request, reload)).toEqual({ ok: false, reason: 'save' });
  expect(request).not.toHaveBeenCalled();
  expect(session.persistedActionPending()).toBe(false);
  expect(session.localeMutationBlocked('en')).toBe(false);

  const clean = translationSession();
  clean.configureAutosave(async () => true);
  expect(await clean.finalPublish(async () => false, reload)).toEqual({
    ok: false,
    reason: 'refused',
  });
  expect(clean.persistedActionPending()).toBe(false);
  expect(
    clean.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Editing resumes' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(reload).not.toHaveBeenCalled();
});

test('machine translation closes admission before its preflush and dispatches after old writes', async () => {
  const sourceSaved = deferred<boolean>();
  const order: string[] = [];
  const write = vi.fn((locale: string) => {
    order.push(`save:${locale}`);
    return locale === 'en' ? sourceSaved.promise : Promise.resolve(true);
  });
  const request = vi.fn(async () => {
    order.push('translate');
    return {
      data: {
        sections: [
          { _id: 'first', title: 'Erste' },
          { _id: 'second', title: 'Zweite before translation' },
        ],
      },
      pending: true,
      revision: 'target-2',
    };
  });
  const session = translationSession();
  session.configureAutosave(write);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Changed before translate' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(
    session.fieldCommand('de', {
      address: 'sections[_id=second].title',
      contentVersion: 0,
      changes: [{ value: 'Zweite before translation' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });

  const translating = session.machineTranslate('de', request);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(request).not.toHaveBeenCalled();
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=second].title',
      contentVersion: 1,
      changes: [{ value: 'Raced preflush' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });

  sourceSaved.resolve(true);
  expect(await translating).toMatchObject({ ok: true });
  expect(request).toHaveBeenCalledOnce();
  expect(order).toEqual(['save:en', 'save:de', 'translate']);
  expect(session.snapshot('de')).toEqual({
    sections: [
      { _id: 'first', title: 'Erste' },
      { _id: 'second', title: 'Zweite before translation' },
    ],
  });
  expect(session.revision('de')).toBe('target-2');
  session.closeSaveGate();
});

test('source prose queues behind an in-flight translation while target and structure stay frozen', async () => {
  vi.useFakeTimers();
  const answer = deferred<{
    data: { sections: { _id: string; title: string }[] };
    pending: boolean;
    revision: string;
  }>();
  const request = vi.fn(() => answer.promise);
  const write = vi.fn(async (_locale: string) => true);
  const session = translationSession();
  session.configureAutosave(write);

  const translating = session.machineTranslate('de', request);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledOnce();
  expect(session.sourceTextOnly('en')).toBe(true);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'New source words' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  expect(
    session.fieldCommand('de', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Neue Zielwörter' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 1,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: false, reason: 'closed' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).not.toHaveBeenCalled();

  answer.resolve({
    data: { sections: [{ _id: 'first', title: 'Erste' }] },
    pending: true,
    revision: 'target-2',
  });
  expect(await translating).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledWith(
    'en',
    JSON.stringify({
      sections: [
        { _id: 'first', title: 'New source words' },
        { _id: 'second', title: '' },
      ],
    }),
    'source-1',
    1,
  );
  expect(write.mock.calls.some(([locale]) => locale === 'de')).toBe(false);
  session.closeSaveGate();
  vi.useRealTimers();
});

test('a failed translation leaves its target alone and releases queued source saving', async () => {
  vi.useFakeTimers();
  const answer = deferred<undefined>();
  const write = vi.fn(async () => true);
  const session = translationSession();
  session.configureAutosave(write);
  const before = JSON.parse(JSON.stringify(session.snapshot('de'))) as ReturnType<typeof data>;

  const translating = session.machineTranslate('de', () => answer.promise);
  await vi.advanceTimersByTimeAsync(0);
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Still save me' }],
  });
  await vi.advanceTimersByTimeAsync(2000);
  answer.resolve(undefined);

  expect(await translating).toEqual({ ok: false, reason: 'request' });
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(session.snapshot('de')).toEqual(before);
  expect(session.persistedActionPending()).toBe(false);
  session.closeSaveGate();
  vi.useRealTimers();
});

test('a late translation response cannot overwrite a newer target revision or a closed epoch', async () => {
  const newerRevision = deferred<{
    data: { sections: { _id: string; title: string }[] };
    pending: boolean;
    revision: string;
  }>();
  const session = translationSession();
  session.configureAutosave(async () => true);
  const first = session.machineTranslate('de', () => newerRevision.promise);
  await vi.waitFor(() => expect(session.sourceTextOnly('en')).toBe(true));
  session.setRevision('de', 'target-from-elsewhere');
  newerRevision.resolve({
    data: { sections: [{ _id: 'first', title: 'Too late' }] },
    pending: true,
    revision: 'target-2',
  });
  expect(await first).toEqual({ ok: false, reason: 'stale' });
  expect(session.snapshot('de')).toEqual(data());

  const closedEpoch = deferred<{
    data: { sections: { _id: string; title: string }[] };
    pending: boolean;
    revision: string;
  }>();
  const second = session.machineTranslate('de', () => closedEpoch.promise);
  await vi.waitFor(() => expect(session.sourceTextOnly('en')).toBe(true));
  session.closeSaveGate();
  closedEpoch.resolve({
    data: { sections: [{ _id: 'first', title: 'Also too late' }] },
    pending: true,
    revision: 'target-3',
  });
  expect(await second).toEqual({ ok: false, reason: 'stale' });
  expect(session.snapshot('de')).toEqual(data());
});

test('historical restore closes admission before preflush and reloads after every locale drains', async () => {
  const sourceSaved = deferred<boolean>();
  const order: string[] = [];
  const session = translationSession();
  session.configureAutosave(async (locale) => {
    order.push(`save:${locale}`);
    return locale === 'en' ? sourceSaved.promise : true;
  });
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'New source draft' }],
  });
  session.fieldCommand('de', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Neuer Entwurf' }],
  });
  const request = vi.fn(async () => {
    order.push('restore');
    return { ok: true as const };
  });
  const reload = vi.fn(async (outcome: 'restored' | 'uncertain') => {
    order.push(`reload:${outcome}`);
  });

  const restoring = session.historicalRestore(request, reload);
  await vi.waitFor(() => expect(order).toEqual(['save:en']));
  expect(request).not.toHaveBeenCalled();
  expect(session.persistedActionPending()).toBe(true);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=second].title',
      contentVersion: 1,
      changes: [{ value: 'Raced restore' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });

  sourceSaved.resolve(true);
  expect(await restoring).toEqual({ ok: true });
  expect(order).toEqual(['save:en', 'save:de', 'restore', 'reload:restored']);
  expect(reload).toHaveBeenCalledWith('restored');
  expect(session.persistedActionPending()).toBe(true);
  expect(
    session.listCommand('en', {
      address: 'sections',
      contentVersion: 1,
      operation: { type: 'remove', index: 0 },
    }),
  ).toEqual({ ok: false, reason: 'closed' });
});

test('a failed restore preflush never dispatches and releases the action gate', async () => {
  const session = translationSession();
  session.configureAutosave(async () => false);
  session.fieldCommand('en', {
    address: 'sections[_id=first].title',
    contentVersion: 0,
    changes: [{ value: 'Keep this local edit' }],
  });
  const request = vi.fn(async () => ({ ok: true as const }));
  const reload = vi.fn();

  expect(await session.historicalRestore(request, reload)).toEqual({
    ok: false,
    reason: 'save',
  });
  expect(request).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(session.persistedActionPending()).toBe(false);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=second].title',
      contentVersion: 1,
      changes: [{ value: 'Editing resumes' }],
    }),
  ).toEqual({ ok: true, contentVersion: 2 });
});

test('a confirmed restore refusal retains snapshots and reopens ordinary editing', async () => {
  const session = translationSession();
  session.configureAutosave(async () => true);
  const before = JSON.parse(JSON.stringify(session.snapshot('en'))) as ReturnType<typeof data>;
  const reload = vi.fn();

  expect(
    await session.historicalRestore(
      async () => ({ ok: false, error: 'That commit cannot be restored.' }),
      reload,
    ),
  ).toEqual({
    ok: false,
    reason: 'refused',
    error: 'That commit cannot be restored.',
  });
  expect(reload).not.toHaveBeenCalled();
  expect(session.snapshot('en')).toEqual(before);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Try another version' }],
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
});

test('an uncertain restore keeps recoverable snapshots closed through authoritative reload', async () => {
  const session = translationSession();
  const writes = vi.fn(async () => true);
  session.configureAutosave(writes);
  const before = JSON.parse(JSON.stringify(session.snapshot('de'))) as ReturnType<typeof data>;
  const reload = deferred<void>();
  const reloading = vi.fn((_outcome: 'restored' | 'uncertain') => reload.promise);

  const restoring = session.historicalRestore(async () => {
    throw new TypeError('connection lost after dispatch');
  }, reloading);
  await vi.waitFor(() => expect(reloading).toHaveBeenCalledWith('uncertain'));
  expect(session.snapshot('de')).toEqual(before);
  expect(session.persistedActionPending()).toBe(true);
  expect(
    session.fieldCommand('en', {
      address: 'sections[_id=first].title',
      contentVersion: 0,
      changes: [{ value: 'Must not overwrite the server' }],
    }),
  ).toEqual({ ok: false, reason: 'closed' });
  expect(await session.flush()).toBe(false);

  reload.resolve();
  expect(await restoring).toEqual({ ok: false, reason: 'uncertain' });
  expect(writes).not.toHaveBeenCalled();
});

test('contiguous typing retains only its boundary values and logical selections', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  const selection = (anchor: number) => ({
    document: 'pages/home',
    locale: 'en',
    address: 'title',
    kind: 'text' as const,
    anchor,
    head: anchor,
  });

  expect(
    session.fieldCommand('en', {
      address: 'title',
      contentVersion: 0,
      changes: [{ value: 'H' }],
      history: { kind: 'typing', before: selection(4), after: selection(1) },
    }),
  ).toEqual({ ok: true, contentVersion: 1 });
  vi.advanceTimersByTime(500);
  expect(
    session.fieldCommand('en', {
      address: 'title',
      contentVersion: 1,
      changes: [{ value: 'He' }],
      history: { kind: 'typing', before: selection(1), after: selection(2) },
    }),
  ).toEqual({ ok: true, contentVersion: 2 });

  expect(session.historyStats()).toEqual({
    redoTransactions: 0,
    retainedFieldValues: 2,
    undoTransactions: 1,
  });
  expect(session.canUndo()).toBe(true);
  expect(session.undo()).toEqual({
    ok: true,
    contentVersion: 3,
    selection: selection(4),
  });
  expect(session.snapshot('en').title).toBe('Home');
  expect(session.canUndo()).toBe(false);
  expect(session.canRedo()).toBe(true);
  expect(session.redo()).toEqual({
    ok: true,
    contentVersion: 4,
    selection: selection(2),
  });
  expect(session.snapshot('en').title).toBe('He');
  expect(session.historyStats()).toEqual({
    redoTransactions: 0,
    retainedFieldValues: 2,
    undoTransactions: 1,
  });
  vi.useRealTimers();
});

test('time, selection, locale, paste, and structural actions end typing groups', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form,
  });
  const selection = (locale: string, anchor: number) => ({
    document: 'pages/home',
    locale,
    address: 'sections[_id=first].title',
    kind: 'text' as const,
    anchor,
    head: anchor,
  });
  const type = (locale: string, value: string, before: number, after: number) =>
    session.fieldCommand(locale, {
      address: 'sections[_id=first].title',
      contentVersion: session.contentVersion(locale),
      changes: [{ value }],
      history: {
        kind: 'typing',
        before: selection(locale, before),
        after: selection(locale, after),
      },
    });

  type('en', 'A', 5, 1);
  vi.advanceTimersByTime(1001);
  type('en', 'AB', 1, 2);
  session.setHistorySelection(selection('en', 0));
  type('en', 'CAB', 0, 1);
  type('de', 'D', 5, 1);
  session.fieldCommand('de', {
    address: 'sections[_id=first].title',
    contentVersion: session.contentVersion('de'),
    changes: [{ value: 'DE' }],
    history: { kind: 'paste', before: selection('de', 1), after: selection('de', 2) },
  });
  session.listCommand('en', {
    address: 'sections',
    contentVersion: session.contentVersion('en'),
    operation: { type: 'move', from: 0, to: 0 },
  });
  type('en', 'CABA', 1, 4);

  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('en').sections as { title: string }[])[0]?.title).toBe('CAB');
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('de').sections as { title: string }[])[0]?.title).toBe('D');
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('de').sections as { title: string }[])[0]?.title).toBe('First');
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('en').sections as { title: string }[])[0]?.title).toBe('AB');
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('en').sections as { title: string }[])[0]?.title).toBe('A');
  expect(session.undo()).toMatchObject({ ok: true });
  expect((session.snapshot('en').sections as { title: string }[])[0]?.title).toBe('First');
  vi.useRealTimers();
});

test('composition updates and structured widget changes keep atomic forward and inverse changes', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });

  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 0,
    changes: [{ value: 'に' }],
    history: { kind: 'composition', group: 'composition-1' },
  });
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 1,
    changes: [{ value: '日本' }],
    history: { kind: 'composition', group: 'composition-1' },
  });
  session.historyBoundary();
  session.fieldCommand('en', {
    address: 'button',
    contentVersion: 2,
    changes: [
      { path: ['type'], value: 'url' },
      { path: ['ref'], value: undefined },
      { path: ['href'], value: 'https://example.com' },
    ],
  });

  expect(session.undo()).toMatchObject({ ok: true });
  expect(session.snapshot('en').button).toEqual({
    type: 'entry',
    ref: 'pages/contact',
    label: 'Contact',
  });
  expect(session.undo()).toMatchObject({ ok: true });
  expect(session.snapshot('en').title).toBe('Home');
  expect(session.redo()).toMatchObject({ ok: true });
  expect(session.snapshot('en').title).toBe('日本');
});

test('history freezes on lock loss and reset establishes a fresh boundary', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: {},
    form: widgetForm,
  });
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 0,
    changes: [{ value: 'Changed' }],
  });

  session.freezeHistory();
  expect(session.historyFrozen()).toBe(true);
  expect(session.undo()).toEqual({ ok: false, reason: 'frozen' });
  session.resetHistory();
  expect(session.historyFrozen()).toBe(false);
  expect(session.canUndo()).toBe(false);
  expect(session.canRedo()).toBe(false);

  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 1,
    changes: [{ value: 'Fresh change' }],
  });
  session.closeSaveGate();
  expect(session.historyFrozen()).toBe(true);
  expect(session.undo()).toEqual({ ok: false, reason: 'frozen' });
});

test('a new change clears redo', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: widgetData(),
    translations: { de: widgetData() },
    form: widgetForm,
  });
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 0,
    changes: [{ value: 'First change' }],
  });
  session.fieldCommand('de', {
    address: 'title',
    contentVersion: 0,
    changes: [{ value: 'Erste Änderung' }],
  });
  expect(session.undo()).toMatchObject({ ok: true });
  expect(session.canRedo()).toBe(true);

  session.fieldCommand('en', {
    address: 'title',
    contentVersion: 1,
    changes: [{ value: 'Second change' }],
  });
  expect(session.canRedo()).toBe(false);
});
