# Secrets

Handover needs five secrets and one var before `/admin` answers, and one more secret per
optional feature. The Worker, its database and the GitHub App the secrets point at are on
[Deploy](deploy.md).

Set each with `wrangler secret put <NAME>` (paste the value when prompted). For the key,
paste the whole PKCS#8 PEM including its header lines — newlines are fine, and so is
the `\n`-escaped one-line form.

| Secret | Value |
|---|---|
| `BETTER_AUTH_SECRET` | signs the admin's sessions — `openssl rand -base64 32`. Changing it signs everyone out ([Accounts](auth.md)) |
| `GITHUB_APP_ID` | App ID from step 2 |
| `GITHUB_INSTALLATION_ID` | installation id from step 3 |
| `GITHUB_PRIVATE_KEY` | the PKCS#8 PEM |
| `GITHUB_REPO` | `owner/repo` of the site |

Optional, each turning on the feature that reads it:

| Secret | Value |
|---|---|
| `GITHUB_BRANCH` | the live branch, if it is not `main` |
| `CLOUDFLARE_API_TOKEN` | build status and revert in the admin. A **read-only** token: dashboard → My Profile → API Tokens → Create Token → Custom token, permission **Account → Workers Scripts → Read**, scoped to the one account. It needs `CLOUDFLARE_WORKER` beside it (below); without both, no build pill is drawn |
| `DEEPL_API_KEY` | [machine translation](translating.md#a-machines-first-draft) from the admin — a free key ends in `:fx` and is recognised as one. Without it the translate buttons are not drawn. The owner can paste a key of their own in **Settings**, which overrides this one ([Integrations](diagnostics.md#integrations)) |
| `HANDOVER_SETTINGS_KEY` | what a key the owner pastes in **Settings** is encrypted with: 32 random bytes, `openssl rand -base64 32`. Only needed if they ever do; without it that section says so and stores nothing. Changing it later makes the keys stored under it unreadable, and they are pasted again |
| `RESEND_API_KEY` | sending mail, when `cms.config.ts` says `mailer: { provider: 'resend', … }` ([Sending email](email.md)). Verify the sending domain at `resend.com/domains` and put an address on it in `from` — until you do, Resend only delivers to the address its own account was created with |
| `SMTP_USER` | the login for `mailer: { provider: 'smtp', … }` — Resend's own relay, for one, wants the literal `resend` |
| `SMTP_PASS` | the password for that login. Without both, the admin treats the site as having no mailer ([Sending email](email.md#smtp)) |
| `GITHUB_CLIENT_ID` | *Continue with GitHub* on the login. An OAuth app whose callback URL is `<HANDOVER_BASE_URL>/admin/api/auth/callback/github`; one app per origin, so local dev needs its own ([Accounts](auth.md#continue-with-github)) |
| `GITHUB_CLIENT_SECRET` | the same app's client secret. Without both, GitHub is not offered |
| `R2_ACCESS_KEY_ID` | uploading pictures. An **R2 API token** with *Object Read & Write* on the one bucket: dashboard → R2 → API → Manage API tokens ([Media](media.md)) |
| `R2_SECRET_ACCESS_KEY` | the same token's secret. Without both, the admin refuses uploads and names what is missing |

`mailer: { provider: 'cloudflare', … }` has no secret at all: it sends through a `send_email`
binding in `wrangler.jsonc`, so it is set up in the dashboard rather than here
([Sending email](email.md#cloudflare)).

One more is a **var rather than a secret**, because an origin is not private — and without it the
emailed sign-in link and GitHub are not offered at all:

```jsonc
// wrangler.jsonc
"vars": { "HANDOVER_BASE_URL": "https://your-site.example" }
```

It is what an emailed link points at, and it is stated rather than read off the request so a
forged `Host` cannot decide where a sign-in link goes ([Accounts](auth.md#2-say-where-the-site-is)).

A second var goes with `CLOUDFLARE_API_TOKEN`, for the same reason — an account id is not private:

```jsonc
// wrangler.jsonc
"vars": { "CLOUDFLARE_WORKER": "<account-id>/<worker-name>" }
```

Two more go with the R2 secrets, for the same reason — an account id and a bucket name are not
private:

```jsonc
// wrangler.jsonc
"vars": { "R2_ACCOUNT_ID": "<account-id>", "R2_BUCKET": "your-site-media" }
```

The bucket also needs a CORS rule and a hostname of its own before anything can be uploaded to
it; [Media](media.md) is the whole setup in four steps.

One value is neither a secret nor a var: `PREVIEW_ENABLED` belongs to the **build**, because
the integration reads it while it sets up and leaves the `/_preview` route out of the bundle
where it is unset. Setting it on the deployed Worker does nothing; it goes in the build command
(below) or in the script that command runs ([Preview](preview.md#turning-it-on)).

The account id is in the dashboard's sidebar; the worker name is this file's own `name`. ⚠️ The
Workers Builds API is keyed on the worker's **tag**, not its name, and answers `200` with an
empty list for a name — which reads as "this commit never built" forever. The name is what you
put here and the admin looks the tag up, so you never have to find one.

`/admin/api` requests fail with an explicit error naming the missing secret. For local
`astro dev`, the same names go in `.dev.vars`. Once the site is up, **Settings** in the admin
checks every one of them and says which is missing ([Settings](diagnostics.md)).

A repository the App was never installed on answers `404` on every path, which looks the
same to GitHub's API as a file that does not exist. The admin tells them apart: it says
*The GitHub App cannot see owner/repo* and names the installation, so a wrong
`GITHUB_REPO` or a missing step 3 shows up as itself rather than as an entry that will not
open.
