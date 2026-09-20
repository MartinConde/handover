# The dashboard

`/admin` is a state-of-the-site page: what changed, who changed it, what is waiting to go
out and how far behind the translations are. Nothing on it is configurable, and it adds no
tables — every tile is a read the admin already makes.

The dashboard and surrounding navigation follow the account's **Interface language**. Switching
between English and Deutsch updates tile headings, counts, loading/empty/error states, build
status, controls, dates, and accessibility labels in place. It does not reread dashboard data.
Entry titles, member names, content-language codes, and provider diagnostics stay exactly as
authored. Collection and global names switch where the site gives one per language
([Configuration](configuration.md#names-in-each-interface-language)). Activity-event sentences are still English during the staged migration.
Malformed successful dashboard and activity responses stay unavailable and retryable; they do not
erase an already-known tile value or masquerade as an empty result.

## Quick actions

Above the tiles, one button per collection — *New page*, *New listing* — opens the same New
entry dialog the collection's list opens: a title, the file name it will be saved under, and
the collection's starters beside Blank. Creating one lands on the new entry.

## The tiles

**Unpublished changes** — how many entries are waiting, how many of them somebody is
holding back, and how old the oldest one is. *Review and publish* opens the same drawer the
top bar's indicator opens ([pending-changes.md](pending-changes.md)).

**Build status** — the same pill the top bar wears, at tile size, with who published last
and when under it. *Revert this publish* is offered whenever the newest commit is one the
admin made; the top bar offers it only on a failed build, where it is the way out of one.

**Recently edited** — the last eight entries somebody touched, newest first. An entry with
unpublished changes reads *Edited by …*; one whose changes are already out reads *Published
by …*. A row somebody has open right now carries *… is editing*.

**Translation health** — per language, how many entries owe it a file, how many of its files are
partly written, how many were made from a source that has changed since, and how many still hold
text a machine wrote. One entry can be in several of these, so they are not added up. *Show*
beside a language opens
the entry list filtered to the rows that owe it ([Translations in the entry list](translation-list.md));
when more than one collection owes it there is one link per list, each named. Not drawn on a
site that declares one language. A language with none of these says *Up to date*, including the
site's default language: the source belongs to each entry and is not implied by the routing
default.

**Source languages** — owners only, and only while entries with files in two or more
languages do not record the language they are written in. *Review and record* opens a dialog
that says what gets recorded (always what the admin shows today), which translations will need
a look and why, and that unpublished changes are kept, then makes one commit
([i18n.md](i18n.md#recording-the-source-of-existing-entries)). It refuses, writing nothing, when
the repository moved while the dialog was open or somebody else is editing one of the entries.

**Recent activity** — the last ten rows of the [activity log](activity.md), which an editor
sees narrowed to their own events exactly as they do on that screen.

## Where "recently edited" comes from

A draft row is deleted once the build carrying it is live, so on a site where everything is
published there would be nothing left to list. The publish event is the record instead: it
names the entries it carried, capped at the eight the tile draws. A row written before this
landed names an entry only where the publish carried exactly one file, so the tile is thin
until the first publish after the upgrade.

That is also the line on each card in **Site settings**: who last touched that global, and
whether their edit is out yet.

## Where the translation counts come from

**Missing** is the content index with today's drafts over it — exact, and it counts only the
languages an entry is *offered* in. A language turned off for an entry is a decision, not a
gap ([i18n.md](i18n.md)).

**Partly written** and **machine translated** are the build's count of each file's text with
today's drafts over it, the same numbers the entry list reads, globals included.

**Stale** is taken at build, over every file in `src/content/`, and shipped with the content
index. Judging one language against another needs every file of the entry, which would be a
git read per entry per page load, so the count is the last build's: a translation you have
fixed but not published is still in it. The per-entry warning in the editor is live, and it
is the one to act on ([translating.md](machine-translation.md#when-the-source-language-moves-on)).

## What is not on it

There is no diagnostics line. Every connection check is a live call to GitHub, R2, DeepL or
the mailer, and nothing stores the result of one, so a verdict here would mean five external
calls on every landing. The [Settings screen](diagnostics.md) runs them when you open it.
