import { parseEntry, stringifyEntry } from './entry-format.js';
import type { GitClient, PublishFile } from './git.js';
import { withSlash } from './names.js';
import { operationMessage } from './operations.js';
import { newId } from './reserved.js';

export interface RedirectRule {
  _id: string;
  from: string;
  to: string;
  /** Moved for good, or only for now: the one thing a manual rule asks the client. */
  status: 301 | 302;
  reason: 'slug-change' | 'hidden' | 'deleted' | 'manual';
  entry?: string;
  createdAt: string;
  /** Where this pointed before a hide re-pointed it; put back on unhide. */
  was?: string;
}

/** The one file several entries write into, which is why a publish assembles it. */
export const REDIRECTS = 'src/content/redirects.yaml';

const unsafeRedirectText = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || code < 32 || (code >= 127 && code <= 159);
  });

export function redirectSourceError(value: string): string | undefined {
  if (!value.startsWith('/')) return 'a path starting with "/"';
  if (unsafeRedirectText(value)) return 'a path without whitespace or control characters';
  if (/[\\*:?#[\]{}]/.test(value) || /%2f|%5c/i.test(value))
    return 'a literal path without patterns, queries, fragments, or encoded separators';
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return 'a path with valid URL encoding';
  }
  if (/[\\*:?#[\]{}]/.test(decoded))
    return 'a literal path without encoded pattern, query, or fragment syntax';
  if (decoded.includes('//') || /\/(?:\.{1,2})(?:\/|$)/.test(decoded))
    return 'a normalized literal path without repeated slashes or dot segments';
  return undefined;
}

const canonicalRedirectPath = (value: string) => {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  // Redirect matching ignores queries; URL parsing also resolves destination dot segments.
  const path = new URL(value, 'https://redirect.invalid').pathname;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Destinations can legitimately contain a literal percent sign.
  }
  return decoded === '/' ? decoded : decoded.replace(/\/+$/, '') || '/';
};

const reservedRedirectSource = (value: string, base = '') => {
  const root = canonicalRedirectPath(base || '/');
  const local =
    root !== '/' && (value === root || value.startsWith(`${root}/`))
      ? value.slice(root.length) || '/'
      : value;
  return ['/admin', '/_preview', '/_astro', '/_server-islands'].some(
    (prefix) => local === prefix || local.startsWith(`${prefix}/`),
  );
};

export function redirectDestinationError(value: string): string | undefined {
  if (unsafeRedirectText(value))
    return 'a path or absolute HTTP(S) URL without whitespace or control characters';
  if (value.startsWith('/')) return undefined;
  if (!/^https?:\/\//i.test(value)) return 'a path or an absolute HTTP(S) URL';
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname)
      return undefined;
  } catch {
    // The field-level error below is more useful than the URL parser's implementation detail.
  }
  return 'a path or an absolute HTTP(S) URL';
}

const assertRedirectRule = (rule: Pick<RedirectRule, 'from' | 'to'>, base = '') => {
  const from = redirectSourceError(rule.from);
  if (from)
    throw new Error(
      from.includes('whitespace')
        ? 'redirect source cannot contain whitespace or control characters'
        : `redirect source must be ${from}`,
    );
  if (reservedRedirectSource(canonicalRedirectPath(rule.from), base))
    throw new Error('redirect source is reserved for the site application');
  const to = redirectDestinationError(rule.to);
  if (to)
    throw new Error(
      to.includes('whitespace')
        ? 'redirect destination cannot contain whitespace or control characters'
        : `redirect destination must be ${to}`,
    );
};

/** One rule as the file carries it: an id of its own and when it was made. */
export const redirectRule = (
  siteId: string,
  rule: Omit<RedirectRule, '_id' | 'createdAt'>,
  at: number,
): RedirectRule => {
  assertRedirectRule(rule);
  return {
    _id: newId(siteId),
    ...rule,
    createdAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
};

/** Appends in the same commit as the entry; `undefined` when there is nothing to write. */
export async function appendRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  added: readonly RedirectRule[],
  /** The commit this is going into, which is the one its existing rules are read from. */
  at: string,
  /** A rule this commit takes back out — an entry it puts back on the site. */
  drop?: (rule: RedirectRule) => boolean,
): Promise<PublishFile | undefined> {
  const file = await git.getFile(REDIRECTS, at);
  if (!file && !added.length) return undefined;
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  const had = doc.rules ?? [];
  const back = new Set(had.filter((r) => drop?.(r)).map((r) => r.entry));
  const kept = had.flatMap((r) => {
    if (drop?.(r)) return [];
    if (r.was === undefined || r.entry === undefined || !back.has(r.entry)) return [r];
    const { was, ...rest } = r;
    return [{ ...rest, to: was }];
  });
  const rules = collapseRedirects(kept, added);
  return { path: REDIRECTS, contents: stringifyEntry(siteId, { ...doc, rules }) };
}

/** A visitor never hops twice; a hide is undone later, so a rule it re-points remembers `was`. */
export function collapseRedirects(
  rules: readonly RedirectRule[],
  written: readonly RedirectRule[],
): RedirectRule[] {
  let all = [...rules];
  for (const rule of written) {
    const list = all.some((r) => r._id === rule._id) ? all : [...all, rule];
    // Rules leading to this `from` are no step onward, or `A → B` over `B → A` chases its tail.
    const onward = list.filter(
      (r) => r._id !== rule._id && canonicalRedirectPath(r.to) !== canonicalRedirectPath(rule.from),
    );
    const seen = new Set([canonicalRedirectPath(rule.from)]);
    let to = rule.to;
    for (
      let next = onward.find((r) => canonicalRedirectPath(r.from) === canonicalRedirectPath(to));
      next && !seen.has(canonicalRedirectPath(next.to));
    ) {
      seen.add(canonicalRedirectPath(to));
      to = next.to;
      next = onward.find((r) => canonicalRedirectPath(r.from) === canonicalRedirectPath(to));
    }
    const landed = { ...rule, to };
    all = list
      .map((r) =>
        r._id === rule._id
          ? landed
          : canonicalRedirectPath(r.to) === canonicalRedirectPath(rule.from)
            ? {
                ...r,
                to,
                entry: rule.entry ?? r.entry,
                ...(rule.reason === 'hidden' ? { was: r.to } : {}),
              }
            : r,
      )
      .filter((r) => canonicalRedirectPath(r.from) !== canonicalRedirectPath(r.to));
  }
  return all;
}

/** The rules `redirects.yaml` holds, or none where the site has never written one. */
export async function readRedirects(
  siteId: string,
  git: Pick<GitClient, 'getFile'>,
  at?: string,
): Promise<RedirectRule[]> {
  const file = await git.getFile(REDIRECTS, at);
  if (!file) return [];
  return ((parseEntry(siteId, file.contents) as { rules?: RedirectRule[] }).rules ?? []).slice();
}

/** Commits on its own: the file never gets a draft row, so a rule has nowhere to wait. */
export async function editRedirects(
  siteId: string,
  git: GitClient,
  message: string,
  change: (rules: RedirectRule[]) => RedirectRule[],
  deps: { baseSha?: string; operationId?: string } = {},
): Promise<{ commit_sha: string }> {
  const base_sha = deps.baseSha ?? (await git.getHead());
  const file = await git.getFile(REDIRECTS, base_sha);
  const doc = (file ? parseEntry(siteId, file.contents) : { _version: 1 }) as {
    rules?: RedirectRule[];
  };
  const contents = stringifyEntry(siteId, { ...doc, rules: change(doc.rules ?? []) });
  return git.publish([{ path: REDIRECTS, contents }], {
    base_sha,
    message: deps.operationId ? operationMessage(message, deps.operationId) : message,
  });
}

/** Every served page by URL, so a `from` can be told it shadows one. */
export interface RedirectSite {
  pages: Record<string, string>;
  rules: readonly RedirectRule[];
  base?: string;
}

export interface RedirectProblem {
  field: 'from' | 'to';
  message: string;
  descriptor: {
    code: string;
    suggestion?: string;
    page?: string;
  };
}

/** Said as the consequence: nobody diagnoses a shadowed page from a 404; `field` is its box. */
export function redirectError(
  _siteId: string,
  rule: { from: string; to: string },
  site: RedirectSite,
  /** The rule being changed, whose own `from` is not a clash with itself. */
  id?: string,
): RedirectProblem | undefined {
  const from = rule.from.trim();
  const to = rule.to.trim();
  const at = (
    field: 'from' | 'to',
    message: string,
    descriptor: RedirectProblem['descriptor'],
  ): RedirectProblem => ({ field, message, descriptor });
  if (!from) return at('from', 'An old address is needed.', { code: 'REDIRECT_FROM_REQUIRED' });
  if (/^[a-z][a-z0-9+.-]*:/i.test(from))
    return at(
      'from',
      'An old address is a path on this site, like "/summer-offer", not a full web address.',
      {
        code: 'REDIRECT_FROM_ABSOLUTE',
      },
    );
  if (!from.startsWith('/'))
    return at('from', `An address has to start with "/" — did you mean "/${from}"?`, {
      code: 'REDIRECT_FROM_SLASH',
      suggestion: `/${from}`,
    });
  const sourceError = redirectSourceError(from);
  if (sourceError)
    return sourceError.includes('whitespace')
      ? at('from', 'An old address cannot contain spaces or control characters.', {
          code: 'REDIRECT_FROM_WHITESPACE',
        })
      : at('from', `An old address must be ${sourceError}.`, {
          code: 'REDIRECT_FROM_INVALID',
        });
  if (!to) return at('to', 'A destination is needed.', { code: 'REDIRECT_TO_REQUIRED' });
  const toError = redirectDestinationError(to);
  if (toError?.includes('whitespace'))
    return at('to', 'A destination cannot contain spaces or control characters.', {
      code: 'REDIRECT_TO_WHITESPACE',
    });
  if (toError)
    return at(
      'to',
      `A destination is a path on this site or a full web address — did you mean "/${to.replace(/^\/+/, '')}"?`,
      {
        code: 'REDIRECT_TO_INVALID',
        suggestion: `/${to.replace(/^\/+/, '')}`,
      },
    );
  const canonicalFrom = canonicalRedirectPath(from);
  const canonicalTo = to.startsWith('/') ? canonicalRedirectPath(to) : to;
  if (reservedRedirectSource(canonicalFrom, site.base))
    return at('from', 'This address is reserved for the site application.', {
      code: 'REDIRECT_FROM_RESERVED',
    });
  if (canonicalFrom === canonicalTo)
    return at('to', 'This sends visitors back where they came from. Pick somewhere else.', {
      code: 'REDIRECT_SAME_ADDRESS',
    });
  const page = site.pages[canonicalFrom] ?? site.pages[`${canonicalFrom}/`];
  if (page)
    return at('from', `This is a real page. A redirect here would hide ${page} from visitors.`, {
      code: 'REDIRECT_SHADOWS_PAGE',
      page,
    });
  if (site.rules.some((r) => canonicalRedirectPath(r.from) === canonicalFrom && r._id !== id))
    return at('from', 'There is already a redirect from this address.', {
      code: 'REDIRECT_FROM_EXISTS',
    });
  return undefined;
}

/** Static Assets matches `from` exactly, so each is written with and without a trailing slash. */
export const redirectsText = (
  _siteId: string,
  rules: RedirectRule[],
  slash: boolean,
  base = '',
): string => {
  for (const rule of rules) assertRedirectRule(rule, base);
  return rules
    .flatMap((r) => {
      const to = withSlash(r.to, slash);
      const forms = new Set([withSlash(r.from, false), withSlash(r.from, true)]);
      return [...forms].map((from) => `${from} ${to} ${r.status}\n`);
    })
    .join('');
};
