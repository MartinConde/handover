import { afterEach, expect, test, vi } from 'vitest';
import { resendMailer } from './mailer.js';

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
