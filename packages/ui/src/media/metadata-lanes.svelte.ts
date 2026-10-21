import type { UiMessage } from '../errors.js';
import { isRecord, postJson, uncertainResponse } from '../request.js';
import { isLibraryItem, type LibraryItem, mediaResponse, name } from './upload.js';

export type MetadataChange = {
  tags?: string[];
  alt?: string;
  archived?: boolean;
  focal?: [number, number];
};
type MetadataLane = {
  acknowledged: LibraryItem;
  draft: LibraryItem;
  pending: MetadataChange[];
  failed?: MetadataChange;
  writing: boolean;
};

// One write at a time per picture, so edits made while one is in flight land in order.
export function createMetadataLanes({ show }: { show: (id: string, draft: LibraryItem) => void }) {
  const lanes = new Map<string, MetadataLane>();
  let failures = $state<
    Record<string, { message: UiMessage; name: string; recovery?: 'retry' | 'reload' }>
  >({});

  function laneFor(item: LibraryItem) {
    const held = lanes.get(item.id);
    if (held) {
      if (!held.writing && !held.failed && !held.pending.length) {
        held.acknowledged = item;
        held.draft = item;
      }
      return held;
    }
    const lane: MetadataLane = {
      acknowledged: item,
      draft: item,
      pending: [],
      writing: false,
    };
    lanes.set(item.id, lane);
    return lane;
  }

  async function write(id: string, lane: MetadataLane) {
    if (lane.writing) return;
    lane.writing = true;
    try {
      while (lane.failed || lane.pending.length) {
        const details = lane.failed ?? lane.pending.shift();
        if (!details) break;
        const res = await postJson(`/admin/api/media/${id}`, details, 'PATCH');
        if (!res.ok) {
          lane.failed = details;
          const message = uncertainResponse(res)
            ? ({ code: 'MEDIA_METADATA_UNCONFIRMED', status: res.status } satisfies UiMessage)
            : await mediaResponse(res, 'MEDIA_METADATA_FAILED');
          failures = {
            ...failures,
            [id]: {
              message,
              name: name(lane.draft),
              recovery:
                message.code === 'MEDIA_NOT_FOUND'
                  ? 'reload'
                  : message.code === 'MEDIA_METADATA_INVALID'
                    ? undefined
                    : 'retry',
            },
          };
          break;
        }
        let answer: unknown;
        try {
          answer = await res.json();
        } catch {
          answer = undefined;
        }
        const saved = isRecord(answer) ? answer.media : undefined;
        if (!isLibraryItem(saved) || saved.id !== id) {
          lane.failed = details;
          failures = {
            ...failures,
            [id]: {
              message: { code: 'MEDIA_METADATA_INVALID' },
              name: name(lane.draft),
              recovery: 'retry',
            },
          };
          break;
        }
        lane.acknowledged = { ...lane.acknowledged, ...saved };
        lane.failed = undefined;
        const optimistic = lane.draft;
        lane.draft = { ...optimistic, ...saved };
        for (const waiting of lane.pending) {
          for (const key of Object.keys(waiting) as (keyof MetadataChange)[]) {
            Object.assign(lane.draft, { [key]: optimistic[key] });
          }
        }
        const { [id]: _, ...rest } = failures;
        failures = rest;
        show(id, lane.draft);
      }
    } finally {
      lane.writing = false;
    }
  }

  return {
    get failures() {
      return failures;
    },
    /** Tags and the default alt are the library's own words, so they are saved as they are typed. */
    describe(item: LibraryItem, details: MetadataChange) {
      const lane = laneFor(item);
      lane.draft = { ...lane.draft, ...details };
      lane.pending.push(details);
      show(item.id, lane.draft);
      if (!lane.failed) void write(item.id, lane);
    },
    retry(id: string) {
      const lane = lanes.get(id);
      if (!lane?.failed) return;
      const { [id]: _, ...rest } = failures;
      failures = rest;
      void write(id, lane);
    },
    /** The draft while a write is still pending or failed; otherwise the item as the list has it. */
    view(item: LibraryItem) {
      const lane = lanes.get(item.id);
      return lane && (lane.writing || lane.failed || lane.pending.length) ? lane.draft : item;
    },
    forget(ids: string[]) {
      failures = Object.fromEntries(Object.entries(failures).filter(([id]) => !ids.includes(id)));
    },
  };
}
