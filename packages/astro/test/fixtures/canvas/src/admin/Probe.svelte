<script lang="ts">
import type { ScreenProps } from 'astro-handover/screen';

let { session, uiLocale }: ScreenProps = $props();
</script>

<h1>Screen from the fixture</h1>
<p>{session.role} · {uiLocale}</p>
