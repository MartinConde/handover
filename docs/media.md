# Media

Pictures and files live in R2. A content file stores a key (`media/9f3a….webp`), never a
URL, so moving the CDN does not change content files.

Uploads enter a **private staging bucket through the authenticated CMS**. The Worker checks
actual size, content type, file signature and hash before writing verified bytes to the public
media bucket. A prefix inside a public bucket is not a private quarantine.

## 1. Create both buckets

[`handover init`](init.md) creates these and configures staging expiry. For an existing site:

```sh
npx wrangler r2 bucket create your-site-media
npx wrangler r2 bucket create your-site-uploads
npx wrangler r2 bucket lifecycle add your-site-uploads handover-expire-uploads uploads/ --expire-days 1
```

Keep **r2.dev disabled and attach no custom domain** on `your-site-uploads`. Check both:

```sh
npx wrangler r2 bucket dev-url get your-site-uploads
npx wrangler r2 bucket domain list your-site-uploads
npx wrangler r2 bucket lifecycle list your-site-uploads
```

The lifecycle rule expires abandoned staging objects independently of the application cron.
Expiry is asynchronous; one day is the eligibility age, not an exact deletion deadline.
When setting up by hand, inspect an existing rule before adding one with the same name.
The initializer verifies the rule on retries and refuses conflicting settings.

## 2. Bind staging and configure public storage

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "MEDIA_UPLOADS", "bucket_name": "your-site-uploads" }
],
"vars": {
  "R2_ACCOUNT_ID": "<account-id>",
  "R2_BUCKET": "your-site-media"
}
```

The binding gives the Worker access to staging. It needs no browser credential or S3 key.
For the public bucket, create an **R2 API token** with **Object Read & Write**, scoped to
`your-site-media`, and save the access key id and secret access key:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Put the same secrets in `.dev.vars` for local development. Missing staging or public storage
configuration makes uploads return `503`; it never falls back to public staging.

## 3. Serve only the public bucket

Attach a custom domain on a zone in the same account to `your-site-media`, on a hostname
separate from the site:

```sh
npx wrangler r2 bucket domain add your-site-media --domain media.your-site.example \
  --zone-id <zone-id>
```

Set a Cloudflare response-header rule for that media hostname:
**`X-Content-Type-Options: nosniff`**. This is a response policy; R2 object metadata does not
set it. Keep the public bucket's r2.dev URL disabled so requests cannot bypass this rule.
The CMS sets verified MIME types, immutable caching and attachment disposition for PDFs.

The public base is build-time configuration:

```ts
export default defineConfig({
  media: { publicBase: 'https://media.your-site.example' },
});
```

Without `publicBase`, a successful upload has no public URL to display.

## 4. Allow public media reads from the admin

Uploads use the site's own authenticated endpoint and need no bucket PUT CORS permission.
The editor still fetches public images for cropping, so allow GET from the admin origin:

```json
{
  "rules": [{
    "allowed": {
      "origins": ["https://your-site.example", "http://localhost:4321"],
      "methods": ["GET"],
      "headers": ["content-type"]
    },
    "exposeHeaders": ["ETag"],
    "maxAgeSeconds": 3600
  }]
}
```

Save this as `cors.json`, then apply it to the **public** bucket:

```sh
npx wrangler r2 bucket cors set your-site-media --file cors.json
```

## Upgrade from public staging

Create the private bucket, verify its access settings and expiry, add `MEDIA_UPLOADS`, then
generate and apply the new [database migration](deploy.md#the-database) before deploying
the upgraded CMS. Rebuild the admin bundle too; an old bundle still requests direct R2 PUTs.
An upload already in progress must be restarted after this change.

Previously issued signed URLs can remain usable for five minutes. Block public reads of
`uploads/` on every public media hostname during the transition, and remove or expire those
old temporary objects after that window. Do not delete verified `media/` or `files/` objects.
The old public staging prefix is no longer adopted by confirmation; new uploads use only
private staging. Remove the public bucket's obsolete PUT CORS permission after deployment.

- [Uploads](media-uploads.md): byte limits, verification and recovery
- [The library](media-library.md): archive, deletion, focal points and cropping
