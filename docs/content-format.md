# Content format

Every entry is one YAML file per locale at `src/content/<collection>/<locale>/<slug>.yaml`.
Handover writes these files; your Astro build reads them through the schema in
`src/content/schemas.ts`. The file is the source of truth — nothing the site renders
lives only in a database.

That layout is exact: one folder per locale, and no folders below it. The filename is the
entry's id, so a file in a sub-folder could not be opened as `collection/slug`; the build
stops and names it rather than leaving it out of the admin's entry list.

The shape on this page is fixed as of `_version: 1`. If a later release of Handover changes
it, the change comes with a migration step: `handover migrate` rewrites your files and
raises their `_version` ([CLI](cli.md#handover-migrate)). Handover never reinterprets a file
it has not migrated, so an upgrade cannot quietly change what your build reads.

## What a file looks like

```yaml
_version: 1
title: "Home"
seo:
  title: "Move to the coast"
  description: "Coastal homes in Devon."
blocks:
  - _type: "cta"
    _id: "k3nf9a2p"
    _label: "Newsletter signup"
    heading: "Ready to move?"
    body: |-
      Book a viewing this week and we'll
      cover your travel.
    button:
      label: "Contact us"
      href: "/contact"
```

Handover always writes the same shape, so a one-field edit is a one-line diff:

- strings are double-quoted; text with line breaks is a `|-` block; rich text is Markdown
  in that block, never HTML
- keys starting with `_` come first, then your fields in schema order
- empty and `null` values are left out
- two-space indent, no line folding
- an array directly inside an array is not allowed — wrap the inner one in an object
  (`columns: [{ _id, blocks: [...] }]`)

You can hand-edit a file in any valid YAML; Handover rewrites it in this shape on the
next save.

## Field types

The form is generated from your Zod schema. Every type and how it is stored is in
[field-types.md](field-types.md) and, for the ones that hold a shape,
[structured-fields.md](structured-fields.md).

## Reserved keys

Keys starting with `_` belong to Handover. Name your own fields anything else — `type`,
`status`, `id` are all free.

| Key | Where | Value |
|---|---|---|
| `_version` | top of file | The format version, currently `1`. A file without one is read as `1`; the next save writes it, and so does `handover migrate`. |
| `_status` | top of file | `hidden` to keep the entry off the site. Absent means live. |
| `_machine` | top of file | Field paths whose current value was written by a translation or AI assist, e.g. `blocks[_id=k3nf9a2p].heading`. Cleared per path when a person edits the field. |
| `_i18n` | top of file | Which locale and which version of it a translation was made from. Only in translated files. |
| `_type` | block | The block type, matching a registered block. |
| `_id` | block, array item | Eight characters from `0-9a-z`, unique in the file, the same across locales. |
| `_label` | block | An editor-given name, shown in the block list instead of the type. |
| `_ref` | block | A path such as `globals/cta-newsletter` the block's content comes from. The block carries no fields of its own; `<Blocks />` fills it from that global, per language ([Site files](site-files.md#globals)). |
| `_locales` | top of file, block, array item | The locales this exists in, e.g. `["de"]`: on a block, the files it is written to; at the top of a file, the languages the entry is offered in ([Translating](translating.md#turning-a-language-off)). Absent means all. Never empty. |

Reading a file checks these: a `_status` other than `hidden`, a malformed `_id`, an empty
`_locales` or a top-level key on a block fails with an error naming the path, such as
`blocks[0]._id: expected eight characters from 0-9a-z, got "ABCDEFGH"`.

## A key your schema no longer declares

Editing an entry keeps every key the file already had, including one the schema has
stopped declaring: the editor writes back the file it read, not the fields it drew. A
field you rename in `schemas.ts` before writing its `handover migrate` step therefore
keeps its old value until the migration moves it, rather than being dropped on the first
save.

## Block ids

Every block and array item carries an `_id`. Drafts, translations and `_machine` paths
address items by id, never by position, so reordering changes nothing but the order.
The same item has the same `_id` in every locale file; that is what lets the admin show
two languages side by side.

Duplicating an entry gives every item a new `_id`, the same new id in every locale of the
copy, and leaves the original's address behind so the copy is served under its new file
name. Write a template or a fixture with ids of your own, or leave them out — the admin
fills them in on first save.

## What happens to a file afterwards

Hiding an entry, creating one, renaming it and deleting it are the same files under the same
rules, one step further on: [Entry lifecycle](entry-lifecycle.md).
