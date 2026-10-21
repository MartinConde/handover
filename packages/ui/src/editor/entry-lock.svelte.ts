import { LOCK_TTL } from '@handover/core';
import type { UiMessage } from '../errors.js';
import { request as fetch, postJson } from '../request.js';

export const TAB_KEY = 'handover-tab';
// Beat cadence, and how stale the last beat must be before typing renews the lock.
const POLL_MS = 15000;
const RENEW_AFTER_MS = 45000;

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
      const kept = sessionStorage.getItem(TAB_KEY);
      if (kept) return kept;
      const made = crypto.randomUUID();
      sessionStorage.setItem(TAB_KEY, made);
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
    const url = `/admin/api/locks/${collection}/${slug}${claim ? '' : `?tab=${tab}`}`;
    const res = await (claim ? postJson(url, { tab }) : fetch(url, { method: 'GET' })).catch(
      () => undefined,
    );
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
    const timer = setInterval(() => beat(false), POLL_MS);
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
      if (!lock?.mine || lost || renewing || Date.now() - beatAt < RENEW_AFTER_MS) return;
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
        const res = await postJson(`/admin/api/locks/${collection}/${slug}`, { take: true, tab });
        if (!res.ok) {
          takeFailure = await failure(res, 'EDITOR_LOCK_TAKE_FAILED');
          return;
        }
        taking = false;
        lock = (await res.json()) as EntryLock;
        await onchanged();
      } finally {
        takeBusy = false;
      }
    },
  };
}
