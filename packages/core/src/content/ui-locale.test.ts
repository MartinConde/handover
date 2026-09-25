import { describe, expect, test } from 'vitest';
import { DEFAULT_UI_LOCALE, isUiLocale, labelIn, UI_LOCALES } from './ui-locale.js';

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

describe('labelIn', () => {
  test('a plain string is the label in every language', () => {
    expect(labelIn('Pages', 'de')).toBe('Pages');
  });

  test('a label per language answers in the one asked for', () => {
    expect(labelIn({ en: 'Pages', de: 'Seiten' }, 'de')).toBe('Seiten');
  });

  test('a language without its own label falls back to English', () => {
    expect(labelIn({ en: 'Pages' }, 'de')).toBe('Pages');
  });

  test('without English either, the first label given is used', () => {
    expect(labelIn({ de: 'Seiten' }, 'en')).toBe('Seiten');
  });

  test('nothing usable is no label', () => {
    expect(labelIn(undefined, 'en')).toBeUndefined();
    expect(labelIn('', 'en')).toBeUndefined();
    expect(labelIn({ en: 3 }, 'en')).toBeUndefined();
  });
});
