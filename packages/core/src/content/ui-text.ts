import type { Field } from './schema.js';
import { DEFAULT_UI_LOCALE, type Labels, type UiLocale } from './ui-locale.js';

// Text the package writes outside the admin screens, per interface language: a new language is added here.

export const SOCIAL_IMAGE: Labels = { en: 'Social image', de: 'Social-Media-Bild' };

// The package's own sub-fields, named as the admin names them; core cannot read the UI messages.
export const PROP_NAMES: Record<string, Labels> = {
  alt: { en: 'Alt text', de: 'Alternativtext' },
  focal: { en: 'Focal point', de: 'Fokuspunkt' },
};
export const PROP_NAMES_OF: Partial<Record<Field['type'], Record<string, Labels>>> = {
  seo: {
    title: { en: 'Search title', de: 'Suchtitel' },
    description: { en: 'Description', de: 'Beschreibung' },
    image: SOCIAL_IMAGE,
    noindex: { en: 'Hide from search engines', de: 'Vor Suchmaschinen verbergen' },
    canonical: { en: 'Canonical URL', de: 'Kanonische URL' },
  },
  embed: { title: { en: 'Title', de: 'Titel' }, start: { en: 'Start at', de: 'Startzeit' } },
  link: {
    label: { en: 'Label', de: 'Beschriftung' },
    newTab: { en: 'Open in a new tab', de: 'In neuem Tab öffnen' },
  },
};

// Read by a person in the language they chose, so it is phrased here, where no admin screen shows it.
const MAIL = {
  en: {
    reset: (email: string, link: string) => ({
      subject: 'Set a new password',
      text: `Open this link to choose a new password for ${email}. It works once and expires in an hour.\n\n${link}\n\nIf you did not ask for this, ignore it — nothing has changed.`,
    }),
    approve: (email: string, link: string, newEmail: string) => ({
      subject: 'Approve your new email address',
      text: `Somebody signed in as ${email} asked to change this account's email to ${newEmail}.\n\nOpen this link to approve it. We then send a link to ${newEmail}, and the change happens when that one is opened. It expires in an hour.\n\n${link}\n\nIf this was not you, do not open the link and change your password — somebody may be signed in as you.`,
    }),
    confirm: (email: string, link: string) => ({
      subject: 'Confirm your new email address',
      text: `Open this link to make ${email} the address you sign in with. It works once and expires in an hour.\n\n${link}\n\nIf you did not ask for this, ignore it — nothing has changed.`,
    }),
    signIn: (email: string, link: string) => ({
      subject: 'Your sign-in link',
      text: `Open this link to sign in as ${email}. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for it, ignore it — nobody can sign in without opening the link.`,
    }),
    invite: (email: string, link: string, site: string) => ({
      subject: 'You have been invited',
      text: `You have been invited to help run ${site}.\n\nOpen this link to sign in as ${email}. It works once and expires in three days; once you are in, your account page offers you a password so the next time needs no link.\n\n${link}\n\nIf you were not expecting this, ignore it — nobody can sign in without opening the link.`,
    }),
    passwordSet: (email: string) => ({
      subject: 'A password was set for your account',
      text: `A password was set for ${email} from the account page, and every other device was signed out.\n\nIf this was not you, ask the site's owner to remove the password and sign you out everywhere.`,
    }),
    test: () => ({
      subject: 'Handover test email',
      text: 'Your site can send email. Nothing else to do — this message was sent from the admin to check.',
    }),
  },
  de: {
    reset: (email: string, link: string) => ({
      subject: 'Neues Passwort festlegen',
      text: `Öffne diesen Link, um ein neues Passwort für ${email} festzulegen. Er kann einmal verwendet werden und läuft nach einer Stunde ab.\n\n${link}\n\nFalls du das nicht angefordert hast, ignoriere diese E-Mail – es wurde nichts geändert.`,
    }),
    approve: (email: string, link: string, newEmail: string) => ({
      subject: 'Neue E-Mail-Adresse genehmigen',
      text: `Jemand, der als ${email} angemeldet ist, möchte die E-Mail-Adresse dieses Kontos auf ${newEmail} ändern.\n\nÖffne diesen Link, um das zu genehmigen. Danach schicken wir einen Link an ${newEmail}, und die Änderung gilt, sobald dieser geöffnet wird. Er läuft nach einer Stunde ab.\n\n${link}\n\nFalls du das nicht warst, öffne den Link nicht und ändere dein Passwort – möglicherweise ist jemand als du angemeldet.`,
    }),
    confirm: (email: string, link: string) => ({
      subject: 'Neue E-Mail-Adresse bestätigen',
      text: `Öffne diesen Link, damit ${email} die Adresse wird, mit der du dich anmeldest. Er kann einmal verwendet werden und läuft nach einer Stunde ab.\n\n${link}\n\nFalls du das nicht angefordert hast, ignoriere diese E-Mail – es wurde nichts geändert.`,
    }),
    signIn: (email: string, link: string) => ({
      subject: 'Dein Anmeldelink',
      text: `Öffne diesen Link, um dich als ${email} anzumelden. Er kann einmal verwendet werden und läuft nach 15 Minuten ab.\n\n${link}\n\nFalls du ihn nicht angefordert hast, ignoriere diese E-Mail – ohne den Link kann sich niemand anmelden.`,
    }),
    invite: (email: string, link: string, site: string) => ({
      subject: 'Du wurdest eingeladen',
      text: `Du wurdest eingeladen, ${site} mitzubetreuen.\n\nÖffne diesen Link, um dich als ${email} anzumelden. Er kann einmal verwendet werden und läuft nach drei Tagen ab; danach bietet dir deine Kontoseite ein Passwort an, damit du dich beim nächsten Mal ohne Link anmelden kannst.\n\n${link}\n\nFalls du keine Einladung erwartet hast, ignoriere diese E-Mail – ohne den Link kann sich niemand anmelden.`,
    }),
    passwordSet: (email: string) => ({
      subject: 'Für dein Konto wurde ein Passwort festgelegt',
      text: `Auf der Kontoseite wurde für ${email} ein Passwort festgelegt, und alle anderen Geräte wurden abgemeldet.\n\nFalls du das nicht warst, bitte die Eigentümer:in der Website, das Passwort zu entfernen und dich überall abzumelden.`,
    }),
    test: () => ({
      subject: 'Handover-Test-E-Mail',
      text: 'Deine Website kann E-Mails senden. Du musst nichts weiter tun – diese Nachricht wurde aus dem Admin gesendet, um das zu prüfen.',
    }),
  },
} satisfies Record<
  UiLocale,
  Record<string, (...args: never[]) => { subject: string; text: string }>
>;

export const mailText = (locale: UiLocale | null | undefined) => MAIL[locale ?? DEFAULT_UI_LOCALE];

// Read inside the preview pane, where the admin shell cannot phrase it, so it is phrased here.
export const PREVIEW_TEXT = {
  en: {
    title: 'Preview failed',
    signIn: 'Sign in to the admin to see a preview.',
    noPage: 'This site serves no page at that address.',
    unrenderable: 'This draft cannot be rendered:',
  },
  de: {
    title: 'Vorschau fehlgeschlagen',
    signIn: 'Melde dich im Admin an, um eine Vorschau zu sehen.',
    noPage: 'Diese Website liefert unter dieser Adresse keine Seite aus.',
    unrenderable: 'Dieser Entwurf lässt sich nicht darstellen:',
  },
} satisfies Record<UiLocale, Record<'title' | 'signIn' | 'noPage' | 'unrenderable', string>>;
