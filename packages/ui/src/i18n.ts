import {
  DEFAULT_UI_LOCALE,
  isUiLocale,
  type Labels,
  labelIn,
  UI_LOCALES,
  type UiLocale,
} from '@handover/core';
import type { Locale } from './paraglide/runtime.js';
import { siteBase } from './request.js';

const compilerLocales: readonly Locale[] = UI_LOCALES;
void compilerLocales;

export type { UiLocale };
export { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES };

export const messageOptions = (locale: UiLocale) => ({ locale }) as const;

export type CollectionLabels = Record<
  string,
  { label?: string | Labels; singular?: string | Labels }
>;

// Fixed by the site's build, so the shell sets it once rather than every screen taking a prop.
let collectionLabels: CollectionLabels = {};
export const useCollectionLabels = (labels: CollectionLabels = {}) => {
  collectionLabels = labels;
};

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** As the name reads mid-sentence; `capitalise` makes a heading of it. */
export function collectionName(
  name: string,
  locale: UiLocale,
  form: 'plural' | 'singular' = 'plural',
): string {
  const { label, singular } = collectionLabels[name] ?? {};
  const plural = labelIn(label, locale);
  if (form === 'plural') return plural ?? name;
  return labelIn(singular, locale) ?? plural ?? name.replace(/s$/, '');
}

const relativeFormatters = new Map<UiLocale, Intl.RelativeTimeFormat>();
const dateFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const exactFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const clockFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const fieldTimeFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const mediaDateFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const calendarDateFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const languageFormatters = new Map<UiLocale, Intl.DisplayNames>();
const languageListFormatters = new Map<UiLocale, Intl.ListFormat>();
export const languageTag = (locale: UiLocale) => (locale === 'en' ? 'en-GB' : locale);

const formatter = <T>(cache: Map<UiLocale, T>, locale: UiLocale, make: () => T): T => {
  const cached = cache.get(locale);
  if (cached) return cached;
  const created = make();
  cache.set(locale, created);
  return created;
};

const midnight = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** Day buckets stay in the browser timezone; changing UI language never changes timezone. */
export function formatRelativeTime(at: number, locale: UiLocale): string {
  const format = formatter(
    relativeFormatters,
    locale,
    () => new Intl.RelativeTimeFormat(languageTag(locale), { numeric: 'auto', style: 'short' }),
  );
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return format.format(0, 'second');
  if (minutes < 60) return format.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format.format(-hours, 'hour');
  const days = Math.round((midnight(Date.now()) - midnight(at)) / 86_400_000);
  if (days < 7) return format.format(-days, 'day');
  return formatter(
    dateFormatters,
    locale,
    () =>
      new Intl.DateTimeFormat(languageTag(locale), {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
  ).format(at);
}

export const formatExactTime = (at: number, locale: UiLocale): string =>
  formatter(
    exactFormatters,
    locale,
    () => new Intl.DateTimeFormat(languageTag(locale), { dateStyle: 'long', timeStyle: 'short' }),
  ).format(at);

export const formatClockTime = (at: number, locale: UiLocale): string =>
  formatter(
    clockFormatters,
    locale,
    () => new Intl.DateTimeFormat(languageTag(locale), { hour: '2-digit', minute: '2-digit' }),
  ).format(at);

/** Field popovers keep the browser timezone and their compact date shape across locales. */
export const formatFieldTime = (at: number, locale: UiLocale): string =>
  formatter(
    fieldTimeFormatters,
    locale,
    () =>
      new Intl.DateTimeFormat(languageTag(locale), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
  ).format(at);

export const formatMediaDate = (at: number, locale: UiLocale): string =>
  formatter(
    mediaDateFormatters,
    locale,
    () =>
      new Intl.DateTimeFormat(languageTag(locale), {
        day: 'numeric',
        month: 'long',
      }),
  ).format(at);

export const formatCalendarDate = (at: number, locale: UiLocale): string =>
  formatter(
    calendarDateFormatters,
    locale,
    () =>
      new Intl.DateTimeFormat(languageTag(locale), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
  ).format(at);

/** Unknown or malformed content-language tags stay visible as their authored code. */
export function formatLanguageName(code: string, locale: UiLocale): string {
  try {
    return (
      formatter(
        languageFormatters,
        locale,
        () => new Intl.DisplayNames([languageTag(locale)], { type: 'language' }),
      ).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/** Content-language names and their conjunction both follow the interface locale. */
export function formatLanguageList(codes: readonly string[], locale: UiLocale): string {
  return formatter(
    languageListFormatters,
    locale,
    () => new Intl.ListFormat(languageTag(locale), { style: 'long', type: 'conjunction' }),
  ).format(codes.map((code) => formatLanguageName(code, locale)));
}

export const DEVICE_LOCALE_COOKIE = 'handover_ui_locale';

const supportedLanguage = (value: unknown): UiLocale | undefined => {
  if (typeof value !== 'string') return undefined;
  const tag = value.trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(tag)) return undefined;
  const language = tag.split('-')[0];
  return isUiLocale(language) ? language : undefined;
};

export function deviceLocale(cookie: string): UiLocale | undefined {
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== DEVICE_LOCALE_COOKIE) continue;
    try {
      const value = decodeURIComponent(rest.join('='));
      return isUiLocale(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export function readDeviceLocale(): UiLocale | undefined {
  try {
    return deviceLocale(document.cookie);
  } catch {
    return undefined;
  }
}

export function resolveUiLocale(
  saved: unknown,
  device: unknown,
  browserLanguages: readonly string[],
): UiLocale {
  if (isUiLocale(saved)) return saved;
  if (isUiLocale(device)) return device;
  for (const language of browserLanguages) {
    const supported = supportedLanguage(language);
    if (supported) return supported;
  }
  return DEFAULT_UI_LOCALE;
}

export function rememberUiLocale(locale: UiLocale): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: this bounded path cookie must also work without Cookie Store
    document.cookie = deviceLocaleCookie(locale, siteBase());
  } catch {
    // It is only a signed-out hint; privacy settings must not block the confirmed account choice.
  }
}

export const deviceLocaleCookie = (locale: UiLocale, base: string): string =>
  `${DEVICE_LOCALE_COOKIE}=${locale}; Path=${base.replace(/\/+$/, '')}/admin; Max-Age=31536000; SameSite=Lax`;

export function showUiLocale(locale: UiLocale): void {
  document.documentElement.lang = locale;
}
