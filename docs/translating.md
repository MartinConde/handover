# Translating

What the admin does with the languages [Languages](i18n.md) declares. A site that declares one
sees none of it: no switcher, no second column, no languages in the entry list. The rule is on
the config and not the data, so a site that declares two and has written one still draws all of
it — the missing translation is the thing to see.

## Choosing a language

An entry opens on the language it is written in, and the header offers the others — buttons up
to four languages, a menu above that. **The language an entry is written in is the entry's own,
not the site's**: the default language where the entry has a file in it, and otherwise the first
language it does. That is the language whose form carries the structure and the one every
translation is made from. Nearly always it is the site's default; where it is not — a legal
notice written in German on a site that defaults to English — the entry opens in German and
offers *Create from German*. Which language a URL carries the segment of stays the site's answer.

A hollow ring means no file for this entry, a filled one a translation the source language has
moved on from since, and a finished language carries no mark. A language turned off for the
entry is struck through, and choosing it says so.

## A language with no file yet

Choosing one draws the two ways out rather than an empty form, which would autosave a file
nobody asked for.

**Create from English** — from whichever language the entry is written in — writes that
language's file: the same blocks in the same order, every value the languages share, and the text
fields empty. It is a draft like any other, so nothing is in the repository until you publish,
and what the schema still wants of it is ordinary validation until then. The entry's
**Publish…** is offered the moment the file is written, without the column being typed in.

**Not offering the entry in that language** is the other answer: some pages genuinely belong to
one market. No file is written for it, and the languages it is offered in go into the files it
does have:

```yaml
_locales:
  - "en"
name: "Theo Adeyemi"
```

Turning the language back on takes the key out again — an entry offered in every language the
site declares carries none. A language that already has a file cannot be turned off, since that
is deleting the file, which is what Delete is for.

Because the key is written into every file the entry has, a hand edit or a bad merge can leave
it disagreeing with them. **The files win** — a language with a file is offered in it whatever
the key says — and the entry says so above its form rather than striking the language through in
the list and letting you type in it anyway. A code the site does not declare is named the same
way; both are fixed in the repository.

## Side by side

**Side by side** puts the second language beside the first: the entry's own language on the
left, the chosen one on the right. They are separate files and separate saves — each column
autosaves its own, and publishing takes both. Which language is on the right and whether the
column is open are two different things: with the entry's own language chosen, it shows the
first of the others.

## What a save of a translation writes

A translation's form shows the fields that language owns. Saving it writes those and reads
everything else off the file as it stands, so a shared value is never lost for not having been on
screen. The structure — which blocks an entry has, in which order — is the same in every language,
and a save of a translation does not change it.

The right-hand column draws that: a shared field is shown as the value the languages share
rather than as something to type over, a field the entry's own language keeps to itself is not
drawn at all, and a link offers its label and not where it points. Blocks are there to translate
but not to add, remove or reorder. Pickers whose translated half has no editor yet — an image's
`alt`, a file's name — are left out.

## When the languages disagree

Opening the entry compares the languages it has files in and reports every block they disagree
about — one language having a block the others do not with nothing to say so, or a block in a
language its `_locales` does not name ([Languages](i18n.md#a-block-one-language-only-has)).
**Publishing an entry with one of those is refused** ([Drafts and
publishing](publishing.md#publishing)) and the drawer marks the row *Languages disagree*. Nothing
is lost: the edits stay where they are until the files agree. The entry opens on a panel instead
of its form, with one card per block and the answers it allows:

| The block | The answers |
|---|---|
| In German, missing from English, marked nothing | Add it to English · Keep it in German only · Remove it from German |
| Marked `_locales: [de]` and in the English file too | Remove it from English · Let it be in every language |

They are not a fixed three: they come from which languages have the block against which should
have it, so a block missing from two languages offers to arrive in both. *Add it to English*
writes the block with the values every language shares and nothing to read yet, so what the
schema still wants is ordinary validation rather than another refusal; *Keep it in German only*
writes `_locales`, leaving a mark that names a language the entry has no file in alone. Each card
shows what every language has written in the block, so *Remove it from English* is answered
against the words it would lose. Answering every card writes each language the answers change in
one go, and the banner goes because the next read has nothing to report.

## A machine's first draft

With something to translate with configured, the second language's header offers **Translate
what's empty** and each field a **Translate** button; the offer a language with no file draws
gains **Create and pre-fill**, which writes the file and fills it in one go. Only prose is sent —
the fields that column draws as something to type in. A shared value, a source-only field and
where a link points are not translations.

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
([Deploying](deploy.md#secrets)); another provider goes in `i18n.translate`
([Configuration](configuration.md#i18n)). With neither, none of the buttons above is drawn.

## When the source language moves on

A translation is made from the entry's own language as it stood at some moment, and writes that
moment down — the language it came from, the git blob SHA of that language's file, a hash of the
values a translation is made from, and when the publish wrote it:

```yaml
_version: 1
_i18n:
  sourceLocale: "en"
  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"
  sourceHash: "8a41c0b2e9d7f350"
  translatedAt: "2026-08-23T10:14:00Z"
title: "Startseite"
```

It goes in when a publish commits a translation somebody has typed into, and names the source
file as that commit leaves it. A file the publish only carries along — the German rewritten
because English added a block or a shared value changed — keeps the mark it had.

The source moving on afterwards is what makes the translation **stale**: opening the entry hashes
the source it now has and compares. A shared value, a source-only field, a block moved and the
same file requoted all leave the hash where it was — none is anything to retranslate; a heading
edited or a block added changes it. It is only ever a warning: a stale translation publishes,
builds and serves like any other file, and the mark stays until somebody translates it again.

## In the entry list

Each row carries one chip per language, in the order the site declares them: filled where the
entry has a file in that language, outlined where it has none, struck through where the entry is
not offered in it — and not drawn at all on a site with one language. An entry written in one
language only is listed by the words it has, whichever language they are in, and opens in that
language.
