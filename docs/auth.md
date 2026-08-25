# Accounts and signing in

`/admin` is behind a real login: an email address and a password, checked against accounts in
the site's own D1 database. There is **no sign-up** — an account exists because someone put it
there, and the endpoints that would create one are closed.

## 1. Set the secret

One secret signs sessions. Generate it once per site and keep it:

```sh
openssl rand -base64 32          # the value
npx wrangler secret put BETTER_AUTH_SECRET
```

For `astro dev` and `wrangler dev`, the same name goes in `.dev.vars` (gitignored). Without it
every `/admin/api` request fails with a message naming it. Changing it later signs everyone out.

## 2. Create the first account

Until `handover init` does this for you, the first owner is two rows you insert yourself.
Hash the password with the same function the login verifies against:

```sh
node --input-type=module -e "
import { hashPassword } from 'better-auth/crypto';
console.log(await hashPassword(process.argv[1]));
" 'the-password-you-chose'
```

Then insert the account, replacing the id, the email and the hash. Run it once with `--local`
and once with `--remote`, since those are two different databases:

```sql
INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
VALUES ('usr_1', 'Your Name', 'you@example.com', 1, 'owner', 0, 0);

INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES ('acc_1', 'local:credential', 'usr_1', 'credential', 'usr_1', '<the hash>', 0, 0);
```

Three of those values are not free choices, and a password that never works is what you get
when one is wrong: `provider_id` is `credential`, `issuer` is `local:credential`, and
`account_id` is the **user's own id**, not the email.

A password is at least 12 characters. There are no composition rules and no forced rotation.

## Roles

Two, in the `user.role` column:

| Role | Can |
|---|---|
| `owner` | Everything: manage members, change settings, edit and publish |
| `editor` | Edit, upload and publish. Cannot change what is editable, or who has an account |

Any other value — including an empty column — is treated as `editor`, because the narrower of
the two is the safe reading of a row nothing recognises.

## What is protected, and what is not

Every request to `/admin/api/*` needs a session, except the login's own endpoints under
`/admin/api/auth/*` — those are the way in, so nothing can sit in front of them. Handlers are
given the signed-in `{ user, role }` and assert on it; none works it out again.

**The admin HTML and its JavaScript are public on purpose.** They hold no content — the shell
renders the login form, and every byte of the site's data arrives through the API, behind the
session. Do not put a gate in front of `/admin` itself.

**The sidebar is not a permission.** An editor is not offered *Members* or *Settings*, but
hiding a link is presentation. Every route that owners alone may use asserts the role on the
server as well; a screen that only filters the nav is not protected.

## Signing in too often

Password sign-in allows **3 attempts per 10 seconds** from one address, then answers `429` and
the login says so. The counter lives in the `rate_limit` table in D1, so it is shared across the
Worker's isolates rather than being per-isolate and meaningless. The address is read from
`cf-connecting-ip`, which Cloudflare writes and a caller cannot send in.

The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on any site served over https.

## Signing out

`POST /admin/api/auth/sign-out`, which the user menu does for you. It must carry
`content-type: application/json` — without one the endpoint answers `415` and the session
survives.

## ⚠️ Sign-up is closed, and what that actually means

There is no route that lets a stranger make an account:

| Endpoint | Answers |
|---|---|
| `POST /admin/api/auth/sign-up/email` | `400`, always. Email/password sign-up is disabled outright |
| `POST /admin/api/auth/admin/create-user` | `401` with no session, `403` for an editor. This is how an owner will invite people |

The status codes are Better Auth's and are not all `403`; what matters, and what the package's
tests assert, is that **no row is created** on any of these paths.

## Sending email

The admin sends mail through whatever `mailer` in `cms.config.ts` names — Resend on a
`RESEND_API_KEY`, or a function of your own ([Configuration](configuration.md#mailer)). Nothing
in the login needs it yet; the emailed sign-in link does, and arrives with it.

What is here is the check that proves a key before anything depends on it. An **owner** posts to
it and the admin mails them at their own account's address:

```sh
curl -X POST https://your-site.example/admin/api/checks/email -b cookies.txt
{"ok":true,"to":"you@your-site.com","id":"3f6b…"}
```

The recipient is never asked for. It is the address of whoever is signed in, so the button
cannot be pointed at a stranger — and on a Resend account with no verified domain that is the
only address it could reach anyway.

| Answer | Means |
|---|---|
| `200` | It sent. `id` is the provider's own id for the message |
| `403` | You are an editor. Test email is the owner's |
| `503` | No mailer is configured, or its key is not set. The message names which |
| `502` | The provider refused, in the provider's own words — an unverified sending domain reads as itself rather than as a number |

## Not here yet

Signing in by emailed link, *Continue with GitHub*, *Forgot password?* and the account page all
need a mailer to be wired into the login or GitHub credentials, and arrive with them. Until then
the login screen shows the email and password form and nothing that does not work.
