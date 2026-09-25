// @vitest-environment node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_UI_LOCALE, UI_LOCALES } from '@handover/core';
import { afterEach, expect, test } from 'vitest';
import { catalogProblems, readCatalogs, uncompiledKeys } from './messages.mjs';

const root = path.resolve(import.meta.dirname, '..');
const settings = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'project.inlang/settings.json'), 'utf8'));
const problems = (changeSettings, changeGerman) => {
  const project = settings();
  changeSettings(project);
  const catalogs = readCatalogs(root, settings(), UI_LOCALES);
  changeGerman(catalogs.de);
  return catalogProblems(project, catalogs, UI_LOCALES, DEFAULT_UI_LOCALE);
};
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the shipped catalogs pass', () => {
  expect(
    problems(
      () => {},
      () => {},
    ),
  ).toEqual([]);
});

test.each([
  [
    'a missing key',
    (de) => {
      delete de.account_title;
    },
    'de missing keys: account_title',
  ],
  [
    'a renamed placeholder',
    (de) => {
      de.diagnostics_checked_when = 'geprüft {wann}';
    },
    'de placeholders differ: diagnostics_checked_when',
  ],
  [
    'no other fallback',
    (de) => {
      delete de.account_last_used_minutes[0].match['countPlural=other'];
    },
    'de has no * or other fallback: account_last_used_minutes',
  ],
  [
    'empty text',
    (de) => {
      de.account_title = '  ';
    },
    'de empty text: account_title',
  ],
  [
    'a changed declaration',
    (de) => {
      de.account_last_used_minutes[0].declarations[1] = 'local countPlural = count: number';
    },
    'de declarations differ: account_last_used_minutes',
  ],
])('a German catalog with %s is refused', (_name, change, problem) => {
  expect(problems(() => {}, change)).toEqual([problem]);
});

test.each([
  [
    'a locale core does not list',
    (project) => {
      project.locales = ['en', 'de', 'fr'];
    },
    "locales must equal core's UI_LOCALES (en, de): en, de, fr",
  ],
  [
    'another base locale',
    (project) => {
      project.baseLocale = 'de';
    },
    "baseLocale must equal core's DEFAULT_UI_LOCALE (en): de",
  ],
])('settings with %s are refused', (_name, change, problem) => {
  expect(problems(change, () => {})).toEqual([problem]);
});

test('settings without a {locale} pathPattern are refused', () => {
  const project = settings();
  delete project['plugin.inlang.messageFormat'].pathPattern;
  expect(() => readCatalogs(root, project, UI_LOCALES)).toThrow(
    'project.inlang/settings.json needs a plugin.inlang.messageFormat.pathPattern with {locale}',
  );
});

test('a compile that emitted no module for a message is caught', () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-paraglide-'));
  temporaryDirectories.push(outdir);
  fs.mkdirSync(path.join(outdir, 'messages'));
  fs.writeFileSync(path.join(outdir, 'messages/account_title.js'), '');
  expect(uncompiledKeys(outdir, ['account_title', 'account_loading'])).toEqual(['account_loading']);
});

test('a compiler failure is the command’s exit status', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-compiler-'));
  temporaryDirectories.push(bin);
  const compiler = path.join(bin, 'paraglide-js');
  fs.writeFileSync(compiler, '#!/bin/sh\nexit 7\n');
  fs.chmodSync(compiler, 0o755);
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'messages.mjs'), '--force'],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  expect(result.status).toBe(7);
});
