export type Readiness = {
  problems: unknown[];
  excludable: boolean;
  reason?: 'published' | 'source';
};

export function createPublishChoice(pending: () => string[], many: () => boolean) {
  let readiness = $state<Record<string, Readiness>>();
  let later = $state<string[]>([]);
  const going = $derived(pending());
  const notReady = $derived(going.filter((of) => (readiness?.[of]?.problems.length ?? 0) > 0));
  const excludable = $derived(notReady.filter((of) => readiness?.[of]?.excludable));
  // An unfinished language can wait only if another language would still publish.
  const waitable = $derived(going.some((of) => !excludable.includes(of)) ? excludable : []);
  const leftOut = $derived(waitable.filter((of) => later.includes(of)));
  const kept = $derived(going.filter((of) => !leftOut.includes(of)));
  const unready = $derived(many() ? notReady.filter((of) => kept.includes(of)) : []);

  return {
    get readiness() {
      return readiness;
    },
    get later() {
      return later;
    },
    get going() {
      return going;
    },
    get notReady() {
      return notReady;
    },
    get waitable() {
      return waitable;
    },
    get leftOut() {
      return leftOut;
    },
    get kept() {
      return kept;
    },
    get unready() {
      return unready;
    },
    reset() {
      readiness = undefined;
      later = [];
    },
    receive(next: Record<string, Readiness> | undefined, failed: boolean) {
      if (failed) later = [];
      readiness = next;
    },
    toggle(of: string) {
      later = later.includes(of) ? later.filter((l) => l !== of) : [...later, of];
    },
  };
}

export type PublishChoice = ReturnType<typeof createPublishChoice>;
