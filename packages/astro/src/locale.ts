import { isUiLocale, UI_LOCALES, type UiLocale } from '@handover/core';

const cookieLocale = (header: string | null): UiLocale | undefined => {
  for (const part of (header ?? '').slice(0, 4096).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'handover_ui_locale') continue;
    try {
      const value = decodeURIComponent(rest.join('='));
      return isUiLocale(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
};

const acceptedLocale = (header: string | null): UiLocale | undefined => {
  const preferences = (header ?? '')
    .slice(0, 4096)
    .split(',')
    .map((part, order) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      const range = tag.toLowerCase();
      if (range !== '*' && !/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(range)) return undefined;
      let quality = 1;
      for (const parameter of parameters) {
        const match = parameter.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
        if (!match) return undefined;
        quality = Number(match[1]);
      }
      const language = range.split('-')[0];
      return { range, locale: isUiLocale(language) ? language : undefined, quality, order };
    })
    .filter((preference) => preference !== undefined);
  const wildcard = preferences.find((preference) => preference.range === '*');
  return UI_LOCALES.map((locale, supportedOrder) => {
    const explicit = preferences.filter((preference) => preference.locale === locale);
    const excluded = explicit.some((preference) => preference.quality === 0);
    const preferred = explicit
      .filter((preference) => preference.quality > 0)
      .sort((a, b) => b.quality - a.quality || a.order - b.order)[0];
    const match = preferred ?? (!excluded && wildcard?.quality ? wildcard : undefined);
    return match
      ? { locale, quality: match.quality, order: match.order, supportedOrder }
      : undefined;
  })
    .filter((candidate) => candidate !== undefined)
    .sort(
      (a, b) => b.quality - a.quality || a.order - b.order || a.supportedOrder - b.supportedOrder,
    )[0]?.locale;
};

/** The device's hint on a signed-out request: the picker's cookie, then `Accept-Language`. */
export const requestLocale = (request?: Request): UiLocale | undefined =>
  request &&
  (cookieLocale(request.headers.get('cookie')) ??
    acceptedLocale(request.headers.get('accept-language')));
