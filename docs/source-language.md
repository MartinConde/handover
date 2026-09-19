# The source language

Every entry is written in one language, its source: the form on the left of [side by
side](translating.md#side-by-side), the language the structure is edited in, and the one machine
translation translates from ([Languages](i18n.md#which-language-an-entry-is-written-in)). This page
covers files that disagree about it, and changing it on purpose.

## When the files disagree about the source language

Every file of an entry names the language it is written in as `_source`. When those disagree —
usually because a file was edited or merged outside the CMS — the entry opens on a panel instead
of its form, and nothing is chosen for you. The panel says which problem it is and what each
file says:

| The files | The panel |
|---|---|
| name two different languages | *Which language is the source?* |
| name a language the site does not declare | *The source language isn't declared* |
| name a language the entry has no file in | *The source language has no file* |

Until it is settled the entry cannot be saved, translated, turned off in a language, held,
hidden, renamed or duplicated, and nothing publishes it; deleting it or discarding its unpublished
changes still works. The drawer says why: the check reads *The files of this entry disagree about which
language it is written in*.

There are two ways out. Choose on the panel: *Make one of them the source* lists every language
the entry has a file in and is offered in, and *Make German the source* writes every file as an
unpublished change naming German, then opens the entry; translations made from another language
read as needing a look. Or fix it in the repository — every file's `_source` has to name the same
language, and that language needs a file (put a deleted one back) — and the entry opens again as
it was. Changing the interface language keeps the panel and the language chosen on it.

## Changing the language an entry is written in

An entry keeps its source when languages are added, removed or reordered, and opening side by
side never changes it. Making German the source of an English entry is its own action: **⋯ →
Change source language…** in the entry's header, drawn on a site with two or more languages for
an entry with files in two or more. The dialog lists every other language; one that cannot be
chosen says why — *No file yet*, *Turned off for this entry*, or its problems once it takes the
source's shared and source-only values. *What happens* spells out, for the language chosen, which
translations stay up to date and which will need a look. *Make German the source* saves unsaved
typing first and sends nothing if that fails; the entry then reopens in German with the notice
*German is now the source. It is on the site when you publish this entry*. The menu entry is
greyed out with the reason while the languages disagree about the blocks or a save has failed,
and the whole menu is closed while somebody else has the entry open. If somebody changed the
entry meanwhile nothing is written and the dialog offers *Reload*; if the answer never arrived,
editing stays closed until you reload, because the change may have gone through.

The same change is a request of its own
([`POST …/source`](admin-api-entries.md#changing-the-language-an-entry-is-written-in)), refused
while German has no file, is turned off, would fail the schema, or holds its own value in a
field only the source keeps, and while the languages disagree about the blocks. Every file
becomes an unpublished change and nothing on the site moves until the entry is published, with
every language going out together. Before that, discarding the entry's changes puts it back.
German then carries the structure, the shared and source-only values it took from English, and
its own words; English keeps its words, and machine translation translates from German.
[Machine translation](machine-translation.md#when-the-source-language-changes) says which
translations read stale afterwards.
