import type { Drift, Field, Form, Labels, SeoDefaultsValue } from '@handover/core';
import type { EntryProblem } from './entry-session.svelte';

type Data = Record<string, unknown>;

export type EditorEntry = {
  fields: readonly Field[];
  blocks: Record<string, Field[]>;
  blockLabels?: Form['blockLabels'];
  data: Data;
  revisions?: Record<string, string>;
  /** The languages whose file this entry has a draft ahead of in git. */
  pending: string[];
  /** The languages the repository already has a file for; the rest are only in the preview. */
  published: string[];
  /** Somebody marked it "Not ready yet" — the toggle opens pressed, whoever they were. */
  held?: boolean;
  /** Off the site for every language, since `_status` is shared across the files. */
  hidden?: boolean;
  /** Where each language sends its readers while it is hidden; empty for "nowhere". */
  redirects?: Record<string, string>;
  /** What the collection schema will not accept yet, by field path. */
  problems: EntryProblem[];
  /** The field this collection is keyed on, when it is not `title`. */
  titleField?: string;
  /** The site's own SEO defaults per language; absent for an entry with no `seo` field. */
  seoDefaults?: Record<string, SeoDefaultsValue>;
  /** A global: one file the schema names, so nothing that renames, hides or copies it. */
  singleton?: boolean;
  /** What the dev calls this global — a global has no title field to be named by. */
  label?: string;
  labels?: Labels;
  /** The languages the site declares. */
  locales: string[];
  /** The site's default, which is what says whether a language's URLs carry its segment. */
  defaultLocale: string;
  /** The language the structure is edited in and a translation is made from. */
  sourceLocale: string;
  /** The languages it is offered in; the rest are turned off and get no file. */
  offered: string[];
  /** What its own `_locales` says that the files it has contradict — a hand edit or a merge. */
  offerProblems?: string[];
  /** The other languages this entry has a file in, parsed; none where it has no other file. */
  translations: Record<string, Data>;
  /** Which of them were translated from a source language that has moved on since. */
  stale: string[];
  /** The blocks this entry's languages disagree about; publishing waits on these. */
  drift: Drift[];
  /** The site has something to machine-translate with: without one, none of it is offered. */
  translator?: boolean;
  /** This collection serves an address per language; without it the row is not drawn at all. */
  localizedSlugs?: boolean;
  /** The address each language serves this entry at, empty meaning under the file name. */
  addresses?: Record<string, string>;
  /** The collection's own route, which is what an address is a segment of. */
  route?: string;
  /** The page above it, where a language that loses its file sends its readers. */
  index?: string;
  /** Whether the default language's URLs carry its segment. */
  prefixDefaultLocale?: boolean;
};
