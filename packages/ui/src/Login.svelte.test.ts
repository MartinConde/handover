import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Login, { type LoginMethods } from './Login.svelte';

let app: ReturnType<typeof mount>;
const BOTH: LoginMethods = { emailLink: true, github: true };
const PASSWORD_ONLY: LoginMethods = { emailLink: false, github: false };

const show = (methods: LoginMethods, path = '/admin', query = '') => {
  app = mount(Login, {
    target: document.body,
    props: { methods, path, query, onlogin: () => {} },
  });
  flushSync();
  return document.body;
};

/** Every call the form made, so a test can read what was asked of the server. */
function server(reply: (url: string) => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return reply(url);
    }),
  );
  return calls;
}

const ok = () => Response.json({ status: true });
const click = (root: HTMLElement, label: string) => {
  const button = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`No button labelled ${label}`);
  button.click();
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const text = (root: HTMLElement) => root.textContent?.replace(/\s+/g, ' ') ?? '';
/** Fill a field the way a person does, so `required` is satisfied when the form submits. */
const type = (root: HTMLElement, id: string, value: string) => {
  const field = root.querySelector(`input#${id}`) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// A button that answers 404 is worse than no button: the site is told which ways in it has.
test('a site with no mailer and no GitHub shows the password form and nothing else', () => {
  const root = show(PASSWORD_ONLY);

  expect(root.querySelector('input#password')).not.toBeNull();
  expect(text(root)).not.toContain('Email me a link');
  expect(text(root)).not.toContain('Continue with GitHub');
});

test('a site with both offers the link as the primary way in and GitHub as a text link', () => {
  const root = show(BOTH);

  expect(root.querySelector('.btn-primary')?.textContent?.trim()).toBe('Email me a link');
  expect(root.querySelector('input#password')).toBeNull();
  expect(text(root)).toContain('Continue with GitHub');
});

// The form must not confirm which addresses have an account, so it renders the same card
// whatever was typed — the server answers the same for both by design.
test('asking for a link says check your inbox for any address at all', async () => {
  const calls = server(ok);
  const root = show(BOTH);
  type(root, 'email', 'stranger@example.com');

  click(root, 'Email me a link');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/auth/sign-in/magic-link');
  expect(calls[0]?.body).toMatchObject({ email: 'stranger@example.com' });
  expect(text(root)).toContain('Check your inbox');
  expect(text(root)).toContain('stranger@example.com');
});

test('too many attempts is named rather than shown as a failure', async () => {
  server(() => new Response('', { status: 429 }));
  const root = show(BOTH);
  type(root, 'email', 'owner@example.com');

  click(root, 'Email me a link');
  await settle();

  expect(text(root)).toContain('Too many attempts');
  expect(text(root)).not.toContain('Check your inbox');
});

test('a dead link lands back here saying so, with one tap to a fresh one', () => {
  const root = show(BOTH, '/admin', '?error=INVALID_TOKEN');

  expect(text(root)).toContain('That sign-in link has expired');
  expect(root.querySelector('input#email')).not.toBeNull();
  expect(root.querySelector('.btn-primary')?.textContent?.trim()).toBe('Send a new link');
});

// Any refusal reads the same. Better Auth's own code for "this GitHub account has no row" is
// `signup_disabled`, and rendering that would tell a stranger their address is unknown here.
test('a refused GitHub sign-in reads the same as an expired link', () => {
  const root = show(BOTH, '/admin', '?error=signup_disabled');

  expect(text(root)).toContain('That sign-in link has expired');
  expect(text(root)).not.toContain('signup');
});

test('the reset page sets a password with the token from the email', async () => {
  const calls = server(ok);
  const root = show(BOTH, '/admin/reset', '?token=tok_123');
  type(root, 'new-password', 'a-brand-new-password');
  type(root, 'confirm-password', 'a-brand-new-password');

  click(root, 'Save password');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/auth/reset-password');
  expect(calls[0]?.body).toEqual({ token: 'tok_123', newPassword: 'a-brand-new-password' });
});

test('a new password under twelve characters is refused without asking the server', async () => {
  const calls = server(ok);
  const root = show(BOTH, '/admin/reset', '?token=tok_123');
  type(root, 'new-password', 'beach');
  type(root, 'confirm-password', 'beach');

  click(root, 'Save password');
  await settle();

  expect(calls).toEqual([]);
  expect(root.querySelector('#new-password-error')?.textContent).toBe(
    'Must be at least 12 characters',
  );
  expect(root.querySelector('input#new-password')?.getAttribute('aria-invalid')).toBe('true');
});
