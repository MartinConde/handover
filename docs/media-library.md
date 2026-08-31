# The media library

`/admin/media`, and the rules under it: nothing is deleted on its own, what Archive and Delete
each do, and the focal point and the crop. Setting the bucket up is [Media](media.md); how a file
gets there is [Uploads](media-uploads.md).

## Nothing is deleted on its own

Clients reuse pictures, and a picture removed from an entry is still on the published site
until that entry is published. Nothing here ever tidies up after an edit. Handover deletes an
object by itself in exactly one case: [step 4 of an upload](media-uploads.md#what-an-upload-does),
where what arrived was not what was asked for and no row was ever written.

An upload whose confirm never arrived leaves an object with no row behind it. An hourly job
lists the bucket and writes a row for anything it finds, so those bytes come back rather than
sitting there unnamed ([Deploy](deploy.md#the-schedule)). It only ever adds: the width and
height it cannot read stay empty, and nothing in the bucket is touched.

## Archive, and the one delete somebody asks for

**Archive** is the answer to *get rid of it*: the picture leaves every field's picker and keeps
its bytes, so every page that already names it goes on working. It stays in the library, flagged,
and the same button puts it back. Nothing about archiving depends on where the picture is used.

**Delete** is the exception, and it is gated. An asset any file names cannot be deleted — the
panel's Delete is off with the count beside it, and the API refuses whatever the screen thought.
The check is not the usage badge: that number comes from a scan the last build made, and a commit
pushed since is not in it. At delete time the site reads `src/content/` out of GitHub as it
stands.

A picture an editor took out of a listing this morning is still refused, and the refusal says
why: *the published site still uses this* — the live page is asking for those bytes until that
listing is published. A repository that cannot be read is not an answer either: the delete is
refused rather than allowed.

What a delete does not check is the rest of the repository. A key written into a template or a
component by hand is not a content file and is not seen.

Deleting takes the row first and the object second. If the bucket refuses, the hourly job finds
the object without a row and brings it back as *Recovered* within the hour.

## The library

`/admin/media` is everything in the bucket as the table sees it: a grid of pictures, a list of
files, and a panel for whichever one is open. Search matches the file name and the tags, and it
is the table that searches — a name past the hundredth row is still found. Three toggles narrow
the grid: **Archived**, **Recovered** (an object the hourly job found in the bucket with no
record) and **Unused**; an archived tile carries its own **Unarchive** button.

Under every picture is where it is used, read from a scan the build made of every content file
with today's unpublished changes laid over it. It counts **entries**, so a listing carrying the
same picture in English and German is *used in 1 place*, and the panel expands the count into
the entries themselves. A picture nothing uses says *not used yet*.

The panel is also where an asset is given tags and a default alt text, where it is archived, and
where the gated Delete is. The alt default is what a page falls back to: a page that writes its
own alt, in its own language, keeps it.

## The focal point

Nothing is written to a picture. Every crop the site renders is a delivery transformation of the
one stored original, framed around a **focal point** — two fractions saying where in the picture
the crop has to hold. *Set focal point* in the library's panel opens the dot over the picture,
with every shape this site's own fields crop to previewed live beside it: move it once and all of
them move. Drag the dot, or use the two sliders under it — a place in a photograph is two numbers,
and each one is a slider a keyboard can reach.

The dot in the library is what a picture is **inserted with**: choosing it for a field copies the
two numbers into that entry, and moving the library's dot afterwards does not go back and change
the pages that already have it. A page moves its own from *Set focal point* on the image field,
over that field's own shape, and it is the same in every language. Cropping around the middle is
not a choice — a centred dot is written as nothing at all, on the row and in the file.

The numbers reach the page through the content file, so a template is what turns them into a
crop — `focal` is `[x, y]` beside `src`, and Cloudflare's transformation takes it as `gravity`:

```astro
---
import cms from '../../cms.config';
const { src, alt, focal = [0.5, 0.5] } = entry.data.photo;
const crop = `width=1200,height=675,fit=cover,gravity=${focal[0]}x${focal[1]}`;
---
<img src={`${cms.media.publicBase}/cdn-cgi/image/${crop}/${src}`} alt={alt} width="1200" height="675" />
```

Image transformations have to be on for the zone the bucket's hostname is on (Cloudflare
dashboard → Images → Transformations). Without them that url answers 404 and the plain
`publicBase/src` still serves the uncropped original.

## Cropping a copy

The secondary action, and the only one in the library that makes a new thing. *Crop* opens a box
over the picture, locked to one of the site's own shapes or free, moved and resized with the
pointer or with the sliders under it. *Create cropped copy* writes a **new asset**: its own bytes,
its own row, its own key, with `derived_from` pointing at the picture it came from. **The original
is untouched** and stays wherever it is used — which is the whole reason cropping is offered at
all.

The crop is made in the browser, so it reads the original back out of the bucket: this is the one
thing beyond the upload itself that needs `GET` in the bucket's [CORS rule](media.md#2-let-the-admins-origin-write-to-it).
Without it the crop refuses and says so. A picture the library has no width and height for — what
