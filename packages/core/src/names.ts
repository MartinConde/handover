// Letters NFD cannot reduce to ASCII: German/Nordic conventions and Cyrillic. Other
// scripts (CJK, Arabic, …) drop out and the title falls back to `untitled`.
const LETTERS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
  œ: 'oe',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  є: 'ye',
  і: 'i',
  ї: 'yi',
  ґ: 'g',
};

const MAX = 80;

// The filename is the entry's cross-locale id, so it must be readable in GitHub: never
// percent-encoded, never random. `taken` is every name in the collection across locales,
// published or drafted.
export function entryName(_siteId: string, title: string, taken: Iterable<string>): string {
  const base =
    Array.from(title.toLowerCase())
      .map((c) => LETTERS[c] ?? c.normalize('NFD').replace(/\p{M}/gu, ''))
      .join('')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX)
      .replace(/-+$/, '') || 'untitled';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = base.slice(0, MAX - suffix.length).replace(/-+$/, '') + suffix;
    if (!used.has(name)) return name;
  }
}

export interface CollectionRoutes {
  route?: unknown;
  index?: unknown;
  load?: unknown;
  titleField?: unknown;
  localizedSlugs?: unknown;
}

// Every message names the key in cms.config.ts that is wrong; the integration throws
// them joined, so a bad config fails the build before any page is served.
export function checkCollections(
  _siteId: string,
  collections: Record<string, CollectionRoutes>,
  globals: Record<string, unknown> = {},
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(globals)) {
    if (!/^[a-z0-9-]+$/.test(key))
      errors.push(
        `cms.config.ts › globals.${key}: global keys are lowercase letters, digits and dashes (it is the file name under src/content/globals/<locale>/)`,
      );
  }
  const routes = new Map<string, string>();
  for (const [name, c] of Object.entries(collections)) {
    const at = (key?: string) => `cms.config.ts › collections.${name}${key ? `.${key}` : ''}: `;
    if (!/^[a-z0-9-]+$/.test(name))
      errors.push(
        `${at()}collection names are lowercase letters, digits and dashes (it is a folder under src/content/)`,
      );
    if (c.route !== undefined) {
      if (typeof c.route !== 'string' || !/^\/[^\s[\]]*\[slug\][^\s[\]]*$/.test(c.route))
        errors.push(
          `${at('route')}expected a path starting with "/" containing "[slug]" once, like "/blog/[slug]", got ${JSON.stringify(c.route)}`,
        );
      else if (routes.has(c.route))
        errors.push(
          `${at('route')}${JSON.stringify(c.route)} is already the route of ${JSON.stringify(routes.get(c.route))}`,
        );
      else routes.set(c.route, name);
    }
    if (c.index !== undefined && (typeof c.index !== 'string' || !/^\/[^\s[\]]*$/.test(c.index)))
      errors.push(
        `${at('index')}expected a fixed path starting with "/", like "/blog", got ${JSON.stringify(c.index)}`,
      );
    // Whether the field exists and holds a string is the schema's business; this is the only
    // place that sees the key, so it checks the shape of the name alone.
    if (
      c.titleField !== undefined &&
      (typeof c.titleField !== 'string' || !/^[^_\s][^\s]*$/.test(c.titleField))
    )
      errors.push(
        `${at('titleField')}expected the name of a field in the collection's schema, like "name", got ${JSON.stringify(c.titleField)}`,
      );
    if (c.localizedSlugs !== undefined && typeof c.localizedSlugs !== 'boolean')
      errors.push(
        `${at('localizedSlugs')}expected true or false, got ${JSON.stringify(c.localizedSlugs)}`,
      );
    if (c.load !== undefined && typeof c.load !== 'string')
      errors.push(
        `${at('load')}expected the loader's name as a string, like "post" for src/loaders/post.ts`,
      );
  }
  return errors;
}

export interface I18nConfig {
  locales?: unknown;
  defaultLocale?: unknown;
  prefixDefaultLocale?: unknown;
  base?: unknown;
}

// Locales are folder names under src/content/<collection>/ and path segments in the URL,
// so they are spelled the way Astro spells them: lowercase, dashes, never `en_US`.
const LOCALE = /^[a-z0-9-]+$/;

/**
 * The `i18n` block's own shape. It is required even for one language: the file layout has
 * a locale folder either way, so a single-locale site is the same code path with one entry
 * in the list. What it has to agree with in astro.config.mjs is checked by the integration.
 */
export function checkI18n(_siteId: string, i18n: I18nConfig | undefined): string[] {
  const at = (key?: string) => `cms.config.ts › i18n${key ? `.${key}` : ''}: `;
  if (!i18n)
    return [
      `${at()}required, like i18n: { locales: ['en'], defaultLocale: 'en' } — a site with one language declares it too, and keeps its files under src/content/<collection>/en/`,
    ];
  const { locales, defaultLocale, prefixDefaultLocale, base } = i18n;
  const errors: string[] = [];
  if (
    !Array.isArray(locales) ||
    locales.length === 0 ||
    !locales.every((l) => typeof l === 'string' && LOCALE.test(l))
  )
    errors.push(
      `${at('locales')}expected a non-empty array of locale folder names in lowercase letters, digits and dashes, like ["en", "de"], got ${JSON.stringify(locales)}`,
    );
  else if (new Set(locales).size !== locales.length)
    errors.push(`${at('locales')}${JSON.stringify(locales)} lists a locale twice`);
  else if (!locales.includes(defaultLocale))
    errors.push(
      `${at('defaultLocale')}expected one of ${JSON.stringify(locales)}, got ${JSON.stringify(defaultLocale)}`,
    );
  if (prefixDefaultLocale !== undefined && typeof prefixDefaultLocale !== 'boolean')
    errors.push(
      `${at('prefixDefaultLocale')}expected true or false, got ${JSON.stringify(prefixDefaultLocale)}`,
    );
  if (base !== undefined && (typeof base !== 'string' || !/^\/.+[^/]$/.test(base)))
    errors.push(
      `${at('base')}expected astro.config.mjs's base, a path like "/site" — leading slash, no trailing one, got ${JSON.stringify(base)}`,
    );
  return errors;
}

/** What a URL is built from: the same block, with the shapes `checkI18n` has already accepted. */
export interface I18nRouting {
  locales: string[];
  defaultLocale: string;
  prefixDefaultLocale?: boolean;
  /** Astro's `base`, where the whole site is served under a path: `/site`. Absent at the root. */
  base?: string;
}

/**
 * Where one entry is served: the collection's `route` with `[slug]` filled in, under the
 * language's own segment. The default language has none unless the site asked for one, which
 * is Astro's `prefixDefaultLocale`. The preview path is this path behind its own prefix, so
 * the segment is settled here rather than in each site's routes, and so is the site's `base`
 * where it has one. `undefined` for a collection with no route: nothing renders it, so there is
 * nowhere to link.
 */
export function entryUrl(
  _siteId: string,
  i18n: I18nRouting,
  route: string | undefined,
  slug: string,
  locale: string,
): string | undefined {
  if (!route) return undefined;
  const prefix = locale === i18n.defaultLocale && !i18n.prefixDefaultLocale ? '' : `/${locale}`;
  return (i18n.base ?? '') + prefix + route.replace('[slug]', slug);
}

/**
 * `path` written the way this site's pages answer — with the trailing slash under Astro's
 * default `build.format: 'directory'`, without it otherwise. A link, an alternate or a
 * redirect target written the other way is a hop through the redirect the asset server
 * answers with. The root, a query, a hash and an address on another site are left as they are.
 */
export function withSlash(path: string, slash: boolean): string {
  if (!path.startsWith('/')) return path;
  const cut = path.search(/[?#]/);
  const [bare, rest] = cut < 0 ? [path, ''] : [path.slice(0, cut), path.slice(cut)];
  const trimmed = bare.replace(/\/+$/, '');
  return `${trimmed}${slash || !trimmed ? '/' : ''}${rest}`;
}

export interface PreviewTarget {
  collection: string;
  locale: string;
  /** Absent on a collection's index page, which is the collection rather than one entry. */
  address?: string;
}

/**
 * What a preview path is a preview *of*: the collection the page belongs to, the language it
 * is read in, and the entry's own address where it has one — an index page is a collection
 * without one. `undefined` is the whole of the allow-list in front of `/_preview`: a path the
 * site's own routes could not serve is not a page anybody may render there, which is what
 * keeps the route from being somewhere to put arbitrary content on the client's domain.
 *
 * The path is the site's own, `entryUrl`'s answer read backwards, so the language segment is
 * where the site puts it and `prefixDefaultLocale` is respected by construction.
 */
export function previewTarget(
  siteId: string,
  i18n: I18nRouting,
  collections: Record<string, { route?: string; index?: string }>,
  path: string,
): PreviewTarget | undefined {
  // One trailing slash is the same page, which is Astro's `trailingSlash: 'ignore'`. Nothing
  // else is tidied up: an allow-list that repairs what it is given ends up allowing more than
  // it can name.
  if (!path.startsWith('/') || path.includes('//')) return undefined;
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = trimmed === '/' ? [] : trimmed.slice(1).split('/');

  // `/de` is the German index and, read as a page, the slug "de" in English; Astro serves the
  // first, since a static segment beats a dynamic one. So the language comes off the front
  // before any route is matched — and only where the site actually puts one there.
  const first = segments[0];
  const prefixed =
    first !== undefined &&
    i18n.locales.includes(first) &&
    (first !== i18n.defaultLocale || Boolean(i18n.prefixDefaultLocale));
  if (!prefixed && i18n.prefixDefaultLocale) return undefined;
  const locale = prefixed ? (first as string) : i18n.defaultLocale;
  const rest = `/${(prefixed ? segments.slice(1) : segments).join('/')}`;

  // Indexes before routes, for the same reason: `/blog` is the blog index and not the page
  // whose address happens to be "blog".
  for (const [collection, c] of Object.entries(collections))
    if (c.index === rest) return { collection, locale };
  for (const [collection, c] of Object.entries(collections)) {
    if (!c.route) continue;
    const [head = '', tail = ''] = c.route.split('[slug]');
    if (!rest.startsWith(head) || !rest.endsWith(tail)) continue;
    const address = rest.slice(head.length, rest.length - tail.length);
    if (address && !addressError(siteId, address)) return { collection, locale, address };
  }
  return undefined;
}

const ADDRESS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why this cannot be the web address of an entry, or nothing. Empty is not a mistake: a file
 * with no address of its own is served under its name. The rules are the file name's, since
 * the two are alternatives for the same URL segment — percent-encoding above all, which turns
 * a clean URL into garbage and every redirect into something nobody can read.
 */
export function addressError(_siteId: string, address: string): string | undefined {
  if (!address) return undefined;
  if (address.length > MAX) return `${JSON.stringify(address)} is longer than ${MAX} characters`;
  if (!ADDRESS.test(address))
    return `${JSON.stringify(address)} is not a web address: lowercase letters, digits and single dashes, like "start-seite"`;
  return undefined;
}

/**
 * The address one file is served under: its own `slug` where the collection has localized
 * slugs, and its file name where it has none. The file name never changes because an address
 * did — it is the entry's id across the languages, and only the URL moved.
 */
export function entryAddress(_siteId: string, data: unknown, name: string): string {
  // Read as a key rather than a property: Astro's content layer defines a non-enumerable `slug`
  // getter on every entry that has none, to warn that its own `slug` is gone, and touching that
  // would log the warning on every page the site renders.
  const found = data ? Object.getOwnPropertyDescriptor(data, 'slug') : undefined;
  const slug = found?.enumerable ? found.value : undefined;
  return typeof slug === 'string' && slug ? slug : name;
}
