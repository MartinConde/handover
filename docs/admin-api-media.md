# The admin API — media

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Media

The upload pipeline, in two calls around a PUT the browser makes straight to the bucket,
and the library the picker reads. What has to be set up before any of them answers anything
is [Media](media.md).

```
GET /admin/api/media?kind=images|files&q=&archived=1
  →  { "media": [ { "id", "src", "filename", "mime", "bytes", "width", "height", "focal", "url?",
                    "alt", "tags", "archived", "createdAt",
                    "uses": [ { "entry", "title", "href" } ] } ] }
```

What the library and the picker list: newest first, at most 100. `kind` is the field's —
`files` is everything that is not a picture, and anything else is the pictures. `q` matches
anywhere in the file name or in one of the tags, and it is matched in the query rather than in
the browser, so a name past the hundredth row is still found. `archived=1` includes what has
been put away; without it archived assets are left out, which is what a field's picker asks for.

`uses` is one row per **entry** the asset is used in — not per file, so a listing that carries
the same picture in both its languages is one place. It is read from a scan the build wrote,
with today's drafts laid over it: a picture taken out of an entry this morning is not still
used there. `href` is where the admin edits that entry.

```
POST /admin/api/media  { "hash", "bytes", "mime", "filename?", "width?", "height?",
                         "derivedFrom?" }
  →  { "media": { "id", "src", "filename", "mime", "bytes", "width", "height", "focal", "url?" } }
  →  { "upload": { "key", "url" } }
```

"Do you have these bytes?" `hash` is the SHA-256 of the file, hex. The first answer is the
asset the site already holds, and the upload is over before it started — the same picture
chosen twice is one object and one row. The second is a PUT URL signed for five minutes,
for a temporary key the server chose: `uploads/<uuid>/media/<sha256>.<ext>`, or
`uploads/<uuid>/files/<sha256>.<ext>` for a PDF. Return that `key` when confirming; the signed URL never permits a write to the public asset. `422` when the type is not one the bucket takes or the declared size
is over 10MB, `503` when the site has no bucket configured.

`focal` is the two fractions every crop of the picture holds around, `[0.5, 0.5]` for one nobody
has framed. `derivedFrom` is the id of the picture a crop was taken out of, and is written to the
new row by the confirm below; an ordinary upload came from nothing and leaves it out.

`src` is the key a content file stores; `url` is that key under
[`media.publicBase`](configuration.md#media) and is absent when the site has not set one. An
upload's answer is the asset alone — none of the library's own columns are known yet.

```
PATCH /admin/api/media/:hash  { "tags?": [ "…" ], "alt?": "…", "archived?": true,
                                "focal?": [ 0.42, 0.3 ] }
  →  { "media": { … } }
```

What the library calls an asset, where its crops hold, and whether it has been put away. None of it is content and none
of it is committed — it is the client's account of the picture, and it lives on the row. Tags are
trimmed and de-duplicated; an alt emptied here is no default at all. **`archived` is never gated
on usage**: it takes the asset out of every field's picker and keeps the bytes, so a page that
names it goes on working; `false` puts it back. `focal` is two fractions of the picture's own width and height — the
default every page that has not set its own crops around; anything else is `400` rather than
clamped into a frame nobody asked for. `400` when the body carries none of the four,
`404` when the site has no such asset.

```
DELETE /admin/api/media/:hash
  →  { "deleted": "<hash>" }
  →  409 { "error": "…", "uses": [ "listings/mill-house" ] }
```

The bytes and the row, gone. **An asset referenced by current drafts, fresh repository
content, or the running deployment cannot be deleted.** The server reads GitHub at deletion
time and checks the bundle's built usage map independently of draft overlays. A build that
is pending or failed does not release assets the deployed snapshot still needs.

An asset used by current content is refused as *used in N places*. One only the repository
or deployed snapshot names is refused as *the published site still uses this*, with instructions
to publish its removal and wait for that deployment to be live. Both responses are `409`
and include the affected entry keys in `uses`. A repository that cannot be read returns `503`
and leaves the asset in place.

`503` when the site has no bucket, or when the repository cannot be read at all — a check that
could not be made is never read as *nothing uses it*. `404` when the site has no such asset.

```
PUT /admin/api/media/:hash  { "key", "hash", "bytes", "mime", "filename?", "width?", "height?",
                              "derivedFrom?" }
  →  { "media": { … } }
```

The Worker reads the temporary object's actual bytes with a bounded size limit, verifies its SHA-256 and type, and derives image dimensions from the encoded container. Caller dimensions are ignored. A bad temporary object is deleted and answered `422`; a failed storage request leaves it available for retry.

After verification, the Worker writes the exact verified bytes to the public `media/` or `files/` key with immutable caching. PDFs must have a PDF signature and the final object is forced to download. Copying the temporary key is deliberately avoided: another PUT could change it between verification and a copy. Reusing a still-valid upload URL can only change the temporary object.

Only after finalization is the media row inserted. Existing rows remain the inexpensive dedupe path. Hourly reconciliation verifies final objects before adoption and finalizes abandoned temporary uploads after their five-minute lease; it uses the same byte/hash/type checks.
