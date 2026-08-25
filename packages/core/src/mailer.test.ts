import { afterEach, expect, test, vi } from 'vitest';
import { cloudflareMailer, type EmailSender, resendMailer, senderAddress } from './mailer.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Resend boundary. Every call made is kept so a test can read what was sent.
function stubFetch(reply: () => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return reply();
    }),
  );
  return calls;
}

test('Resend is called with the message, the sender and the key, and answers with its id', async () => {
  const calls = stubFetch(() => Response.json({ id: 'e1b2c3d4' }));
  const sent = await resendMailer(
    'default',
    're_123',
    'Handover <onboarding@resend.dev>',
  )({
    to: 'anna@example.com',
    subject: 'Handover test email',
    text: 'It works.',
  });
  expect(sent).toEqual({ id: 'e1b2c3d4' });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://api.resend.com/emails');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('Bearer re_123');
  // No `html` key at all rather than a null one: a message that has none sends none.
  expect(calls[0]?.body).toEqual({
    from: 'Handover <onboarding@resend.dev>',
    to: 'anna@example.com',
    subject: 'Handover test email',
    text: 'It works.',
  });
});

test("Resend's own message is what a refused send says", async () => {
  stubFetch(() =>
    Response.json(
      {
        name: 'validation_error',
        statusCode: 403,
        message:
          'You can only send testing emails to your own email address (martin@martinconde.com).',
      },
      { status: 403 },
    ),
  );
  await expect(
    resendMailer(
      'default',
      're_123',
      'Handover <onboarding@resend.dev>',
    )({
      to: 'someone@example.com',
      subject: 'Handover test email',
      text: 'It works.',
    }),
  ).rejects.toThrow(
    'Resend refused the message (403): You can only send testing emails to your own email address (martin@martinconde.com).',
  );
});

test('a sender with a display name is split into the two halves a binding takes apart', () => {
  expect(senderAddress('default', 'Handover <admin@dev.martinconde.de>')).toEqual({
    name: 'Handover',
    email: 'admin@dev.martinconde.de',
  });
});

test('a sender that is only an address stays one string', () => {
  expect(senderAddress('default', '  admin@dev.martinconde.de  ')).toBe('admin@dev.martinconde.de');
});

// The `send_email` binding. Every call is kept, the way the Resend stub above keeps its own.
function stubBinding(reply: () => Promise<{ messageId: string }>) {
  const calls: Parameters<EmailSender['send']>[0][] = [];
  return {
    calls,
    binding: {
      send: (message: Parameters<EmailSender['send']>[0]) => {
        calls.push(message);
        return reply();
      },
    },
  };
}

test("Cloudflare is called with the split sender, and answers with the binding's message id", async () => {
  const { calls, binding } = stubBinding(async () => ({ messageId: 'cf-9f21' }));
  const sent = await cloudflareMailer(
    'default',
    binding,
    'Handover <admin@cf-mail.martinconde.de>',
  )({
    to: 'anna@example.com',
    subject: 'Handover test email',
    text: 'It works.',
  });
  expect(sent).toEqual({ id: 'cf-9f21' });
  // No `html` key at all rather than a null one, as with Resend above.
  expect(calls).toEqual([
    {
      to: 'anna@example.com',
      from: { name: 'Handover', email: 'admin@cf-mail.martinconde.de' },
      subject: 'Handover test email',
      text: 'It works.',
    },
  ]);
});

test("Cloudflare's own sentence is what a refused send says", async () => {
  // Verbatim from the binding, sending from a domain the account has not onboarded.
  const { binding } = stubBinding(() =>
    Promise.reject(
      new Error(
        'email from not-onboarded.example.com not allowed because domain is not owned by the same account',
      ),
    ),
  );
  await expect(
    cloudflareMailer(
      'default',
      binding,
      'admin@not-onboarded.example.com',
    )({ to: 'someone@example.com', subject: 'Handover test email', text: 'It works.' }),
  ).rejects.toThrow(
    'Cloudflare refused the message: email from not-onboarded.example.com not allowed because domain is not owned by the same account',
  );
});
