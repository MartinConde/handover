import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { page } from '../cms.config';

const byPath = ({ entry }: { entry: string }) => entry.replace(/\.ya?ml$/, '');

export const collections = {
  pages: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/pages', generateId: byPath }),
    schema: page,
  }),
  globals: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/globals', generateId: byPath }),
    schema: z.looseObject({}),
  }),
};
