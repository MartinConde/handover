// @vitest-environment node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { validateCatalogs } from './catalog-validator.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const messageFormatModule = path.resolve(
  import.meta.dirname,
  '../../../node_modules/@inlang/plugin-message-format/dist/index.js',
);

function fixture({ locales = ['en', 'de'], en = baseMessages(), de = baseMessages() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-catalog-'));
  temporaryDirectories.push(root);
  const projectPath = path.join(root, 'project.inlang');
  const messagesPath = path.join(root, 'messages');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(messagesPath);
  fs.writeFileSync(
    path.join(projectPath, 'settings.json'),
    JSON.stringify({
      baseLocale: 'en',
      locales,
      modules: [messageFormatModule],
      'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' },
    }),
  );
  fs.writeFileSync(path.join(messagesPath, 'en.json'), JSON.stringify(en));
  fs.writeFileSync(path.join(messagesPath, 'de.json'), JSON.stringify(de));
  return projectPath;
}

function baseMessages() {
  return {
    title: 'Title',
    save_failed: 'Could not save {field}.',
    pending: [
      {
        declarations: ['input count', 'local countPlural = count: plural'],
        selectors: ['countPlural'],
        match: {
          'countPlural=one': '{count} pending change',
          'countPlural=other': '{count} pending changes',
        },
      },
    ],
  };
}

function rewriteSettings(projectPath, update) {
  const settingsPath = path.join(projectPath, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  update(settings);
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}

describe('validateCatalogs', () => {
  test('accepts complete catalogs', async () => {
    await expect(
      validateCatalogs({ projectPath: fixture(), expectedLocales: ['en', 'de'] }),
    ).resolves.toBeUndefined();
  });

  test.each([
    ['missing key', () => ({ ...baseMessages(), title: undefined }), 'missing keys: title'],
    ['extra key', () => ({ ...baseMessages(), extra: 'Extra' }), 'extra keys: extra'],
    ['empty value', () => ({ ...baseMessages(), title: '   ' }), 'empty translation: title'],
    [
      'placeholder mismatch',
      () => ({ ...baseMessages(), save_failed: 'Could not save {name}.' }),
      'placeholder contract differs: save_failed',
    ],
    [
      'missing fallback',
      () => ({
        ...baseMessages(),
        pending: [
          {
            declarations: ['input count', 'local countPlural = count: plural'],
            selectors: ['countPlural'],
            match: { 'countPlural=one': '{count} pending change' },
          },
        ],
      }),
      'required fallback is missing: pending',
    ],
  ])('rejects a %s', async (_name, mutate, message) => {
    const de = JSON.parse(JSON.stringify(mutate(), (_key, value) => value));
    await expect(
      validateCatalogs({ projectPath: fixture({ de }), expectedLocales: ['en', 'de'] }),
    ).rejects.toThrow(message);
  });

  test('rejects locale configuration that differs from core', async () => {
    await expect(
      validateCatalogs({
        projectPath: fixture({ locales: ['en', 'de', 'fr'] }),
        expectedLocales: ['en', 'de'],
      }),
    ).rejects.toThrow('configured locales must exactly match the core UI locale allowlist');
  });

  test('rejects a base locale that differs from the core default', async () => {
    const projectPath = fixture();
    rewriteSettings(projectPath, (settings) => {
      settings.baseLocale = 'de';
    });
    await expect(
      validateCatalogs({
        projectPath,
        expectedLocales: ['en', 'de'],
        expectedBaseLocale: 'en',
      }),
    ).rejects.toThrow('configured base locale must match the core UI default (en): de');
  });

  test('does not treat malformed plugin configuration as an empty catalog', async () => {
    const projectPath = fixture();
    rewriteSettings(projectPath, (settings) => {
      settings.modules = [`/missing/${messageFormatModule}`];
    });
    await expect(validateCatalogs({ projectPath, expectedLocales: ['en', 'de'] })).rejects.toThrow(
      'Inlang project could not be loaded',
    );
  });

  test('requires the configured catalog path pattern', async () => {
    const projectPath = fixture();
    rewriteSettings(projectPath, (settings) => {
      delete settings['plugin.inlang.messageFormat'].pathPattern;
    });
    await expect(validateCatalogs({ projectPath, expectedLocales: ['en', 'de'] })).rejects.toThrow(
      'message-format pathPattern must include {locale}',
    );
  });

  test('propagates compiler failure through the shared command', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-compiler-'));
    temporaryDirectories.push(bin);
    const compiler = path.join(bin, 'paraglide-js');
    fs.writeFileSync(compiler, '#!/bin/sh\nexit 7\n');
    fs.chmodSync(compiler, 0o755);
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'messages.mjs')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.status).toBe(7);
  });
});
