import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

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
    else if (node.type === 'listItem' && typeof node.checked === 'boolean')
      errors.push(`task list item is not allowed${at}`);
    else if (!BASIC_NODES.has(node.type) && !FULL_ONLY_NODES.has(node.type))
      errors.push(`${node.type} is not allowed${at}`);
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return errors;
}
