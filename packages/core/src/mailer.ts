/**
 * One message, out, and the provider's own id for it where there is one — the diagnostics
 * "send test email" quotes that back, and a provider that hands out nothing identifiable says
 * so by leaving it off. A site swaps the provider the package ships for another service by
 * handing `mailer` its own function; nothing above here knows which one carried the message.
 */
export type Mailer = (message: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => Promise<{ id?: string }>;

/**
 * Resend behind the interface. The key is the Worker's and `from` is the site's, because an
 * address is not a secret and the diagnostics page shows it. On an account with no verified
 * domain the only sender is `onboarding@resend.dev`, which delivers to the Resend account's
 * own address and refuses every other recipient — with a message saying exactly that, which
 * is why the refusal below is worth quoting rather than counting.
 */
export function resendMailer(_siteId: string, key: string, from: string): Mailer {
  return async ({ to, subject, text, html }) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      // An undefined `html` is not a key: a plain-text message asks for no HTML part.
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok)
      throw new Error(
        `Resend refused the message (${res.status})${body.message ? `: ${body.message}` : ''}`,
      );
    return { id: body.id };
  };
}
