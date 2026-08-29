<script lang="ts">
// The only file that imports TipTap. Value in and out is Markdown; the tier decides which
// extensions exist, so a paste is sanitised to the tier by the schema itself.
import type { RichtextTier } from '@handover/core';
import { richtextErrors } from '@handover/core';
import { Editor } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Document } from '@tiptap/extension-document';
import { Heading } from '@tiptap/extension-heading';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { onMount } from 'svelte';
import PagePicker from './PagePicker.svelte';

let {
  id,
  labelId,
  tier,
  value,
  locale = '',
  invalid = false,
  describedby,
  onchange,
}: {
  id: string;
  labelId: string;
  tier: RichtextTier;
  value: string;
  /** The language being written: a link to an entry points at the page that language serves. */
  locale?: string;
  /** The schema will not accept what is in here; the message sits under the field. */
  invalid?: boolean;
  describedby?: string;
  onchange: (markdown: string) => void;
} = $props();

// svelte-ignore state_referenced_locally -- decided once on load; TipTap would silently drop the content
const foreign = richtextErrors('default', value, tier).length > 0;

const BASIC = [
  { label: 'Bold', mark: 'bold', run: (e: Editor) => e.chain().focus().toggleBold().run() },
  { label: 'Italic', mark: 'italic', run: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { label: 'Link', mark: 'link', run: (e: Editor) => toggleLink(e) },
  {
    label: 'Bullet list',
    mark: 'bulletList',
    run: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    mark: 'orderedList',
    run: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
];
const FULL = [
  {
    label: 'Heading 2',
    mark: 'heading',
    attrs: { level: 2 },
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Heading 3',
    mark: 'heading',
    attrs: { level: 3 },
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: 'Quote',
    mark: 'blockquote',
    run: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
];
// svelte-ignore state_referenced_locally -- the tier is fixed per field
const buttons = tier === 'full' ? [...BASIC, ...FULL] : BASIC;

// Where a link points is chosen in the page picker, so a target the site would refuse is
// refused while it is being typed rather than on the way to the repository.
let linking = $state(false);
function toggleLink(e: Editor) {
  if (e.isActive('link')) return e.chain().focus().unsetLink().run();
  linking = true;
  return true;
}
// With nothing selected there are no words to link, so the page's title becomes them.
function linkTo(href: string, text = href) {
  linking = false;
  if (!editor) return;
  if (editor.state.selection.empty)
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
      .run();
  else editor.chain().focus().setLink({ href }).run();
}

let element = $state<HTMLDivElement>();
let editor = $state<Editor>();

// TipTap fixes the editable node's attributes when it is built, so the two that change with
// the entry's problems are written onto the node itself.
$effect(() => {
  const body = editor?.view.dom;
  if (!body) return;
  for (const [name, value] of [
    ['aria-invalid', invalid ? 'true' : undefined],
    ['aria-describedby', describedby],
  ] as const) {
    if (value) body.setAttribute(name, value);
    else body.removeAttribute(name);
  }
});

// Bumped on every transaction so `isActive` re-runs; the Editor itself is not reactive.
let tick = $state(0);

onMount(() => {
  if (foreign || !element) return;
  const extensions = [
    Document,
    Paragraph,
    Text,
    Bold,
    Italic,
    Link.configure({ openOnClick: false }),
    BulletList,
    OrderedList,
    ListItem,
    UndoRedo,
    Markdown,
    ...(tier === 'full' ? [Heading.configure({ levels: [2, 3] }), Blockquote] : []),
  ];
  const e = new Editor({
    element,
    extensions,
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        id,
        'aria-labelledby': labelId,
        'aria-multiline': 'true',
        class: 'input rte-body',
      },
    },
    onTransaction: () => {
      tick += 1;
    },
    onUpdate: ({ editor }) => onchange(editor.getMarkdown()),
  });
  editor = e;
  return () => e.destroy();
});

const active = (b: { mark: string; attrs?: Record<string, unknown> }) =>
  tick >= 0 && editor ? editor.isActive(b.mark, b.attrs) : false;
</script>

{#if foreign}
  <div class="readonly" role="region" aria-labelledby={labelId} aria-describedby="{id}-hint"><pre {id}>{value}</pre></div>
  <p class="hint" id="{id}-hint">This text was edited in code and uses formatting the editor can’t change. Ask your developer.</p>
{:else}
  <div class="rte" role="group" aria-labelledby={labelId}>
    <div class="rte-toolbar" role="toolbar" aria-label="Formatting">
      {#each buttons as b (b.label)}
        <button type="button" aria-label={b.label} aria-pressed={active(b)} disabled={!editor} onclick={() => editor && b.run(editor)}>{b.label}</button>
      {/each}
    </div>
    <div bind:this={element}></div>
    {#if linking}
      <PagePicker id="{id}-link" label="pages and entries to link to" labelId={labelId} {locale} onpick={(entry) => linkTo(entry.urls[locale] ?? '', entry.title)} onurl={linkTo} onclose={() => (linking = false)} />
    {/if}
  </div>
{/if}
