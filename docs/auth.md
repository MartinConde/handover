# Accounts and signing in

`/admin` is behind a real login, checked against accounts in the site's own D1 database. There
are three ways in — an emailed link, a password, and *Continue with GitHub* — and the login
offers only the ones the site is configured for. There is **no sign-up**: an account exists
because someone put it there, and every endpoint that would create one is closed. After the
first one, that someone is an owner on the [Members screen](roles.md#members--adminmembers).

## 1. Set the secret

One secret signs sessions. Generate it once per site and keep it:

```sh
openssl rand -base64 32          # the value
npx wrangler secret put BETTER_AUTH_SECRET
```

For `astro dev` and `wrangler dev`, the same name goes in `.dev.vars` (gitignored). Without it
every `/admin/api` request fails with a message naming it. Changing it later signs everyone out.

## 2. Say where the site is

`HANDOVER_BASE_URL` is the site's own origin, and it is the one thing about the login that is
never read off the request:

```jsonc
// wrangler.jsonc — a plain var, not a secret. An origin is not private.
"vars": { "HANDOVER_BASE_URL": "https://your-site.example" }
```

It is what an emailed sign-in link points at, and a `Host` header is written by whoever sent the
request — so a link built from one is a working credential mailed to the right person pointing at
somebody else's server. Locally the same name goes in `.dev.vars`, matching the port `astro dev`
prints: `HANDOVER_BASE_URL=http://localhost:4321`.

**Without it the emailed link and GitHub are not offered at all**, the same answer a missing key
gets. Passwords and sessions work without it; only what puts a URL in an email needs it.

## 3. Create the first account

[`handover init`](cli.md#handover-init) seeds the first owner, and this is the row it writes:

```sql
INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
VALUES ('usr_1', 'Your Name', 'you@example.com', 1, 'owner', 0, 0);
```

With a mailer and a base URL set that is the whole of it: they sign in with an emailed link and
set a password from their account page. A site with no mailer has no way to send that link, so
give them a password too — insert it yourself, hashed with the same function the login verifies
against:

```sh
node --input-type=module -e "
import { hashPassword } from 'better-auth/crypto';
console.log(await hashPassword(process.argv[1]));
" 'the-password-you-chose'
```

```sql
INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES ('acc_1', 'local:credential', 'usr_1', 'credential', 'usr_1', '<the hash>', 0, 0);
```

Run each once with `--local` and once with `--remote`: those are two different databases. Three
values are not free choices, and a password that never works is what you get when one is wrong:
`provider_id` is `credential`, `issuer` is `local:credential`, and `account_id` is the **user's
own id**, not the email. A password is at least 12 characters, with no other rules.

## Signing in by emailed link

Needs a [mailer](email.md) and the base URL above. The login takes an address and answers *Check
your inbox* — the same answer for every address, so the form never confirms which ones have an
account. A link is mailed only to an address that does, works **once**, and expires in **15
minutes**; the database stores a hash of it, so a copy of the database is not a way in. A used or
expired link lands back on the login saying so, with *Send a new link* under it.

The one exception is the link in an [invite](roles.md#inviting-somebody), which lasts **three
days** — it is read when the person gets round to it rather than in the minute they asked.

## Continue with GitHub

Needs `HANDOVER_BASE_URL`, and a GitHub OAuth app per origin — the callback URL is
`<HANDOVER_BASE_URL>/admin/api/auth/callback/github`, and GitHub allows one per app, so a site
you also run locally needs a second app for `http://localhost:4321`.

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Sign-up is closed here too, so GitHub only works when a `user` row **already carries the same
email** GitHub reports as verified; it links to that row rather than making a new one. A GitHub
account nobody invited lands back on the login with the message a dead link gets, and is not told
whether the address is known here.

The trip to GitHub and back has **five minutes** on it. Sitting on the consent screen for longer
than that — which a first time through, signing in to GitHub as well, can easily take — comes
back to the login rather than into the admin. Clicking *Continue with GitHub* again is the whole
of the fix, and the second time is instant because the consent is already given.

Which of the two roles somebody has, and what each may do, is
[Roles and permissions](roles.md).

## Forgot password, and the account page

*Forgot password?* mails a link to `/admin/reset` that lives for **an hour** and works once.
Setting a new password there ends every session the account had, including the one that asked —
which is the point, if the reason for the reset is that somebody else had it.

Everyone has an account page at `/admin/account`: their display name, their email and role as
facts, a password form, and their sessions with *Sign out everywhere*. Somebody who signed in
with a link and has no password yet is offered one there instead of the password form — that is
how an invited person gets one. Changing a password signs the other devices out.

## Signing in too often

Password sign-in allows **3 attempts per 10 seconds** from one address, then answers `429` and the
login says so; asking for an emailed link is limited separately, at 5 a minute. Both counters live
in the `rate_limit` table in D1, so they are shared across the Worker's isolates rather than being
per-isolate and meaningless. The address is read from `cf-connecting-ip`, which Cloudflare writes
and a caller cannot send in.

The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on any site whose
`HANDOVER_BASE_URL` is `https:` — so `http://localhost` still signs in.

## Signing out

`POST /admin/api/auth/sign-out`, which the user menu does for you. It must carry
`content-type: application/json` — without one the endpoint answers `415` and the session
survives.

## ⚠️ Sign-up is closed, and what that actually means

There is no route that lets a stranger make an account:

| Endpoint | Answers |
|---|---|
| `POST /admin/api/auth/sign-up/email` | `400`, always. Email/password sign-up is disabled outright |
| `POST /admin/api/auth/sign-in/magic-link` | `200`, always — and mails nothing to an address with no account. Opening a link minted for one makes no user |
| `GET /admin/api/auth/callback/github` | back to the login. A GitHub account with no matching row makes no user |
| `POST /admin/api/auth/admin/create-user` | `401` with no session, `403` for an editor. This is what an owner's invite is built on |

The status codes are Better Auth's and are not all `403`; what matters, and what the package's
tests assert, is that **no row is created** on any of these paths.
