import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  compilationFingerprint,
  compiledCatalogIsCurrent,
  recordCompilation,
  removeCompilationRecord,
} from './message-cache.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-message-cache-'));
  temporaryDirectories.push(workspace);
  const root = path.join(workspace, 'packages/ui');
  for (const directory of [
    'messages',
    'project.inlang',
    'scripts',
    'src/paraglide',
    '../core/src/content',
  ])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  const files = {
    '../../pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'package.json': '{}\n',
    '../core/src/content/ui-locale.ts': "export const UI_LOCALES = ['en', 'de'];\n",
    'project.inlang/settings.json': '{}\n',
    'scripts/catalog-validator.mjs': 'validator implementation\n',
    'scripts/message-cache.mjs': 'cache\n',
    'scripts/messages.mjs': 'messages\n',
    'scripts/validate-catalogs.mjs': 'validator\n',
    'messages/en.json': '{"title":"Title"}\n',
    'messages/de.json': '{"title":"Titel"}\n',
    ...Object.fromEntries(
      [
        'messages.d.ts',
        'messages.js',
        'registry.d.ts',
        'registry.js',
        'runtime.d.ts',
        'runtime.js',
        'server.d.ts',
        'server.js',
      ].map((file) => [`src/paraglide/${file}`, `${file} output\n`]),
    ),
  };
  for (const [relative, content] of Object.entries(files))
    fs.writeFileSync(path.resolve(root, relative), content);
  return root;
}

test('reuses generated catalogs only while every compiler input and required output matches', () => {
  const root = fixture();
  const fingerprint = compilationFingerprint(root);
  expect(compiledCatalogIsCurrent(root, fingerprint)).toBe(false);

  recordCompilation(root, fingerprint);
  expect(compiledCatalogIsCurrent(root, fingerprint)).toBe(true);

  fs.writeFileSync(path.join(root, 'messages/de.json'), '{"title":"Überschrift"}\n');
  expect(compiledCatalogIsCurrent(root, compilationFingerprint(root))).toBe(false);

  removeCompilationRecord(root);
  expect(compiledCatalogIsCurrent(root, fingerprint)).toBe(false);
});
