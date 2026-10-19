import type { RichtextTier } from '@handover/core';
import type { Extensions } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Markdown } from '@tiptap/markdown';
import { NodeSelection, type Selection, TextSelection } from '@tiptap/pm/state';

export interface ProseSelection {
  kind: 'node' | 'text';
  anchor: number;
  head: number;
}

/** Form and Canvas intentionally use one TipTap schema and Markdown serializer. */
export const richTextExtensions = (tier: RichtextTier, additional: Extensions = []): Extensions => [
  Document,
  // A backslash with nothing after it in the block reads back as a literal backslash.
  Paragraph.extend({
    renderMarkdown: (node, h, ctx) => {
      const content = [...(node.content ?? [])];
      while (content.at(-1)?.type === 'hardBreak') content.pop();
      return Paragraph.config.renderMarkdown?.({ ...node, content }, h, ctx) ?? '';
    },
  }),
  Text,
  // The file writer drops trailing spaces, so the default two-space break would not survive a save.
  // A heading is one line in Markdown, so a break there becomes a space.
  HardBreak.extend({
    renderMarkdown: (_node, _h, ctx) => (ctx.parentType === 'heading' ? ' ' : '\\\n'),
  }),
  Bold,
  Italic,
  Link.configure({ openOnClick: false }),
  BulletList,
  OrderedList,
  ListItem,
  ...additional,
  Markdown,
  ...(tier === 'full' ? [Heading.configure({ levels: [2, 3] }), Blockquote] : []),
];

export const proseSelection = (selection: Selection): ProseSelection => ({
  kind: selection instanceof NodeSelection ? 'node' : 'text',
  anchor: selection.anchor,
  head: selection.head,
});

export function restoreProseSelection(
  doc: Parameters<typeof TextSelection.between>[0]['doc'],
  selection: ProseSelection,
): Selection {
  const max = doc.content.size;
  const anchor = Math.max(0, Math.min(max, selection.anchor));
  const head = Math.max(0, Math.min(max, selection.head));
  if (selection.kind === 'node') {
    const node = doc.nodeAt(anchor);
    if (node && NodeSelection.isSelectable(node)) return NodeSelection.create(doc, anchor);
  }
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}
