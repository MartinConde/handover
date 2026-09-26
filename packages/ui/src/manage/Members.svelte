<script lang="ts">
import type { Member as CoreMember } from '@handover/core';
import { messageDetail, messageText, responseMessage, type UiMessage } from '../errors.js';
import { formatRelativeTime, messageOptions, type UiLocale } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath, uncertainResponse } from '../request.js';
import Modal from '../shared/Modal.svelte';

export type Member = CoreMember & {
  /** The entries they are holding a lock on right now, by the name the list shows. */
  editing: string[];
};

let {
  user,
  uiLocale = 'en',
}: {
  user: { id: string; name: string; email: string };
  uiLocale?: UiLocale;
} = $props();
const options = $derived(messageOptions(uiLocale));

type MembersMessage = UiMessage & { email?: string; name?: string };
const text = (message: MembersMessage) => {
  switch (message.code) {
    case 'MEMBER_INVITE_SENT':
      return m.members_invite_sent({ email: message.email ?? '' }, options);
    case 'MEMBER_INVITE_UNCONFIRMED':
      return m.members_invite_unconfirmed({}, options);
    case 'MEMBER_MAILER_FAILED':
      return m.members_mailer_failed({}, options);
    case 'MEMBER_INVITE_REVOKED':
      return m.members_invite_revoked({ email: message.email ?? '' }, options);
    case 'MEMBER_ACCESS_REMOVED':
      return m.members_access_removed({ name: message.name ?? '' }, options);
    case 'MEMBER_RESEND_FAILED':
      return m.members_resend_failed_status({ status: message.status ?? 0 }, options);
    default:
      return messageText(message, uiLocale);
  }
};

let members = $state<Member[]>([]);
let loading = $state(true);
let dialog = $state<'' | 'invite' | 'role' | 'remove'>('');
let target = $state<Member>();
let email = $state('');
let role = $state<'owner' | 'editor'>('editor');
let open = $state('');
let busy = $state(false);
/** Above the table and about the row under it, so the two are read together. */
let notice = $state<MembersMessage>();
let failure = $state<MembersMessage>();
/** The dialog's own refusal, which belongs beside the button that was pressed. */
let error = $state<MembersMessage>();
let trigger = $state<HTMLElement>();

$effect(() => {
  load();
});

const initials = (member: Member) =>
  (member.name || member.email)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

const methodName = (method: NonNullable<Member['method']>) => {
  if (method === 'github') return 'GitHub';
  if (method === 'password') return m.members_method_password({}, options);
  return m.members_method_link({}, options);
};

/** Coarse on purpose: the question this column answers is "recently, or ages ago?". */
function when(member: Member): string {
  if (member.pending) return m.members_never({}, options);
  // Signing out deletes the session row, so there is nothing left to read a date off.
  if (member.lastSignIn === null) return m.members_not_known({}, options);
  return formatRelativeTime(member.lastSignIn, uiLocale);
}

async function load() {
  const res = await fetch('/admin/api/members');
  if (res.ok) members = ((await res.json()) as { members: Member[] }).members;
  else failure = { code: 'MEMBER_LIST_FAILED', status: res.status };
  loading = false;
}

function start(kind: 'invite' | 'role' | 'remove', member?: Member) {
  // The row's own button: the menu item is gone with the menu and cannot take focus back.
  const here = document.activeElement as HTMLElement | null;
  trigger = here?.closest('.row-menu')?.querySelector('button') ?? here ?? undefined;
  dialog = kind;
  target = member;
  email = '';
  role = member?.role ?? 'editor';
  error = undefined;
  open = '';
}

function close() {
  dialog = '';
  error = undefined;
}

/** Keep the wire code and safe detail so a visible refusal follows the current UI locale. */
async function send(
  path: string,
  init: RequestInit,
  fallback: 'MEMBER_ROLE_FAILED' | 'MEMBER_REMOVE_FAILED',
): Promise<Record<string, unknown> | undefined> {
  busy = true;
  const res = await fetch(path, init);
  busy = false;
  if (!res.ok) {
    error = await responseMessage(res, fallback);
    return undefined;
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function invite(event: SubmitEvent) {
  event.preventDefault();
  error = undefined;
  busy = true;
  const res = await fetch('/admin/api/members', json({ email, role }));
  busy = false;
  if (uncertainResponse(res)) {
    close();
    notice = undefined;
    failure = { code: 'MEMBER_INVITE_UNCONFIRMED' };
    await load();
    return;
  }
  // The row exists whether the mailer refused (502) or is unwired (503), so the list is reloaded.
  if (res.status === 502 || res.status === 503) {
    close();
    notice = undefined;
    failure = { code: 'MEMBER_MAILER_FAILED' };
    await load();
    return;
  }
  if (!res.ok) {
    error = await responseMessage(res, 'MEMBER_INVITE_FAILED');
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { to?: string };
  close();
  failure = undefined;
  notice = { code: 'MEMBER_INVITE_SENT', email: body.to ?? email };
  await load();
}

async function resend(member: Member) {
  open = '';
  notice = undefined;
  failure = undefined;
  busy = true;
  const res = await fetch(`/admin/api/members/${member.id}/invite`, json({}));
  busy = false;
  if (uncertainResponse(res)) {
    failure = { code: 'MEMBER_INVITE_UNCONFIRMED' };
    await load();
  } else if (res.status === 502 || res.status === 503) failure = { code: 'MEMBER_MAILER_FAILED' };
  else if (res.ok) notice = { code: 'MEMBER_INVITE_SENT', email: member.email };
  else failure = await responseMessage(res, 'MEMBER_RESEND_FAILED');
}

async function changeRole(event: SubmitEvent) {
  event.preventDefault();
  error = undefined;
  if (!(await send(`/admin/api/members/${target?.id}/role`, json({ role }), 'MEMBER_ROLE_FAILED')))
    return;
  close();
  await load();
}

async function remove() {
  error = undefined;
  if (
    !(await send(`/admin/api/members/${target?.id}`, { method: 'DELETE' }, 'MEMBER_REMOVE_FAILED'))
  )
    return;
  const gone = target;
  close();
  notice = gone?.pending
    ? { code: 'MEMBER_INVITE_REVOKED', email: gone.email }
    : { code: 'MEMBER_ACCESS_REMOVED', name: gone?.name || gone?.email || '' };
  await load();
}
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && !dialog && (open = '')}
  onclickcapture={(e) =>
    open && !(e.target as HTMLElement).closest('.row-menu') && (open = '')}
/>

<main class="main">
  <div class="list-toolbar">
    <h1>{m.members_title({}, options)} <span class="count">{members.length}</span></h1>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="button" onclick={() => start('invite')}>{m.members_invite({}, options)}</button>
  </div>
  {#if notice}<p class="notice notice-success" role="status">{text(notice)}</p>{/if}
  {#if failure}
    <p class="notice notice-danger" role="alert">
      {text(failure)}
      {#if failure.code === 'MEMBER_MAILER_FAILED'}
        <a href={sitePath(`/admin/settings`)}>{m.shell_settings({}, options)}</a> {m.members_mailer_fix({}, options)}
      {/if}
    </p>
  {/if}
  {#if loading}
    <p class="placeholder">{m.common_loading({}, options)}</p>
  {:else}
    <div class="table" role="table" aria-label={m.members_title({}, options)}>
      <!-- role="table" needs a row around its columnheaders; display: contents keeps the grid. -->
      <div class="row-head" role="row">
        <div class="th" role="columnheader">{m.members_name({}, options)}</div>
        <div class="th" role="columnheader">{m.members_role({}, options)}</div>
        <div class="th" role="columnheader" aria-sort="descending">{m.members_last_sign_in({}, options)}</div>
        <div class="th" role="columnheader">{m.members_sign_in_method({}, options)}</div>
        <div class="th" role="columnheader"><span class="visually-hidden">{m.members_actions({}, options)}</span></div>
      </div>
      {#each members as member (member.id)}
        <div class="row" role="row">
          <div class="td title" role="cell">
            <span class={['avatar avatar-sm', { 'is-pending': member.pending }]} aria-hidden="true"
              >{initials(member)}</span
            >
            <span class="who">
              <span class="name">
                {member.name || member.email}
                {#if member.id === user.id}<span class="sub">{m.members_you({}, options)}</span>{/if}
                {#if member.pending}<span class="badge badge-warn">{m.members_invite_pending({}, options)}</span>{/if}
              </span>
              {#if member.name}<span class="sub">{member.email}</span>{/if}
            </span>
          </div>
          <div class="td" role="cell" data-label={m.members_role({}, options)}>
            <span class={['badge', { 'badge-accent': member.role === 'owner' }]}>
              {member.role === 'owner' ? m.members_owner({}, options) : m.members_editor({}, options)}
            </span>
          </div>
          <div class="td num" role="cell" data-label={m.members_last_sign_in({}, options)}>{when(member)}</div>
          <div class="td num" role="cell" data-label={m.members_sign_in_method({}, options)}>
            {member.method ? methodName(member.method) : '—'}
          </div>
          <div class="td menu-cell" role="cell">
            <!-- No menu on your own row, since the server refuses self changes. -->
            {#if member.id !== user.id}
              <div class="row-menu">
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  aria-expanded={open === member.id}
                  aria-label={m.members_actions_for({ name: member.name || member.email }, options)}
                  onclick={() => (open = open === member.id ? '' : member.id)}>⋯</button
                >
                {#if open === member.id}
                  <div class="menu">
                    <button type="button" onclick={() => start('role', member)}>{m.members_change_role({}, options)}</button>
                    {#if member.pending}
                      <button type="button" disabled={busy} onclick={() => resend(member)}>
                        {m.members_resend_invite({}, options)}
                      </button>
                    {/if}
                    <hr />
                    <button type="button" onclick={() => start('remove', member)}>
                      {member.pending ? m.members_revoke_invite({}, options) : m.members_remove({}, options)}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</main>

{#if dialog === 'invite'}
  <Modal labelledby="invite-h" initialFocus="#invite-email" returnTo={trigger} dismissible={!busy} onclose={close}>
      <h2 id="invite-h">{m.members_invite_someone({}, options)}</h2>
      <form onsubmit={invite}>
        <div class="field">
          <label for="invite-email">{m.account_email({}, options)}</label>
          <input
            class="input"
            id="invite-email"
            name="email"
            type="email"
            autocomplete="email"
            required
            aria-describedby="invite-email-hint"
            bind:value={email}
          />
          <p class="hint" id="invite-email-hint">
            {m.members_invite_hint({}, options)}
          </p>
        </div>
        <fieldset>
          <legend>{m.members_role({}, options)}</legend>
          <label class="choice">
            <input type="radio" name="invite-role" value="editor" bind:group={role} />
            {m.members_editor({}, options)} <span class="desc">{m.members_editor_description({}, options)}</span>
          </label>
          <label class="choice">
            <input type="radio" name="invite-role" value="owner" bind:group={role} />
            {m.members_owner({}, options)} <span class="desc">{m.members_owner_description({}, options)}</span>
          </label>
        </fieldset>
        {#if error}<p class="notice notice-danger" role="alert">{text(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>
            {busy ? m.members_sending({}, options) : m.members_send_invite({}, options)}
          </button>
        </div>
      </form>
  </Modal>
{:else if dialog === 'role'}
  <Modal labelledby="role-h" panelClass="dialog is-slim" initialFocus="input" returnTo={trigger} dismissible={!busy} onclose={close}>
      <h2 id="role-h">{m.members_change_role_for({ name: target?.name || target?.email || '' }, options)}</h2>
      <form onsubmit={changeRole}>
        <fieldset>
          <legend class="visually-hidden">{m.members_role({}, options)}</legend>
          <label class="choice">
            <input
              type="radio"
              name="member-role"
              value="editor"
              bind:group={role}
            />
            {m.members_editor({}, options)} <span class="desc">{m.members_editor_description({}, options)}</span>
          </label>
          <label class="choice">
            <input type="radio" name="member-role" value="owner" bind:group={role} />
            {m.members_owner({}, options)} <span class="desc">{m.members_owner_description({}, options)}</span>
          </label>
        </fieldset>
        {#if error}<p class="notice notice-danger" role="alert">{text(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</p>{/if}
        <div class="actions">
          <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
          <button class="btn btn-primary" type="submit" disabled={busy}>{m.members_save({}, options)}</button>
        </div>
      </form>
  </Modal>
{:else if dialog === 'remove'}
  <Modal labelledby="remove-h" describedby="remove-d" role="alertdialog" returnTo={trigger} dismissible={!busy} onclose={close}>
      <h2 id="remove-h">
        {#if target?.pending}
          {m.members_revoke_question({ email: target.email }, options)}
        {:else}
          {m.members_remove_question({ name: target?.name || target?.email || '' }, options)}
        {/if}
      </h2>
      <div id="remove-d">
        {#if target?.pending}
          <p>
            {m.members_revoke_explanation({}, options)}
          </p>
        {:else}
          {#if target?.editing.length}
            <p>
              {m.members_editing_before({}, options)}{#each target.editing as name, i}{#if i > 0}{i === target.editing.length - 1 ? m.members_list_and({}, options) : ', '}{/if}<strong>{name}</strong>{/each}{target.editing.length === 1 ? m.members_editing_after_one({}, options) : m.members_editing_after_many({}, options)}
            </p>
          {/if}
          <p>
            {m.members_remove_access_explanation({}, options)}
          </p>
          <p>{m.members_remove_drafts({}, options)}</p>
        {/if}
      </div>
      {#if error}<p class="notice notice-danger" role="alert">{text(error)}{#if error.detail}<span class="technical-detail">{messageDetail(error, uiLocale)}</span>{/if}</p>{/if}
      <div class="actions">
        <button class="btn" type="button" disabled={busy} onclick={close}>{m.common_cancel({}, options)}</button>
        <button class="btn btn-danger" type="button" disabled={busy} onclick={remove}>
          {target?.pending ? m.members_revoke({}, options) : m.members_remove({}, options)}
        </button>
      </div>
  </Modal>
{/if}
