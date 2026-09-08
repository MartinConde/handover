import {
  type FieldTargetResult,
  type Form,
  fieldAddress,
  fieldPosition,
  resolveFieldTarget,
} from '@handover/core';
import { type SaveState, saveCoordinator, saveLane } from './save';

export type EntryData = Record<string, unknown>;
export type EntryProblem = { path: string; message: string };

export type EntrySession = ReturnType<typeof createEntrySession>;

/** Working locale files and their opaque revisions for the lifetime of one opened entry. */
export function createEntrySession({
  sourceLocale,
  data,
  translations,
  revisions = {},
  form,
  problems = {},
}: {
  sourceLocale: string;
  data: EntryData;
  translations: Record<string, EntryData>;
  revisions?: Record<string, string>;
  form?: Form;
  problems?: Record<string, EntryProblem[]>;
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
  const versions = $state<Record<string, number>>(
    Object.fromEntries(Object.keys(snapshots).map((locale) => [locale, 0])),
  );
  const observed = Object.fromEntries(
    Object.entries(snapshots).map(([locale, snapshot]) => [locale, JSON.stringify(snapshot)]),
  );
  const validation = $state<Record<string, Record<string, string>>>({});
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
  const synchronizeVersion = (locale: string) => {
    const serialized = JSON.stringify(snapshots[locale]);
    if (serialized !== observed[locale]) {
      versions[locale] = (versions[locale] ?? 0) + 1;
      observed[locale] = serialized;
    }
    return versions[locale] ?? 0;
  };
  const normalize = (snapshot: EntryData, found: EntryProblem[]) => {
    const normalized: Record<string, string> = {};
    for (const problem of found) {
      const address = fieldAddress(
        'default',
        problem.path ? problem.path.split('.') : [],
        snapshot,
        form,
      );
      // A duplicate id cannot safely attach an error to either occurrence.
      if (address !== undefined && normalized[address] === undefined)
        normalized[address] = problem.message;
    }
    return normalized;
  };

  for (const [locale, found] of Object.entries(problems)) {
    const snapshot = snapshots[locale];
    if (snapshot) validation[locale] = normalize(snapshot, found);
  }

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
      synchronizeVersion(locale);
    },
    contentVersion(locale: string): number {
      return synchronizeVersion(locale);
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
      write: (
        locale: string,
        snapshot: string,
        revision: string | undefined,
        contentVersion: number,
      ) => Promise<boolean>,
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
            write: (snapshot) =>
              write(locale, snapshot, openedRevisions[locale], synchronizeVersion(locale)),
            onstate: (state) => {
              saveStates[locale] = state;
            },
          }),
        );
      }
    },
    change(locale: string): void {
      synchronizeVersion(locale);
      coordinator(locale).change();
    },
    /** Store wire-format errors by stable identity only when they describe the current version. */
    acceptProblems(
      locale: string,
      found: EntryProblem[],
      validatedSnapshot: string,
      contentVersion: number,
    ): boolean {
      if (
        contentVersion !== synchronizeVersion(locale) ||
        validatedSnapshot !== JSON.stringify(snapshots[locale])
      )
        return false;
      validation[locale] = normalize(JSON.parse(validatedSnapshot) as EntryData, found);
      return true;
    },
    /** Stable addresses are consumed directly by Canvas and future session commands. */
    problemAddresses(locale: string): Record<string, string> {
      return { ...(validation[locale] ?? {}) };
    },
    /** Form controls still consume the API's positional dotted-path shape. */
    positionalProblems(locale: string): Record<string, string> {
      const current = snapshots[locale];
      if (!current) return {};
      const positional: Record<string, string> = {};
      for (const [address, message] of Object.entries(validation[locale] ?? {})) {
        const path = fieldPosition('default', address, current, form);
        if (path) positional[path.join('.')] = message;
      }
      return positional;
    },
    /** Resolve a command target against this session's current schema and locale data. */
    resolveField(locale: string, address: string): FieldTargetResult {
      const current = snapshots[locale];
      if (!current) throw new Error(`The ${locale} locale is not loaded in this entry session.`);
      return form
        ? resolveFieldTarget('default', form, address, current)
        : { ok: false, reason: 'schema' };
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
