<script lang="ts">
import type { Field } from '@handover/core';
import { createEntrySession } from '../../../../../../ui/src/editor/entry-session.svelte';
import Fields from '../../../../../../ui/src/editor/fields/Fields.svelte';
import '../../../../../../ui/src/tokens.css';

const fields: Field[] = [
  { path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' },
];
const session = createEntrySession({
  document: 'pages/richtext-history',
  sourceLocale: 'en',
  data: { summary: 'Harbour home' },
  translations: {},
  form: { fields, blocks: {} },
});
let data = $state(session.snapshot('en'));
</script>

<main>
  <h1>Rich text history fixture</h1>
  <form class="form" onsubmit={(event) => event.preventDefault()}>
    <Fields {fields} blocks={{}} locale="en" {session} bind:root={data} />
  </form>
  <output data-markdown>{String(data.summary ?? '')}</output>
</main>

<style>
  main {
    box-sizing: border-box;
    max-width: 720px;
    margin: 40px auto;
    padding: 24px;
  }

  output {
    display: block;
    margin-top: 24px;
    white-space: pre-wrap;
  }
</style>
