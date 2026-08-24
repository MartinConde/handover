# Translating

What the admin does with the languages [Languages](i18n.md) declares. A site that declares one
of them sees none of it: no switcher, no second column, no languages in the entry list — the
admin looks exactly like one with no translation in it. The rule is on the config and not on
the data, so a site that declares two languages and has written only one still draws all of it,
because the missing translation is the thing to see.

## Choosing a language

An entry opens on the default language, and the header offers the others — buttons up to four
languages, a menu above that. A language marked with a hollow ring has no file for this entry;
a filled one has a translation the default language has moved on from since. A language that is
finished carries no mark, so an entry nobody has to look at is quiet.

A language turned off for the entry is struck through, and choosing it says so.

## A language with no file yet

Choosing one draws the two ways out rather than an empty form — an empty form would autosave a
file nobody asked for.

**Create from English** — from whichever language is the default — writes that language's file:
the same blocks in the same order, every value the languages share, and the text fields empty.
It is a draft like any other, so nothing is in the repository until you publish, and what the
schema still wants of it is listed as the entry's ordinary validation problems until then. The
entry's **Publish…** is offered the moment the file is written, without the column being typed
in: it is one of the entry's languages waiting like any other.

**Not offering the entry in that language** is the other answer, and a different one: some
pages genuinely belong to one market. No file is written for it, and the languages the entry is
offered in go into the files it does have:

```yaml
_locales:
  - "en"
name: "Theo Adeyemi"
```

Turning the language back on takes the key out again — an entry offered in every language the
site declares carries none. A language that already has a file cannot be turned off, since that
would be deleting the file, which is what Delete is for.

## Side by side

**Side by side** puts the second language beside the first: the default language's form on the
left, the chosen language's on the right. The two are separate files and separate saves — each
column autosaves its own, and publishing takes both.

Which language is on the right and whether the second column is open are two different things:
with the default language chosen, the second column shows the first of the others.

## What a save of a translation writes

The form of a language other than the default shows the fields that language owns. Saving it
writes those and reads everything else off the file as it stands, so a shared value is never
lost for not having been on screen. The structure of an entry — which blocks it has, in which
order — is the same in every language, and a save of a translation does not change it.

The right-hand column draws that: a field the languages share is shown as the value they share
and not as something to type over, a field the default language keeps to itself is not drawn at
all, and a link offers its label and not where it points. Blocks are there to translate but not
to add, remove or reorder — that is the left-hand column's, in every language at once.

Pickers whose translated half has no editor yet — an image's `alt`, a file's name — are left out
of the second column rather than shown as the first language's value.

## When the languages disagree

Opening the entry compares the languages it has files in and reports every block they disagree
about — one language having a block the others do not with nothing to say so, or a block in a
language its `_locales` does not name ([Languages](i18n.md#a-block-one-language-only-has)).
**Publishing an entry with one of those is refused**
([Drafts and publishing](publishing.md#publishing)), because committing a file that disagrees
with its other languages would bake the difference into git — the drawer marks the row
*Languages disagree*. Nothing is lost: the edits stay where they are until the files agree.

### Making them agree

The entry itself is where that happens. It opens on a panel instead of its form — the form is
about a structure the languages have not settled — with one card per block they disagree about
and the answers that block allows:

| The block | The answers |
|---|---|
| In German, missing from English, marked nothing | Add it to English · Keep it in German only · Remove it from German |
| Marked `_locales: [de]` and in the English file too | Remove it from English · Let it be in every language |

They are not a fixed three: they come from which languages have the block against which should
have it, so a block missing from two languages offers to arrive in both. *Add it to English*
writes the block into that file with the values every language shares — an image's `src`, a
price — and nothing to read yet, so what the schema still wants shows up as the entry's ordinary
validation problems rather than another refusal. *Keep it in German only* writes `_locales`;
a mark naming a language the entry has no file in is left alone rather than narrowed to the
languages it does have. Answering every card writes each language the answers change, in one
go. Nothing is marked resolved — the entry is read again, and the banner goes because there is
no longer anything to report.

Each card shows what every language has written in the block, so *Remove it from English* is
answered against the words it would lose rather than against a file name.

## A machine's first draft

With something to translate with configured, the second language's header offers **Translate
what's empty** and each field a **Translate** button; the offer a language with no file draws
gains **Create and pre-fill**, which writes the file and fills it in one go. Only prose is
sent — the fields that column draws as something to type in. A shared value, a field the
default language keeps to itself, and where a link points are not translations.

What a machine wrote is written down in the file:

```yaml
_machine:
  - "title"
  - "blocks[_id=k3nf9a2p].heading"
```

Those fields are badged **Machine translated** in the form, and the badge comes off one field
at a time: the first save after somebody types in one takes its path out of the list. It is in
the file rather than the database so a diff shows it and a lost database does not lose it.

Nothing about it blocks anything — a machine-filled translation publishes like any other file,
and publishing one stamps `_i18n` below, since a value the two languages disagree about is
what says the translation is of this English and not an older one.

**Configuring it** is one secret: `DEEPL_API_KEY` ([Deploying](deploy.md#secrets)). Another
provider goes in `i18n.translate` ([Configuration](configuration.md#i18n)). With neither, none
of the buttons above is drawn.

## When the source language moves on

A translation is made from the default language as it stood at some moment, and the translated
file writes that moment down:

```yaml
_version: 1
_i18n:
  sourceLocale: "en"
  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"
  sourceHash: "8a41c0b2e9d7f350"
  translatedAt: "2026-08-23T10:14:00Z"
title: "Startseite"
```

| Key | What it is |
|---|---|
| `sourceLocale` | The language this file was translated from. |
| `sourceBlob` | The git blob SHA of that language's file: the exact bytes, which git can hand back on their own. |
| `sourceHash` | A hash of the values inside those bytes that a translation is made from. |
| `translatedAt` | When the publish wrote this. |

It goes in when a publish commits a translation somebody has typed into, and names the source
language's file as that same commit leaves it. A file the publish only carries along — the
German rewritten because English added a block, or because a shared value changed — keeps the
mark it had, since neither of those is somebody translating.

English moving on afterwards is what makes the German **stale**: opening the entry hashes the
English it now has and compares. A shared value, a field the default language keeps to itself, a
block moved, and the same file written with different quoting all leave the hash where it was —
none of them is anything to retranslate. A heading edited, or a block added, changes it.

It is a warning and only ever a warning. A stale translation publishes, builds and serves
exactly like any other file; the mark stays where it is until somebody translates the entry
again. The two values are there for different questions: `sourceHash` answers *stale or not*,
and `sourceBlob` is what a per-field "changed since translated" can later fetch the old English
from.

## In the entry list

Each row carries one chip per language, in the order the site declares them: filled where the
entry has a file in that language, outlined where it has none, struck through where the entry is
not offered in it. The column is not drawn at all on a site with one language. An entry written
in one language only is listed by the words it has, whichever language they are in.
