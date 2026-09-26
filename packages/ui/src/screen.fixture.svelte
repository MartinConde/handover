<script lang="ts">
// Stands in for a site's own screen: it prints what the shell handed it and calls its fetch.
import type { ScreenProps } from './screen.js';

let { session, request, uiLocale }: ScreenProps = $props();
let answer = $state('');
</script>

<p class="screen-session">{session.role} · {uiLocale}</p>
<button
  class="screen-ask"
  type="button"
  onclick={async () => (answer = await (await request('/admin/api/screen-probe')).text())}
>ask</button>
<p class="screen-answer">{answer}</p>
