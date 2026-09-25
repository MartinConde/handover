import { LOCK_TTL } from '@handover/core';
import type { UiMessage } from '../errors.js';
import { request as fetch } from '../request.js';

export type EntryLock = {
  held_by: { id: string; name: string | null } | null;
  mine: boolean;
  expires_at: number | null;
};

export function createEntryLock({
  collection,
  slug,
  userId,
  onlost,
  onchanged,
  failure,
}: {
  collection: string;
  slug: string;
  userId: string;
  onlost: () => void;
  onchanged: () => void | Promise<void>;
  failure: (response: Response, fallback: string) => Promise<UiMessage>;
}) {
  let lock = $state<EntryLock>();
  let lost = $state(false);
  let taking = $state(false);
  let takeFailure = $state<UiMessage>();
  let takeBusy = $state(false);
  let asked = $state(0);
  let beatAt = 0;
  let renewing = false;
  const tab = (() => {
    try {
      const kept = sessionStorage.getItem('handover-tab');
      if (kept) return kept;
      const made = crypto.randomUUID();
      sessionStorage.setItem('handover-tab', made);
      return made;
    } catch {
      return crypto.randomUUID();
    }
  })();

  function lose(next?: EntryLock) {
    if (next) lock = next;
    if (lost) return;
    lost = true;
    onlost();
  }

  async function beat(claim: boolean) {
    const res = await fetch(
      `/admin/api/locks/${collection}/${slug}${claim ? '' : `?tab=${tab}`}`,
      claim
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab }),
          }
        : { method: 'GET' },
    ).catch(() => undefined);
    if (!res?.ok) return;
    const had = lock?.mine === true;
    const answer = (await res.json()) as EntryLock;
    asked = Date.now();
    // Lapsed with nobody after it: the next edit claims it back, and the save revision catches edits meanwhile.
    if (had && !answer.mine && !answer.held_by) return;
    lock = answer;
    if (lock.mine && claim) beatAt = asked;
    else if (had && !lock.mine) lose();
  }

  $effect(() => {
    void beat(true);
  });
  // Polls on either side so a holder hears of a take-over without typing.
  $effect(() => {
    if (lost) return;
    const timer = setInterval(() => beat(false), 15000);
    return () => clearInterval(timer);
  });

  return {
    get tab() {
      return tab;
    },
    get lock() {
      return lock;
    },
    get lost() {
      return lost;
    },
    get locked() {
      return lost || (lock !== undefined && !lock.mine);
    },
    get holderName() {
      return lock?.held_by?.name;
    },
    get otherTab() {
      return lock?.held_by?.id !== undefined && lock?.held_by?.id === userId;
    },
    get idle() {
      return lock?.expires_at ? asked - (lock.expires_at - LOCK_TTL) : 0;
    },
    get taking() {
      return taking;
    },
    get takeFailure() {
      return takeFailure;
    },
    get takeBusy() {
      return takeBusy;
    },
    lose,
    recheck() {
      if (lock?.mine && !lost && document.visibilityState === 'visible') void beat(false);
    },
    renew() {
      if (!lock?.mine || lost || renewing || Date.now() - beatAt < 45000) return;
      renewing = true;
      void beat(true).finally(() => {
        renewing = false;
      });
    },
    openTake() {
      taking = true;
    },
    cancelTake() {
      taking = false;
      takeFailure = undefined;
    },
    async takeOver() {
      takeBusy = true;
      takeFailure = undefined;
      try {
        const res = await fetch(`/admin/api/locks/${collection}/${slug}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ take: true, tab }),
        });
        if (!res.ok) {
          takeFailure = await failure(res, 'EDITOR_LOCK_TAKE_FAILED');
          return;
        }
        taking = false;
        lock = (await res.json()) as EntryLock;
        takeBusy = false;
        await onchanged();
      } finally {
        takeBusy = false;
      }
    },
  };
}
