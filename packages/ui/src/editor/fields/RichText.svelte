<script lang="ts">
// Form and the lazy Canvas surface share the tier extensions that sanitize prose input.
import type { RichtextTier } from '@handover/core';
import { richtextErrors } from '@handover/core';
import { Editor, Extension } from '@tiptap/core';
import type { Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { onMount, untrack } from 'svelte';
import PagePicker from '../../PagePicker.svelte';
import type {
  EntrySession,
  FieldCommandResult,
  FieldHistory,
  LogicalSelection,
} from '../entry-session.svelte';
import { proseSelection, restoreProseSelection, richTextExtensions } from './rich-text-kit';

let {
  id,
  labelId,
  tier,
  value,
  locale = '',
  invalid = false,
  describedby,
  address = '',
  session,
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
  /** Stable owner of this prose field; required when the entry session owns history. */
  address?: string;
  session?: EntrySession;
  onchange: (markdown: string, history?: FieldHistory) => FieldCommandResult | undefined;
} = $props();

const logical = (selection: Selection): LogicalSelection | undefined =>
  session && address
    ? {
        document: session.documentIdentity(),
        locale,
        address,
        ...proseSelection(selection),
      }
    : undefined;

const matches = (selection: LogicalSelection | undefined) =>
  selection !== undefined &&
  selection.document === session?.documentIdentity() &&
  selection.locale === locale &&
  selection.address === address;

function logicalFromDom(view: EditorView): LogicalSelection | undefined {
  const selection = view.dom.ownerDocument.getSelection();
  const anchorNode = selection?.anchorNode;
  const focusNode = selection?.focusNode;
  if (
    !session ||
    !address ||
    !selection ||
    !anchorNode ||
    !focusNode ||
    !view.dom.contains(anchorNode) ||
    !view.dom.contains(focusNode)
  )
    return undefined;
  try {
    return {
      document: session.documentIdentity(),
      locale,
      address,
      kind: 'text',
      anchor: view.posAtDOM(anchorNode, selection.anchorOffset),
      head: view.posAtDOM(focusNode, selection.focusOffset),
    };
  } catch {
    return undefined;
  }
}

// svelte-ignore state_referenced_locally -- initialized once to avoid dropping content
const foreign = richtextErrors('default', value, tier).length > 0;

const BASIC = [
  {
    label: 'Bold',
    mark: 'bold',
    run: (e: Editor) => formatted(() => e.chain().focus().toggleBold().run()),
  },
  {
    label: 'Italic',
    mark: 'italic',
    run: (e: Editor) => formatted(() => e.chain().focus().toggleItalic().run()),
  },
  { label: 'Link', mark: 'link', run: (e: Editor) => toggleLink(e) },
  {
    label: 'Bullet list',
    mark: 'bulletList',
    run: (e: Editor) => formatted(() => e.chain().focus().toggleBulletList().run()),
  },
  {
    label: 'Numbered list',
    mark: 'orderedList',
    run: (e: Editor) => formatted(() => e.chain().focus().toggleOrderedList().run()),
  },
];
const FULL = [
  {
    label: 'Heading 2',
    mark: 'heading',
    attrs: { level: 2 },
    run: (e: Editor) => formatted(() => e.chain().focus().toggleHeading({ level: 2 }).run()),
  },
  {
    label: 'Heading 3',
    mark: 'heading',
    attrs: { level: 3 },
    run: (e: Editor) => formatted(() => e.chain().focus().toggleHeading({ level: 3 }).run()),
  },
  {
    label: 'Quote',
    mark: 'blockquote',
    run: (e: Editor) => formatted(() => e.chain().focus().toggleBlockquote().run()),
  },
];
// svelte-ignore state_referenced_locally -- the tier is fixed per field
const buttons = tier === 'full' ? [...BASIC, ...FULL] : BASIC;

// A target the site would refuse is refused while typed, not on the way to the repository.
let linking = $state(false);
let nextIntent: FieldHistory['kind'];
let composition = '';
let compositionNumber = 0;
let reconciling = false;
let pendingBefore: LogicalSelection | undefined;
let previousSelection: LogicalSelection | undefined;
let reconcileTick = $state(0);

function formatted(run: () => boolean) {
  session?.historyBoundary();
  nextIntent = 'format';
  try {
    return run();
  } finally {
    nextIntent = undefined;
  }
}

function toggleLink(e: Editor) {
  if (e.isActive('link')) return formatted(() => e.chain().focus().unsetLink().run());
  session?.historyBoundary();
  linking = true;
  return true;
}
// With nothing selected there are no words to link, so the page's title becomes them.
function linkTo(href: string, text = href) {
  linking = false;
  if (!editor) return;
  if (editor.state.selection.empty)
    formatted(
      () =>
        editor
          ?.chain()
          .focus()
          .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
          .run() ?? false,
    );
  else formatted(() => editor?.chain().focus().setLink({ href }).run() ?? false);
}

let element = $state<HTMLDivElement>();
let editor = $state<Editor>();

function replay(direction: 'redo' | 'undo') {
  if (!session) return false;
  if (direction === 'undo') session.undo();
  else session.redo();
  // The session owns history even when the stack is empty or frozen. Never let the browser
  // mutate the contenteditable DOM through a second, private undo path.
  return true;
}

const SessionHistory = Extension.create({
  name: 'handoverSessionHistory',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => replay('undo'),
      'Mod-Shift-z': () => replay('redo'),
      'Mod-y': () => replay('redo'),
    };
  },
});

function reconcile(e: Editor, next: string, wanted: LogicalSelection | undefined) {
  if (composition || reconciling) return;
  const current = logical(e.state.selection);
  const restore = matches(wanted) ? wanted : current;
  reconciling = true;
  try {
    if (e.getMarkdown() !== next)
      e.commands.setContent(next, { contentType: 'markdown', emitUpdate: false });
    if (restore) {
      const selection = restoreProseSelection(e.state.doc, {
        kind: restore.kind ?? 'text',
        anchor: restore.anchor ?? 0,
        head: restore.head ?? restore.anchor ?? 0,
      });
      if (selection && !selection.eq(e.state.selection))
        e.view.dispatch(e.state.tr.setSelection(selection));
    }
  } finally {
    reconciling = false;
  }
}

// TipTap fixes the editable node's attributes on build, so the changing two are written directly.
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

$effect(() => {
  reconcileTick;
  tick;
  const e = editor;
  const next = value;
  const selection = session?.historySelection();
  if (e) untrack(() => reconcile(e, next, selection));
});

onMount(() => {
  if (foreign || !element) return;
  const e = new Editor({
    element,
    extensions: richTextExtensions(tier, [SessionHistory]),
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        id,
        'aria-labelledby': labelId,
        'aria-multiline': 'true',
        class: 'input rte-body',
      },
      handleDOMEvents: {
        beforeinput: (view, event) => {
          const intent = event as InputEvent;
          const direction =
            intent.inputType === 'historyUndo'
              ? 'undo'
              : intent.inputType === 'historyRedo'
                ? 'redo'
                : undefined;
          if (!direction) {
            pendingBefore = logicalFromDom(view) ?? logical(view.state.selection);
            return false;
          }
          if (!session) return false;
          event.preventDefault();
          replay(direction);
          return true;
        },
        compositionstart: (view) => {
          session?.historyBoundary();
          pendingBefore = logicalFromDom(view) ?? logical(view.state.selection);
          composition = `${id}:${++compositionNumber}`;
          return false;
        },
        compositionend: () => {
          const ended = composition;
          queueMicrotask(() => {
            if (composition !== ended) return;
            composition = '';
            session?.historyBoundary();
            reconcileTick += 1;
          });
          return false;
        },
      },
    },
    onTransaction: ({ editor, transaction }) => {
      tick += 1;
      if (transaction.docChanged && !reconciling && !pendingBefore)
        pendingBefore = previousSelection;
      previousSelection = logical(editor.state.selection);
    },
    onSelectionUpdate: ({ editor, transaction }) => {
      if (!reconciling && !transaction.docChanged)
        session?.setHistorySelection(logical(editor.state.selection));
    },
    onPaste: () => {
      session?.historyBoundary();
      if (editor) pendingBefore = logicalFromDom(editor.view) ?? logical(editor.state.selection);
      nextIntent = 'paste';
      queueMicrotask(() => {
        if (nextIntent === 'paste') nextIntent = undefined;
      });
    },
    onBlur: () => session?.historyBoundary(),
    onUpdate: ({ editor }) => {
      if (reconciling) return;
      const after = logical(editor.state.selection);
      const kind = composition ? 'composition' : (nextIntent ?? 'typing');
      onchange(editor.getMarkdown(), {
        kind,
        ...(composition ? { group: composition } : {}),
        before: pendingBefore,
        after,
      });
      pendingBefore = undefined;
      nextIntent = undefined;
    },
  });
  previousSelection = logical(e.state.selection);
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
        <button type="button" aria-label={b.label} aria-pressed={active(b)} disabled={!editor} onclick={() => editor && b.run(editor)} title={b.label}>
          {#if b.mark === 'bold'}<strong aria-hidden="true">B</strong>
          {:else if b.mark === 'italic'}<em aria-hidden="true">I</em>
          {:else if b.mark === 'heading'}<span class="heading-tool" aria-hidden="true">H{b.label.endsWith('2') ? '2' : '3'}</span>
          {:else if b.mark === 'link'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></svg>
          {:else if b.mark === 'bulletList' || b.mark === 'orderedList'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/>{#if b.mark === 'bulletList'}<path d="M3 6h.1M3 12h.1M3 18h.1" stroke-width="3"/>{:else}<path d="M2 4h1v5M2 13c3-2 4 1 0 5h3"/>{/if}</svg>
          {:else}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h5v6H4zm11 0h5v6h-5zM9 13c0 4-2 5-4 5m15-5c0 4-2 5-4 5"/></svg>{/if}
        </button>
      {/each}
    </div>
    <div bind:this={element}></div>
    {#if linking}
      <PagePicker id="{id}-link" label="pages and entries to link to" labelId={labelId} {locale} onpick={(entry) => linkTo(entry.urls[locale] ?? '', entry.title)} onurl={linkTo} onclose={() => (linking = false)} />
    {/if}
  </div>
{/if}
