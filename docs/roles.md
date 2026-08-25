# Roles and permissions

Two roles, in the `user.role` column:

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

See also: [Accounts and signing in](auth.md) for how somebody gets a session in the first place.
