import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Account from './Account.svelte';

let app: ReturnType<typeof mount>;
const USER = { id: 'u1', name: 'Martin', email: 'martin@example.com' };

interface Facts {
  hasPassword: boolean;
  sessions: { id: string; current: boolean; userAgent: string | null; lastUsed: number }[];
}

/** What `GET /admin/api/account` answers, plus every write the page made. */
function server(facts: Facts) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init) return Response.json(facts);
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ status: true });
    }),
  );
  return calls;
}

const show = async (role: 'owner' | 'editor' = 'owner') => {
  app = mount(Account, { target: document.body, props: { user: USER, role, onname: () => {} } });
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  return document.body;
};
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

const HERE = {
  id: 's1',
  current: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/1',
  lastUsed: Date.now(),
};
const THERE = {
  id: 's2',
  current: false,
  userAgent: 'Mozilla/5.0 (iPhone) Safari/1',
  lastUsed: Date.now() - 2 * 86400000,
};

// Two password forms on one screen is how somebody sets the wrong one, so the prompt takes the
// section's place rather than sitting above it.
test('somebody who has never set a password is offered one instead of the Password section', async () => {
  server({ hasPassword: false, sessions: [HERE] });
  const root = await show();

  expect(text(root)).toContain('You signed in with an email link');
  expect(root.querySelector('input#set-new')).not.toBeNull();
  expect(root.querySelector('input#current-password')).toBeNull();
});

test('somebody who has a password is asked for the old one and not prompted', async () => {
  server({ hasPassword: true, sessions: [HERE] });
  const root = await show();

  expect(root.querySelector('input#current-password')).not.toBeNull();
  expect(text(root)).not.toContain('You signed in with an email link');
});

// Two endpoints, because Better Auth has two: setting a first password is server-only and
// asks for nothing, changing one asks for the old one.
test('a first password goes to the package route, not to change-password', async () => {
  const calls = server({ hasPassword: false, sessions: [HERE] });
  const root = await show();
  type(root, 'set-new', 'a-brand-new-password');
  type(root, 'set-confirm', 'a-brand-new-password');

  click(root, 'Set password');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/account/set-password');
  expect(calls[0]?.body).toEqual({ newPassword: 'a-brand-new-password' });
});

// The section says "Changing it signs out your other devices", which is only true if it asks.
test('changing a password revokes the other sessions it says it revokes', async () => {
  const calls = server({ hasPassword: true, sessions: [HERE, THERE] });
  const root = await show();
  type(root, 'current-password', 'correct-horse-battery');
  type(root, 'change-new', 'a-brand-new-password');
  type(root, 'change-confirm', 'a-brand-new-password');

  click(root, 'Change password');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/auth/change-password');
  expect(calls[0]?.body).toMatchObject({ revokeOtherSessions: true });
});

test('the session this page was opened from is the one badged as this device', async () => {
  server({ hasPassword: true, sessions: [HERE, THERE] });
  const root = await show();
  const rows = root.querySelectorAll('.session-item');

  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Chrome on macOS');
  expect(rows[0]?.querySelector('.badge-accent')?.textContent).toBe('This device');
  expect(rows[1]?.querySelector('.badge-accent')).toBeNull();
  expect(rows[1]?.textContent).toContain('Safari on iPhone');
});

// Nothing to sign out of but this one, so the button would do nothing and say nothing.
test('sign out everywhere is not offered when this is the only session', async () => {
  server({ hasPassword: true, sessions: [HERE] });
  const root = await show();
  const button = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Sign out everywhere',
  );

  expect(button?.disabled).toBe(true);
});

test('sign out everywhere ends the other sessions and says so', async () => {
  const calls = server({ hasPassword: true, sessions: [HERE, THERE] });
  const root = await show();

  click(root, 'Sign out everywhere');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/auth/revoke-other-sessions');
  expect(text(root)).toContain('Your other devices are signed out');
});

// The role is shown and never editable here — an owner changes it on the Members screen.
test('the role is a fact on the page, not a control', async () => {
  server({ hasPassword: true, sessions: [HERE] });
  const root = await show('editor');

  expect(root.querySelector('.facts .badge')?.textContent).toBe('Editor');
  expect(root.querySelector('.facts select, .facts input')).toBeNull();
});
