<script lang="ts" module>
/** A third language shown under each translated field; `values` and `rows` are `referenceText`'s. */
export type Reference = {
  locale: string;
  label: string;
  values: Record<string, string>;
  rows: string[];
};
</script>

<script lang="ts">
import type { RichtextTier } from '@handover/core';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { DOMSerializer, Node } from '@tiptap/pm/model';
import { messageOptions, type UiLocale } from '../../i18n.js';
import * as m from '../../paraglide/messages.js';
import { richTextExtensions } from './rich-text-kit';

let {
  reference,
  path,
  tier,
  uiLocale = 'en',
}: {
  reference: Reference;
  /** The core address, so a row found by `_id` stays matched however the rows are ordered. */
  path: string;
  /** Set for rich text, which is rendered through the editor's own schema. */
  tier?: RichtextTier;
  uiLocale?: UiLocale;
} = $props();

const options = $derived(messageOptions(uiLocale));
// Every `[…]` closes a row the path passes through; the reference must have each of them.
const missingRow = $derived(
  [...path.matchAll(/\]/g)].some(
    (close) => !reference.rows.includes(path.slice(0, (close.index ?? 0) + 1)),
  ),
);
const text = $derived(missingRow ? undefined : reference.values[path]);

// The schema drops what the editor could not hold; a link loses its href so it is no tab stop.
function render(node: HTMLElement, markdown: string, of: RichtextTier) {
  const extensions = richTextExtensions(of);
  const schema = getSchema(extensions);
  const doc = Node.fromJSON(schema, new MarkdownManager({ extensions }).parse(markdown));
  node.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  for (const link of Array.from(node.querySelectorAll('a'))) link.removeAttribute('href');
}
</script>

<div class={['reference-peek', { 'is-empty': text === undefined }]}>
  <span class="reference-lang">{reference.label}</span>
  {#if text === undefined}
    <span>{missingRow ? m.translation_reference_no_row({ language: reference.label }, options) : m.translation_reference_empty({ language: reference.label }, options)}</span>
  {:else if tier}
    {@const markdown = text}
    <div lang={reference.locale} {@attach (node) => render(node, markdown, tier)}></div>
  {:else}
    <span lang={reference.locale}>{text}</span>
  {/if}
</div>
