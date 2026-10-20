<script lang="ts" module>
export type RevertFailure = {
  code: 'REVERT_SAVE_FAILED' | 'REVERT_UNCERTAIN' | 'REVERT_FAILED' | 'REVERT_CONFLICT';
  detail?: string;
  paths?: string[];
  status?: number;
};
</script>

<script lang="ts">
import { retainedFailure } from '../errors.js';
import { messageOptions, type UiLocale } from '../i18n.js';
import { coordinateEntryReplacement } from '../navigate';
import * as m from '../paraglide/messages.js';
import { request as fetch, uncertainResponse } from '../request.js';
import ConfirmDialog from '../shared/ConfirmDialog.svelte';

let {
  sha = $bindable(),
  uiLocale,
  onfailed,
  onreverted,
}: {
  /** The commit whose revert is waiting to be confirmed. */
  sha?: string;
  uiLocale: UiLocale;
  onfailed: (failure: RevertFailure) => void;
  onreverted: () => void | Promise<void>;
} = $props();
const options = $derived(messageOptions(uiLocale));
let reverting = $state(false);

function closeRevert() {
  sha = undefined;
}

// The pill's and the drawer's Revert are the same inverse commit over whichever sha is named.
async function revert() {
  const confirmed = sha;
  if (!confirmed) return;
  reverting = true;
  let res: Response | undefined;
  const outcome = await coordinateEntryReplacement(undefined, async () => {
    res = await fetch('/admin/api/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commit_sha: confirmed }),
    });
    if (uncertainResponse(res)) throw new TypeError('The revert response was not confirmed.');
    return res.ok;
  });
  reverting = false;
  closeRevert();
  if (!outcome.ok && outcome.reason === 'save') {
    onfailed({ code: 'REVERT_SAVE_FAILED' });
    return;
  }
  if (!outcome.ok && (outcome.reason === 'uncertain' || outcome.reason === 'reload')) {
    onfailed({ code: 'REVERT_UNCERTAIN' });
    return;
  }
  if (!outcome.ok) {
    if (!res) {
      onfailed({ code: 'REVERT_UNCERTAIN' });
      return;
    }
    // A file that has moved on since is named in the interface language; any other 409 keeps the server's sentence.
    const refusal = res.status === 409 ? await retainedFailure(res, 'REVERT_FAILED') : undefined;
    onfailed(
      refusal?.code === 'REVERT_CONFLICT'
        ? { code: 'REVERT_CONFLICT', paths: refusal.paths ?? [] }
        : {
            code: 'REVERT_FAILED',
            status: res.status,
            ...(refusal?.detail ? { detail: refusal.detail } : {}),
          },
    );
    return;
  }
  await onreverted();
}
</script>

{#if sha}
  <ConfirmDialog
    labelledby="revert-h"
    describedby="revert-p"
    role="dialog"
    title={m.build_revert_question({}, options)}
    cancel={m.common_cancel({}, options)}
    confirm={reverting ? m.build_reverting({}, options) : m.build_revert({}, options)}
    busy={reverting}
    onconfirm={revert}
    onclose={closeRevert}
  >
    <p id="revert-p">
      {m.build_revert_explanation({}, options)}
    </p>
  </ConfirmDialog>
{/if}
