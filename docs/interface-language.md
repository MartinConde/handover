# Interface language

Handover's interface language is separate from the language of the content being edited.
English and Deutsch are available even when the site has only one content language.

Choose **Interface language** from the account menu to change it without leaving the current
screen. The same choice is available on **Account**. Signed-out screens, including password reset
and expired-link screens, have a device-only picker so they remain readable before sign-in.

## What is translated now

Language controls, sign-in, password-reset and expired-link flows, and the complete Account screen
are bilingual. Their already-visible notices and known authentication failures reformat when the
language changes. Typed credentials and profile values, the signed-in session, and an open editor
remain in place. The rest of the admin is being converted screen by screen and can still contain
English.

Handover-owned interface text is translated. Content and site configuration are not: collection
labels, schema descriptions, custom validation messages, entry titles, names, URLs, provider
diagnostics, and the values being edited remain as authored.

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

Changing interface language does not navigate, refetch content, change `?locale=`, remount an open
editor, or replace its draft. A new sign-in resolves the newly signed-in account's preference.

Connection failures retain the existing uncertain-result behavior. Handover renders a localized
summary from a stable error descriptor, not from an English sentence or status code. Known
authentication codes select specific recovery text. Unknown technical detail stays separate from
the translated summary where it is useful and safe to show.

The negotiated shell and authenticated bootstrap response use `Cache-Control: private, no-store`.
Hashed admin JavaScript and CSS remain shared immutable assets.
