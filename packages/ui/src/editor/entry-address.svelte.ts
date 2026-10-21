import { tick } from 'svelte';
import { invalidateEntryDirectory } from '../entry-directory.js';
import { retainedFailure, type UiMessage } from '../errors.js';
import { postJson } from '../request.js';
import type { createEntryActions } from './entry-actions.svelte';
import type { EditorEntry } from './entry-payload';
import type { EntrySession } from './entry-session.svelte';

// Unlike a field, an address is validated, unique and owes a redirect when it moves.
export function createEntryAddress({
  collection,
  slug,
  entry,
  locale,
  untranslated,
  session,
  actions,
  onchanged,
}: {
  collection: string;
  slug: string;
  entry: () => EditorEntry;
  locale: () => string;
  untranslated: (of: string) => boolean;
  session: EntrySession;
  actions: ReturnType<typeof createEntryActions>;
  onchanged: () => void | Promise<void>;
}) {
  let editing = $state(false);
  let typed = $state('');
  let addressFailed = $state<UiMessage>();
  let addressInput = $state<HTMLInputElement>();
  let addressTrigger = $state<HTMLButtonElement>();
  const address = $derived(entry().addresses?.[locale()] ?? '');
  // A language with no file has no address: the offer to make one stands where the form would be.
  const addressable = $derived(
    entry().localizedSlugs === true &&
      (locale() === entry().sourceLocale || !untranslated(locale())),
  );

  function editAddress() {
    typed = address;
    addressFailed = undefined;
    editing = true;
    void tick().then(() => {
      addressInput?.focus();
      addressInput?.select();
    });
  }

  async function cancelAddress() {
    editing = false;
    await tick();
    addressTrigger?.focus();
  }

  function addressKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!actions.busy) void saveAddress();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!actions.busy) void cancelAddress();
    }
  }

  // The screen is read again afterwards so both columns get the address the server settled on.
  async function saveAddress() {
    actions.busy = true;
    if (!(await session.flush())) {
      actions.busy = false;
      return;
    }
    const res = await postJson(`/admin/api/entries/${collection}/${slug}/address/${locale()}`, {
      address: typed.trim(),
    });
    actions.busy = false;
    if (!res.ok) {
      addressFailed = await retainedFailure(res, 'ENTRY_ACTION_FAILED');
      return;
    }
    await cancelAddress();
    invalidateEntryDirectory();
    onchanged();
  }

  return {
    get editing() {
      return editing;
    },
    get typed() {
      return typed;
    },
    set typed(value: string) {
      typed = value;
    },
    get addressFailed() {
      return addressFailed;
    },
    get addressInput() {
      return addressInput;
    },
    set addressInput(value: HTMLInputElement | undefined) {
      addressInput = value;
    },
    get addressTrigger() {
      return addressTrigger;
    },
    set addressTrigger(value: HTMLButtonElement | undefined) {
      addressTrigger = value;
    },
    get address() {
      return address;
    },
    get addressable() {
      return addressable;
    },
    editAddress,
    cancelAddress,
    addressKeydown,
    saveAddress,
  };
}
