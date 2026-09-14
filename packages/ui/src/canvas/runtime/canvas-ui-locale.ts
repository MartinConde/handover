import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '@handover/core';

export interface CanvasUiLocaleState {
  current: () => UiLocale;
  set: (locale: UiLocale) => boolean;
  subscribe: (listener: (locale: UiLocale) => void) => () => void;
}

/** Shared by eager and lazy Canvas controls so a late control starts in the latest UI locale. */
export function createCanvasUiLocaleState(
  initial: UiLocale = DEFAULT_UI_LOCALE,
): CanvasUiLocaleState {
  let locale = isUiLocale(initial) ? initial : DEFAULT_UI_LOCALE;
  const listeners = new Set<(locale: UiLocale) => void>();
  return {
    current: () => locale,
    set(next) {
      if (!isUiLocale(next) || next === locale) return false;
      locale = next;
      for (const listener of listeners) listener(locale);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(locale);
      return () => listeners.delete(listener);
    },
  };
}
