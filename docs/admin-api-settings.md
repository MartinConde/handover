# The admin API — settings

Conventions, status codes and what these routes are for: [The admin API](admin-api.md).

## Diagnostics

What the **Settings** screen reads. All of it is **owner only** — the payload names the sending
address and the media host, and a sidebar item an editor never sees is not a gate.
[Settings](diagnostics.md) is what the screen makes of it.

```
GET /admin/api/diagnostics
  →  { "collections", "locales", "defaultLocale", "mediaBase", "mailer", "preview", "dev" }
```

`cms.config.ts` as it came out: `collections` is `{ name, route? }` in declaration order,
`mailer` is `{ provider, from }` — or `{ "provider": "custom" }` where the site handed in a
function of its own, and `null` where it configured none — and `preview` says whether this
build has a `/_preview` route at all. `dev` is the build mode, and is what decides whether the
screen offers *Simulate a conflict*.

```
POST /admin/api/checks/github        →  { "ok": true, "detail" }
POST /admin/api/checks/storage       →  { "ok": true, "detail" }
POST /admin/api/checks/translation   →  { "ok": true, "detail" } | { "off": true, "detail" }
POST /admin/api/checks/build         →  { "ok": true, "detail" } | { "off": true, "detail" }
POST /admin/api/checks/database      →  { "ok": true, "detail" }
```

One connection, tried for real: an installation token and a read of the branch head; one small
object written to the bucket, read back and deleted again; one word translated; the worker asked
about without naming a commit; a read of the admin's own tables. `detail` is a sentence and not a
code, because this page is read by whoever forwards it.

`off` is a thing the site never configured and does not need — no DeepL key, no
`CLOUDFLARE_API_TOKEN` — which is not a failure. `503` is a thing it needs and was never told,
and the body's `error` is the sentence naming what to set; `502` is a thing that was told and
refused, and `error` is the refusal itself. `403` for an editor; `404` for a check name that is
not one of these.

The test email is [`POST /admin/api/checks/email`](email.md#prove-it-before-anything-depends-on-it), which sends
something and so is never run on its own, and *Simulate a conflict* is
[`POST /admin/api/checks/conflict`](admin-api-publishing.md).

## Integration keys

The keys the client owns rather than the developer ([Settings](diagnostics.md#integrations)).
Owner only, like the rest of that screen.

```
GET    /admin/api/settings          →  { "integrations": [ { "key", "source", "fallback",
                                                             "hint", "updatedAt", "by" } ] }
PUT    /admin/api/settings/:key        { "value": "…" }   →  { "ok": true, "detail"? }
DELETE /admin/api/settings/:key                           →  { "ok": true }
```

`key` is `deepl` or `assist` and nothing else — anything the admin needs to run itself stays in
the environment. `source` is where that key is **in force** — `settings`, `env`, `code` (the
site handed in its own `i18n.translate`) or `off` — and `fallback` is what would be in force
without the row, so *Remove* can say what happens before it is pressed. `hint` is the last four
characters of the key. **The key itself is never in an answer**: to check one, replace it.

A `PUT` of a DeepL key translates one word with it before storing anything, and answers `502`
with DeepL's own refusal if that fails; `detail` is what it translated when it worked. `400` for
an empty value, `404` for a key outside the two, `503` when `HANDOVER_SETTINGS_KEY` is not set —
the body names it. Every write is a `setting-changed` row in the [activity log](activity.md),
carrying the name of the key and never its value.
