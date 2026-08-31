// What a page says about itself, resolved once: the entry's own `seo` field, then the site's
// defaults, then nothing. The admin's panel and `<Seo />` both read it here, so the greyed
// value a client is shown while typing cannot disagree with the tag the build emits.

/** Guidance, never validation: what Google shows before it truncates, in characters. */
export const SEO_TITLE_LIMIT = 60;
export const SEO_DESCRIPTION_LIMIT = 155;

/** A picture as a content file stores it — the same shape an `image` field holds. */
export interface SeoImage {
  src: string;
  alt?: string;
  width: number;
  height: number;
}

/** The entry's own `seo` field. */
export interface SeoValue {
  title?: string;
  description?: string;
  image?: SeoImage;
  noindex?: boolean;
  canonical?: string;
}

/** The site's, from the global that declares `defaultSeo`. */
export interface SeoDefaultsValue {
  /** `%s · Coastal Homes`, where `%s` is the page's own title. */
  titlePattern?: string;
  description?: string;
  image?: SeoImage;
  twitter?: string;
}

export interface ResolvedSeo {
  title: string;
  description?: string;
  image?: SeoImage;
  noindex: boolean;
  canonical?: string;
  twitter?: string;
}

/**
 * `pageTitle` is the entry's own heading — what a search title nobody typed falls back to.
 *
 * A typed search title is used as it is: a client who writes one has said what the page is
 * called, and appending the site name to it would be the panel changing their words. The
 * pattern is for the pages nobody has written one for, which is nearly all of them.
 */
export function resolveSeo(
  seo: SeoValue | undefined,
  defaults: SeoDefaultsValue | undefined,
  pageTitle: string,
): ResolvedSeo {
  const pattern = defaults?.titlePattern;
  // One substitution, so a site name that really contains "%s" keeps the rest of it.
  const fallback = pattern ? pattern.replace('%s', pageTitle) : pageTitle;
  return {
    title: seo?.title || fallback,
    ...pick('description', seo?.description || defaults?.description),
    ...pick('image', seo?.image ?? defaults?.image),
    noindex: seo?.noindex === true,
    ...pick('canonical', seo?.canonical || undefined),
    ...pick('twitter', defaults?.twitter || undefined),
  };
}

// An absent key rather than an undefined one: the result is compared in tests and spread into
// attributes, and `{ canonical: undefined }` is not the same object as `{}` in either.
const pick = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** The line beside the label: what is typed, against the length Google starts cutting at. */
export function seoMeter(text: string, limit: number): string {
  const count = text.trim().length;
  if (count === 0) return `Up to about ${limit} characters`;
  const said = `About ${count} of ≈${limit} characters`;
  return count > limit ? `${said} — may be cut off` : said;
}
