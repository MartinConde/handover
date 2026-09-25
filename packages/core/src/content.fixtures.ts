import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  readFileSync(join(import.meta.dirname, '../test/locales', locale, 'mill-house.yaml'), 'utf8');
