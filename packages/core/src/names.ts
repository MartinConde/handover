// Letters NFD cannot reduce to ASCII; other scripts drop out and fall back to `untitled`.
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

// The filename is the entry's id in GitHub, so never percent-encoded, never random.
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

// Every message names the config key, and the integration throws them joined at build.
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
    // Whether the field exists is the schema's business; this checks the name's shape alone.
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

// Locales are folder names and URL segments, so spelled Astro's way: never `en_US`.
const LOCALE = /^[a-z0-9-]+$/;

/** Required even for one language: the file layout has a locale folder either way. */
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
  /** Astro's base path, absent when served at the root. */
  base?: string;
}

/** `undefined` for a collection with no route: nothing renders it, so there is nowhere to link. */
export function entryUrl(
  _siteId: string,
  i18n: I18nRouting,
  route: string | undefined,
  slug: string,
  locale: string,
): string | undefined {
  if (!route) return undefined;
  const prefix = locale === i18n.defaultLocale && !i18n.prefixDefaultLocale ? '' : `/${locale}`;
  return (i18n.base ?? '').replace(/\/+$/, '') + prefix + route.replace('[slug]', slug);
}

/** A path written the other way is a hop through the asset server's redirect. */
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

/** The allow-list in front of `/_preview`: `undefined` for any path the site could not serve. */
export function previewTarget(
  siteId: string,
  i18n: I18nRouting,
  collections: Record<string, { route?: string; index?: string }>,
  path: string,
): PreviewTarget | undefined {
  // Only one trailing slash is forgiven: an allow-list that repairs input allows too much.
  if (!path.startsWith('/') || path.includes('//')) return undefined;
  const base = (i18n.base ?? '').replace(/\/+$/, '');
  if (base && path !== base && !path.startsWith(`${base}/`)) return undefined;
  path = path.slice(base.length) || '/';
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = trimmed === '/' ? [] : trimmed.slice(1).split('/');

  // `/de` is the German index, not the English slug "de": the language comes off first.
  const first = segments[0];
  const prefixed =
    first !== undefined &&
    i18n.locales.includes(first) &&
    (first !== i18n.defaultLocale || Boolean(i18n.prefixDefaultLocale));
  if (!prefixed && i18n.prefixDefaultLocale) return undefined;
  const locale = prefixed ? (first as string) : i18n.defaultLocale;
  const rest = `/${(prefixed ? segments.slice(1) : segments).join('/')}`;

  // Indexes before routes: `/blog` is the blog index, not the page addressed "blog".
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

/** Empty is not a mistake; the rules are the file name's, since both fill the same URL segment. */
export function addressError(_siteId: string, address: string): string | undefined {
  if (!address) return undefined;
  if (address.length > MAX) return `${JSON.stringify(address)} is longer than ${MAX} characters`;
  if (!ADDRESS.test(address))
    return `${JSON.stringify(address)} is not a web address: lowercase letters, digits and single dashes, like "start-seite"`;
  return undefined;
}

/** The file name never changes because an address did: it is the id across languages. */
export function entryAddress(_siteId: string, data: unknown, name: string): string {
  // Read as a key: Astro's non-enumerable `slug` getter logs a warning when touched.
  const found = data ? Object.getOwnPropertyDescriptor(data, 'slug') : undefined;
  const slug = found?.enumerable ? found.value : undefined;
  return typeof slug === 'string' && slug ? slug : name;
}
