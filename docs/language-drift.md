# When the languages disagree

Opening an entry that has [more than one language](translating.md) compares the languages it has files
in and reports every block they disagree about — one language having a block the others do not with nothing to say so, or a block in a
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
Changing the interface language while deciding keeps each selected answer and focused control;
an already-visible changed-entry or apply refusal is rendered again in the new interface language.
