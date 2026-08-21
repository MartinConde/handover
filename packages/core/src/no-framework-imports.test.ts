import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The seam that makes multi-site possible: core knows nothing about Astro or Cloudflare.
const FORBIDDEN = /from\s+['"](astro|@astrojs\/|astro:|cloudflare:|@cloudflare\/|wrangler)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((f) => f.isFile() && /\.ts$/.test(f.name) && !/\.test\.ts$/.test(f.name))
    .map((f) => join(f.parentPath, f.name));
}

test('core/src imports nothing from Astro or Cloudflare', () => {
  const offenders = sources(join(import.meta.dirname, '.')).filter((file) =>
    FORBIDDEN.test(readFileSync(file, 'utf8')),
  );
  expect(offenders).toEqual([]);
});
