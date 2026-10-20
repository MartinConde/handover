import { DEFAULT_UI_LOCALE, isUiLocale, UI_LOCALES, type UiLocale } from '@handover/core';

export const cookieLocale = (header: string | null): UiLocale | undefined => {
  for (const part of (header ?? '').slice(0, 4096).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'handover_ui_locale') continue;
    try {
      const value = decodeURIComponent(rest.join('='));
      return isUiLocale(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
};

export const acceptedLocale = (header: string | null): UiLocale | undefined => {
  const preferences = (header ?? '')
    .slice(0, 4096)
    .split(',')
    .map((part, order) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      const range = tag.toLowerCase();
      if (range !== '*' && !/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(range)) return undefined;
      let quality = 1;
      for (const parameter of parameters) {
        const match = parameter.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
        if (!match) return undefined;
        quality = Number(match[1]);
      }
      const language = range.split('-')[0];
      return { range, locale: isUiLocale(language) ? language : undefined, quality, order };
    })
    .filter((preference) => preference !== undefined);
  const wildcard = preferences.find((preference) => preference.range === '*');
  return UI_LOCALES.map((locale, supportedOrder) => {
    const explicit = preferences.filter((preference) => preference.locale === locale);
    const excluded = explicit.some((preference) => preference.quality === 0);
    const preferred = explicit
      .filter((preference) => preference.quality > 0)
      .sort((a, b) => b.quality - a.quality || a.order - b.order)[0];
    const match = preferred ?? (!excluded && wildcard?.quality ? wildcard : undefined);
    return match
      ? { locale, quality: match.quality, order: match.order, supportedOrder }
      : undefined;
  })
    .filter((candidate) => candidate !== undefined)
    .sort(
      (a, b) => b.quality - a.quality || a.order - b.order || a.supportedOrder - b.supportedOrder,
    )[0]?.locale;
};

/** The device's hint on a signed-out request: the picker's cookie, then `Accept-Language`. */
export const requestLocale = (request?: Request): UiLocale | undefined =>
  request &&
  (cookieLocale(request.headers.get('cookie')) ??
    acceptedLocale(request.headers.get('accept-language')));

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
