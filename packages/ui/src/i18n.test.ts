import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_UI_LOCALE,
  deviceLocale,
  deviceLocaleCookie,
  isUiLocale,
  messageOptions,
  rememberUiLocale,
  resolveUiLocale,
  UI_LOCALES,
} from './i18n.js';
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

describe('interface locale resolution', () => {
  test('a valid saved account preference wins over device and browser hints', () => {
    expect(resolveUiLocale('de', 'en', ['en-US'])).toBe('de');
  });

  test('invalid stored and device hints fall through to supported regional browser preferences', () => {
    expect(resolveUiLocale('fr', '%E0%A4%A', ['fr-FR', 'de-CH', 'en-GB'])).toBe('de');
  });

  test('device choice wins only without a saved account preference', () => {
    expect(resolveUiLocale(null, 'de', ['en-US'])).toBe('de');
    expect(resolveUiLocale('en', 'de', ['de-DE'])).toBe('en');
  });

  test('unsupported preferences fall back to English', () => {
    expect(resolveUiLocale(undefined, undefined, ['fr-FR', 'it'])).toBe('en');
  });

  test('the installation cookie is read by exact name', () => {
    expect(deviceLocale('other=de; handover_ui_locale=en; tail=1')).toBe('en');
    expect(deviceLocale('handover_ui_locale=de-DE')).toBeUndefined();
  });

  test('device preference cookies are scoped to root and non-empty admin installations', () => {
    expect(deviceLocaleCookie('de', '')).toContain('Path=/admin;');
    expect(deviceLocaleCookie('en', '/cms/')).toContain('Path=/cms/admin;');
    expect(deviceLocaleCookie('en', '/cms/')).not.toContain('Path=/;');
  });

  test('a refused device cookie does not block language selection', () => {
    const write = vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
      throw new DOMException('Cookies disabled', 'SecurityError');
    });
    expect(() => rememberUiLocale('de')).not.toThrow();
    write.mockRestore();
  });
});
