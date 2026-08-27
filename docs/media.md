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
        "methods": ["PUT"],
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

Add `http://localhost:4321` to `allowed.origins` as well if you upload from `astro dev`.
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

## Nothing is ever deleted

Clients reuse pictures, and a picture removed from an entry is still on the published site
until that entry is published. Handover deletes an object in exactly one case: the one in
step 4, where what arrived was not what was asked for and no row was ever written.

An upload whose confirm never arrived leaves an object with no row behind it. An hourly job
lists the bucket and writes a row for anything it finds, so those bytes come back rather than
sitting there unnamed ([Deploy](deploy.md#the-schedule)). It only ever adds: the width and
height it cannot read stay empty, and nothing in the bucket is touched.

## Not yet

The media library screen, with its usage counts, archiving and tags; *moving* the focal point,
which is drawn on every preview but set in the library; choosing several pictures at once for
an array of images; and searching by anything but the file name.
