export const UI_LOCALES = ['en', 'de'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export const isUiLocale = (value: unknown): value is UiLocale =>
  UI_LOCALES.some((locale) => locale === value);

/** What a site developer writes wherever the admin shows a name: one string, or one per language. */
export type Labels = Partial<Record<UiLocale, string>>;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The one per language in the object form, or undefined when the label is not that form. */
export const labelsOf = (label: unknown): Labels | undefined => {
  if (typeof label !== 'object' || label === null || Array.isArray(label)) return undefined;
  const found = Object.entries(label).filter(
    (entry): entry is [UiLocale, string] => isUiLocale(entry[0]) && isText(entry[1]),
  );
  return found.length ? Object.fromEntries(found) : undefined;
};

// English next, since it is the language every site has had a label in so far.
export function labelIn(label: unknown, locale: UiLocale): string | undefined {
  if (isText(label)) return label;
  const labels = labelsOf(label);
  return labels && (labels[locale] ?? labels.en ?? Object.values(labels)[0]);
}
