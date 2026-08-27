# Settings — what is connected

**Settings** in the admin's Manage group is the owner's read-only view of the site: what
`cms.config.ts` came out as, and whether the things it points at answer. It is where somebody
who is not you finds out *what* is broken, in a sentence they can forward.

Owner only. An editor is offered neither the sidebar item nor the route.

## Configuration

The collections and their routes, the languages, where uploads are served from, who sends the
mail, and whether this build has a preview route. All of it is read out of `cms.config.ts` and
the build; nothing on the page edits it. A build with no preview says which variable turns it
on rather than saying "off" and stopping.

## Connections

Each connection is tried for real when the page opens, and again whenever **Test** is pressed:

| Check | What it does |
|---|---|
| Your website's code (GitHub) | mints an installation token and reads the branch head |
| Images and files (R2) | writes, reads back and deletes one small object |
| Email | **only when you press it** — sends a test message to your own address |
| Translation | translates one word into the site's second language — a one-language site has nothing to translate into and says so |
| Build status | asks Cloudflare about the worker, so the token is proven without a commit |
| Database | reads from the admin's own tables |

A check whose thing the site never configured reads **Not in use** rather than failing: a site
with no `DEEPL_API_KEY` is not broken. A check that was configured and refused reads **Not
working**, and its result line is the refusal itself — `RESEND_API_KEY is not set: …`, the
bucket's own status, the sentence naming the four R2 values. That is the wording to send to
whoever holds the credentials.

The failures are counted at the top of the page, with what stops working while they stand.

## Sending a test email

The one check with a side effect, so it never runs on its own. It goes to the address of
whoever is signed in and to nobody else — the recipient is never asked for, so the button
cannot be pointed at a stranger. [Sending email](email.md) is the setup behind it.

## Simulate a conflict

Under **Developer tools**, and only while the site is running in development. It publishes a
scratch entry, edits its draft and then commits a different edit to the same file — which is
what a colleague's push does to somebody's open draft — so the three-way view in the
pending-changes drawer can be exercised without hand-crafting commits
([Working together](working-together.md#resolving-it-field-by-field)).

It writes to your repository. The result names the entry it made: delete that entry when you
are done with it.
