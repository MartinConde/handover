# Canvas editing

Canvas shows the real site inside the entry editor and maps rendered elements back to fields and
blocks. A site opts in by enabling [Preview](preview.md), using the normal loader convention, and
adding explicit edit annotations to its templates. Without annotations, Form still works and the
page remains usable as an ordinary preview.

## Annotate a page

Call `createEditContext(Astro)` in the component that receives the loaded entry. The context is safe
to create and spread during every render: on public pages, prerendered output, and ordinary preview
GETs it is inactive and emits no attributes.

This is the pattern used by the package's built Canvas fixture:

```astro
---
import { createEditContext } from 'astro-handover';
import Blocks from 'astro-handover/Blocks.astro';
import Markdown from 'astro-handover/Markdown.astro';
import { components } from '../blocks/registry';

const { data, globals } = Astro.props;
const edit = createEditContext(Astro);
const blocksEdit = edit.list('blocks');
---

<main {...blocksEdit}>
  <h1 {...edit.field('title')}>{data.title}</h1>
  {data.summary && <div {...edit.field('summary')}><Markdown content={data.summary} /></div>}
  <Blocks blocks={data.blocks} {components} {globals} edit={blocksEdit} />
</main>
```

Put a field annotation on an existing element that renders the whole field. Repeating the same
field annotation on several elements is allowed: Canvas treats them as several occurrences of one
value. A rich-text annotation belongs on the compatible prose container around `<Markdown />`, not
on each element it produces.

The list annotation on `<main>` is deliberate. It makes the insertion point selectable even when
`data.blocks` is empty. Passing the same context to `<Blocks />` gives each rendered block its stable
source address; the component adds no wrapper of its own.

## Pass the context through blocks

`<Blocks />` gives each registered component an optional `edit` prop. Spread it on the block's
existing root, derive field contexts from it, and pass a derived list context into nested
`<Blocks />` calls:

```astro
---
import type { EditContext } from 'astro-handover';
import Blocks from 'astro-handover/Blocks.astro';
import type { z } from 'astro/zod';
import type { columns } from '../content/schemas';
import type { components } from './registry';

interface Props {
  block: z.infer<typeof columns>;
  components: typeof components;
  edit?: EditContext;
}

const { block, components: registry, edit } = Astro.props;
---

<section {...(edit ?? {})}>
  <h2 {...(edit?.field('heading') ?? {})}>{block.heading}</h2>
  <div {...(edit?.list('columns') ?? {})}>
    {block.columns.map((column) => {
      const columnEdit = edit?.list('columns').block(column);
      const blocksEdit = columnEdit?.list('blocks');
      return (
        <div {...(columnEdit ?? {})} {...(blocksEdit ?? {})}>
          <Blocks blocks={column.blocks} components={registry} edit={blocksEdit} />
        </div>
      );
    })}
  </div>
</section>
```

Every block or object row passed to `block()` needs a unique, persisted `_id`. In Canvas,
`<Blocks />` refuses duplicate IDs rather than mapping an edit to the wrong row. It also preserves
the owner of `_ref` blocks: selecting shared content opens its global editor, while removing the
block still removes only that occurrence from the page.

## Context API

`createEditContext(Astro)` returns `EditContext`:

| Member | Use |
|---|---|
| `field(name)` | Advance to a field and emit `data-handover-field`. |
| `list(name)` | Advance to a block or stable-row list and emit `data-handover-list`. Annotate empty lists too. |
| `block(row)` | Advance by `row._id` and emit `data-handover-block`. Pass the whole row so `row._label` or `row._type` also names it in Structure; a string ID also works, and that block falls back to its position. |
| `child(name)` | Advance through a group without emitting an annotation; for example `edit.child('address').field('city')`. |
| `active` | `true` only in a verified Canvas render. It is not emitted when the context is spread. |
| `target` | The current stable document, locale, and field address, for typed integrations. It is not emitted when spread. |

The generated marker values include the verified collection, stable entry ID, locale, and address.
Do not construct `data-handover-*` values by hand or infer an address from visible text.

`isCanvas(Astro)` reports the same verified state without creating a context. The integration also
types `Astro.locals.handoverCanvas` as `HandoverCanvas`; it contains the protocol, render request,
session epoch, active entry identity, locale, and content version. Treat that local as read-only
request metadata. The integration sets it only after the Canvas POST has resolved the page address
back to the requested content file.

## Suppress external effects

A completed edit renders a fresh candidate document before it replaces the visible one. Client
islands therefore mount again, and both the visible and candidate documents can briefly exist.
Use `isCanvas(Astro)` to omit or disable behavior that must happen only on the public site:
analytics, autoplay, autonomous polling, autofocus, and submissions or requests with external
effects. Click interception is not enough to stop code that sends a request on its own.

Edit mode consumes links and form controls as editing selections, so working on linked text or a
CTA never navigates away or shifts the canvas with a confirmation banner. Interact mode permits
normal controls and mediates links, but forms do not submit from Canvas. Use **Open preview** to
test a real submission after dirty locales have saved. Internal links to another editable entry
also save first and open a new editing session; links to indexes, downloads, and external sites
require an explicit open action.

## Boundaries

- Canvas edits only explicitly annotated fields and stable rows in the active entry. Unannotated,
  derived, or client-created DOM remains visible but is not inferred as editable.
- Complex fragments and scalar-array items without `_id` stay in the Inspector or Form. Rich text
  outside its configured Markdown tier is read-only in place and opens the Inspector.
- Shared globals and referenced entries keep their own ownership and open in their own editor;
  Canvas does not write through the current page as if it owned them.
- Blocks reorder only within their current list. Cross-container movement, freeform layout or style
  controls, and collaborative editing are not included.
- A promoted render restores the logical selection without scrolling it into view, preserving the
  viewport even if the editor scrolled away while editing. Explicit Structure selections still scroll
  to their target. A refresh does not preserve arbitrary state inside
  hydrated islands.
- Collection indexes have no single active entry, so they remain ordinary previews rather than
  editable Canvas documents.

Canvas POST bodies contain transient working snapshots, are same-origin and authenticated, and do
not save or publish by rendering. Public pages and ordinary preview GETs contain no Canvas markers,
source metadata, bridge scripts, or Canvas styles.


## Editor feedback and panels

Canvas fills the available viewport below the entry header. Structure and Inspector can stay open
side by side on wide workspaces. Drag either divider to resize its panel; the browser remembers both
widths, and a focused divider also accepts the arrow keys, Home, and End. The Canvas takes the space
released by either panel, while minimum widths keep all three surfaces usable. On narrow workspaces,
opening Inspector temporarily hides Structure; closing it or choosing Structure returns to the same
selection.

Structure lists blocks by the same name the form editor gives them — a block's `_label`, else its
type — and a row with children collapses from its own arrow, or with `←` and `→` while it has
focus. Selecting content in the page opens whatever branch it sits in. Adding a block commits the
chosen type immediately, selects the new block, and opens its fields in Inspector; replacement
continues to use the staged block form so existing data is not discarded accidentally.

Incomplete required fields pause Canvas rendering while draft autosave continues. The last working
page and the new block’s Inspector remain available, with one neutral completion hint instead of
validation and render-error banners. Completing the fields resumes rendering automatically.
Server validation remains authoritative; other field problems and genuine render failures keep
their existing feedback. Field validation appears above the canvas even when Inspector is closed. **Review fields** opens
Form and focuses the affected field in the current language. The header problem count also opens
Form when needed. Validation still prevents publishing; it does not disable unrelated field edits.

Selected content uses a short field label; the full path stays in the editor rail. During inline
editing, the label recedes and a single selection boundary remains. Rich-text editing replaces the
rendered prose in place and keeps accepted content visible until the updated page is ready. Its
Inspector fields are also immediately visible without a second disclosure or a Form detour. Image
selections expose **Replace image** on the canvas. Clicking an annotated CTA or an existing link in
rich text opens the same compact Canvas link editor for its label, Page/Entry or URL destination,
and (where the schema supports it) new-tab behavior; edit mode never follows the link. The
Inspector presents those destination choices as a full-width control and truncates long entry
titles and paths without widening the panel.
