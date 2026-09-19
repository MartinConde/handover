# Machine translation and staleness

A first draft from a machine, and the mark that says a translation's source has moved on since
somebody made it. Both hang off the second language's column ([Translating](translating.md)).

Button text, language names, machine/stale badges, before-and-after headings, dates and retained
translation failures follow the account's interface language. Switching the interface language
does not restart a provider request, replace the translated field, or alter its authored value.
Handover keeps an unknown provider diagnostic separate from its translated recovery summary; when
a disconnected write cannot be confirmed, reload the entry before retrying it.

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
one is used ahead of `DEEPL_API_KEY` ([Translation and AI](diagnostics.md#translation-and-ai)). A site that
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

A mark has to name the language the entry is [written in](i18n.md#which-language-an-entry-is-written-in).
One that names another language is stale however current it is against that language, because
nothing says it matches the source: a German translation made from French reads stale in an
entry written in English. Turning French off leaves that mark in place, so it goes on reading
stale rather than vanishing. Side by side there is nothing to compare field by field, and the
column's header says *Translated from French — the source is now English* instead. After an
upgrade this is how a translation made from another translation first appears;
[recording source languages](i18n.md#recording-the-source-of-existing-entries) settles those it can and tells
you beforehand how many will read stale.

Side by side, each field the source has moved on from carries an amber marker of its own. Opening
one shows that field's source as it read when somebody translated it and as it reads now, with the
words that went and the words that arrived marked; **Re-translate** runs the provider for that one
field, and **Dismiss** takes the marker off until the entry is opened again. The older source is
read from the blob the mark names, so it is the exact bytes the translation was made from.

The [dashboard](dashboard.md) counts them per language. That count is taken at build over every
file, so it is the last build's rather than today's: the warning in the editor is the live one.

## When the source language changes

Making German the source of an English entry
([the route](admin-api-entries.md#changing-the-language-an-entry-is-written-in)) moves a mark only
where nothing is lost by it. When German was up to date with English, English is marked as
translated from German as it is now, dated at the change, and so is every translation that was up
to date with English, keeping its own `translatedAt`. When German was behind or never marked,
no mark moves and English gets none: every translation still names English, so each reads stale
until it is translated again. German loses its own mark, being the source. No words change,
`_machine` included.
