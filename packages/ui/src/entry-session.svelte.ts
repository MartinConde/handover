import { type SaveState, saveCoordinator, saveLane } from './save';

export type EntryData = Record<string, unknown>;

export type EntrySession = ReturnType<typeof createEntrySession>;

/** Working locale files and their opaque revisions for the lifetime of one opened entry. */
export function createEntrySession({
  sourceLocale,
  data,
  translations,
  revisions = {},
}: {
  sourceLocale: string;
  data: EntryData;
  translations: Record<string, EntryData>;
  revisions?: Record<string, string>;
}) {
  const snapshots = $state<Record<string, EntryData>>(
    structuredClone({ ...translations, [sourceLocale]: data }),
  );
  const openedRevisions = $state<Record<string, string | undefined>>({ ...revisions });
  const saveStates = $state<Record<string, SaveState>>(
    Object.fromEntries(
      Object.entries(snapshots).map(([locale, snapshot]) => [
        locale,
        { saved: JSON.stringify(snapshot), phase: 'idle' },
      ]),
    ),
  );
  const coordinators = new Map<string, ReturnType<typeof saveCoordinator>>();

  const locales = () => [sourceLocale, ...Object.keys(snapshots).filter((l) => l !== sourceLocale)];
  const coordinator = (locale: string) => {
    const found = coordinators.get(locale);
    if (!found) throw new Error(`Autosave is not configured for the ${locale} locale.`);
    return found;
  };
  const dirty = (locale: string) =>
    JSON.stringify(snapshots[locale]) !== saveStates[locale]?.saved ||
    saveStates[locale]?.phase === 'saving';

  return {
    snapshots,
    hasSnapshot(locale: string): boolean {
      return Object.hasOwn(snapshots, locale);
    },
    snapshot(locale: string): EntryData {
      const snapshot = snapshots[locale];
      if (!snapshot) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return snapshot;
    },
    replaceSnapshot(locale: string, snapshot: EntryData): void {
      snapshots[locale] = structuredClone(snapshot);
    },
    revision(locale: string): string | undefined {
      return openedRevisions[locale];
    },
    setRevision(locale: string, revision: string): void {
      openedRevisions[locale] = revision;
    },
    mergeRevisions(revisions: Record<string, string> | undefined): void {
      if (!revisions) return;
      for (const [locale, revision] of Object.entries(revisions)) {
        openedRevisions[locale] = revision;
      }
    },
    saveState(locale: string): SaveState {
      const state = saveStates[locale];
      if (!state) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return state;
    },
    /** Configure once so save scheduling survives locale-pane mount cycles. */
    configureAutosave(
      write: (locale: string, snapshot: string, revision: string | undefined) => Promise<boolean>,
    ): void {
      if (coordinators.size) throw new Error('Autosave is already configured for this entry.');
      const lane = saveLane();
      for (const locale of locales()) {
        const initial = saveStates[locale];
        if (!initial) continue;
        coordinators.set(
          locale,
          saveCoordinator({
            current: () => JSON.stringify(snapshots[locale]),
            saved: initial.saved,
            lane,
            write: (snapshot) => write(locale, snapshot, openedRevisions[locale]),
            onstate: (state) => {
              saveStates[locale] = state;
            },
          }),
        );
      }
    },
    change(locale: string): void {
      coordinator(locale).change();
    },
    /** Drain every loaded locale, including dirty panes which are no longer mounted. */
    async flush(): Promise<boolean> {
      do {
        for (const locale of locales()) {
          if (!(await coordinator(locale).flush())) return false;
        }
      } while (locales().some(dirty));
      return true;
    },
    unsaved(locale?: string): boolean {
      return locale === undefined ? locales().some(dirty) : dirty(locale);
    },
    accept(locale: string, snapshot: string): void {
      coordinator(locale).accept(snapshot);
    },
    closeSaveGate(): void {
      for (const saves of coordinators.values()) saves.close();
    },
  };
}
