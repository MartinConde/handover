// What a page says about itself, resolved once.

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

/** `pageTitle` is the entry's own heading — what a search title nobody typed falls back to. */
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

// An absent key rather than an undefined one.
const pick = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** The line beside the label: what is typed, against the length Google starts cutting at. */
export function seoMeter(text: string, limit: number): string {
  const count = text.trim().length;
  if (count === 0) return `Up to about ${limit} characters`;
  const said = `About ${count} of ≈${limit} characters`;
  return count > limit ? `${said} — may be cut off` : said;
}
