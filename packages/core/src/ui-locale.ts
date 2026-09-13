export const UI_LOCALES = ['en', 'de'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export const isUiLocale = (value: unknown): value is UiLocale =>
  UI_LOCALES.some((locale) => locale === value);
