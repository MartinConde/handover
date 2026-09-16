<script lang="ts">
import { type Field, type Form, formIn, labelIn } from '@handover/core';
import { untrack } from 'svelte';
import type {
  EntrySession,
  FieldCommandResult,
  ListCommandResult,
} from '../editor/entry-session.svelte';
import Fields from '../editor/fields/Fields.svelte';
import { formatLanguageName, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { sitePath } from '../request';
import CanvasIcon from './CanvasIcon.svelte';
import type { CanvasDocumentIdentity, CanvasSelection } from './canvas-bridge';

let {
  selection,
  selectionLabel,
  context,
  mediaPickerRequest = 0,
  blockInspection,
  entryDocument,
  ownerLabel,
  locale,
  uiLocale = 'en',
  sourceLocale,
  session,
  blocks,
  blockLabels,
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
  uiLocale?: UiLocale;
  sourceLocale: string;
  session: EntrySession;
  blocks: Record<string, Field[]>;
  blockLabels?: Form['blockLabels'];
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
const options = $derived(messageOptions(uiLocale));
const shownFields = $derived(
  formIn(
    { fields: blockInspection?.fields ?? (inspected ? [inspected.field] : []), blocks: {} },
    uiLocale,
  ).fields,
);
const fieldLabel = $derived(
  labelIn(resolvedTarget?.field.labels, uiLocale) ||
    resolvedTarget?.field.label ||
    resolvedTarget?.field.path.at(-1) ||
    m.canvas_content({}, options),
);
const heading = $derived(
  sameDocument
    ? blockInspection
      ? (labelIn(blockLabels?.[blockInspection.type], uiLocale) ?? blockInspection.type)
      : fieldLabel
    : selection.target.document.id,
);
const fieldType = $derived.by(() => {
  if (blockInspection) return m.canvas_type_block({}, options);
  if (!resolvedTarget)
    return selection.target.document.collection === 'globals'
      ? m.canvas_type_shared({}, options)
      : m.canvas_type_entry({}, options);
  switch (resolvedTarget.field.type) {
    case 'text':
      return m.canvas_type_text({}, options);
    case 'richtext':
      return m.canvas_type_richtext({}, options);
    case 'number':
      return m.canvas_type_number({}, options);
    case 'boolean':
      return m.canvas_type_boolean({}, options);
    case 'date':
      return m.canvas_type_date({}, options);
    case 'select':
      return m.canvas_type_select({}, options);
    case 'link':
      return m.canvas_type_link({}, options);
    case 'image':
      return m.canvas_type_image({}, options);
    case 'file':
      return m.canvas_type_file({}, options);
    case 'embed':
      return m.canvas_type_embed({}, options);
    case 'seo':
      return m.canvas_type_seo({}, options);
    case 'menus':
      return m.canvas_type_menus({}, options);
    case 'reference':
      return m.canvas_type_reference({}, options);
    case 'group':
      return m.canvas_type_group({}, options);
    case 'array':
      return m.canvas_type_array({}, options);
    case 'blocks':
      return m.canvas_type_blocks({}, options);
    case 'unsupported':
      return m.canvas_type_unsupported({}, options);
  }
});
const imageField = $derived(
  !blockInspection && resolvedTarget && ['image', 'file'].includes(resolvedTarget.field.type),
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
const refusalText = $derived.by(() => {
  if (refusal === 'stale') return m.canvas_action_stale({}, options);
  if (refusal === 'deleted') return m.canvas_action_deleted({}, options);
  if (refusal === 'readonly' || refusal === 'closed') return m.canvas_action_readonly({}, options);
  return m.canvas_action_structure_changed({}, options);
});
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
      <span class="canvas-selection-icon"><CanvasIcon name={imageField ? 'image' : selection.kind === 'field' ? 'text' : 'block'} /></span>
      <div>
        <span class="canvas-inspector-kicker">{m.canvas_inspector({}, options)} · {fieldType}</span>
        <h2 id="canvas-inspector-heading">{selectionLabel || heading}</h2>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm" type="button" aria-label={m.canvas_close_inspector({}, options)} onclick={onclose}><CanvasIcon name="collapse-right" /></button>
  </header>
  {#if context}<p class="canvas-inspector-context" title={context}>{context}</p>{/if}

  {#if !sameDocument}
    <div class="canvas-inspector-message">
      <p>{m.canvas_other_editor({}, options)}</p>
      <a class="btn btn-primary" href={ownerHref}>
        {selection.target.document.collection === 'globals' ? m.canvas_edit_shared({}, options) : m.canvas_open_entry({}, options)} ↗
      </a>
    </div>
  {:else if inspected || blockInspection}
    {#if locked}
      <p class="notice notice-danger" role="status">{m.canvas_inspector_locked({}, options)}</p>
    {/if}
    {#if refusal}
      <p class="notice notice-danger" role="alert">{refusalText}</p>
    {/if}
    <form
      class="form canvas-inspector-form"
      onsubmit={(event) => event.preventDefault()}
      use:completionEvents
    >
      <fieldset disabled={mutationBlocked}>
        {#key widgetKey}
          <Fields
            fields={shownFields}
            root={session.snapshot(locale)}
            path={blockInspection?.path ?? parentPath}
            {blocks}
            {blockLabels}
            {problems}
            {mediaBase}
            {locale}
            {uiLocale}
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
      <p>{m.canvas_select_block_field({}, options)}</p>
    </div>
  {/if}
  <div class="canvas-inspector-owner">
    <span class="visually-hidden">{m.canvas_owned_by({}, options)}</span>
    <strong>{sameDocument ? ownerLabel : `${selection.target.document.collection}/${selection.target.document.id}`} · {formatLanguageName(selection.target.locale, uiLocale)}</strong>
  </div>
</aside>
