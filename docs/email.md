# Sending email

The admin sends mail for three things: the sign-in link on the login screen, the "set a new
password" link behind *Forgot password?*, and the test message on the settings screen. All three
go through whatever `mailer` in `cms.config.ts` names, so a site swaps its provider in one place.

Until a site has one, none of the three is offered — the login shows the password form and
nothing that does not work. The same is true of a provider named without its credential: the
admin treats that as no mailer at all rather than offering a button that fails.

`from` is config and never a secret, whichever provider you pick: it is an address, the settings
screen shows it, and every provider refuses a domain it does not know.

## Resend

An HTTPS API and one key. The default for a site on the Workers Free plan.

```ts
// cms.config.ts
mailer: { provider: 'resend', from: 'Your Site <hello@your-site.com>' },
```

```sh
npx wrangler secret put RESEND_API_KEY
```

`from` has to be on a domain verified at `resend.com/domains`. Without one, the only sender that
works is `onboarding@resend.dev`, and Resend delivers it **only to the address the Resend account
was created with** — enough to prove a key works, not enough to write to anybody else. A site
whose people are not all you needs a verified domain before its first invite.

## SMTP

Any mailbox or relay you already have. `host` is not a secret, so it sits in the config beside
`from`; the login is two secrets.

```ts
mailer: {
  provider: 'smtp',
  from: 'Your Site <hello@your-site.com>',
  host: 'smtp.your-provider.com',
  // port: 465 is the default
},
```

```sh
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
```

Your `wrangler.jsonc` needs the `nodejs_compat` compatibility flag — SMTP is a raw socket, not
an HTTP request.

⚠️ **The port has to be encrypted from the first byte** — 465 on nearly every provider. Handover
does not open a plaintext session and ask the server to upgrade it, because a server that does
not offer the upgrade would be handed your password in the clear, and it would look like it
worked. If your provider only offers 587, ask them for their implicit-TLS port.

Resend's own relay is a working example, and reuses the key from above: `host: 'smtp.resend.com'`,
`SMTP_USER` the literal `resend`, `SMTP_PASS` the API key.

## Cloudflare

Cloudflare Email Sending, reached through a binding rather than a key — so this is the one
provider with no secret to set.

```jsonc
// wrangler.jsonc
"send_email": [{ "name": "EMAIL" }]
```

```ts
// cms.config.ts
mailer: { provider: 'cloudflare', from: 'Your Site <hello@your-site.com>' },
```

The binding must be named `EMAIL`, and the domain in `from` has to be onboarded first — in the
dashboard under **Compute → Email Service → Email Sending → Onboard Domain**, or:

```sh
npx wrangler email sending enable your-site.com
```

That writes the SPF, DKIM and DMARC records for you. It takes a few minutes to propagate, and
until it has, a send is refused in as many words.

⚠️ **Sending to anybody but yourself needs the Workers Paid plan.** On Free, Cloudflare delivers
only to addresses verified in your own account, which is not enough for a site that invites
people. A refusal says so; see the check below.

To send real mail from `wrangler dev`, add `"remote": true` to the binding. Take it out again
before you deploy.

## Something else

Anything other than the three is a function of your own, given the message and answering with
the provider's own id for it where there is one:

```ts
mailer: async ({ to, subject, text, html }) => {
  const { id } = await myProvider.send({ to, subject, text, html });
  return { id };
},
```

## Prove it before anything depends on it

An **owner** posts to the check, and the admin mails them at their own account's address:

```sh
curl -X POST https://your-site.example/admin/api/checks/email -b cookies.txt
{"ok":true,"to":"you@your-site.com","id":"3f6b…"}
```

The recipient is never asked for. It is the address of whoever is signed in, so the button
cannot be pointed at a stranger.

| Answer | Means |
|---|---|
| `200` | It sent. `id` is the provider's own id for the message, where it has one — SMTP has none, so the answer carries no `id` at all |
| `403` | You are an editor. The test email is the owner's |
| `503` | No mailer is configured, or the one you named has no credential. The message names which |
| `502` | The provider refused, in the provider's own words — an unverified sending domain, a plan that may not write to that recipient, or a login the relay would not take, each reads as itself rather than as a number |

## When a send fails

The two links behave differently, and it is worth knowing which you are looking at.

The **sign-in link** and the **test email** both wait for the provider's answer. A send that
fails is a failed request: the test email answers `502` with the refusal in it, and the login
shows its ordinary "we couldn't sign you in" rather than telling somebody to check an inbox
nothing is coming to.

The **reset link** does not wait. `Forgot password?` answers *If this email exists in our system,
check your email for the reset link* before the mail is handed over — which is what keeps it from
confirming who has an account. A send that then fails reaches the Worker's log and nowhere else,
as `Failed to run background task` carrying the provider's own sentence. `npx wrangler tail` is
where to look when somebody says a reset link never arrived. Nothing in that line is the link
itself.

See also: [Configuration](configuration.md#mailer) for the config key, and
[Accounts and signing in](auth.md) for what the links do.
