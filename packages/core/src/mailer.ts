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

/**
 * The `send_email` binding, named here rather than pulled in from `workers-types`: one method,
 * the one that is called. Its shape is `SendEmail.send(EmailMessageBuilder)` from
 * `@cloudflare/workers-types@5.20260825.1`, narrowed to the fields a Handover message has.
 */
export interface EmailSender {
  send(message: {
    to: string;
    from: string | { name: string; email: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

/**
 * `Display Name <someone@example.com>` split into the two halves a provider that takes them
 * apart needs. Resend takes the whole string; the Cloudflare binding and SMTP do not, and an
 * unsplit `from` becomes `MAIL FROM: <Handover <admin@…>>` — a malformed envelope rather than
 * an error. Exported because the SMTP implementation lives in the Astro package and needs the
 * same split; getting it wrong in two places is the thing worth avoiding.
 */
export function senderAddress(
  _siteId: string,
  from: string,
): { name: string; email: string } | string {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!angled) return from.trim();
  const name = (angled[1] ?? '').replace(/^"|"$/g, '').trim();
  const email = (angled[2] ?? '').trim();
  return name ? { name, email } : email;
}

/**
 * Cloudflare Email Sending behind the interface. The binding is the credential — there is no
 * key to hold — which is why it arrives as an argument like every other resolved credential.
 * A refusal arrives as a plain `Error` whose message is the rule that was broken, and that
 * sentence is what the settings screen quotes back: an unonboarded sending domain, or the
 * recipient narrowing a plan imposes, has to read as itself rather than as a number. The
 * documented `E_*` codes are not on the error the runtime throws — checked against three
 * refusals, whose only own property is `remote`.
 */
export function cloudflareMailer(_siteId: string, binding: EmailSender, from: string): Mailer {
  return async ({ to, subject, text, html }) => {
    try {
      const { messageId } = await binding.send({
        to,
        from: senderAddress(_siteId, from),
        subject,
        text,
        ...(html ? { html } : {}),
      });
      return { id: messageId };
    } catch (err) {
      const { message } = err as { message?: string };
      throw new Error(`Cloudflare refused the message${message ? `: ${message}` : ''}`);
    }
  };
}
