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
