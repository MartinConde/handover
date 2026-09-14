// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { validateCatalogs } from './catalog-validator.mjs';
import { pseudoCatalog, pseudoMessage } from './pseudo-locale.mjs';

const messages = (locale) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, `../messages/${locale}.json`), 'utf8'));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('German language review', () => {
  test('user-directed copy uses informal address', () => {
    const formal = /\b(?:Sie|Ihnen|Ihr|Ihre|Ihren|Ihrer|Ihrem)\b/;
    const grammaticalThirdPerson = new Set([
      'members_remove_access_explanation',
      'members_remove_drafts',
      'members_already_signed_in',
      'entry_list_template_hint',
      'field_seo_hide_notice',
      'editor_restored_unpublished',
      'media_library_delete_intro',
      'redirect_pending',
    ]);
    const text = (value) =>
      typeof value === 'string'
        ? [value]
        : value.flatMap((message) => Object.values(message.match));
    const violations = Object.entries(messages('de'))
      .filter(
        ([key, value]) =>
          !grammaticalThirdPerson.has(key) && text(value).some((part) => formal.test(part)),
      )
      .map(([key]) => key);

    expect(violations).toEqual([]);
  });

  test('account and member role labels use the reviewed inclusive glossary', () => {
    const de = messages('de');
    expect({
      accountOwner: de.account_role_owner,
      accountEditor: de.account_role_editor,
      memberOwner: de.members_owner,
      memberEditor: de.members_editor,
    }).toEqual({
      accountOwner: 'Eigentümer:in',
      accountEditor: 'Redakteur:in',
      memberOwner: 'Eigentümer:in',
      memberEditor: 'Redakteur:in',
    });
  });
});

describe('pseudo-locale fixture', () => {
  test('expands copy while preserving placeholders and linked-message boundaries', () => {
    const source = 'Open {#guide}the {count} item{/guide}.';
    const pseudo = pseudoMessage(source);

    expect(pseudo.length).toBeGreaterThan(source.length);
    expect(pseudo).toContain('{#guide}');
    expect(pseudo).toContain('{count}');
    expect(pseudo).toContain('{/guide}');
  });

  test('leaves declarations and selectors intact in structured plural messages', () => {
    const source = {
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
    const pseudo = pseudoCatalog(source);

    expect(pseudo.pending[0].declarations).toEqual(source.pending[0].declarations);
    expect(pseudo.pending[0].selectors).toEqual(source.pending[0].selectors);
    expect(pseudo.pending[0].match['countPlural=other']).toContain('{count}');
    expect(pseudo.pending[0].match['countPlural=other'].length).toBeGreaterThan(
      source.pending[0].match['countPlural=other'].length,
    );
  });

  test('passes the full catalog contract as a temporary third locale', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-language-review-'));
    temporaryDirectories.push(root);
    const projectPath = path.join(root, 'project.inlang');
    const messagesPath = path.join(root, 'messages');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(messagesPath);
    fs.writeFileSync(
      path.join(projectPath, 'settings.json'),
      JSON.stringify({
        baseLocale: 'en',
        locales: ['en', 'de', 'qps-ploc'],
        modules: [
          path.resolve(
            import.meta.dirname,
            '../../../node_modules/@inlang/plugin-message-format/dist/index.js',
          ),
        ],
        'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' },
      }),
    );
    fs.copyFileSync(
      path.join(import.meta.dirname, '../messages/en.json'),
      path.join(messagesPath, 'en.json'),
    );
    fs.copyFileSync(
      path.join(import.meta.dirname, '../messages/de.json'),
      path.join(messagesPath, 'de.json'),
    );
    fs.writeFileSync(
      path.join(messagesPath, 'qps-ploc.json'),
      JSON.stringify(pseudoCatalog(messages('en'))),
    );

    await expect(
      validateCatalogs({
        projectPath,
        expectedLocales: ['en', 'de', 'qps-ploc'],
        expectedBaseLocale: 'en',
      }),
    ).resolves.toBeUndefined();
  });
});
