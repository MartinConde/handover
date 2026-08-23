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
    if (c.load !== undefined && typeof c.load !== 'string')
      errors.push(
        `${at('load')}expected the loader's name as a string, like "post" for src/loaders/post.ts`,
      );
  }
  return errors;
}
