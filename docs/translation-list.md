# Translations in the entry list

With two or more languages the entry list shows what each entry still owes, and can take you
through one language entry by entry. The translating itself happens in the editor
([Translating](translating.md)).

Each row carries one chip per language in the site's own order: filled where the entry has that
file, outlined where it has none, struck through where it is not offered in that language, tinted
where the last build found the translation behind its source, and not drawn at all on a
one-language site. An entry written in one language only is listed by the words it has, whichever
language they are in, and opens in that language.

Above four languages a chip each stops reading at a glance, so a row shows how many language files
exist out of the languages the entry is offered in — `4/5` is *4 of 5 language files created*,
counting the source and files that are empty or stale, not translations finished — followed by up
to three chips for the languages still owed (missing or stale) in the site's order, and `+2` when
more are owed. Hovering the row's languages, or a screen reader, gives every language's state in
full. Sites with four languages or fewer keep one chip per language.

The **Language** filter in the toolbar narrows the list to the rows a language is still owed in,
and the filter beside it says which work: **Missing or stale** (the default), **Missing** (no
file yet) or **Stale** (a translation the last build found behind its source). A language turned
off for an entry is never owed in it. The second filter is off until a language is chosen. The
heading counts what is shown, of the total.

The address can set both: `/admin/c/listings?locale=de` opens the list on what German is owed,
which is where the dashboard's *Show* lands, and `?locale=fr&owed=stale` on the stale French
translations. `owed` takes `missing` or `stale`; any other value means missing or stale, and a
language the site does not declare filters nothing.

A row opened from a filtered list starts a queue for that language. The entry opens with the
language beside the source, on its *Create from …* offer when there is no file yet, and the right
column's heading has **Next in German**: the next entry further down the list that still owes
German the chosen work. The queue follows the whole collection in the list's order; the search
and the live or hidden filter do not carry over. It never goes back to earlier entries, so after
the last one the heading says *End of this queue*, which is not a claim that nothing above is
owed. Creating or publishing the translation, the Content, SEO and History tabs, and showing
another language in the right column all keep the queue and its place. The address carries it as
`?queue=de&owed=missing`, and a language the site does not declare means no queue. Next saves
what you typed first, and stays on the entry if that save fails.
