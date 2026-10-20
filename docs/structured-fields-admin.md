# Structured fields in the admin

How the editor draws the [structured fields](structured-fields.md): groups, lists and blocks,
references, embeds and the SEO tab. Pictures and files have their own page,
[Pictures and files in a field](media-fields.md).

`group` is a collapsible fieldset. An `array` is a list of rows with Add, Remove and move
up / down buttons — the first row's up and the last row's down are disabled. Every row
keeps its `_id` across moves; a new row gets a fresh one. A `blocks` field is the same list
of cards, each headed by its `_label` or `_type`, and Add block offers one button per type
in your registry in a wide, responsive dialog, including inside nested lists. The choices
scroll independently, keeping the heading and Cancel action visible. Cancel or Escape closes it
without adding a block and returns focus to Add block. Reordering never rewrites an `_id`, so translations and `_machine` paths
keep pointing at the same block.

Existing blocks and object-list items start collapsed, with a content summary so editors
can scan the page before choosing a section. Open any number of cards independently;
simple lists such as paragraphs stay directly editable. New and duplicated items open
for editing. Cards with validation problems open automatically, and field links and
translation jumps reveal the nested field before focusing it.

Group counts, list empty states, row actions, block controls, references, link controls, embed
guidance and the SEO panel follow the account's interface language. Switching English/Deutsch
updates open block and page pickers, an embed replacement with a retained refusal, SEO notices and
compact Handover-owned dates in place. Nested and repeatable input nodes, focus, selections and
values stay where they are; no entry-directory reread or content write is caused by the switch.
Option values, entry titles, paths, filenames, URLs and edited content remain exactly as authored;
schema labels and block type names switch only where the site gives one per language. “Same in every language” describes shared structure; it changes
language as interface text but does not duplicate or rewrite the stored value.
Link-choice and row-action sentences translate as complete phrases around authored field names and
row numbers. SEO meters always describe the plural configured limit, even when one character has
been entered.

Rich-text toolbar names, link controls and the read-only explanation for Markdown outside a
field's tier follow the interface language. Switching English/Deutsch keeps the same editor,
focus, selection, active formatting, Markdown, undo history and open link draft. It does not write
content or reread the entry directory. The field's label, written text and link addresses remain as
authored; `##` / `###` heading levels and Markdown syntax do not change with the interface.
The same rule applies inside Canvas: toolbar and compact link-editor text, attributes, search states,
unsafe-address guidance and retained failures update in place. A lazy Canvas rich-text editor opens
in the latest language without recreating the edited content or its history.

`reference` is a search box over the collection its schema names, one row per entry with
the languages that entry has a file in. Choosing one stores `collection/slug`; the chosen
row shows the entry's title beside the path it stores, and Change reopens the search. A
language that is being translated is not shown the field at all — an entry points at the
same entry in every language.

`embed` is one box: paste a YouTube, Vimeo or Google Maps link and it becomes a card with
the provider's name, the id that was stored and — for YouTube — the provider's own still.
Under it are the `title` the frame is named by and the second the video starts at. **Change**
puts the box back with the card still under it, so a link that is not recognised leaves the
video you had; a link from anywhere else is refused with the list of what is accepted, and
nothing is stored until one parses. YouTube's `watch`, `youtu.be`, `shorts`, `embed` and `live`
links all parse. Three Google Maps links are refused with a sentence saying what to do instead: a
shortened `maps.app.goo.gl` one, Google's own embed code, and a map dragged to somewhere
(`/maps/@lat,lng`) — a view with no place on it. A language that is being translated gets the title and
nothing else — the video is the same in every language. What the page does with the value is
[`<Embed />`](rendering.md#videos-and-maps).
The parser keeps its existing English `refused` sentence for older callers and also returns a stable
`reason`; the admin uses that reason to present the same recovery in the selected interface language.

`seo` is a tab of its own rather than a row in the form, and what it draws is described in
[Search and sharing](seo.md#in-the-admin) along with the `<Seo />` that renders it.
Its search and social previews, meter guidance, canonical controls and visible no-index notice follow
the interface language. SEO title, description, canonical URL, image and preview content do not.

Make a structured field **required** and a new entry cannot be published until it is filled in.
Nothing typed is lost: the draft is stored anyway and the field is marked as a problem. Keep a
field required only when your site really cannot render without it
([Drafts and publishing](publishing.md#fields-the-schema-is-not-happy-with)).
