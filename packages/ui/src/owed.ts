/** What the language filter reads of a row of `GET /admin/api/entries/{collection}`. */
export type OwedRow = {
  id: string;
  locales: Record<string, { title: string }>;
  /** The languages it is offered in, absent when that is every language the site declares. */
  offered?: string[];
  /** The languages the last build found translated from a source that has moved on since. */
  stale?: string[];
};

const WORK = ['owed', 'missing', 'stale'] as const;
export type Work = (typeof WORK)[number];

// An unknown kind of work asks for all of it rather than for an empty list.
export const workFrom = (value: string | null): Work =>
  WORK.find((kind) => kind === value) ?? 'owed';

// A language turned off for the entry gets no file, so it is not one still to write.
export const offered = (entry: OwedRow, locale: string) => entry.offered?.includes(locale) ?? true;
export const missing = (entry: OwedRow, locale: string) =>
  offered(entry, locale) && !entry.locales[locale];
export const stale = (entry: OwedRow, locale: string) =>
  offered(entry, locale) &&
  Boolean(entry.locales[locale]) &&
  (entry.stale?.includes(locale) ?? false);
export const owes = (entry: OwedRow, locale: string, work: Work) =>
  (work !== 'stale' && missing(entry, locale)) || (work !== 'missing' && stale(entry, locale));

// An entry that exists in German alone is listed by its German title, not its file name.
export const rowTitle = (entry: OwedRow, locales: string[]) =>
  locales.map((l) => entry.locales[l]?.title).find(Boolean) ||
  Object.values(entry.locales)[0]?.title ||
  entry.id;

/** The address tail that keeps a queue through links; nothing without one. */
export const queueQuery = (queue: string | undefined, work: Work) =>
  queue ? `?${new URLSearchParams({ queue, owed: work })}` : '';
