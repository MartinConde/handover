import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_UI_LOCALE,
  deviceLocale,
  deviceLocaleCookie,
  formatClockTime,
  formatExactTime,
  formatRelativeTime,
  isUiLocale,
  messageOptions,
  readDeviceLocale,
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
    expect(resolveUiLocale(undefined, undefined, ['de-@@', 'en-GB'])).toBe('en');
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

  test('a refused device cookie read is treated as an absent hint', () => {
    const read = vi.spyOn(document, 'cookie', 'get').mockImplementation(() => {
      throw new DOMException('Cookies disabled', 'SecurityError');
    });
    try {
      expect(readDeviceLocale).not.toThrow();
      expect(readDeviceLocale()).toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });
});

describe('localized date and time formatting', () => {
  const now = Date.parse('2026-08-25T14:00:00Z');
  const localAfternoon = new Date(2026, 7, 25, 14, 0).getTime();

  test.each([
    ['en', now, 'now'],
    ['de', now, 'jetzt'],
    ['en', now - 5 * 60_000, '5 min ago'],
    ['de', now - 5 * 60_000, 'vor 5 Min.'],
    ['en', now - 2 * 60 * 60_000, '2 hr ago'],
    ['de', now - 2 * 60 * 60_000, 'vor 2 Std.'],
    ['en', now - 24 * 60 * 60_000, 'yesterday'],
    ['de', now - 24 * 60 * 60_000, 'gestern'],
    ['en', Date.parse('2026-08-10T14:00:00Z'), '10 Aug 2026'],
    ['de', Date.parse('2026-08-10T14:00:00Z'), '10. Aug. 2026'],
  ] as const)('%s formats a relative branch as %s', (locale, at, expected) => {
    vi.setSystemTime(now);
    expect(formatRelativeTime(at, locale)).toBe(expected);
  });

  test.each([
    ['en', '25 August 2026 at 14:00'],
    ['de', '25. August 2026 um 14:00'],
  ] as const)('%s selects its exact date-time format', (locale, expected) => {
    expect(formatExactTime(localAfternoon, locale)).toBe(expected);
  });

  test.each([
    ['en', '14:00'],
    ['de', '14:00'],
  ] as const)('%s selects its compact clock format', (locale, expected) => {
    expect(formatClockTime(localAfternoon, locale)).toBe(expected);
  });

  test('calendar-day bucketing survives a 25-hour daylight-saving boundary', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      vi.setSystemTime(new Date('2026-10-26T00:30:00+01:00'));
      expect(formatRelativeTime(new Date('2026-10-25T00:30:00+02:00').getTime(), 'en')).toBe(
        'yesterday',
      );
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      vi.setSystemTime(now);
    }
  });
});
