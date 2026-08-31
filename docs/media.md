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

## The rest, by page

- [Uploads](media-uploads.md) — what an upload does, the size and type limits, and why a key is the
  hash of the bytes
- [The library](media-library.md) — nothing is deleted on its own, archive and the gated delete, the
  library screen, the focal point and cropping a copy
