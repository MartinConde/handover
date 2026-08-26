# Blocks

`<Blocks />` draws a `blocks()` field: the list as stored, the components you register for it,
and the site-wide globals a `_ref` block is filled from. The rest of what a template renders —
rich text, the language switcher, hidden entries — is [Rendering content](rendering.md).

It takes the list and a `{ _type: component }` map.
Each component receives the stored block as `block` and the map as `components`, so a
block that nests `blocks` renders them by calling `<Blocks />` again with the same map.
A `_type` with no component throws at build, naming the type.

A block with `_ref` is filled from that global, so `<Blocks />` also takes the language's
globals — `globalsAt()` builds the map, keyed by file name:

```ts
// src/loaders/globals.ts — the same shape as any other loader
import { type ContentSource, globalsAt, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';

type Source = ContentSource<{ globals: unknown }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

export const load = (source: Source, { locale }: { locale: string }) =>
  globalsAt('default', source, locale);
```

```astro
---
// src/layouts/BlocksPage.astro
import Blocks from 'astro-handover/Blocks.astro';
import { components } from '../blocks/registry';
import { load, staticSource } from '../loaders/globals';

const { data, locale } = Astro.props;
const globals = await load(staticSource, { locale });
---

<Blocks blocks={data.blocks} components={components} globals={globals} />
```

`globals` is a collection like any other in `src/content.config.ts`, with the same
`generateId` — the file name is the key, and the `<locale>/` folder is what `globalsAt`
reads ([Site files](site-files.md#globals)).

Every `_ref` in the tree is filled here, however deep it sits, so a block component that
nests `<Blocks />` passes on `components` and nothing more. A `_ref` naming a global that
`cms.config.ts` does not declare fails the build; one whose file this language does not have
throws when the page renders, naming the file to write.

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
import type { z } from 'astro/zod';
import type { columns } from '../content/schemas';
import type { components } from './registry';

interface Props {
  block: z.infer<typeof columns>;
  components: typeof components;
}

const { block, components: registry } = Astro.props;
---

<section>
  {block.columns.map((column) => <div><Blocks blocks={column.blocks} components={registry} /></div>)}
</section>
```

The layout renders the top level: `<Blocks blocks={data.blocks} components={components} />`.
