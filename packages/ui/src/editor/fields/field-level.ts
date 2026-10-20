import type { Preset } from '@handover/core';
import type { UiLocale } from '../../i18n.js';
import type { MediaItem } from '../../media/upload.js';
import type { FieldChange, FieldCommandResult, FieldHistory } from '../entry-session.svelte';
import type { Reference } from './ReferencePeek.svelte';

export type Data = Record<string, unknown>;
type Path = readonly string[];

// One form level as its widget components see it; the getters read the level's live state.
export type FieldLevel = {
  read(at: Path): unknown;
  str(at: Path): string;
  num(at: Path): number | '';
  write(at: Path, value: unknown, history?: FieldHistory): FieldCommandResult | undefined;
  writeMany(
    at: Path,
    changes: readonly FieldChange[],
    history?: FieldHistory,
  ): FieldCommandResult | undefined;
  address(at: Path): string;
  childAddress(at: Path, child: string): string;
  src(at: Path): string;
  point(at: Path): [number, number];
  picked(at: Path, type: 'image' | 'file', items: MediaItem[]): void;
  dropOn(id: string, e: DragEvent): void;
  // One picker open per level, by field id, and the files dropped on the field that opened it.
  picker: string;
  dropped: File[];
  readonly uiLocale: UiLocale;
  readonly options: { readonly locale: UiLocale };
  readonly mediaBase: string;
  readonly reference: Reference | undefined;
  readonly translating: boolean;
  readonly structureLocked: boolean;
};

export function readFrom(data: Data, at: Path): unknown {
  return at.reduce<unknown>((node, key) => (node as Data | undefined)?.[key], data);
}

export const aspect = (preset: Preset) => preset.ratio?.replace(':', ' / ') ?? '4 / 3';

// The middle is where a crop holds when nothing says otherwise, so it is not written.
export const centred = (focal?: [number, number] | null) =>
  !focal || (focal[0] === 0.5 && focal[1] === 0.5);

// One picked asset as the format stores it, and in that order.
export const stored = (type: 'image' | 'file', item: MediaItem, pageAlt?: unknown) =>
  type === 'image'
    ? // A page keeps its own words; otherwise selection takes a snapshot of the library default.
      {
        src: item.src,
        alt: typeof pageAlt === 'string' ? pageAlt : item.alt || undefined,
        width: item.width,
        height: item.height,
        focal: centred(item.focal) ? undefined : item.focal,
      }
    : { src: item.src, name: item.filename, bytes: item.bytes, mime: item.mime };
