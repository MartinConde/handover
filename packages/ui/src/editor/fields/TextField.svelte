<script lang="ts">
let {
  id,
  value,
  invalid,
  describedBy,
  onvalue,
}: {
  id: string;
  value: string;
  invalid?: 'true';
  describedBy?: string;
  onvalue: (value: string) => void;
} = $props();

// A field chooses its control when it opens. Changing this while the user types would replace
// the focused DOM node and discard its selection (including an active IME composition).
// svelte-ignore state_referenced_locally
const multiline = value.length > 80 || value.includes('\n');
</script>

{#if multiline}
  <textarea
    class="input textarea"
    {id}
    aria-invalid={invalid}
    aria-describedby={describedBy}
    {value}
    oninput={(event) => onvalue(event.currentTarget.value)}
  ></textarea>
{:else}
  <input
    class="input"
    {id}
    type="text"
    aria-invalid={invalid}
    aria-describedby={describedBy}
    {value}
    oninput={(event) => onvalue(event.currentTarget.value)}
  />
{/if}
