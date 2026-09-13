import { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES, type UiLocale } from '@handover/core';
import type { Locale } from './paraglide/runtime.js';

const compilerLocales: readonly Locale[] = UI_LOCALES;
void compilerLocales;

export type { UiLocale };
export { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES };

export const messageOptions = (locale: UiLocale) => ({ locale }) as const;
