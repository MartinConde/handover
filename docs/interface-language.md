# Interface language

Handover's interface language is separate from the language of the content being edited.
English and Deutsch are available even when the site has only one content language.

Choose **Interface language** from the account menu to change it without leaving the current
screen. The same choice is available on **Account**. Signed-out screens, including password reset
and expired-link screens, have a device-only picker so they remain readable before sign-in.

## What is translated now

Language controls, sign-in, password-reset and expired-link flows, the complete Account screen,
the signed-in shell, the dashboard, collection entry lists, entry creation, shared page/entry
pickers, and the entry editor's tabs and header controls are bilingual. Navigation, pending/build
indicators, list and picker states, editor URL metadata, converted dates, accessibility labels,
validation that already carries a Handover descriptor, and retained editor save/lock/hold feedback
reformat when the language changes. Structured-field wrappers now include group/list/block controls,
link and reference presentation, image/file cards, embed recovery, SEO controls and their open field
popovers and notices. Required fields and built-in scalar type, date, selection, text-length and
number-bound validation emit descriptors. Rich-text toolbar names, link controls and
foreign-formatting guidance are bilingual. Media-picker presentation, selection queues and upload
recovery are bilingual; crop/focal dialogs and the full media-library screen remain staged follow-up
work. Dashboard, collection, picker, and open-entry data are not reread, and typed
values, queued saves, undo history, filters, selected rows, creation starters, custom URLs, the
signed-in session, editor content language, and the active editor field remain in place.
Activity-event sentences and the remaining admin screens are being converted in stages and can
still contain English.

Handover-owned interface text is translated. Content and site configuration are not: collection
labels, schema descriptions, custom validation messages, entry titles, names, URLs, provider
diagnostics, and the values being edited remain as authored.

If entry creation returns success without a usable filename, Handover cannot know whether the
draft was created. It keeps the creation form and presents translated guidance to check the entry
list before trying again; changing interface language retranslates that guidance in place.

## How the initial language is chosen

Before the signed-in interface first appears, Handover uses the first supported value from:

1. the signed-in account's saved preference;
2. this installation's device hint, when the account has no saved preference;
3. the browser's language preferences, including regional English and German variants;
4. English.

Unsupported or malformed hints are ignored. The empty HTML shell uses the device hint first, then
weighted `Accept-Language`, then English. The existing authenticated bootstrap response can still
replace that shell hint with the account preference before any visible UI mounts.

The device hint is a small `handover_ui_locale` cookie scoped to the installation's `/admin` path.
It is retained on sign-out and cannot override a saved preference belonging to another account.
Handover does not use Paraglide's global locale cookie.

## Saving and recovery

For a signed-in account, a selection is applied only after the existing profile update confirms
`{ "status": true }`. A failed save keeps the last confirmed language and device hint. If the
network makes the outcome uncertain, Handover reads the existing bootstrap endpoint once to
reconcile the stored value; it does not reload the page or recreate the editor.

Changing interface language does not navigate, refetch content, change a list's content-language
`?locale=`, clear search/status/language filters or selected rows, remount an open editor, or
replace a local action draft. A new sign-in resolves the newly signed-in account's preference.

In an open entry, the Content/SEO/History tabs, Form/Split/Canvas controls, status and overflow
actions, URL metadata, outline labels, and the date of a language removed through Handover update
in place. An editable web-address label presents the selected content language in the interface
language, and a disabled Publish action translates whether a lock, block drift or a missing value
is in the way. The collection identifier, entry title, field labels, filenames, URLs,
content-language selection, and typed content remain authored data.

Connection failures retain the existing uncertain-result behavior. Handover renders a localized
summary from a stable error descriptor, not from an English sentence or status code. Known
authentication codes select specific recovery text. Unknown technical detail stays separate from
the translated summary where it is useful and safe to show. In particular, an entry read uses the
specific not-found message only when the response carries `x-handover-error-code:
ENTRY_NOT_FOUND`; an unidentified `404` keeps the generic localized load summary and status.

Pending, build, dashboard, and activity reads validate their small response envelopes as well as
their JSON syntax. `null`, a non-array collection, or an unknown build state enters the same
localized retry state as another failed read without replacing last-known values. The empty build
response `{}` remains valid and means that no build status is available.

Password-length failures keep the entered values and give the supported 12–128-character range.
Only an invalid, expired, or already-used reset token asks for a new link. A malformed Account read
uses the localized account-loading recovery and Retry action rather than parser text.

The negotiated shell and authenticated bootstrap response use `Cache-Control: private, no-store`.
Hashed admin JavaScript and CSS remain shared immutable assets.
