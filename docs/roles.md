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

## Members — `/admin/members`

Owner-only, and the only place an account is made or unmade. Every route behind it asserts the
role on the server; the two rules the screen greys out are refused there as well, because a
disabled menu item is a drawing of a rule and not the rule.

### Inviting somebody

*Invite* takes an address and one of the two roles. It writes a `user` row and mails that
address a sign-in link — there is no invite table, no password and nothing for you to pass on.
The person opens the link, which signs them in, and `/admin/account` offers them a first
password so the next time needs no link.

An invite's link **works once and lasts three days**, where an ordinary sign-in link lasts
fifteen minutes: an invite is read in the evening. Only a hash of it is stored, so a copy of the
database is not a way in.

Until somebody opens their link the row shows as **Invite pending**, and its menu has two extra
items: *Resend invite*, which mails a new link, and *Revoke invite*, which removes the row. A
member who has already signed in is not offered a resend — they ask for their own link on the
login screen.

If the mail cannot be sent the row is still made, so the invite is there to resend once the
[mailer](email.md) is fixed. The screen says so rather than pretending nothing happened.

### Changing a role

Owner ↔ editor, from the row's menu. **The last owner cannot be demoted** — a site with no owner
has nobody who can invite, change a role or reach Settings, and nothing in the admin could undo
it.

### Taking access away

*Remove* deletes the `user` row and, with it, every session and every account: their password,
their linked GitHub, and any browser they were signed in on. It takes effect on their next
request.

**Their drafts stay.** An unpublished change belongs to the site, not to whoever last typed in
it, so removing somebody never loses work.

Two removals are refused by the server, not just hidden: **you cannot remove yourself**, and the
last owner stays. Getting a colleague to remove you is the way out of the first.

### How somebody signs in

The **Sign-in method** column is worked out from the account rows, not stored, so it cannot go
stale:

| It says | Because |
|---|---|
| `GitHub` | They have a linked GitHub account. It wins over the others — it is the one they will recognise |
| `Password + email link` | They have a password. An email link always works too |
| `Email link only` | They have no password yet. Setting one is on their account page |
| `—` | The invite has not been opened, so nobody knows yet |

**Last sign-in** is read from their live sessions. Signing out removes the last one, so somebody
who signed out everywhere reads *Not known* until they are back — the number is a convenience,
not a record.

See also: [Accounts and signing in](auth.md) for how somebody gets a session in the first place.
