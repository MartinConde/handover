<script lang="ts">
import type { Field } from '@handover/core';
import { type Snippet, tick, untrack } from 'svelte';
import CanvasIcon from './CanvasIcon.svelte';
import type { CanvasDocumentIdentity, CanvasSelection, CanvasTarget } from './canvas-bridge';
import type { EntrySession, FieldCommandResult, ListCommandResult } from './entry-session.svelte';
import Fields from './Fields.svelte';
import { sitePath } from './request';

let {
  selection,
  selectionLabel,
  inlineRichtext = false,
  context,
  blockActions,
  entryDocument,
  ownerLabel,
  locale,
  sourceLocale,
  session,
  blocks,
  problems = {},
  mediaBase = '',
  site,
  servedAt,
  locked = false,
  onschedule,
  onclose,
  onform,
}: {
  selection: CanvasSelection;
  selectionLabel?: string;
  inlineRichtext?: boolean;
  context?: string;
  blockActions?: Snippet;
  entryDocument: CanvasDocumentIdentity;
  ownerLabel: string;
  locale: string;
  sourceLocale: string;
  session: EntrySession;
  blocks: Record<string, Field[]>;
  problems?: Record<string, string>;
  mediaBase?: string;
  site?: string;
  servedAt?: string;
  locked?: boolean;
  onschedule: () => void;
  onclose: () => void;
  onform: (target: CanvasTarget) => void;
} = $props();

const sameDocument = $derived(
  selection.target.document.collection === entryDocument.collection &&
    selection.target.document.id === entryDocument.id,
);
const resolved = $derived(
  sameDocument && selection.kind === 'field'
    ? session.inspectField(locale, selection.target.address)
    : undefined,
);
const resolvedTarget = $derived(resolved?.ok ? resolved.target : undefined);
const inspected = $derived(
  resolvedTarget?.field.type === 'unsupported' ? undefined : resolvedTarget,
);
const parentPath = $derived(
  inspected ? inspected.path.slice(0, inspected.path.length - inspected.field.path.length) : [],
);
const translating = $derived(locale !== sourceLocale);
const mutationBlocked = $derived(locked || session.localeMutationBlocked(locale));
const fieldLabel = $derived(
  resolvedTarget?.field.label || resolvedTarget?.field.path.at(-1) || 'Content',
);
const heading = $derived(sameDocument ? fieldLabel : selection.target.document.id);
const fieldType = $derived(
  resolvedTarget
    ? `${resolvedTarget.field.type.charAt(0).toUpperCase()}${resolvedTarget.field.type.slice(1)}`
    : selection.target.document.collection === 'globals'
      ? 'Shared'
      : 'Entry',
);

const language = (value: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(value) ?? value;
  } catch {
    return value;
  }
};

const ownerHref = $derived.by(() => {
  const owner = selection.target.document;
  const route =
    owner.collection === 'globals'
      ? `/admin/site/${encodeURIComponent(owner.id)}`
      : `/admin/c/${encodeURIComponent(owner.collection)}/${encodeURIComponent(owner.id)}`;
  const query = new URLSearchParams({
    field: selection.target.address,
    locale: selection.target.locale,
  });
  return sitePath(`${route}?${query}`);
});

let refusal = $state('');
let completedVersion = -1;
$effect(() => {
  selection.target.address;
  locale;
  untrack(() => {
    completedVersion = session.contentVersion(locale);
    refusal = '';
  });
});

function command(result: FieldCommandResult | ListCommandResult) {
  refusal = result.ok ? '' : result.reason;
}

async function completed() {
  await tick();
  const next = session.contentVersion(locale);
  if (next === completedVersion) return;
  completedVersion = next;
  onschedule();
}

function completionEvents(node: HTMLFormElement) {
  const done = () => void completed();
  node.addEventListener('click', done);
  node.addEventListener('change', done);
  return {
    destroy() {
      node.removeEventListener('click', done);
      node.removeEventListener('change', done);
    },
  };
}
</script>

<aside
  class="canvas-inspector"
  id="canvas-inspector"
  aria-labelledby="canvas-inspector-heading"
>
  <header>
    <h2 id="canvas-inspector-heading">Inspector</h2>
    <button class="btn btn-ghost btn-sm" type="button" aria-label="Close Inspector" onclick={onclose}><CanvasIcon name="collapse-right" /></button>
  </header>
  <div class="canvas-inspector-selection">
    <span class="canvas-selection-icon"><CanvasIcon name={['Image', 'File'].includes(fieldType) ? 'image' : selection.kind === 'field' ? 'text' : 'block'} /></span>
    <div><h3>{selectionLabel || heading}</h3><span>{fieldType === 'Richtext' ? 'Rich text' : fieldType}</span></div>
  </div>
  {#if context}<p class="canvas-inspector-context">{context}</p>{/if}

  {#if !sameDocument}
    <div class="canvas-inspector-message">
      <p>This content belongs to another editor. Its source cannot be changed through this page.</p>
      <a class="btn btn-primary" href={ownerHref}>
        {selection.target.document.collection === 'globals' ? 'Edit shared content' : 'Open entry'} ↗
      </a>
    </div>
  {:else if inspected}
    {#if locked}
      <p class="notice notice-danger" role="status">Editing is disabled because this entry is locked.</p>
    {/if}
    {#if refusal}
      <p class="notice notice-danger" role="alert">This change was not applied ({refusal}).</p>
    {/if}
    {#if inlineRichtext}
      <div class="canvas-inspector-message"><strong>Content</strong><p>Double-click text on the canvas to edit it.</p>
        <button class="btn btn-sm" type="button" onclick={() => onform(selection.target)}>Open in form <CanvasIcon name="external" /></button>
      </div>
    {/if}
    <details class="canvas-field-details" class:is-collapsible={inlineRichtext} open={!inlineRichtext}>
      <summary>Edit in Inspector</summary>
    <form
      class="form canvas-inspector-form"
      onsubmit={(event) => event.preventDefault()}
      use:completionEvents
    >
      <fieldset disabled={mutationBlocked}>
        <Fields
          fields={[inspected.field]}
          root={session.snapshot(locale)}
          path={parentPath}
          {blocks}
          {problems}
          {mediaBase}
          {locale}
          {site}
          {servedAt}
          {session}
          translating={translating}
          inherited={inspected.mode}
          prefix="canvas-inspector"
          oncommand={command}
          structureLocked={session.structureMutationBlocked()}
          textOnly={session.sourceTextOnly(locale)}
        />
      </fieldset>
    </form>
    </details>
  {:else}
    <div class="canvas-inspector-message">
      <p>Select a field inside this block to edit its content, or open it in the form.</p>
      <button class="btn btn-sm" type="button" onclick={() => onform(selection.target)}>Edit in Form</button>
    </div>
  {/if}
  {@render blockActions?.()}
  <div class="canvas-inspector-owner">
    <span class="visually-hidden">Owned by</span>
    <strong>{sameDocument ? ownerLabel : `${selection.target.document.collection}/${selection.target.document.id}`} · {language(selection.target.locale)}</strong>
  </div>
</aside>
