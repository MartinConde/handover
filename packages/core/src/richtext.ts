import GithubSlugger from 'github-slugger';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const textOf = (node: Nodes): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';

export type RichtextTier = 'basic' | 'full';

// The editor-facing names; each one is one round-trip test in richtext.test.ts.
export const RICHTEXT_CONSTRUCTS = {
  basic: ['paragraph', 'bold', 'italic', 'link', 'bulletList', 'numberedList'],
  full: [
    'paragraph',
    'bold',
    'italic',
    'link',
    'bulletList',
    'numberedList',
    'h2',
    'h3',
    'blockquote',
  ],
} as const satisfies Record<RichtextTier, readonly string[]>;

// A link is the only construct that carries a target. Browsers ignore ASCII whitespace
// and control characters inside a URL, so `java<tab>script:` is a live `javascript:` link
// and the scheme is read from the stripped string.
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** The scheme of a link that must not be rendered, or undefined when the target is fine. */
export function unsafeLinkScheme(_siteId: string, url: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: what a browser itself drops.
  const found = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000-\u0020\u007f]/g, ''));
  const scheme = found?.[1]?.toLowerCase();
  return scheme && !LINK_SCHEMES.has(scheme) ? scheme : undefined;
}

const BASIC_NODES = new Set([
  'root',
  'paragraph',
  'text',
  'strong',
  'emphasis',
  'link',
  'list',
  'listItem',
  'break',
]);
const FULL_ONLY_NODES = new Set(['heading', 'blockquote']);

// GFM is parsed so a table or strikethrough is rejected by name instead of slipping
// through as paragraph text and rendering as a table later.
export function richtextErrors(_siteId: string, markdown: string, tier: RichtextTier): string[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const errors: string[] = [];
  const visit = (node: Nodes) => {
    const at = node.position ? ` (line ${node.position.start.line})` : '';
    if (node.type === 'heading' && (node.depth < 2 || node.depth > 3))
      errors.push(`heading level ${node.depth} is not allowed${at}`);
    else if (FULL_ONLY_NODES.has(node.type) && tier === 'basic')
      errors.push(`${node.type} needs richtext: full${at}`);
    else if (node.type === 'link' && unsafeLinkScheme(_siteId, node.url))
      errors.push(`${unsafeLinkScheme(_siteId, node.url)}: links are not allowed${at}`);
    else if (node.type === 'listItem' && typeof node.checked === 'boolean')
      errors.push(`task list item is not allowed${at}`);
    else if (!BASIC_NODES.has(node.type) && !FULL_ONLY_NODES.has(node.type))
      errors.push(`${node.type} is not allowed${at}`);
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return errors;
}

/**
 * Every link target in a richtext value, read with the parser the page is rendered with — so
 * the pre-publish link check sees the links the site sees and not what a regular expression
 * makes of the markdown.
 */
export function richtextLinks(_siteId: string, markdown: string): string[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const found: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === 'link') found.push(node.url);
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Every attribute value is editor text, so it is escaped here rather than trusted to
// arrive clean — a heading's slug included.
const escapeAttribute = (value: string) => escapeHtml(value).replace(/"/g, '&quot;');

/**
 * Richtext as HTML. Astro's own Markdown pipeline is a native binary the Workers runtime
 * cannot run, and a hast pipeline in its place costs ~20 KiB gzip of a Worker bundle
 * already at 16% of the limit, so the closed construct list is emitted straight from the
 * mdast the tier check already parses. A node the tiers disallow — raw HTML above all —
 * contributes escaped text and never markup, so this output is safe to set as HTML.
 */
export function renderRichtext(_siteId: string, markdown: string): string {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const slugger = new GithubSlugger();

  const render = (node: Nodes, tight = false): string => {
    const kids = (separator = '') =>
      'children' in node ? node.children.map((child) => render(child, tight)).join(separator) : '';
    switch (node.type) {
      case 'root':
        return kids('\n');
      case 'paragraph':
        return tight ? kids() : `<p>${kids()}</p>`;
      case 'heading':
        return `<h${node.depth} id="${escapeAttribute(slugger.slug(textOf(node)))}">${kids()}</h${node.depth}>`;
      case 'blockquote':
        // Not `kids`: a quote's own paragraphs are paragraphs even inside a tight list.
        return `<blockquote>\n${node.children.map((child) => render(child)).join('\n')}\n</blockquote>`;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const items = node.children
          .map((item) => render(item, !node.spread && !item.spread))
          .join('\n');
        return `<${tag}>\n${items}\n</${tag}>`;
      }
      case 'listItem':
        return `<li>${kids('\n')}</li>`;
      case 'strong':
        return `<strong>${kids()}</strong>`;
      case 'emphasis':
        return `<em>${kids()}</em>`;
      case 'link':
        // A file written outside the CMS never passed the tier check, so the target is
        // read again here and a link that would run code keeps only its text.
        return unsafeLinkScheme(_siteId, node.url)
          ? kids()
          : `<a href="${escapeAttribute(node.url)}">${kids()}</a>`;
      case 'break':
        return '<br>';
      case 'text':
        return escapeHtml(node.value);
      default:
        return 'children' in node
          ? kids()
          : escapeHtml('value' in node && typeof node.value === 'string' ? node.value : '');
    }
  };
  return render(tree);
}
