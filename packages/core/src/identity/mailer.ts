/** The provider's own id where there is one; a provider with nothing identifiable leaves it off. */
export type Mailer = (message: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => Promise<{ id?: string }>;

/** The refusal is quoted rather than counted: Resend's message says exactly what is wrong. */
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

/** `SendEmail.send` from `@cloudflare/workers-types@5.20260825.1`. */
export interface EmailSender {
  send(message: {
    to: string;
    from: string | { name: string; email: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

/** Cloudflare and SMTP take the halves apart, or `from` becomes `MAIL FROM. */
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

/** The runtime's error carries no `E_*` code, so its message is what the settings screen quotes. */
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
