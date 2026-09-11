<script lang="ts">
import type { Field } from '@handover/core';
import { untrack } from 'svelte';
import CanvasIcon from './CanvasIcon.svelte';
import type { CanvasDocumentIdentity, CanvasSelection } from './canvas-bridge';
import type {
  EntrySession,
  FieldCommandResult,
  ListCommandResult,
} from '../editor/entry-session.svelte';
import Fields from '../editor/fields/Fields.svelte';
import { sitePath } from '../request';

let {
  selection,
  selectionLabel,
  context,
  mediaPickerRequest = 0,
  blockInspection,
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
}: {
  selection: CanvasSelection;
  selectionLabel?: string;
  context?: string;
  /** A changing request opens the selected image's library directly from the Canvas overlay. */
  mediaPickerRequest?: number;
  blockInspection?: { fields: Field[]; path: string[]; type: string };
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
  onschedule: (policy: 'continuous' | 'discrete') => void;
  onclose: () => void;
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
const heading = $derived(
  sameDocument ? (blockInspection?.type ?? fieldLabel) : selection.target.document.id,
);
const fieldType = $derived(
  blockInspection
    ? 'Block'
    : resolvedTarget
      ? `${resolvedTarget.field.type.charAt(0).toUpperCase()}${resolvedTarget.field.type.slice(1)}`
      : selection.target.document.collection === 'globals'
        ? 'Shared'
        : 'Entry',
);
const widgetKey = $derived.by(() => {
  if (!sameDocument) return '';
  const ownerAddress = blockInspection ? selection.target.address : inspected?.address;
  if (!ownerAddress) return '';
  return JSON.stringify([
    selection.target.document.collection,
    selection.target.document.id,
    locale,
    ownerAddress,
  ]);
});

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
  if (result.ok) queueCompletion();
}

function completed(policy: 'continuous' | 'discrete') {
  const next = session.contentVersion(locale);
  if (next === completedVersion) return;
  completedVersion = next;
  onschedule(policy);
}

let completionQueued = false;
let completionPolicy: 'continuous' | 'discrete' | undefined;
function queueCompletion(policy?: 'continuous' | 'discrete') {
  if (policy === 'discrete' || (policy === 'continuous' && !completionPolicy))
    completionPolicy = policy;
  if (completionQueued) return;
  completionQueued = true;
  queueMicrotask(() => {
    completionQueued = false;
    const nextPolicy = completionPolicy ?? 'discrete';
    completionPolicy = undefined;
    completed(nextPolicy);
  });
}

function completionEvents(node: HTMLFormElement) {
  const continuous = () => queueCompletion('continuous');
  const discrete = () => queueCompletion('discrete');
  node.addEventListener('input', continuous);
  node.addEventListener('click', discrete);
  node.addEventListener('change', discrete);
  return {
    destroy() {
      node.removeEventListener('input', continuous);
      node.removeEventListener('click', discrete);
      node.removeEventListener('change', discrete);
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
    <div class="canvas-inspector-title">
      <span class="canvas-selection-icon"><CanvasIcon name={['Image', 'File'].includes(fieldType) ? 'image' : selection.kind === 'field' ? 'text' : 'block'} /></span>
      <div>
        <span class="canvas-inspector-kicker">Inspector · {fieldType === 'Richtext' ? 'Rich text' : fieldType}</span>
        <h2 id="canvas-inspector-heading">{selectionLabel || heading}</h2>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm" type="button" aria-label="Close Inspector" onclick={onclose}><CanvasIcon name="collapse-right" /></button>
  </header>
  {#if context}<p class="canvas-inspector-context" title={context}>{context}</p>{/if}

  {#if !sameDocument}
    <div class="canvas-inspector-message">
      <p>This content belongs to another editor. Its source cannot be changed through this page.</p>
      <a class="btn btn-primary" href={ownerHref}>
        {selection.target.document.collection === 'globals' ? 'Edit shared content' : 'Open entry'} ↗
      </a>
    </div>
  {:else if inspected || blockInspection}
    {#if locked}
      <p class="notice notice-danger" role="status">Editing is disabled because this entry is locked.</p>
    {/if}
    {#if refusal}
      <p class="notice notice-danger" role="alert">This change was not applied ({refusal}).</p>
    {/if}
    <form
      class="form canvas-inspector-form"
      onsubmit={(event) => event.preventDefault()}
      use:completionEvents
    >
      <fieldset disabled={mutationBlocked}>
        {#key widgetKey}
          <Fields
            fields={blockInspection?.fields ?? (inspected ? [inspected.field] : [])}
            root={session.snapshot(locale)}
            path={blockInspection?.path ?? parentPath}
            {blocks}
            {problems}
            {mediaBase}
            {locale}
            {site}
            {servedAt}
            {session}
            translating={translating}
            inherited={inspected?.mode ?? true}
            prefix="canvas-inspector"
            openMediaPicker={mediaPickerRequest}
            oncommand={command}
            structureLocked={session.structureMutationBlocked()}
            textOnly={session.sourceTextOnly(locale)}
          />
        {/key}
      </fieldset>
    </form>
  {:else}
    <div class="canvas-inspector-message">
      <p>Select a field inside this block to edit its content.</p>
    </div>
  {/if}
  <div class="canvas-inspector-owner">
    <span class="visually-hidden">Owned by</span>
    <strong>{sameDocument ? ownerLabel : `${selection.target.document.collection}/${selection.target.document.id}`} · {language(selection.target.locale)}</strong>
  </div>
</aside>
