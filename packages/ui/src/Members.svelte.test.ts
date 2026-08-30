import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Members from './Members.svelte';

let app: ReturnType<typeof mount>;
const YOU = { id: 'u1', name: 'Martin Conde', email: 'martin@example.com' };

interface Row {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'editor';
  pending: boolean;
  method: 'github' | 'password' | 'link' | null;
  editing: string[];
  lastSignIn: number | null;
  invitedAt: number;
}

const row = (id: string, email: string, extra: Partial<Row> = {}): Row => ({
  id,
  name: '',
  email,
  role: 'editor',
  pending: false,
  method: 'link',
  editing: [],
  lastSignIn: Date.now() - 3_600_000,
  invitedAt: 0,
  ...extra,
});

/** What `GET /admin/api/members` answers, plus every write the screen made. */
function server(
  members: Row[],
  answers: Record<string, Response | (() => Promise<Response>)> = {},
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init) return Response.json({ members });
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const answer = answers[url];
      if (answer === undefined) return Response.json({ ok: true, to: 'lea@example.com' });
      return typeof answer === 'function' ? answer() : answer;
    }),
  );
  return calls;
}

const show = async () => {
  app = mount(Members, { target: document.body, props: { user: YOU } });
  flushSync();
  await settle();
  return document.body;
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (root: ParentNode, label: string) => {
  const found = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
};
const click = (root: ParentNode, label: string) => {
  button(root, label).click();
  flushSync();
};
/** Open one row's actions, by the label the trigger carries. */
const actions = (root: HTMLElement, who: string) => {
  const trigger = root.querySelector(`button[aria-label="Actions for ${who}"]`) as HTMLElement;
  trigger.click();
  flushSync();
  return root.querySelector('.menu') as HTMLElement;
};
const cells = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll(`.td[data-label="${label}"]`)).map((c) => text(c));

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('each sign-in method is named in the words the person would use', async () => {
  server([
    row('u1', 'martin@example.com', { method: 'github' }),
    row('u2', 'anna@example.com', { method: 'password' }),
    row('u3', 'jonas@example.com', { method: 'link' }),
    row('u4', 'lea@example.com', { pending: true, method: null, lastSignIn: null }),
  ]);

  const root = await show();

  expect(cells(root, 'Sign-in method')).toEqual([
    'GitHub',
    'Password + email link',
    'Email link only',
    '—',
  ]);
});

test('an invite nobody has opened is marked pending and has never signed in', async () => {
  server([row('u4', 'lea@example.com', { pending: true, method: null, lastSignIn: null })]);

  const root = await show();

  expect(text(root)).toContain('Invite pending');
  expect(cells(root, 'Last sign-in')).toEqual(['Never']);
});

// Signing out deletes the session row, so there is no date left to show — and saying "Never"
// there would call somebody who uses the site every day an unopened invite.
test('a member with no session row left reads as not known, not as never', async () => {
  server([row('u2', 'anna@example.com', { lastSignIn: null })]);

  const root = await show();

  expect(cells(root, 'Last sign-in')).toEqual(['Not known']);
});

test('the invite dialog sends the address and the role that were chosen', async () => {
  const calls = server([row('u1', 'martin@example.com', { role: 'owner' })]);
  const root = await show();

  click(root, 'Invite');
  const field = root.querySelector('input#invite-email') as HTMLInputElement;
  field.value = 'lea@example.com';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  (root.querySelector('input[name="invite-role"][value="owner"]') as HTMLInputElement).click();
  flushSync();
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  expect(calls[0]).toEqual({
    url: '/admin/api/members',
    method: 'POST',
    body: { email: 'lea@example.com', role: 'owner' },
  });
  expect(text(root)).toContain('Invite sent to lea@example.com.');
});

// Settings is where the mailer's own sentence names the credential that is missing, so the
// notice sends them there rather than describing the problem a second time.
test('an invite the mailer refused sends the owner to Settings', async () => {
  server([row('u1', 'martin@example.com', { role: 'owner' })], {
    '/admin/api/members': Response.json({ error: 'invite-not-sent' }, { status: 502 }),
  });
  const root = await show();

  click(root, 'Invite');
  const field = root.querySelector('input#invite-email') as HTMLInputElement;
  field.value = 'lea@example.com';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  const failure = root.querySelector('.notice-danger') as HTMLElement;
  expect(text(failure)).toBe(
    "Couldn't send the invite — email isn't set up correctly on this site. Settings says which credential is missing. Fix it and resend.",
  );
  expect(failure.querySelector('a')?.getAttribute('href')).toBe('/admin/settings');
});

test('the only owner is offered neither a role change nor a removal, and is told why', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com', { role: 'editor' }),
  ]);
  const root = await show();

  const menu = actions(root, 'martin@example.com');

  expect(text(menu.querySelector('.menu-note') as HTMLElement)).toBe(
    'There must be at least one owner.',
  );
  expect(button(menu, 'Change role').getAttribute('aria-disabled')).toBe('true');
  expect(button(menu, 'Remove').getAttribute('aria-disabled')).toBe('true');
});

test('an owner beside another owner is offered neither on their own row, and both on the other', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com', { role: 'owner' }),
  ]);
  const root = await show();

  const mine = actions(root, 'martin@example.com');
  expect(text(mine.querySelector('.menu-note') as HTMLElement)).toBe(
    'You cannot change your own access.',
  );
  expect(button(mine, 'Change role').getAttribute('aria-disabled')).toBe('true');
  expect(button(mine, 'Remove').getAttribute('aria-disabled')).toBe('true');

  const theirs = actions(root, 'anna@example.com');
  expect(theirs.querySelector('.menu-note')).toBe(null);
  expect(button(theirs, 'Remove').getAttribute('aria-disabled')).toBe(null);
});

test('a pending invite is offered a resend and a revoke, and a member is offered neither', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com'),
    row('u4', 'lea@example.com', { pending: true, method: null, lastSignIn: null }),
  ]);
  const root = await show();

  const pending = actions(root, 'lea@example.com');
  expect(text(pending)).toContain('Resend invite');
  expect(text(pending)).toContain('Revoke invite');

  const member = actions(root, 'anna@example.com');
  expect(text(member)).not.toContain('Resend invite');
  expect(text(member)).toContain('Remove');
});

test('resending an invite says where it went', async () => {
  const calls = server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u4', 'lea@example.com', { pending: true, method: null, lastSignIn: null }),
  ]);
  const root = await show();

  click(actions(root, 'lea@example.com'), 'Resend invite');
  await settle();

  expect(calls[0]?.url).toBe('/admin/api/members/u4/invite');
  expect(text(root)).toContain('Invite sent to lea@example.com.');
});

test('changing a role sends the one that was picked', async () => {
  const calls = server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com'),
  ]);
  const root = await show();

  click(actions(root, 'anna@example.com'), 'Change role');
  (root.querySelector('input[name="member-role"][value="owner"]') as HTMLInputElement).click();
  flushSync();
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  expect(calls[0]).toEqual({
    url: '/admin/api/members/u2/role',
    method: 'POST',
    body: { role: 'owner' },
  });
});

// Hazard: the one line people get wrong. Their drafts belong to the site and stay; what goes
// is their access, and the entries they were holding.
test('removing somebody warns what goes and says their drafts stay', async () => {
  const calls = server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com', { name: 'Anna Berg' }),
  ]);
  const root = await show();

  click(actions(root, 'Anna Berg'), 'Remove');
  const dialog = root.querySelector('[role="alertdialog"]') as HTMLElement;
  expect(text(dialog)).toContain('Remove Anna Berg?');
  expect(text(dialog)).toContain('Their unpublished changes stay.');

  click(dialog, 'Remove');
  await settle();

  expect(calls[0]).toEqual({ url: '/admin/api/members/u2', method: 'DELETE', body: undefined });
});

test('removing somebody who is editing names what goes quiet', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com', { name: 'Anna Berg', editing: ['Seaview Cottage', 'Home'] }),
  ]);
  const root = await show();

  click(actions(root, 'Anna Berg'), 'Remove');

  const dialog = root.querySelector('[role="alertdialog"]') as HTMLElement;
  expect(text(dialog)).toContain('They are editing Seaview Cottage and Home right now');
  expect(text(dialog)).toContain('releases them straight away');
});

test('revoking an invite is a different question from removing a member', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u4', 'lea@example.com', { pending: true, method: null, lastSignIn: null }),
  ]);
  const root = await show();

  click(actions(root, 'lea@example.com'), 'Revoke invite');

  const dialog = root.querySelector('[role="alertdialog"]') as HTMLElement;
  expect(text(dialog)).toContain('Revoke the invite to lea@example.com?');
  expect(text(dialog)).not.toContain('unpublished changes');
});

// The server refuses these too; what the dialog owes is the sentence it was given, rather than
// a status the person at the keyboard cannot act on.
test("a refused change comes back in the server's own words, beside the button that asked", async () => {
  server([row('u1', 'martin@example.com', { role: 'owner' }), row('u2', 'anna@example.com')], {
    '/admin/api/members/u2/role': Response.json(
      { error: 'There must be at least one owner' },
      { status: 400 },
    ),
  });
  const root = await show();

  click(actions(root, 'anna@example.com'), 'Change role');
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  expect(text(root.querySelector('.dialog .notice-danger') as HTMLElement)).toBe(
    'There must be at least one owner',
  );
});

// axe sees none of this. A dialog opened from a row menu has to take focus and give it back
// to the row's own button — the menu item that was pressed is gone by then.
test('each dialog takes focus and hands it back to the button that opened it', async () => {
  server([
    row('u1', 'martin@example.com', { role: 'owner' }),
    row('u2', 'anna@example.com', { name: 'Anna Berg' }),
  ]);
  const root = await show();

  const invite = button(root, 'Invite');
  invite.focus();
  invite.click();
  flushSync();
  expect(document.activeElement?.id).toBe('invite-email');
  click(root, 'Cancel');
  expect(document.activeElement).toBe(invite);

  const menu = root.querySelector('button[aria-label="Actions for Anna Berg"]') as HTMLElement;
  menu.focus();
  menu.click();
  flushSync();
  // A real click focuses the button it lands on, and jsdom's `.click()` does not — so the
  // focus the component reads is put where a browser would put it.
  const item = button(root.querySelector('.menu') as HTMLElement, 'Change role');
  item.focus();
  item.click();
  flushSync();
  expect((document.activeElement as HTMLInputElement).value).toBe('editor');
  click(root, 'Cancel');
  expect(document.activeElement).toBe(menu);
});

// A real send takes about a second. Without this the button stays live and a second click
// invites the same address again, which comes back "User already exists".
test('the invite button is disabled while the message is being sent', async () => {
  const calls = server([row('u1', 'martin@example.com', { role: 'owner' })], {
    // Never settles: a send still in flight, which is what the button is disabled for.
    '/admin/api/members': () => new Promise<Response>(() => {}),
  });
  const root = await show();

  click(root, 'Invite');
  const field = root.querySelector('input#invite-email') as HTMLInputElement;
  field.value = 'lea@example.com';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  const submit = root.querySelector('.dialog button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(submit.textContent?.trim()).toBe('Sending…');
  expect(calls).toHaveLength(1);
});

// `missingMailer()` names env vars and a `wrangler secret put` command. Those are the
// developer's words and belong on the diagnostics screen, not in front of the client.
test('a site with no mailer gets the same sentence as one whose mailer refused', async () => {
  server([row('u1', 'martin@example.com', { role: 'owner' })], {
    '/admin/api/members': Response.json(
      {
        error:
          'RESEND_API_KEY is not set: put it in .dev.vars, or set it with `wrangler secret put RESEND_API_KEY`',
      },
      { status: 503 },
    ),
  });
  const root = await show();

  click(root, 'Invite');
  const field = root.querySelector('input#invite-email') as HTMLInputElement;
  field.value = 'lea@example.com';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (root.querySelector('.dialog form') as HTMLFormElement).requestSubmit();
  await settle();

  const failure = text(root.querySelector('.notice-danger') as HTMLElement);
  expect(failure).toContain('Settings says which credential is missing');
  // The developer's own sentence is on Settings and not here: this screen is the owner's.
  expect(failure).not.toContain('RESEND_API_KEY');
});
