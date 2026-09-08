export type SaveState = { saved: string; phase: 'idle' | 'saving' | 'failed' };

export type DraftSaveLock = {
  held_by: { id: string; name: string | null } | null;
  mine: false;
  expires_at: number | null;
};

export type DraftSaveRefusal =
  | { kind: 'lock'; lock: DraftSaveLock }
  | { kind: 'revision'; error?: string }
  | { kind: 'other' };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const lockRefusal = (value: unknown): value is DraftSaveLock => {
  if (!object(value) || value.mine !== false) return false;
  const holder = value.held_by;
  return (
    (holder === null ||
      (object(holder) &&
        typeof holder.id === 'string' &&
        (typeof holder.name === 'string' || holder.name === null))) &&
    (typeof value.expires_at === 'number' || value.expires_at === null)
  );
};

/** A 409 means different things across the API; only draft saves return this lock shape. */
export async function classifyDraftSaveRefusal(response: Response): Promise<DraftSaveRefusal> {
  if (response.status !== 409) return { kind: 'other' };
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (object(body) && body.reason === 'revision')
    return {
      kind: 'revision',
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  return lockRefusal(body) ? { kind: 'lock', lock: body } : { kind: 'other' };
}

/** One entry owns this lane: source and translation writes cannot overtake each other. */
export function saveLane() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
}

/** Debounce changes, serialize writes and drain edits made during an outstanding request. */
export function saveCoordinator(options: {
  current: () => string;
  saved: string;
  write: (snapshot: string) => Promise<boolean>;
  onstate: (state: SaveState) => void;
  lane?: ReturnType<typeof saveLane>;
}) {
  const lane = options.lane ?? saveLane();
  let state: SaveState = { saved: options.saved, phase: 'idle' };
  let active: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = true;
  const update = (phase: SaveState['phase'], saved = state.saved) => {
    state = { phase, saved };
    options.onstate(state);
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const dirty = () => options.current() !== state.saved;
  const flush = (): Promise<boolean> => {
    cancel();
    if (!open) return Promise.resolve(false);
    if (active) return active;
    active = lane(async () => {
      while (dirty()) {
        // The gate may have closed while this locale waited behind another one on the lane.
        if (!open) return false;
        const snapshot = options.current();
        update('saving');
        if (!(await options.write(snapshot))) {
          update('failed');
          return false;
        }
        // An in-flight request is allowed to acknowledge exactly the version it sent.
        update('idle', snapshot);
        if (!open) return false;
      }
      return true;
    })
      .catch(() => {
        update('failed');
        return false;
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const change = () => {
    cancel();
    if (open && dirty()) timer = setTimeout(() => void flush(), 2000);
    return cancel;
  };
  return {
    change,
    flush,
    close: () => {
      open = false;
      cancel();
    },
    unsaved: () => state.phase === 'saving' || dirty(),
    // Machine translation already persisted these bytes outside the autosave lifecycle.
    accept: (snapshot: string) => update('idle', snapshot),
  };
}

type Saves = Pick<ReturnType<typeof saveCoordinator>, 'flush' | 'unsaved'>;

/** The translation can change panes; flush the currently mounted languages until both settle. */
export async function flushEntry(
  source: Saves,
  translation: () => Saves | undefined,
): Promise<boolean> {
  do {
    if (!(await source.flush())) return false;
    const pane = translation();
    if (pane && !(await pane.flush())) return false;
  } while (source.unsaved() || translation()?.unsaved());
  return true;
}
