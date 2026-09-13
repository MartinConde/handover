import { describe, expect, test } from 'vitest';
import { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES } from './ui-locale.js';

describe('UI locales', () => {
  test('accepts only the supported interface language codes', () => {
    expect(UI_LOCALES).toEqual(['en', 'de']);
    expect(DEFAULT_UI_LOCALE).toBe('en');
    expect(isUiLocale('en')).toBe(true);
    expect(isUiLocale('de')).toBe(true);
    expect(isUiLocale('de-DE')).toBe(false);
    expect(isUiLocale(null)).toBe(false);
  });
});
