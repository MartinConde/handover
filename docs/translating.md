# Translating

What the admin does with the languages [Languages](i18n.md) declares. A site that declares one sees
none of it: no switcher, no second column, no languages in the entry list. The rule is on the
config and not the data — a site that declares two and has written one draws all of it, because
the missing translation is the thing to see.

## Choosing a language

An entry opens on the language it is written in, and the header offers the others — buttons up
to four languages, a menu above that. **The language an entry is written in is the entry's own,
not the site's**: the default language where the entry has a file in it, and otherwise the first
language it does. That is the language whose form carries the structure and the one every
translation is made from. Nearly always that is the site's default; a legal notice written in
German on an English site opens in German and offers *Create from German*. Which language a URL
carries the segment of stays the site's answer.

A hollow ring means no file for this entry, a filled one a translation the source language has
moved on from since, and a finished language carries no mark. A language turned off is struck
through, and choosing it says so.

## A language with no file yet

Choosing one draws the two ways out rather than an empty form, which would autosave a file nobody
asked for. **Create from English** — from whichever language the entry is written in — writes that
language's file: the same blocks in the same order, every value the languages share, and the text
fields empty. It is a draft like any other, so nothing is in the repository until you publish, and
what the schema still wants of it is ordinary validation until then. The entry's **Publish…** is
offered the moment the file is written, without the column being typed in.

## Turning a language off

Some pages genuinely belong to one market. The languages an entry is offered in go into the files
it does have, and nothing is written for the ones it is not offered in:

```yaml
_locales:
  - "en"
name: "Theo Adeyemi"
```

On a language with no file that is the link beside *Create from English*, and turning it back on
takes the key out again — an entry offered in every language the site declares carries none. On a
language that **has** a file it is a delete of that file, so it is asked for where the file is:
the second column's header offers **Turn German off**, and confirming it commits. The file leaves
the repository, the mark goes into the files that stay, the URL that language served redirects to
the collection's listing page under its own language segment, and unpublished changes to it go
with it. Where the collection has no listing page the dialog says so before you press — the old
URL will 404.

**The last language an entry has a published file in cannot be turned off**: that is deleting the
entry, and Delete asks where its readers should go for all of it at once. A language whose file is
only a draft is not one the entry has yet — publish it first. The language the entry is written in
can go while another still has a file: what is left becomes the language it is written in, and an
`_i18n` naming the one that went is dropped with it.

A hand edit or a bad merge can leave the key disagreeing with the files. **The files win** — a
language with a file is offered in it whatever the key says — and the entry says so above its
form instead of striking the language through in the list and letting you type in it anyway. A
code the site does not declare is named the same way; both are fixed in the repository.

## Side by side

**Side by side** puts the second language beside the first: the entry's own language on the left,
the chosen one on the right. They are separate files and separate saves — each column autosaves
its own, and publishing takes both. Which language is on the right and whether the column is open
are two different things: with the entry's own language chosen, it shows the first of the others.

## What a save of a translation writes

A translation's form shows the fields that language owns. Saving it writes those and reads the
rest off the file as it stands, so a shared value is never lost for not having been on screen. The
structure — which blocks an entry has, in which order — is the same in every language, and a save
of a translation does not change it.

The right-hand column draws that: a shared field is shown as the value the languages share rather
than as something to type over, a field the entry's own language keeps to itself is not drawn at
all, and a link offers its label and not where it points. Blocks are there to translate but not to
add, remove or reorder, and the navigation menus are drawn the same way: the tree as one box a
row, for the labels alone, with items added and moved in the other column. Pickers whose
translated half has no editor yet — an image's `alt`, a file's name — are left out.

## When the languages disagree

Opening the entry compares the languages it has files in and reports every block they disagree
about — one language having a block the others do not with nothing to say so, or a block in a
language its `_locales` does not name ([Languages](i18n.md#a-block-one-language-only-has)).
**Publishing an entry with one of those is refused** ([Drafts and
publishing](publishing.md#publishing)) and the drawer marks the row *Languages disagree*; nothing
is lost, since the edits stay where they are until the files agree. The entry opens on a panel
instead of its form, with one card per block and the answers it allows:

| The block | The answers |
|---|---|
| In German, missing from English, marked nothing | Add it to English · Keep it in German only · Remove it from German |
| Marked `_locales: [de]` and in the English file too | Remove it from English · Let it be in every language |

They are not a fixed three: they come from which languages have the block against which should
have it, so a block missing from two languages offers to arrive in both. *Add it to English* writes
the block with the values every language shares and nothing to read yet, so what the schema still
wants is ordinary validation rather than another refusal; *Keep it in German only* writes
`_locales`. Each card shows what every language has written in the block, so *Remove it from
English* is answered against the words it would lose. Answering every card writes each language
the answers change in one go, and the banner goes because the next read has nothing to report.

A menu label is the one translated value a machine is never offered: an empty box is not a gap
but *use the page's own title*, and that title is already translated.

## A machine's first draft

With something to translate with configured, the second language's header offers **Translate
what's empty** and each field a **Translate** button; the offer a language with no file draws gains
**Create and pre-fill**, which writes the file and fills it in one go. Only prose is sent — the
fields that column draws as something to type in; a shared value, a source-only field and where a
link points are not translations.

What a machine wrote is written down in the file:

```yaml
_machine:
  - "title"
  - "blocks[_id=k3nf9a2p].heading"
```

Those fields are badged **Machine translated** in the form, and the badge comes off one field at
a time: the first save after somebody types in one takes its path out of the list. Nothing about
it blocks anything — a machine-filled translation publishes like any other file, and publishing
one stamps `_i18n` below. **Configuring it** is one secret, `DEEPL_API_KEY`
([Deploying](secrets.md)); another provider goes in `i18n.translate`
([Configuration](configuration.md#i18n)). With neither, none of the buttons above is drawn.

The site's owner can paste a DeepL key of their own into **Settings** without a deploy, and that
one is used ahead of `DEEPL_API_KEY` ([Integrations](diagnostics.md#integrations)). A site that
hands in its own `i18n.translate` is translated by that code whatever is stored there.

## When the source language moves on

A translation is made from the entry's own language as it stood at some moment, and writes that
moment down:

```yaml
_i18n:
  sourceLocale: "en"
  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"
  sourceHash: "8a41c0b2e9d7f350"
  translatedAt: "2026-08-23T10:14:00Z"
```

It goes in when a publish commits a translation somebody has typed into, and names the source
file as that commit leaves it. A file the publish only carries along — the German rewritten
because English added a block or a shared value changed — keeps the mark it had.

The source moving on afterwards is what makes the translation **stale**: opening the entry hashes
the source it now has and compares. A shared value, a source-only field, a block moved and the same
file requoted all leave the hash where it was — none is anything to retranslate; a heading edited
or a block added changes it. It is only ever a warning: a stale translation publishes, builds and
serves like any other file, and the mark stays until somebody translates it again.

Side by side, each field the source has moved on from carries an amber marker of its own. Opening
one shows that field's source as it read when somebody translated it and as it reads now, with the
words that went and the words that arrived marked; **Re-translate** runs the provider for that one
field, and **Dismiss** takes the marker off until the entry is opened again. The older source is
read from the blob the mark names, so it is the exact bytes the translation was made from.

The [dashboard](dashboard.md) counts them per language. That count is taken at build over every
file, so it is the last build's rather than today's: the warning in the editor is the live one.

## In the entry list

Each row carries one chip per language in the site's own order: filled where the entry has that
file, outlined where it has none, struck through where it is not offered in that language, and not
drawn at all on a one-language site. An entry written in one language only is listed by the words
it has, whichever language they are in, and opens in that language.
