import { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES, type UiLocale } from '@handover/core';
import type { Locale } from './paraglide/runtime.js';
import { siteBase } from './request.js';

const compilerLocales: readonly Locale[] = UI_LOCALES;
void compilerLocales;

export type { UiLocale };
export { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES };

export const messageOptions = (locale: UiLocale) => ({ locale }) as const;

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
