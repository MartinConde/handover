# Settings — what is connected

**Settings** in the admin's Manage group is where the owner sees whether the services the site
runs on answer, and manages the keys they own. It is where somebody who is not you finds out
*what* is broken, in a sentence they can forward.

A line at the top says whether everything is working, or how many checks fail and what stops
working while they do. **Check again** reruns every check except the test email.

Owner only. An editor is offered neither the sidebar item nor the route.

The screen follows the account's **Interface language** choice immediately. Headings, controls,
dates, language names, check states and Handover's own result summaries switch between English and
German without rerunning a check or clearing an open key dialog. Collection names, routes, email
addresses, repository names, commit prefixes, bucket and worker names, configuration identifiers
and provider refusal details remain exactly as the site or service supplied them. Changing this
language never changes the site's content languages or configuration.

## Services

Each service is tried for real when the page opens, and again on **Check again**. A row shows
its name and state; open it for the provider, where uploads are served from or who sends the
mail, and the last result:

| Service | What the check does |
|---|---|
| Publishing | mints a GitHub installation token and reads the branch head |
| Images and files | writes, reads back and deletes one small object on R2 |
| Email | **only when you press Send a test email** — sends a message to your own address |
| Build status | asks Cloudflare about the worker, so the token is proven without a commit |
| Database | reads from the admin's own tables |

Translation is checked the same way — one word into the site's second language — and its result
is shown on the **DeepL** row under [Translation and AI](#translation-and-ai). A one-language
site has nothing to translate into and says so.

A failing row opens by itself, so its reason is visible without a click. A check whose thing the
site never configured reads **Not in use** rather than failing: a site
with no `DEEPL_API_KEY` is not broken. A check that was configured and refused reads **Not
working**, and its result line is the refusal itself — `RESEND_API_KEY is not set: …`, the
bucket's own status, the sentence naming the four R2 values. That is the wording to send to
whoever holds the credentials.

Those two states come from stable response codes, not from treating every `502` or `503` as the
same cause. Known successful and optional-off results are formatted by the browser in the current
interface language. A service refusal or configuration detail stays verbatim so a translated
summary cannot obscure the value that needs fixing.

## Translation and AI

The one section of this page that writes. Two keys belong to whoever owns the site rather than to
whoever built it — **DeepL** and, when there is a version with writing help in it, the AI
provider's — and swapping one should not be a support ticket. Everything else the admin runs on
stays in the environment: a wrong GitHub App key or bucket credential would lock you out of the
screen that fixes it.

A key is stored **encrypted** in the site's own database, under `HANDOVER_SETTINGS_KEY`
([Deploying](secrets.md)). Without that secret there is nowhere to put one, and the page
says so rather than failing.

Each row says where the key it names is coming from, and what happens if you take it away:

| The row says | What it means |
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

## About this site

A closed section at the bottom: the collections and their routes, the languages, and whether
this build has a preview route. All of it is read out of `cms.config.ts` and the build; nothing
on the page edits it. A build with no preview says which variable turns it on rather than saying
"off" and stopping.

**Source languages**, on a site with two or more languages, counts the entries that do not yet
record the language they are written in and links to the Dashboard, where an owner records them
([i18n.md](i18n.md#recording-the-source-of-existing-entries)). Settings never writes to the
repository, so there is no button here.

## Simulate a conflict

Under **Developer tools** inside **About this site**, and only while the site is running in
development. It publishes a
scratch entry, edits its draft and then commits a different edit to the same file — which is
what a colleague's push does to somebody's open draft — so the three-way view in the
pending-changes drawer can be exercised without hand-crafting commits
([Publish conflicts](conflicts.md#resolving-it-field-by-field)).

It writes to your repository. The result names the entry it made: delete that entry when you
are done with it.
