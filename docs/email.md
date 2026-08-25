# Sending email

The admin sends mail for three things: the sign-in link on the login screen, the "set a new
password" link behind *Forgot password?*, and the test message on the settings screen. All three
go through whatever `mailer` in `cms.config.ts` names, so a site swaps its provider in one place.

Until a site has one, none of the three is offered — the login shows the password form and
nothing that does not work.

## 1. Name a provider

```ts
// cms.config.ts
mailer: { provider: 'resend', from: 'Your Site <hello@your-site.com>' },
```

`from` is config, not a secret: it is an address, the settings screen shows it, and the provider
refuses a domain it does not know. The key is a secret:

```sh
npx wrangler secret put RESEND_API_KEY
```

`'resend'` is the only provider so far. Anything else is a function of your own, given the
message and answering with the provider's own id for it where there is one:

```ts
mailer: async ({ to, subject, text, html }) => {
  const { id } = await myProvider.send({ to, subject, text, html });
  return { id };
},
```

## 2. Verify the sending domain

`from` has to be on a domain verified at `resend.com/domains`. Without one, the only sender that
works is `onboarding@resend.dev`, and Resend delivers it **only to the address the Resend account
was created with** — enough to prove a key works, not enough to write to anybody else. A site
whose people are not all you needs a verified domain before its first invite.

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
| `200` | It sent. `id` is the provider's own id for the message |
| `403` | You are an editor. The test email is the owner's |
| `503` | No mailer is configured, or its key is not set. The message names which |
| `502` | The provider refused, in the provider's own words — an unverified sending domain reads as itself rather than as a number, and so does a placeholder address like `you@example.com`, which Resend rejects outright |

## When a send fails

The test email above is the one message that waits for its answer, which is why it can quote the
refusal. The sign-in and reset links do not: the response goes back before the mail is handed
over, so the person at the keyboard is told to check their inbox either way.

A send that then fails reaches the Worker's log — `Failed to run background task`, carrying the
provider's own sentence — and nowhere else. `npx wrangler tail` is where to look when somebody
says a link never arrived. Nothing in that line is the link itself.

See also: [Configuration](configuration.md#mailer) for the config key, and
[Accounts and signing in](auth.md) for what the links do.
