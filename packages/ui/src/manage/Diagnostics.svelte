<script lang="ts">
import { onMount } from 'svelte';
import {
  capitalise,
  formatCalendarDate,
  formatLanguageName,
  formatRelativeTime,
  languageTag,
  messageOptions,
  type UiLocale,
} from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { request as fetch, sitePath } from '../request.js';
import Modal from '../shared/Modal.svelte';

let {
  uiLocale = 'en',
  oncommitted,
}: { uiLocale?: UiLocale; oncommitted?: () => void | Promise<void> } = $props();
const options = $derived(messageOptions(uiLocale));

interface Config {
  collections: { name: string; route?: string }[];
  locales: string[];
  defaultLocale: string;
  mediaBase?: string;
  mailer: { provider: string; from?: string } | null;
  preview: boolean;
  /** Whether "Simulate conflict" is offered: it commits, so it is a developer's button. */
  dev: boolean;
}

/** The key itself is never here: a value that can be read back leaves in a screenshot. */
interface Key {
  key: string;
  source: 'settings' | 'env' | 'code' | 'off';
  fallback: 'env' | 'code' | 'off';
  hint: string | null;
  updatedAt: number | null;
  by: string | null;
}

type State = 'running' | 'ok' | 'off' | 'failed';
interface Result {
  state: State;
  message?: DiagnosticMessage;
  at?: number;
}

interface DiagnosticMessage {
  code: string;
  status?: number;
  detail?: string;
  to?: string;
  locale?: string;
  repository?: string;
  revision?: string;
  bucket?: string;
  duration?: number;
  worker?: string;
  version?: number;
  entry?: string;
  name?: string;
}

/** `sends` marks the one check with a side effect: it never runs on open. */
const CHECKS = [
  { key: 'github' },
  { key: 'storage' },
  { key: 'email', sends: true },
  { key: 'translation' },
  { key: 'build' },
  { key: 'database' },
];

let results = $state<Record<string, Result>>({});
let expanded = $state<Record<string, boolean>>({});
let conflict = $state<DiagnosticMessage>();
let simulating = $state(false);
let keys = $state<Key[]>([]);
let keysError = $state<DiagnosticMessage>();
/** The key currently being entered, never retained before Save. */
let typing = $state<Key>();
let typed = $state('');
let saving = $state(false);
let keyError = $state<DiagnosticMessage>();
let keySaid = $state<DiagnosticMessage>();
let trigger = $state<HTMLElement | null>(null);
/** Read-only here: recording commits, so it is the Dashboard's button. */
let unrecorded = $state<{ count: number } | { status: number }>();

onMount(() => {
  checkAll();
  void loadKeys();
  void loadSources();
});

async function loadSources() {
  const res = await fetch('/admin/api/sources');
  const body = res.ok ? ((await res.json().catch(() => undefined)) as { entries?: unknown }) : {};
  unrecorded = Array.isArray(body?.entries)
    ? { count: body.entries.length }
    : { status: res.ok ? 0 : res.status };
}

async function load(): Promise<Config> {
  const res = await fetch('/admin/api/diagnostics');
  if (!res.ok) throw { code: 'DIAGNOSTICS_LOAD_FAILED', status: res.status };
  return res.json();
}

const responseMessage = (
  body: Record<string, unknown>,
  fallback: string,
  status?: number,
): DiagnosticMessage => ({
  code: typeof body.code === 'string' ? body.code : fallback,
  ...(status ? { status } : {}),
  ...(typeof body.error === 'string'
    ? { detail: body.error }
    : typeof body.detail === 'string'
      ? { detail: body.detail }
      : {}),
  ...(typeof body.to === 'string' ? { to: body.to } : {}),
  ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
  ...(typeof body.repository === 'string' ? { repository: body.repository } : {}),
  ...(typeof body.revision === 'string' ? { revision: body.revision } : {}),
  ...(typeof body.bucket === 'string' ? { bucket: body.bucket } : {}),
  ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
  ...(typeof body.worker === 'string' ? { worker: body.worker } : {}),
  ...(typeof body.version === 'number' ? { version: body.version } : {}),
  ...(typeof body.entry === 'string' ? { entry: body.entry } : {}),
});

function messageText(message: DiagnosticMessage): string {
  switch (message.code) {
    case 'DIAGNOSTICS_LOAD_FAILED':
      return m.diagnostics_load_failed({ status: message.status ?? 0 }, options);
    case 'DIAGNOSTIC_CHECK_FAILED':
      return message.detail ?? m.diagnostics_check_failed({ status: message.status ?? 0 }, options);
    case 'DIAGNOSTIC_EMAIL_SENT':
      return m.diagnostics_email_sent({ email: message.to ?? '' }, options);
    case 'DIAGNOSTIC_GITHUB_OK':
      return m.diagnostics_github_ok(
        { repository: message.repository ?? '', revision: message.revision ?? '' },
        options,
      );
    case 'DIAGNOSTIC_STORAGE_OK':
      return m.diagnostics_storage_ok(
        { bucket: message.bucket ?? '', duration: message.duration ?? 0 },
        options,
      );
    case 'DIAGNOSTIC_TRANSLATION_OK':
    case 'INTEGRATION_KEY_TESTED':
      return m.diagnostics_translation_ok(
        { locale: message.locale ? formatLanguageName(message.locale, uiLocale) : '' },
        options,
      );
    case 'DIAGNOSTIC_TRANSLATION_OFF':
      return m.diagnostics_translation_off({}, options);
    case 'DIAGNOSTIC_TRANSLATION_SINGLE_LANGUAGE':
      return m.diagnostics_translation_single_language({}, options);
    case 'DIAGNOSTIC_BUILD_OK':
      return m.diagnostics_build_ok({ worker: message.worker ?? '' }, options);
    case 'DIAGNOSTIC_BUILD_OFF':
      return m.diagnostics_build_off({}, options);
    case 'DIAGNOSTIC_DATABASE_OK':
      return m.diagnostics_database_ok({ version: message.version ?? 0 }, options);
    case 'INTEGRATION_KEYS_LOAD_FAILED':
      return m.diagnostics_keys_load_failed({ status: message.status ?? 0 }, options);
    case 'INTEGRATION_KEY_SAVE_FAILED':
      return (
        message.detail ?? m.diagnostics_key_save_failed({ status: message.status ?? 0 }, options)
      );
    case 'INTEGRATION_KEY_REMOVE_FAILED':
      return m.diagnostics_key_remove_failed({ status: message.status ?? 0 }, options);
    case 'INTEGRATION_KEY_REQUIRED':
      return m.diagnostics_key_required({}, options);
    case 'INTEGRATION_KEY_STORED':
      return m.diagnostics_key_stored({ name: message.name ?? '' }, options);
    case 'INTEGRATION_KEY_REMOVED':
      return m.diagnostics_key_removed({ name: message.name ?? '' }, options);
    case 'DIAGNOSTIC_CONFLICT_CREATED':
      return m.diagnostics_conflict_created({ entry: message.entry ?? '' }, options);
    case 'DIAGNOSTIC_CONFLICT_FAILED':
      return (
        message.detail ?? m.diagnostics_conflict_failed({ status: message.status ?? 0 }, options)
      );
    case 'DIAGNOSTIC_REFUSED':
    case 'DIAGNOSTIC_UNAVAILABLE':
      return message.detail ?? m.diagnostics_check_failed({ status: message.status ?? 0 }, options);
    default:
      return message.detail ?? m.diagnostics_check_failed({ status: message.status ?? 0 }, options);
  }
}

function checkName(key: string): string {
  if (key === 'github') return m.diagnostics_github_name({}, options);
  if (key === 'storage') return m.diagnostics_storage_name({}, options);
  if (key === 'email') return m.diagnostics_email_name({}, options);
  if (key === 'build') return m.diagnostics_build_name({}, options);
  return m.diagnostics_database_name({}, options);
}

function checkWhat(key: string): string {
  if (key === 'github') return m.diagnostics_github_what({}, options);
  if (key === 'storage') return m.diagnostics_storage_what({}, options);
  if (key === 'email') return m.diagnostics_email_what({}, options);
  if (key === 'build') return m.diagnostics_build_what({}, options);
  return m.diagnostics_database_what({}, options);
}

/** Brand names, so they stay as they are in every interface language. */
function provider(key: string, config: Config): string | undefined {
  if (key === 'github') return 'GitHub';
  if (key === 'storage') return 'Cloudflare R2';
  if (key === 'email') return config.mailer ? mailerName(config.mailer.provider) : undefined;
  if (key === 'build') return 'Cloudflare Workers Builds';
  return 'Cloudflare D1';
}

function checkStops(key: string): string {
  if (key === 'github') return m.diagnostics_github_stops({}, options);
  if (key === 'storage') return m.diagnostics_storage_stops({}, options);
  if (key === 'email') return m.diagnostics_email_stops({}, options);
  if (key === 'translation') return m.diagnostics_translation_stops({}, options);
  if (key === 'build') return m.diagnostics_build_stops({}, options);
  return m.diagnostics_database_stops({}, options);
}

const badgeClass = (state: State) =>
  state === 'running'
    ? 'badge-info'
    : state === 'ok'
      ? 'badge-success'
      : state === 'failed'
        ? 'badge-danger'
        : '';
const badgeLabel = (state: State) =>
  state === 'running'
    ? m.diagnostics_checking({}, options)
    : state === 'ok'
      ? m.diagnostics_working({}, options)
      : state === 'off'
        ? m.diagnostics_not_in_use({}, options)
        : m.diagnostics_not_working({}, options);

async function run(key: string) {
  if (results[key]?.state === 'running') return;
  results[key] = { state: 'running' };
  const res = await fetch(`/admin/api/checks/${key}`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    off?: boolean;
    to?: string;
  };
  const at = Date.now();
  // Opened here rather than bound to the state, so a row somebody opened survives a recheck.
  if (!res.ok || body.to) expanded[key] = true;
  if (!res.ok) {
    results[key] = {
      state: 'failed',
      message: responseMessage(body, 'DIAGNOSTIC_CHECK_FAILED', res.status),
      at,
    };
    return;
  }
  results[key] = {
    state: body.off ? 'off' : 'ok',
    message: responseMessage(body, body.to ? 'DIAGNOSTIC_EMAIL_SENT' : 'DIAGNOSTIC_DETAIL'),
    at,
  };
}

async function loadKeys() {
  const res = await fetch('/admin/api/settings');
  if (!res.ok) {
    keysError = responseMessage({}, 'INTEGRATION_KEYS_LOAD_FAILED', res.status);
    return;
  }
  keys = ((await res.json()) as { integrations: Key[] }).integrations;
  keysError = undefined;
}

function open(row: Key) {
  // Remember the card's button so closing puts focus back where it came from.
  trigger = document.activeElement as HTMLElement | null;
  typing = row;
  typed = '';
  keyError = undefined;
  keySaid = undefined;
}

function close() {
  typing = undefined;
  typed = '';
  keyError = undefined;
}

async function saveKey(event: SubmitEvent) {
  event.preventDefault();
  const row = typing;
  if (!row) return;
  saving = true;
  keyError = undefined;
  const res = await fetch(`/admin/api/settings/${row.key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: typed }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  saving = false;
  // The dialog stays open on a refusal: what refused is nearly always a typo in the value.
  if (!res.ok) {
    keyError = responseMessage(body, 'INTEGRATION_KEY_SAVE_FAILED', res.status);
    return;
  }
  const success = responseMessage(body, 'INTEGRATION_KEY_STORED');
  close();
  keySaid = { ...success, name: keyName(row.key) };
  await loadKeys();
}

// Asked first: a key cannot be typed back from memory.
let removing = $state<Key>();

async function removeKey(row: Key) {
  removing = undefined;
  const res = await fetch(`/admin/api/settings/${row.key}`, { method: 'DELETE' });
  const failed = res.ok
    ? undefined
    : responseMessage({}, 'INTEGRATION_KEY_REMOVE_FAILED', res.status);
  keySaid = res.ok ? { code: 'INTEGRATION_KEY_REMOVED', name: keyName(row.key) } : undefined;
  await loadKeys();
  if (failed) keysError = failed;
}

async function simulate() {
  simulating = true;
  conflict = undefined;
  const res = await fetch('/admin/api/checks/conflict', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    entry?: string;
  };
  simulating = false;
  conflict = res.ok
    ? { code: 'DIAGNOSTIC_CONFLICT_CREATED', entry: body.entry }
    : responseMessage(body, 'DIAGNOSTIC_CONFLICT_FAILED', res.status);
  if (res.ok) await oncommitted?.();
}

// Translation is checked like the rest but drawn on the DeepL row, where its key is managed.
const SERVICES = CHECKS.filter((check) => check.key !== 'translation');

function checkAll() {
  for (const check of CHECKS) if (!check.sends) void run(check.key);
}

const busy = $derived(CHECKS.some((check) => results[check.key]?.state === 'running'));
const lastChecked = $derived(Math.max(0, ...CHECKS.map((check) => results[check.key]?.at ?? 0)));

const failing = $derived(CHECKS.filter((check) => results[check.key]?.state === 'failed'));
const consequence = $derived.by(() => {
  const list = new Intl.ListFormat(languageTag(uiLocale), {
    style: 'long',
    type: 'conjunction',
  }).format(failing.map((check) => checkStops(check.key)));
  const sentenceList = list.charAt(0).toLocaleUpperCase(uiLocale) + list.slice(1);
  return failing.length === 1
    ? m.diagnostics_consequence_one({ things: sentenceList }, options)
    : m.diagnostics_consequence_many({ things: sentenceList }, options);
});

/** Coarse on purpose: what a result line answers is "just now, or a while ago?". */
function when(at: number): string {
  return m.diagnostics_checked_when({ when: formatRelativeTime(at, uiLocale) }, options);
}

const keyName = (key: string) =>
  key === 'deepl' ? 'DeepL' : key === 'assist' ? m.diagnostics_assist_name({}, options) : key;
const keyBadgeClass = (source: Key['source']) =>
  source === 'settings' ? 'badge-success' : source === 'off' ? '' : 'badge-info';
const keyBadgeLabel = (source: Key['source']) => {
  if (source === 'settings') return m.diagnostics_set_here({}, options);
  if (source === 'env') return m.diagnostics_from_site_settings({}, options);
  if (source === 'code') return m.diagnostics_site_code({}, options);
  return m.diagnostics_not_set({}, options);
};

/** A removal names what takes over, because the alternative is finding out after the press. */
function says(row: Key): string {
  if (row.source === 'code') return m.diagnostics_key_site_code({}, options);
  if (row.source === 'settings') {
    const who = row.updatedAt
      ? row.by
        ? m.diagnostics_key_set_by(
            { person: row.by, date: formatCalendarDate(row.updatedAt, uiLocale) },
            options,
          )
        : m.diagnostics_key_set_on({ date: formatCalendarDate(row.updatedAt, uiLocale) }, options)
      : '';
    const next =
      row.fallback === 'env'
        ? m.diagnostics_key_remove_fallback({}, options)
        : row.key === 'deepl'
          ? m.diagnostics_key_remove_hides_translation({}, options)
          : m.diagnostics_key_remove_plain({}, options);
    return m.diagnostics_key_stored_description(
      { hint: row.hint ?? '', attribution: who, consequence: next },
      options,
    );
  }
  if (row.source === 'env') return m.diagnostics_key_environment({}, options);
  return row.key === 'deepl'
    ? m.diagnostics_key_deepl_off({}, options)
    : m.diagnostics_key_assist_off({}, options);
}

const mailerName = (provider: string) => {
  if (provider === 'resend') return 'Resend';
  if (provider === 'smtp') return 'SMTP';
  if (provider === 'cloudflare') return 'Cloudflare Email Sending';
  if (provider === 'custom') return m.diagnostics_custom_mailer({}, options);
  return provider;
};
</script>

<main class="main diagnostics-page">
  <header class="page-head">
    <h1>{m.diagnostics_title({}, options)}</h1>
    <p class="list-note">{m.diagnostics_intro({}, options)}</p>
  </header>
  {#await load()}
    <p class="placeholder">{m.common_loading({}, options)}</p>
  {:then config}
    <div class="settings is-wide">
      <div class={['health', { 'is-failing': failing.length > 0, 'is-busy': busy && !failing.length }]}>
        <!-- The count says what stops working, because that is the half the owner can judge. -->
        {#if failing.length}
          <p class="page-alert" role="status">
            <strong>
              {m.diagnostics_failures({ count: failing.length }, options)}
            </strong>
            {consequence}
          </p>
        {:else if busy}
          <p class="health-line" role="status"><span class="health-dot" aria-hidden="true"></span>{m.diagnostics_checking({}, options)}</p>
        {:else}
          <p class="health-line" role="status">
            <span class="health-dot" aria-hidden="true"></span>
            <strong>{m.diagnostics_all_working({}, options)}</strong>
            {#if lastChecked}<span class="sub">{when(lastChecked)}</span>{/if}
          </p>
        {/if}
        <!-- aria-disabled, not disabled: a disabled button takes no focus. -->
        <button class="btn btn-sm" type="button" aria-disabled={busy ? 'true' : undefined} onclick={checkAll}>
          {m.diagnostics_check_again({}, options)}
        </button>
      </div>

      <section class="settings-section" aria-labelledby="integ">
        <header>
          <h2 id="integ">{m.diagnostics_keys_title({}, options)}</h2>
          <p>{m.diagnostics_keys_hint({}, options)}</p>
        </header>
        {#if keysError}<p class="notice notice-danger" role="alert">{messageText(keysError)}</p>{/if}
        {#if keySaid}<p class="notice notice-info" role="status">{messageText(keySaid)}</p>{/if}
        <ul class="check-list">
          {#each keys as row (row.key)}
            {@const translation = row.key === 'deepl' ? results.translation : undefined}
            <li class="check-card key-row">
              <div class="head">
                <span class="name">{keyName(row.key)}</span>
                <span class="badge {keyBadgeClass(row.source)}">{keyBadgeLabel(row.source)}</span>
              </div>
              <p class="what">{says(row)}</p>
              {#if translation?.state === 'failed'}
                <p class="result is-failed" role="status">{translation.message ? messageText(translation.message) : ''}</p>
              {:else if translation?.state === 'ok' && translation.message}
                <p class="result is-ok" role="status">{messageText(translation.message)}</p>
              {:else if translation?.message?.code === 'DIAGNOSTIC_TRANSLATION_SINGLE_LANGUAGE'}
                <p class="result" role="status">{messageText(translation.message)}</p>
              {/if}
              <div class="actions">
                <!-- No button where the site's code is in charge: it could change nothing. -->
                {#if row.source === 'settings'}
                  <button class="btn btn-sm" type="button" onclick={() => open(row)}>
                    {m.diagnostics_replace({}, options)}<span class="visually-hidden"> {m.diagnostics_key_for({ name: keyName(row.key) }, options)}</span>
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" onclick={() => (removing = row)}>
                    {m.diagnostics_remove({}, options)}<span class="visually-hidden"> {m.diagnostics_key_for({ name: keyName(row.key) }, options)}</span>
                  </button>
                {:else if row.source !== 'code'}
                  <button class="btn btn-sm" type="button" onclick={() => open(row)}>
                    {row.source === 'env' ? m.diagnostics_set_key_here({}, options) : m.diagnostics_add_key({}, options)}<span
                      class="visually-hidden"
                    >
                      {m.diagnostics_for_name({ name: keyName(row.key) }, options)}</span
                    >
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>

      <section class="settings-section" aria-labelledby="conn">
        <header>
          <h2 id="conn">{m.diagnostics_services({}, options)}</h2>
          <p>{m.diagnostics_services_hint({}, options)}</p>
        </header>
        <ul class="check-list">
          {#each SERVICES as check (check.key)}
            {@const result = results[check.key]}
            {@const state = result?.state ?? 'unchecked'}
            {@const name = provider(check.key, config)}
            <li class={['check-card', `service-row is-${state}`, { 'has-action': check.sends }]}>
              <details bind:open={expanded[check.key]}>
                <summary>
                  <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
                  <span class="name">{checkName(check.key)}</span>
                  <span class="what">{checkWhat(check.key)}</span>
                  <span class="state">
                    {#if result}
                      <span class="badge {badgeClass(result.state)}">{badgeLabel(result.state)}</span>
                    {:else}
                      <span class="sub">{m.diagnostics_not_checked({}, options)}</span>
                    {/if}
                  </span>
                </summary>
                <dl class="service-facts">
                  {#if name}
                    <div><dt>{m.diagnostics_provider({}, options)}</dt><dd>{name}</dd></div>
                  {/if}
                  {#if check.key === 'storage'}
                    <div>
                      <dt>{m.diagnostics_served_from({}, options)}</dt>
                      <dd>
                        {#if config.mediaBase}
                          <code>{config.mediaBase}</code>
                        {:else}
                          {m.diagnostics_off({}, options)} — {m.diagnostics_media_off_before({}, options)} <code>media.publicBase</code>{m.diagnostics_media_off_after({}, options)}
                        {/if}
                      </dd>
                    </div>
                  {/if}
                  {#if check.key === 'email'}
                    <div>
                      <dt>{m.diagnostics_sender({}, options)}</dt>
                      <dd>
                        {#if config.mailer?.from}
                          {config.mailer.from}
                        {:else if !config.mailer}
                          {m.diagnostics_off({}, options)} — {m.diagnostics_email_off_before({}, options)} <code>mailer</code>{m.diagnostics_email_off_after({}, options)}
                        {:else}
                          {m.diagnostics_custom_mailer({}, options)}
                        {/if}
                      </dd>
                    </div>
                  {/if}
                  {#if result}
                    <div>
                      <dt>{m.diagnostics_last_check({}, options)}</dt>
                      <dd>
                        <span class={['result', { 'is-failed': result.state === 'failed' }]} role="status">
                          {#if result.state === 'running'}
                            {m.diagnostics_checking({}, options)}
                          {:else if result.message}
                            {messageText(result.message)}
                          {/if}
                        </span>
                        {#if result.at}<span class="sub">{when(result.at)}</span>{/if}
                      </dd>
                    </div>
                  {/if}
                </dl>
              </details>
              {#if check.sends}
                <button
                  class="btn btn-sm service-action"
                  type="button"
                  aria-disabled={result?.state === 'running' ? 'true' : undefined}
                  onclick={() => run(check.key)}
                >
                  {m.diagnostics_send_test_email({}, options)}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <details class="about">
        <summary>
          <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
          <span class="about-title">{m.diagnostics_about({}, options)}</span>
          <span class="sub">{m.diagnostics_configuration_before({}, options)} <code>cms.config.ts</code>{m.diagnostics_configuration_after({}, options)}</span>
        </summary>
        <dl class="facts">
          <div>
            <dt>{m.diagnostics_collections({}, options)}</dt>
            <dd>
              {#each config.collections as collection, i (collection.name)}
                {#if i}<span class="sep" aria-hidden="true">·</span>{/if}
                <span>
                  {capitalise(collection.name)}
                  {#if collection.route}<code class="sub">{collection.route}</code>{/if}
                </span>
              {/each}
            </dd>
          </div>
          <div>
            <dt>{m.diagnostics_languages({}, options)}</dt>
            <dd>
              {#each config.locales as locale, i (locale)}
                {#if i}<span class="sep" aria-hidden="true">·</span>{/if}
                <span>
                  {formatLanguageName(locale, uiLocale)}
                  {#if locale === config.defaultLocale}<span class="badge">{m.diagnostics_default({}, options)}</span>{/if}
                </span>
              {/each}
            </dd>
          </div>
          {#if (config.locales ?? []).length > 1 && unrecorded}
            <div>
              <dt>{m.diagnostics_sources({}, options)}</dt>
              <dd>
                {#if 'status' in unrecorded}
                  {m.diagnostics_sources_failed({ status: unrecorded.status }, options)}
                {:else if unrecorded.count}
                  {m.diagnostics_sources_unrecorded({ count: unrecorded.count }, options)}
                  <a href={sitePath('/admin')}>{m.diagnostics_sources_link({}, options)}</a>
                {:else}
                  {m.diagnostics_sources_all({}, options)}
                {/if}
              </dd>
            </div>
          {/if}
          <div>
            <dt>{m.diagnostics_preview({}, options)}</dt>
            <dd>
              {#if config.preview}
                {m.diagnostics_on({}, options)}
              {:else}
                <!-- Named rather than offered: nothing in the admin can turn this on. -->
                {m.diagnostics_off({}, options)} <span class="sub">{m.diagnostics_preview_off_before({}, options)} <code>PREVIEW_ENABLED</code>{m.diagnostics_preview_off_after({}, options)}</span>
              {/if}
            </dd>
          </div>
        </dl>
        {#if config.dev}
          <section class="dev-tools" aria-labelledby="dev">
            <h2 id="dev">{m.diagnostics_developer_tools({}, options)}</h2>
            <p>{m.diagnostics_developer_tools_hint({}, options)}</p>
            <div class="actions">
              <button class="btn btn-sm" type="button" disabled={simulating} onclick={simulate}>
                {simulating ? m.diagnostics_making_conflict({}, options) : m.diagnostics_simulate_conflict({}, options)}
              </button>
            </div>
            {#if conflict}<p class="notice notice-info" role="status">{messageText(conflict)}</p>{/if}
          </section>
        {/if}
      </details>
    </div>
    <!-- Inside the loaded block: whether the key is tried first is the site's language count. -->
    {#if removing}
      {@const name = keyName(removing.key)}
      {@const row = removing}
      <Modal labelledby="remove-h" onclose={() => (removing = undefined)}>
          <h2 id="remove-h">{m.diagnostics_remove_key_question({ name }, options)}</h2>
          <p>{says(row)}</p>
          <div class="actions">
            <button class="btn" type="button" onclick={() => (removing = undefined)}>{m.common_cancel({}, options)}</button>
            <button class="btn btn-danger" type="button" onclick={() => removeKey(row)}>{m.diagnostics_remove({}, options)}</button>
          </div>
      </Modal>
    {/if}
    {#if typing}
      {@const name = keyName(typing.key)}
      {@const tried = typing.key === 'deepl' && config.locales.length > 1}
      <Modal
        labelledby="key-h"
        initialFocus="#key-value"
        returnTo={trigger}
        dismissible={!saving}
        onclose={close}
      >
          <h2 id="key-h">{typing.hint ? m.diagnostics_replace_key_title({ name }, options) : m.diagnostics_add_key_title({ name }, options)}</h2>
          <form onsubmit={saveKey}>
            <p>
              {m.diagnostics_key_secret({}, options)}
              {#if typing.hint}
                {m.diagnostics_key_replaced({ hint: typing.hint }, options)}
              {/if}
            </p>
            <div class="field">
              <div class="label-row">
                <label for="key-value">{typing.hint ? m.diagnostics_new_key_label({ name }, options) : m.diagnostics_key_label({ name }, options)}</label>
              </div>
              <input
                class="input"
                id="key-value"
                type="password"
                autocomplete="off"
                bind:value={typed}
                aria-describedby={tried ? 'key-tried' : undefined}
              />
              {#if tried}
                <p class="hint" id="key-tried">{m.diagnostics_deepl_test_hint({}, options)}</p>
              {/if}
            </div>
            {#if keyError}<div class="notice notice-danger" role="alert">{messageText(keyError)}</div>{/if}
            <div class="actions">
              <button class="btn" type="button" disabled={saving} onclick={close}>{m.common_cancel({}, options)}</button>
              <button class="btn btn-primary" type="submit" disabled={saving}>
                {saving ? m.diagnostics_saving({}, options) : tried ? m.diagnostics_save_test({}, options) : m.diagnostics_save({}, options)}
              </button>
            </div>
          </form>
      </Modal>
    {/if}
  {:catch error}
    <p class="notice notice-danger" role="alert">{messageText(error as DiagnosticMessage)}</p>
  {/await}
</main>
