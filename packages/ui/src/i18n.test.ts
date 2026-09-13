import { describe, expect, test } from 'vitest';
import { DEFAULT_UI_LOCALE, isUiLocale, messageOptions, UI_LOCALES } from './i18n.js';
import { m } from './paraglide/messages.js';

describe('UI message runtime', () => {
  test('uses the shared locale contract for explicit message calls', () => {
    expect(UI_LOCALES).toEqual(['en', 'de']);
    expect(DEFAULT_UI_LOCALE).toBe('en');
    expect(isUiLocale('de')).toBe(true);
    expect(isUiLocale('fr')).toBe(false);
    expect(m.common_save_failed({ field: 'Title' }, messageOptions('en'))).toBe(
      'Could not save Title.',
    );
    expect(m.common_save_failed({ field: 'Titel' }, messageOptions('de'))).toBe(
      'Titel konnte nicht gespeichert werden.',
    );
  });
});
