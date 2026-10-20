# Preview in the editor

What the editor shows around a preview once [it is on](preview.md#turning-it-on).

## Beside the form, and Canvas

The form is always on the left. **Beside the form** picks what sits on its right: **Live
preview**, the page as the site renders it, or **Translate**, the entry in another language
([Translating](translating.md#side-by-side)). **Live preview** is offered to entries with a
`route`, a [loader](loaders.md), and preview enabled, and is where they open; everything else
opens with the form alone. Press **Live preview** again to fold the page away and give the form
the full width. The choice is remembered per browser; an entry opened on a language from a link,
such as a queue from the entry list, shows it side by side without changing that choice.

The page beside the form stays in view while the form scrolls, under one row with its address, the
device widths and **Preview**. Opening a block or object-list card scrolls the preview to its
nearest annotated section. Clicking annotated content in the preview opens the matching form
field, scrolls it into view and focuses its control. Edits stay in the form: the split preview
does not offer inline editing, follow links or submit forms. **Canvas** gives the page the workspace width, adds
Structure, Inspector, undo and Edit/Interact, and collapses the normal navigation; its back arrow
returns to the form. Tablet and phone controls set the iframe's real width rather than scaling it.

Canvas renders the current working snapshots, including changes that autosave has not sent yet.
Completed edits are coalesced into a fresh render; autosave by itself does not reload the page.
If a render fails, the last working page and the current form data remain available with Retry and
Form actions. If the page reloads itself, as it does after a change to the site's code in
`astro dev`, Canvas renders it again. **Open preview** first saves every dirty locale, then opens the ordinary authenticated
GET in a new tab without putting snapshot data or a Canvas signal in its URL.

A global has no route of its own, so its editor offers Form only. To see a global in context, open
an entry whose loader reads it. A site without [template annotations](canvas.md) can still use Form
and the rendered page, but its content is not selectable in place.

A link inside an ordinary preview stays in preview: every link to a page on this site is rewritten
to that page's `/_preview` address on the way out, so clicking through a draft site keeps showing
drafts. Links elsewhere are left alone. Canvas keeps the site's real links and mediates them through
the editor instead; its navigation and external-effect rules are in the [Canvas guide](canvas.md).

## Interface language

The controls around the page beside the form and in Canvas, its device widths, render failures
with their Retry and Form actions, and accessibility labels are available in English and German.
Changing the interface language updates that surrounding CMS chrome in place. It does not replace
or reload the iframe, change its URL, request another render, or change the selected content
language.

The page inside the frame remains the site-rendered content in the selected content language. Its
`<html lang>`, words, links, dates, and formatting belong to the site, not the CMS interface
preference. Schema-authored validation messages also remain authored copy.
