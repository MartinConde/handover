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

## Integrations

The one section of this page that writes. Two keys belong to whoever owns the site rather than to
whoever built it — **DeepL** and, when there is a version with writing help in it, the AI
provider's — and swapping one should not be a support ticket. Everything else the admin runs on
stays in the environment: a wrong GitHub App key or bucket credential would lock you out of the
screen that fixes it.

A key is stored **encrypted** in the site's own database, under `HANDOVER_SETTINGS_KEY`
([Deploying](secrets.md)). Without that secret there is nowhere to put one, and the page
says so rather than failing.

Each card says where the key it names is coming from, and what happens if you take it away:

| The card says | What it means |
|---|---|
| **Set here** | A key was pasted into this page. It ends in the four characters shown, with who set it and when |
| **Coming from the site's settings** | Your developer set it in the site's environment. Setting one here overrides it, and removing yours falls back to theirs |
| **Your site's own code** | The site was handed its own translation function, which is used whatever is stored here |
| **Not set** | Nothing anywhere, and the card says what is switched off as a result |

**The value is never shown again** — not in the page, not in the API answer. The last four
characters are enough to answer "is this the one I pasted?", and to check anything more you
replace it. A DeepL key is tried against DeepL before it is stored: a key that was pasted wrong
is refused here, in DeepL's own words, rather than at the next translation.

Every change is a line in the [activity log](activity.md) naming the key and what happened to
it — set, replaced or removed — and never the key.

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
