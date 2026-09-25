import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntry } from './entry-format.js';
import type { Form } from './schema.js';

// decap-cms#6978: the German form never sends duplicate fields back; a save must keep them.
export const listing: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'text', required: false },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['bedrooms'], label: 'Bedrooms', type: 'number', required: true, i18n: 'duplicate' },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
  ],
  blocks: {},
};

// A translated save carries values, never structure: blocks are paired by `_id` with the file's.
export const article: Form = {
  fields: [{ path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero'] }],
  blocks: {
    hero: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
    ],
  },
};

export const localeFile = (locale: string) =>
  readFileSync(join(import.meta.dirname, '../../test/locales', locale, 'mill-house.yaml'), 'utf8');

// `notes` is the source locale's alone and the German file holds only translations.
export const millHouse: Form = {
  fields: [
    ...listing.fields,
    { path: ['blocks'], label: 'Blocks', type: 'blocks', required: true, types: ['hero'] },
  ],
  blocks: article.blocks,
};

// DE has the shared blocks plus `compliance` marked `_locales: [de]` and an unmarked `quote`.
export const page: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'cta', 'compliance', 'quote'],
    },
  ],
  blocks: {
    hero: [
      { path: ['heading'], label: 'Heading', type: 'text', required: true },
      { path: ['image'], label: 'Image', type: 'image', required: false, preset: { max: 2400 } },
    ],
    cta: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    compliance: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    quote: [{ path: ['body'], label: 'Body', type: 'text', required: true }],
  },
};

export const driftFile = (locale: string) =>
  readFileSync(join(import.meta.dirname, '../../test/drift', locale, 'home.yaml'), 'utf8');
export const drifted = (locale: string) =>
  parseEntry('default', driftFile(locale)) as Record<string, unknown>;
