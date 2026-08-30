# Pictures and files in a field

What an `image` or a `file` field asks of what goes in it, and what the client sees when
they fill one. Getting the bytes into the bucket at all is [Media](media.md); the shape they
are stored in is [Structured fields](structured-fields.md).

## What a field asks of a picture

A preset belongs to the field, not to the site: the schema knows what it is.

```ts
photo: image({ ratio: '3:2', max: 2400, min: 1200 }),
hero: image({ ratio: '16:9', max: 2400, min: 1600 }),
brochure: file(),
```

`file({ accept })` narrows what the picker offers and what the file dialog filters by. PDF is
the only non-image type the pipeline verifies today — the confirm reads an object's first bytes
back against the type it was uploaded as — so widening `accept` needs that type's signature in
the package first.

- **`ratio`** is what the field shows — the card, the picker's preview and the crop the site
  renders. Leave it out and the picture is shown as it is
- **`max`** is the cap, in longest side, applied once on the way *in*. It is what the browser
  downscales to before a byte leaves it ([step 1](media.md#what-an-upload-does))
- **`min`** is the floor, in width, applied every time a picture is *chosen*. It is optional:
  a field without one refuses nothing

The two numbers are not the same number and are not measured the same way. `min` is measured
on the **crop** — the width of the widest crop at this field's ratio the picture can yield —
which is what stops a 900 × 1600 phone photo passing a 1600 hero sideways, and it is what the
refusal says: *its widest 16:9 crop is 900 px, this field needs 1600*. A picker that refused
anything under its own cap would refuse your own photographs, since a picture uploaded through
a 1600 field is already 1600.

Nothing is ever stored at the crop size. A variant is a delivery transformation, so a preset
describes what is accepted and what is kept, never a file written at 1200 × 630.

## Choosing a picture

An `image` or `file` field with nothing in it is a drop zone: drop a file on it, or open the
picker, which is the library scoped to that field — its types, its preset, its floor on the
header line. Uploading happens inside the picker, and a picture the site already has is
reused rather than uploaded again.

A picture the library has no width and height for — what the reconciliation job recovers, since
a HEAD cannot measure one — is refused by every image field, floor or no floor: the field stores
those two numbers.

An **array of `image`** — a gallery — is the one field the picker takes several pictures for at
once. *Add to …* opens it with checkboxes rather than radio buttons, the panel beside the grid is
the order they will go in, and each ticked picture becomes a row of its own.

## The focal point on a field

A picture inserted into a field brings the library's dot with it, and *Set focal point* on the
card moves it for this page alone — over this field's own shape, previewed as the site will crop
it. It is written as `focal` on the value and wins over the picture's own default wherever that
page renders it; a dot left in the middle is written as nothing. Moving the default for every
page that did not set one is the library's ([Media](media.md#the-focal-point)).

What a translation owns is the alt text of a picture and the display name of a file. Every
other part is the same in every language, so a language being translated is shown those two
and nothing else: no picker, no Replace, no Remove.
