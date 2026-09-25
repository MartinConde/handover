// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const messages = (locale) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, `../messages/${locale}.json`), 'utf8'));

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
