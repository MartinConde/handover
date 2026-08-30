# Media

Pictures and files live in an R2 bucket, not in the repository. A content file stores a
key (`media/9f3a….webp`), never a URL, so moving the CDN never touches one.

The bytes never pass through the Worker: the browser asks for a signed URL and PUTs
straight to the bucket. What the Worker does is decide the key, sign the PUT, and check
afterwards that what arrived is what was declared.

## 1. Make the bucket

[`handover init`](init.md) creates it, named after the project, and writes its
two vars into `wrangler.jsonc` (step 4). By hand:

```sh
npx wrangler r2 bucket create your-site-media
```

The three steps below are yours either way — init sets no CORS rule, because the origin that
needs one is the deployed site's, which it cannot know.

## 2. Let the admin's origin write to it

⚠️ **This is the step that goes wrong.** Without a CORS rule the browser's PUT is blocked
and every upload fails with a network error that says nothing. Put the admin's origin —
scheme and host, no path — in `allowed.origins`:

```jsonc
// cors.json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://your-site.example"],
        "methods": ["GET", "PUT"],
        "headers": ["content-type", "content-disposition"]
      },
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

```sh
npx wrangler r2 bucket cors set your-site-media --file cors.json
```

Add `http://localhost:4321` to `allowed.origins` as well if you upload from `astro dev`. `GET`
is there so the admin can read a stored file back, not only `<img>` it — a fetch of a media URL
from the admin's origin is refused without it, and the error names nothing.
`content-disposition` is in the list because a file is stored as a download; leave it out and
PDFs fail the browser's preflight while pictures keep working.

## 3. Serve it from its own hostname

A custom domain on the bucket, on a zone in the same account. Not the site's own host,
and not the `r2.dev` URL — that one is rate-limited and has no cache in front of it:

```sh
npx wrangler r2 bucket domain add your-site-media --domain media.your-site.example \
  --zone-id <zone-id>
```

The zone id is on the zone's overview page in the dashboard. Wrangler creates the DNS
record and the certificate; the domain answers within a minute or two.

## 4. Tell the site

Two values are not secrets — an account id and a bucket name — so they are vars:

```jsonc
// wrangler.jsonc
"vars": {
  "R2_ACCOUNT_ID": "<account-id>",
  "R2_BUCKET": "your-site-media"
}
```

Two are. Make an **R2 API token** in the dashboard under R2 → API → *Manage API tokens*,
permission **Object Read & Write**, scoped to this bucket. It gives you an access key id
and a secret access key:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

And the public base, which is config rather than env because the build resolves keys with
it ([Configuration](configuration.md#media)):

```ts
// cms.config.ts
export default defineConfig({
  media: { publicBase: 'https://media.your-site.example' },
  // …
});
```

Without all four env values the admin refuses uploads with a message naming them. Without
`publicBase` an upload still works; nothing can show the result.

## What an upload does

1. The browser normalises the picture: decodes it, downscales the longest side to the
   field's cap (2400px unless its preset says otherwise), re-encodes as WebP at quality 0.9. That bakes in the EXIF orientation and
   **strips the rest of the EXIF** — the GPS coordinates of somebody's house must not
   land in a public bucket — reads the width and height the content file needs, and turns
   a phone's HEIC into something every browser can draw. It is not about the delivery
   format: Cloudflare re-encodes on the way out anyway
2. It hashes the result, SHA-256, and asks the admin whether the site already has those
   bytes. If it does, **nothing is uploaded at all** — the same picture chosen twice is
   one object and one row
3. Otherwise the admin answers with a PUT URL signed for five minutes, for a key it chose
   itself: `media/<sha256>.webp`. The browser PUTs the bytes to it
4. The browser says it is done, and the admin reads the object back: an object whose size
   or content type is not what was declared is **deleted**, and no row is written for it

Step 4 is the size limit. R2 cannot bind a maximum size into a signed URL, so the declared
size is checked before anything is signed and the object is checked after it arrives.

The cap is **10MB** per upload and the types are `image/webp`, `image/jpeg`, `image/png`,
`image/gif`, `image/avif` and `application/pdf`. Anything else is refused before a signature
exists.

A file skips step 1 — nothing re-encodes a PDF — and gets two checks pictures do not. It is
PUT with `content-disposition: attachment`, so the bucket's own domain hands it over instead
of rendering it, and step 4 reads its first bytes back: an object whose signature is not the
type it was uploaded as is deleted, whatever it was called. A renamed `.html` served from your
CDN domain would be a cross-site scripting hole, and a name is not evidence.

## Keys are content-addressed

An object is named by the SHA-256 of its own bytes, so the same picture is always the same
key. That makes uploads idempotent, dedupe free, and every object safe to cache forever.

The browser never chooses the key or the extension — that would be an overwrite and a
path-traversal waiting to happen. The server derives both from the type it verified.

A key is what a content file stores:

```yaml
hero:
  src: "media/9f3a2c7ee1b97f13fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.webp"
  alt: "Front of the house"
  width: 2400
  height: 1350
```

A file is the same idea under `files/`, named by the type its bytes actually are. What each
field asks of the picture it takes, and how a client chooses one, is
[Pictures and files in a field](media-fields.md).

## Nothing is deleted on its own

Clients reuse pictures, and a picture removed from an entry is still on the published site
until that entry is published. Nothing here ever tidies up after an edit. Handover deletes an
object by itself in exactly one case: the one in step 4, where what arrived was not what was
asked for and no row was ever written.

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
is the table that searches — a name past the hundredth row is still found.

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

The dot in the library is the picture's **default**. A page can move it for itself: the same
dialog opens from *Set focal point* on the image field, over that field's own shape, and writes
`focal` into the entry. That value wins for that page, and it is the same in every language.
Cropping around the middle is not a choice — a centred dot is written as nothing at all, on the
row and in the file.

## Cropping a copy

The secondary action, and the only one in the library that makes a new thing. *Crop* opens a box
over the picture, locked to one of the site's own shapes or free, moved and resized with the
pointer or with the sliders under it. *Create cropped copy* writes a **new asset**: its own bytes,
its own row, its own key, with `derived_from` pointing at the picture it came from. **The original
is untouched** and stays wherever it is used — which is the whole reason cropping is offered at
all.

The crop is made in the browser, so it reads the original back out of the bucket: this is the one
thing beyond the upload itself that needs `GET` in the bucket's [CORS rule](#2-let-the-admins-origin-write-to-it).
Without it the crop refuses and says so. A picture the library has no width and height for — what
the reconciliation job recovers — cannot be cropped, since a region is measured in pixels nobody
has counted; its focal point still works, being a fraction of whatever it is.
