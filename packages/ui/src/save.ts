export type SaveState = { saved: string; phase: 'idle' | 'saving' | 'failed' };

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
    if (active) return active;
    active = lane(async () => {
      while (dirty()) {
        const snapshot = options.current();
        update('saving');
        if (!(await options.write(snapshot))) {
          update('failed');
          return false;
        }
        update('idle', snapshot);
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
    if (dirty()) timer = setTimeout(() => void flush(), 2000);
    return cancel;
  };
  return {
    change,
    flush,
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
