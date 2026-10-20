<script lang="ts">
import * as m from '../../paraglide/messages.js';
import type { FieldLevel } from './field-level.js';
import ReferencePeek from './ReferencePeek.svelte';

let {
  level,
  id,
  at,
  key,
  label,
}: { level: FieldLevel; id: string; at: readonly string[]; key: string; label: string } = $props();
</script>

<div class="field"
  ><div class="label-row"
    ><label for="{id}.{key}">{label}</label><span class="mode"
      >{m.field_per_language({}, level.options)}</span
    ></div
  ><input
    class="input"
    id="{id}.{key}"
    type="text"
    value={level.str([...at, key])}
    oninput={(e) => level.write([...at, key], e.currentTarget.value || undefined)}
  />{#if level.reference}<ReferencePeek
      reference={level.reference}
      path={level.childAddress(at, key)}
      uiLocale={level.uiLocale}
    />{/if}</div
>
