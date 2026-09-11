# Blocks

`<Blocks />` draws a `blocks()` field: the list as stored, the components you register for it,
and the site-wide globals a `_ref` block is filled from. The rest of what a template renders —
rich text, the language switcher, hidden entries — is [Rendering content](rendering.md).

It takes the list and a `{ _type: component }` map.
Each component receives the stored block as `block`, the map as `components`, and an optional
`edit` context when the caller has enabled [Canvas editing](canvas.md). A block that nests `blocks`
renders them by calling `<Blocks />` again with the same map and its derived edit context.
A `_type` with no component throws at build, naming the type.

A block with `_ref` is filled from that global, so `<Blocks />` also takes the language's
globals — `globalsAt()` builds the map, keyed by file name:

```ts
// src/loaders/globals.ts
import { type ContentSource, globalsAt, menusAt } from 'astro-handover';
import cms from '../../cms.config';
import type { Site } from '../content/schemas';

type Source = ContentSource<{ globals: unknown }>;

export async function load(
  source: Source,
  { locale, blocks }: { locale: string; blocks?: unknown },
) {
  const globals = await globalsAt(
    'default', source, locale,
    source.preview ? { required: ['site', 'navigation'], blocks } : undefined,
  );
  const menus = await menusAt('default', source, cms, globals.navigation, locale);
  return { globals, menus, site: globals.site as Site };
}
```

The page loader passes its rendered tree to this shared loader:
`await loadGlobals(source, { locale, blocks: entry.data.blocks })`. The layout receives the
result as props and renders `<Blocks blocks={data.blocks} components={components} globals={globals} />`.
It does not fetch content itself, so preview uses the draft source throughout.

The optional fourth argument selects globals: `required` names content the layout reads
directly, and `blocks` discovers `_ref` through nested arrays and plain objects. Names may be
bare (`site`) or prefixed (`globals/site`); each is read once through `source.getEntry()`, so
required drafts are validated. A missing selected global throws `ContentError`, naming its
locale and file; preview turns it into a readable `422`.

Selection works with any content source. The example opts in for preview only, keeping the
public collection read unchanged. Omitting the argument preserves the existing whole-collection
behavior; `{}` selects nothing. Pass every tree you render (an array of trees works too), and
list every global the layout reads directly. Discovery follows `<Blocks />`: a `_ref` is a
replacement boundary, and the replacement's own content is not walked recursively.

`globals` is a collection like any other in `src/content.config.ts`, with the same
`generateId` — the file name is the key, and the `<locale>/` folder is what `globalsAt`
reads ([Site files](site-files.md#globals)).

Every `_ref` in the tree is filled here, however deep it sits, so a block component that
nests `<Blocks />` passes on `components` and, when present, the nested `edit` context. A `_ref`
naming a global that `cms.config.ts` does not declare fails the build; one whose file this language
does not have fails, naming the file to write.

```ts
// src/blocks/registry.ts
import type { BlockType } from '../content/schemas';
import Columns from './Columns.astro';
import Hero from './Hero.astro';

// A block type with a schema but no component fails typecheck here, not at build.
export const components = { hero: Hero, columns: Columns } satisfies Record<BlockType, unknown>;
```

`BlockType` is `keyof` the plain object the schema registry is built from, so in
`schemas.ts` write `const blockTypes = { hero, columns }`, then
`export const registry: BlockRegistry = blockTypes` and
`export type BlockType = keyof typeof blockTypes`.

```astro
---
// src/blocks/Columns.astro — a block that nests blocks
import Blocks from 'astro-handover/Blocks.astro';
import type { EditContext } from 'astro-handover';
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
  {block.columns.map((column) => {
    const columnEdit = edit?.list('columns').block(column);
    const blocksEdit = columnEdit?.list('blocks');
    return (
      <div {...(columnEdit ?? {})} {...(blocksEdit ?? {})}>
        <Blocks blocks={column.blocks} components={registry} edit={blocksEdit} />
      </div>
    );
  })}
</section>
```

The layout renders the top level. Without Canvas annotations it remains
`<Blocks blocks={data.blocks} components={components} />`; the [Canvas guide](canvas.md) shows the
annotated call and the explicit empty-list container.
