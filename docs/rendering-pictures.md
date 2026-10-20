# Rendering pictures

Drawing an `image` field on a page: the stored value, the demo's `<img>` with the focal point, and
the same picture through Astro's `<Picture>`. The other shipped components are
[Rendering content](rendering.md); what a field asks of a picture is
[Pictures and files in a field](media-fields.md).

The package ships no picture component: the template draws its own `<img>`. An image field's
value is the stored `src` key, `alt`, `width`, `height` and, when the client moved the dot,
`focal` — `[x, y]` as fractions of the picture. A centred dot is not written, so default it to
the middle. This is the demo's hero, which keeps the dot in frame as the crop changes:

```astro
---
import cms from '../../cms.config';

const { block, edit } = Astro.props;
const media = (key: string) => `${cms.media?.publicBase}/${key}`;
const focal = block.image?.focal ?? [0.5, 0.5];
---

<section class="hero-block" {...(edit ?? {})}>
  <h1 {...(edit?.field('heading') ?? {})}>{block.heading}</h1>
  {
    block.image && (
      <img
        {...(edit?.field('image') ?? {})}
        src={media(block.image.src)}
        alt={block.image.alt ?? ''}
        width={block.image.width}
        height={block.image.height}
        style={`object-position: ${focal[0] * 100}% ${focal[1] * 100}%`}
      />
    )
  }
</section>
```

`object-position` only moves anything under `object-fit: cover` in a box of another shape, so
style the image that way. To have Cloudflare cut the crop instead of the browser, pass the same
two numbers as `gravity` ([The focal point](media-library.md#the-focal-point)).

## With Astro's `<Picture>`

A site that already draws its pictures with `<Picture>` from `astro:assets` can keep it and
let the build make the sizes. Add the media domain to `image.domains` in `astro.config.mjs`,
and pass the remote URL with the stored width and height, since Astro cannot read either from
a URL:

```astro
---
import { Picture } from 'astro:assets';
import type { Image } from 'astro-handover';
import cms from '../../cms.config';

interface Props {
  image: Image;
  widths: number[];
  sizes?: string;
}

const { image, widths, sizes } = Astro.props;
// Astro stops a local picture's widths at its own width; a remote one is not capped.
let candidates = [...widths].sort((a, b) => a - b);
if (candidates.at(-1)! > image.width) {
  candidates = [...candidates.filter((w) => w <= image.width), image.width];
}
---

<Picture
  src={`${cms.media?.publicBase}/${image.src}`}
  width={image.width}
  height={image.height}
  alt={image.alt ?? ''}
  formats={['avif', 'webp']}
  widths={candidates}
  sizes={sizes}
  fallbackFormat={image.src.endsWith('.png') ? 'png' : 'jpg'}
/>
```

Two things differ from a picture in `src/assets/`:

- **No width cap.** Astro drops the widths larger than a local picture, but not those of a
  remote one: it upscales them. The component above caps them the way Astro caps a local one.
- **A PNG fallback.** Without `fallbackFormat`, the `<img>` inside a remote `<picture>` is a
  PNG, often several times the size of the JPEG it was made from.
