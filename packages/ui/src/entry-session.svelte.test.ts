import type { Form } from '@handover/core';
import { expect, test } from 'vitest';
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
  session.snapshot('en').sections = [...(session.snapshot('en').sections as unknown[])].reverse();
  session.contentVersion('en');
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

  const second = (session.snapshot('en').sections as { title: string }[])[1];
  if (!second) throw new Error('second section missing');
  second.title = 'Now valid';
  session.contentVersion('en');

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
