<script lang="ts">
interface Member {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'editor';
  /** An invite nobody has opened yet. Computed by the server; there is no invite table. */
  pending: boolean;
  method: 'github' | 'password' | 'link' | null;
  /** The entries they are holding a lock on right now, by the name the list shows. */
  editing: string[];
  lastSignIn: number | null;
  invitedAt: number;
}

let { user }: { user: { id: string; name: string; email: string } } = $props();

let members = $state<Member[]>([]);
let loading = $state(true);
let dialog = $state<'' | 'invite' | 'role' | 'remove'>('');
let target = $state<Member>();
let email = $state('');
let role = $state<'owner' | 'editor'>('editor');
let open = $state('');
let busy = $state(false);
/** Above the table and about the row under it, so the two are read together. */
let notice = $state('');
let failure = $state('');
/** The dialog's own refusal, which belongs beside the button that was pressed. */
let error = $state('');
/** Whatever the open dialog wants focus on: its first field, or Cancel where the answer is no. */
let opening = $state<HTMLElement>();
let trigger: HTMLElement | undefined;

$effect(() => {
  load();
});
$effect(() => {
  opening?.focus();
});

const owners = $derived(members.filter((m) => m.role === 'owner').length);
/** The rule the greyed-out item draws. The route applies it; this only says why. */
const lastOwner = (member: Member) => member.role === 'owner' && owners < 2;
const initials = (member: Member) =>
  (member.name || member.email)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

const METHODS = {
  github: 'GitHub',
  password: 'Password + email link',
  link: 'Email link only',
};

/** Coarse on purpose: the question this column answers is "recently, or ages ago?". */
function when(member: Member): string {
  if (member.pending) return 'Never';
  // Signing out deletes the session row, so there is nothing left to read a date off.
  if (member.lastSignIn === null) return 'Not known';
  const minutes = Math.floor((Date.now() - member.lastSignIn) / 60000);
  if (minutes < 60) return 'Just now';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 28) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

async function load() {
  const res = await fetch('/admin/api/members');
  if (res.ok) members = ((await res.json()) as { members: Member[] }).members;
  else failure = `Could not load the members (${res.status}).`;
  loading = false;
}

function start(kind: 'invite' | 'role' | 'remove', member?: Member) {
  // The row's own button, not the menu item that was pressed: the item is thrown away with the
  // menu, and focus cannot go back to a node that is no longer in the document.
  const here = document.activeElement as HTMLElement | null;
  trigger = here?.closest('.row-menu')?.querySelector('button') ?? here ?? undefined;
  dialog = kind;
  target = member;
  email = '';
  role = member?.role ?? 'editor';
  error = '';
  open = '';
}

function close() {
  dialog = '';
  error = '';
  trigger?.focus();
}

/** What a refusal from any of the four routes says, in the server's words where it has them. */
async function send(path: string, init: RequestInit): Promise<Record<string, unknown> | undefined> {
  busy = true;
  const res = await fetch(path, init);
  busy = false;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body;
  error = typeof body.error === 'string' ? body.error : `Something went wrong (${res.status}).`;
  return undefined;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function invite(event: SubmitEvent) {
  event.preventDefault();
  error = '';
  busy = true;
  const res = await fetch('/admin/api/members', json({ email, role }));
  const body = (await res.json().catch(() => ({}))) as { error?: string; to?: string };
  busy = false;
  // The row exists either way, so the list is reloaded whether the message went or not — the
  // failure notice tells the owner to fix the mailer and resend, and the row is what they
  // resend from.
  // A mailer that is not wired is the same thing to the person at the keyboard as one that
  // refused, and `missingMailer()` names env vars and a wrangler command at them. The words
  // that name the missing credential are the developer's, and they are on Settings.
  if (res.status === 502 || res.status === 503) {
    close();
    notice = '';
    failure = mailerFailure;
    await load();
    return;
  }
  if (!res.ok) {
    error = body.error ?? `The invite was not sent (${res.status}).`;
    return;
  }
  close();
  failure = '';
  notice = `Invite sent to ${body.to}.`;
  await load();
}

// Settings is where the mailer says which credential is missing, so the notice sends them
// there rather than describing the problem twice. The link is markup: the notice is one
// interpolated string everywhere else, and an anchor inside it would be escaped.
const mailerFailure = "Couldn't send the invite — email isn't set up correctly on this site.";

async function resend(member: Member) {
  open = '';
  notice = '';
  failure = '';
  busy = true;
  const res = await fetch(`/admin/api/members/${member.id}/invite`, json({}));
  busy = false;
  if (res.status === 502 || res.status === 503) failure = mailerFailure;
  else if (res.ok) notice = `Invite sent to ${member.email}.`;
  else failure = `That invite was not sent (${res.status}).`;
}

async function changeRole(event: SubmitEvent) {
  event.preventDefault();
  error = '';
  if (!(await send(`/admin/api/members/${target?.id}/role`, json({ role })))) return;
  close();
  await load();
}

async function remove() {
  error = '';
  if (!(await send(`/admin/api/members/${target?.id}`, { method: 'DELETE' }))) return;
  const gone = target;
  close();
  notice = gone?.pending
    ? `The invite to ${gone.email} is revoked.`
    : `${gone?.name || gone?.email} no longer has access.`;
  await load();
}
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && (dialog ? close() : (open = ''))}
  onclickcapture={(e) =>
    open && !(e.target as HTMLElement).closest('.row-menu') && (open = '')}
/>

<main class="main">
  <div class="list-toolbar">
    <h1>Members <span class="count">{members.length}</span></h1>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="button" onclick={() => start('invite')}>Invite</button>
  </div>
  {#if notice}<p class="notice notice-success" role="status">{notice}</p>{/if}
  {#if failure}
    <p class="notice notice-danger" role="alert">
      {failure}
      {#if failure === mailerFailure}
        <a href="/admin/settings">Settings</a> says which credential is missing. Fix it and resend.
      {/if}
    </p>
  {/if}
  {#if loading}
    <p class="placeholder">Loading…</p>
  {:else}
    <div class="table" role="table" aria-label="Members">
      <!-- The header cells need a row of their own: `role="table"` with `columnheader`
           children and nothing between them is what axe calls aria-required-parent. Both
           wrappers are `display: contents`, so the grid is unchanged. -->
      <div class="row-head" role="row">
        <div class="th" role="columnheader">Name</div>
        <div class="th" role="columnheader">Role</div>
        <div class="th" role="columnheader" aria-sort="descending">Last sign-in</div>
        <div class="th" role="columnheader">Sign-in method</div>
        <div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>
      </div>
      {#each members as member (member.id)}
        <div class="row" role="row">
          <div class="td title" role="cell">
            <span class="avatar avatar-sm" class:is-pending={member.pending} aria-hidden="true"
              >{initials(member)}</span
            >
            <span class="who">
              <span class="name">
                {member.name || member.email}
                {#if member.id === user.id}<span class="sub">you</span>{/if}
                {#if member.pending}<span class="badge badge-warn">Invite pending</span>{/if}
              </span>
              {#if member.name}<span class="sub">{member.email}</span>{/if}
            </span>
          </div>
          <div class="td" role="cell" data-label="Role">
            <span class="badge" class:badge-accent={member.role === 'owner'}>
              {member.role === 'owner' ? 'Owner' : 'Editor'}
            </span>
          </div>
          <div class="td num" role="cell" data-label="Last sign-in">{when(member)}</div>
          <div class="td num" role="cell" data-label="Sign-in method">
            {member.method ? METHODS[member.method] : '—'}
          </div>
          <div class="td menu-cell" role="cell">
            <!-- A disclosure, not a menu: `role="menu"` promises arrow keys, typeahead and a
                 roving tabindex, and three buttons in DOM order need none of it. Escape and a
                 click outside close it; Tab walks the items as it would anywhere. -->
            <div class="row-menu">
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                aria-expanded={open === member.id}
                aria-label="Actions for {member.name || member.email}"
                onclick={() => (open = open === member.id ? '' : member.id)}>⋯</button
              >
              {#if open === member.id}
                <div class="menu">
                  {#if lastOwner(member)}
                    <p class="menu-note">There must be at least one owner.</p>
                  {:else if member.id === user.id}
                    <p class="menu-note">You cannot remove yourself.</p>
                  {/if}
                  <button
                    type="button"
                    class:is-disabled={lastOwner(member)}
                    aria-disabled={lastOwner(member) || undefined}
                    onclick={() => !lastOwner(member) && start('role', member)}>Change role</button
                  >
                  {#if member.pending}
                    <button type="button" disabled={busy} onclick={() => resend(member)}>
                      Resend invite
                    </button>
                  {/if}
                  <hr />
                  <button
                    type="button"
                    class:is-disabled={lastOwner(member) || member.id === user.id}
                    aria-disabled={lastOwner(member) || member.id === user.id || undefined}
                    onclick={() =>
                      !lastOwner(member) && member.id !== user.id && start('remove', member)}
                  >
                    {member.pending ? 'Revoke invite' : 'Remove'}
                  </button>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</main>

<!-- Not aria-modal: the shell behind stays reachable, as it does on the entry list, and
     claiming a focus trap that is not there is worse than not claiming one. Native <dialog>
     would give all three screens the trap, Escape and the top layer for free; that is a change
     to the shared stylesheet and to two screens that already shipped. -->
{#if dialog === 'invite'}
  <div class="scrim">
    <div class="dialog" role="dialog" aria-labelledby="invite-h">
      <h2 id="invite-h">Invite someone</h2>
      <form onsubmit={invite}>
        <div class="field">
          <label for="invite-email">Email</label>
          <input
            class="input"
            id="invite-email"
            name="email"
            type="email"
            autocomplete="email"
            required
            aria-describedby="invite-email-hint"
            bind:value={email}
            bind:this={opening}
          />
          <p class="hint" id="invite-email-hint">
            They get a sign-in link. This is the only way an account comes to exist.
          </p>
        </div>
        <fieldset>
          <legend>Role</legend>
          <label class="choice">
            <input type="radio" name="invite-role" value="editor" bind:group={role} />
            Editor <span class="desc">Edit, upload and publish</span>
          </label>
          <label class="choice">
            <input type="radio" name="invite-role" value="owner" bind:group={role} />
            Owner <span class="desc">Also members and settings</span>
          </label>
        </fieldset>
        {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={close}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </form>
    </div>
  </div>
{:else if dialog === 'role'}
  <div class="scrim">
    <div class="dialog is-slim" role="dialog" aria-labelledby="role-h">
      <h2 id="role-h">Change role for {target?.name || target?.email}</h2>
      <form onsubmit={changeRole}>
        <fieldset>
          <legend class="visually-hidden">Role</legend>
          <label class="choice">
            <input
              type="radio"
              name="member-role"
              value="editor"
              bind:group={role}
              bind:this={opening}
            />
            Editor <span class="desc">Edit, upload and publish</span>
          </label>
          <label class="choice">
            <input type="radio" name="member-role" value="owner" bind:group={role} />
            Owner <span class="desc">Also members and settings</span>
          </label>
        </fieldset>
        {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" onclick={close}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>Save</button>
        </div>
      </form>
    </div>
  </div>
{:else if dialog === 'remove'}
  <div class="scrim">
    <div class="dialog" role="alertdialog" aria-labelledby="remove-h" aria-describedby="remove-d">
      <h2 id="remove-h">
        {#if target?.pending}
          Revoke the invite to {target.email}?
        {:else}
          Remove {target?.name || target?.email}?
        {/if}
      </h2>
      <div id="remove-d">
        {#if target?.pending}
          <p>
            The link that was mailed to them stops working and the row goes. You can invite the
            same address again whenever you like.
          </p>
        {:else}
          {#if target?.editing.length}
            <p>
              They are editing {#each target.editing as name, i}{#if i > 0}{i === target.editing.length - 1 ? ' and ' : ', '}{/if}<strong>{name}</strong>{/each}
              right now. Removing them signs them out and releases
              {target.editing.length === 1 ? 'it' : 'them'} straight away.
            </p>
          {/if}
          <p>
            They are signed out everywhere straight away, and their password and any linked
            GitHub account go with the row.
          </p>
          <p>Their unpublished changes stay. Drafts belong to the site, not to a person.</p>
        {/if}
      </div>
      {#if error}<p class="notice notice-danger" role="alert">{error}</p>{/if}
      <div class="actions">
        <button class="btn" type="button" bind:this={opening} onclick={close}>Cancel</button>
        <button class="btn btn-danger" type="button" disabled={busy} onclick={remove}>
          {target?.pending ? 'Revoke' : 'Remove'}
        </button>
      </div>
    </div>
  </div>
{/if}
