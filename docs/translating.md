# Translating

What the admin does with the languages [Languages](i18n.md) declares. A site that declares one sees
none of it: no switcher, no second column, no languages in the entry list. The rule is on the
config and not the data — a site that declares two and has written one draws all of it, because
the missing translation is the thing to see.

A first draft from a machine, and what happens when the source language moves on after a
translation was made, are [a page of their own](machine-translation.md).

Which language an entry is written in, and changing it, is [The source
language](source-language.md); what the entry list shows about each language, and working through
one language entry by entry, is [Translations in the entry list](translation-list.md).

All Handover-owned controls on this screen follow the account's interface language, including
content-language names, missing/off/stale indicators, the translation column, and the block-drift
decision panel. Changing the interface language keeps the selected content language, open column,
typed values, focused field, drift answers and pending work. It does not create a content file or
send a translation request. A one-content-language site still keeps the interface-language picker,
but continues to show none of the content-language controls described below.

## Choosing a language

**New entry** asks which language to write the entry in whenever the site declares more than
one. It starts on the language the list is filtered to, or on the site's default language, and
the entry is created in the one chosen: writing a legal notice in German makes German its
source, and creating its English file later leaves it German.

An entry opens on the language it is written in, and the header offers the others — buttons up
to four languages; from five, a button naming the current language opens a list of them all,
with the same marks, and Escape closes it. **The language an entry is written in is the entry's own,
not the site's**: the language it was first written in, recorded in its files as `_source`
([Languages](i18n.md#which-language-an-entry-is-written-in)). That is the language whose form
carries the structure and the one every translation is made from. Nearly always that is the
site's default; a legal notice written in German on an English site opens in German and offers
*Create from German*, and creating its English file keeps it German. Which language a URL
carries the segment of stays the site's answer.

A hollow ring means no file for this entry, a filled one a translation the source language has
moved on from since, a half-filled one a file that answers only part of the source's text, and
a finished language carries no mark. One mark each, in that order: a stale file that is also
partly written shows as stale. A language turned off is struck through, and choosing it says so.

### How much is written

The column of a translation says how much of the source it answers — *3 of 5 texts written* —
and counts again as either column is typed in, before anything is saved. The count is the
source's own text that is stored and not empty: text and rich-text fields, a link's label, an
image's alt text, a file's name, a video's title, and the SEO title, description and image alt
text, inside groups, blocks and lists too. Rows are matched by their id, so a moved block still
counts. It leaves out what the language does not own — shared and source-only values, numbers,
dates, choices, references — and menu labels and empty SEO fields, since blank there means *use
the page's own title*. Whitespace, and rich text with no words in it (an empty list or quote),
answer nothing; text only the translation has adds nothing. A source with none of that text
reads *No source text to translate*. The count says what is typed, not that the translation is
reviewed or that the entry can be published. The entry list and the dashboard count the same way,
unpublished changes included, and the list can be filtered to the partly written files of one
language ([Translations in the entry list](translation-list.md)).

## A language with no file yet

Choosing one draws the two ways out rather than an empty form, which would autosave a file nobody
asked for. **Create from English** — from whichever language the entry is written in — writes that
language's file: the same blocks in the same order, every value the languages share, and the text
fields empty. The new file records the language it was made from, so adding a language — the
site's default included — never changes which one the entry is written in, and **Translate** keeps
translating from it. It is a draft like any other, so nothing is in the repository until you publish, and
what the schema still wants of it is ordinary validation until then. The entry's **Publish…** is
offered the moment the file is written, without the column being typed in, and its dialog can
[leave the new language for later](publishing.md#publishing) while the rest of the entry publishes.

With two or more offered languages still missing, the offer adds **Create all 3 missing
languages**. It writes each one in the order `locales` lists them, one after another, and reads
the entry again once at the end; a language turned off or already written is left alone. The
fields, the language switcher and the entry's other actions wait while it runs. It stops at the
first language that is refused or whose answer is lost, and a line above the entry says what
happened to each: created, not created, or not attempted. The reload settles a lost answer — the
language reads *created* if its file is there. Running it again writes only what is still missing,
so it never replaces a language that has a file.

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
the second column's header offers **Turn German off**, which asks where that language's readers
go — the same four answers Hide gets: the collection's listing page under its own language
segment, another page, a web address, or nowhere — and confirming it commits. The file leaves the
repository, the mark goes into the files that stay, the URL that language served redirects where
you answered, and unpublished changes to it go with it. Where the collection has no listing page,
*nowhere* is the answer offered first. A turn-off the CMS refuses — on the last language the entry is published in, say —
keeps the dialog open with the reason (*publish en first, or Delete the entry*).

**The last language an entry has a published file in cannot be turned off**: that is deleting the
entry, and Delete asks where its readers should go for all of it at once. A language whose file is
only a draft is not one the entry has yet — publish it first. **Nor can the language the entry
is written in**: the CMS refuses before writing anything. A translation made from a language
that goes keeps its `_i18n` and reads stale until somebody translates it again from the source.

A hand edit or a bad merge can leave the key disagreeing with the files. **The files win** — a
language with a file is offered in it whatever the key says — and the entry says so above its
form instead of striking the language through in the list and letting you type in it anyway. A
code the site does not declare is named the same way; both are fixed in the repository.

## Side by side

**Side by side**, under *Beside the form*, puts the second language beside the first: the entry's own language on the left,
the chosen one on the right. They are separate files and separate saves — each column autosaves
its own, and publishing takes both. Which language is on the right and whether the column is open
are two different things: with the entry's own language chosen, it shows the first of the others.
With two or more other languages, the right column's heading is a button that lists them, with the
same marks as the header, so you can change the language on the right without leaving side by side
or moving the left column. Typing in the old language is saved first; if that save fails, the
column stays where it is.
A block moved, added or removed on the left moves on the right at once, and a shared value reads on
the right as it is typed — the same walk the save makes into the other language's stored draft.

### A third language beside each field

When the entry has files in other languages too, the right column's header offers **Beside each
field**. Choose a language and every text the column translates shows that language's words
under its input, read only. A French translator working from English can check the German
wording without leaving the field. It covers the texts the count covers: text and rich text,
link labels, alt text, file names, video titles and SEO text, in blocks and lists too. Rows are
matched by their id, so a row the French file has in another order still shows its own German
text. A German field with nothing in it reads *Not written in German yet*, and a row German does
not have reads *This row is not in German*.

The list offers only languages with a file, other than the entry's own language and the one being
written, each with its header mark. It shows the language as it is saved, including changes not
yet published. The choice is remembered in this browser for each site and account. A remembered
language that is now the column's own, or has no file, shows *None* until it can be offered again.
It never changes what **Translate** translates from, and nothing typed is written to that language.

### Working through what is left

The right column's **Next to do** goes to the next text the language still owes: one that is
empty, or one the source has changed since it was translated. `Alt` + `↓` anywhere in the column
does the same without the button. Each press puts the cursor in the field itself, opening a folded
block or switching to the SEO tab when that is where the text is; after the last one it comes back
to the first and says so. Typing an answer takes that field out of the run at once, and a changed
text leaves it when its marker is dismissed
([the amber markers](machine-translation.md#when-the-source-language-moves-on)).
Reading a field is not answering it, and only a language with nothing outstanding says *Nothing
left to do*.

## What a save of a translation writes

A translation's form shows the fields that language owns. Saving it writes those and reads the
rest off the file as it stands, so a shared value is never lost for not having been on screen. The
structure — which blocks an entry has, in which order — is the same in every language, and a save
of a translation does not change it.

The right-hand column draws that: a shared field is shown as the value the languages share rather
than as something to type over, a field the entry's own language keeps to itself is not drawn at
all, and a link offers its label and not where it points. Blocks are there to translate but not to
add, remove or reorder, and the navigation menus are drawn the same way: the tree as one box a
row, for the labels alone, with items added and moved in the other column. A picture, a file
and a video stay the ones the source chose; their alt text, name and title are the translation's
to write.

## When the languages disagree

Blocks the languages of an entry disagree about are [a page of their own](language-drift.md).

A menu label is the one translated value a machine is never offered: an empty box is not a gap
but *use the page's own title*, and that title is already translated.
