# Redirects

`src/content/redirects.yaml` is a flat list of rules. Handover appends to it when an entry
is renamed or deleted ([entry lifecycle](entry-lifecycle.md#renaming-and-deleting-an-entry));
the client adds their own under **Site settings → Redirects**, and you can edit the file by hand.

## The file

```yaml
_version: 1
rules:
  - _id: "q8r9s0t1"
    from: "/brochure"
    to: "https://example.com/files/brochure.pdf"
    status: 301
    reason: "manual"
    createdAt: "2026-08-21T08:00:00Z"
```

`from` is a path starting with `/`; `to` is a path or an absolute URL; `status` is `301` or
`302`; `reason` is one of `slug-change`, `hidden`, `deleted`, `manual`. Exact matches only — no
wildcards.

## In the admin

The admin's table refuses a `from` that is a page the site already serves — that redirect would
take the page off the site — and a second rule from an address that already has one. A rule
pointing at an address a new rule claims is re-pointed at its destination, so a visitor never
hops twice. A rule the client adds is **committed as it is added** rather than waiting in the
publish drawer: this file is assembled at publish out of the rules of the selected entries, so a
rule belonging to no entry has nowhere to wait. It reaches visitors after the build.

**Test** on a row asks the live site for the old address, from the browser, and says what came
back rather than what the file says: *Working* (it forwards where the rule points), *Not there
yet* (a 404 — the rule is unpublished or the site is still building) or *Not what this rule says*
(a page answers at the old address, or it forwards somewhere else).

A rule with `reason: hidden` belongs to the entry that is hidden — showing that entry again
removes the rule in the same commit — so the table draws it but neither edits nor deletes it.

## At build time

At build time the integration writes every rule into `_redirects` in the output directory,
which Cloudflare serves without any Worker code. Each `from` is written twice — with the trailing
slash and without, since a visitor arrives with whichever form the page had when they bookmarked
it — and `to` the way your pages answer (`trailingSlash` and `build.format`), so they land in one
hop:

```
/brochure https://example.com/files/brochure.pdf 301
/brochure/ https://example.com/files/brochure.pdf 301
```

A rule that fails validation fails the build, naming it:
`src/content/redirects.yaml › rules[0].from: a path starting with "/"`. Redirects from
`astro.config` still work; the adapter adds them to the same file.
