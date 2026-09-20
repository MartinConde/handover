# Uploads

How a picture or a file gets from the browser into the bucket, and what it is called once it is
there. Setting the bucket up is [Media](media.md).

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
3. Otherwise the admin records an expiring upload intent tied to the signed-in user, exact
   byte count, MIME type and key. It returns a same-origin authenticated PUT URL. The browser
   sends the bytes there; ingestion checks ownership and enforces the byte limit while reading,
   then writes to the private `MEDIA_UPLOADS` bucket
4. The browser returns the temporary key. The admin reads the bytes with a bounded size limit,
   checks the SHA-256 and type, and reads image dimensions from the encoded container.
   A bad upload is deleted without creating a media row
5. The admin writes the exact verified bytes to `media/<sha256>.webp` (or `files/<sha256>.pdf`),
   sets immutable caching and PDF download headers, writes the row, and deletes the temporary object.
   The staging intent permits one ingestion; it cannot be used to overwrite an existing upload

The size limit is enforced before bytes enter R2, including a streamed request without
Content-Length. The received size must match the recorded declaration; inventing a staging
key or skipping the declaration does not bypass the upload budget.

The cap is **10 MiB** per upload and the types are `image/webp`, `image/jpeg`, `image/png`,
`image/gif`, `image/avif` and `application/pdf`. Anything else is refused before an upload intent
is created.

Hourly limits are 30 intents and 30 MiB per account, and 500 intents and 250 MiB per site.
They are stored in D1 and return `429` when exhausted. Failed or abandoned declarations still
consume their reservations. Ingestion stops after 60 seconds; if a Worker dies during ingestion,
start a new declaration rather than reclaiming an in-progress intent.

A file skips step 1 — nothing re-encodes a PDF. Its signature must identify a PDF and the
server stores the final object with `content-disposition: attachment`. An object whose signature
is not the type it was uploaded as is deleted, whatever it was called. A renamed `.html` served from your
CDN domain would be a cross-site scripting hole, and a name is not evidence.

## Failure and recovery

The picker distinguishes image preparation, declaration, upload PUT and confirmation failures with
stable operation descriptors. It does not guess from English response text or status alone. A
connection loss or malformed success after a possible write is reported as unconfirmed: check the
library before starting another upload. Server or provider diagnostics remain separate from the
localized recovery sentence. Changing **Interface language** reformats an already-visible failure
and an upload that finishes afterwards uses the latest language; it does not restart the upload.
The same contract applies on the full media-library screen: its selected asset, search, metadata
draft and queue stay in place, and a pending upload completes in the language currently selected.
The library reload after completion keeps the selected detail panel and authored metadata rather
than treating the locale change as a new request.

Unconfirmed private objects expire through the bucket lifecycle rule even when the Worker
cron is unavailable. They are never automatically published.

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
