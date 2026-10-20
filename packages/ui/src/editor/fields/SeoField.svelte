<script lang="ts">
import {
  type ResolvedSeo,
  SEO_DESCRIPTION_LIMIT,
  SEO_TITLE_LIMIT,
  SOCIAL_CARD,
  unsafeLinkScheme,
} from '@handover/core';
import Focal from '../../media/Focal.svelte';
import Media from '../../media/Media.svelte';
import type { MediaItem } from '../../media/upload.js';
import * as m from '../../paraglide/messages.js';
import MediaImage from '../../shared/MediaImage.svelte';
import { aspect, centred, type FieldLevel, stored } from './field-level.js';
import PerLanguageInput from './PerLanguageInput.svelte';
import ReferencePeek from './ReferencePeek.svelte';

let {
  level,
  id,
  at,
  says,
  locale,
  inheritedSeo,
  site,
  servedAt,
}: {
  level: FieldLevel;
  id: string;
  at: readonly string[];
  says?: string;
  locale: string;
  inheritedSeo?: ResolvedSeo;
  site?: string;
  servedAt?: string;
} = $props();
const options = $derived(level.options);
const image = $derived([...at, 'image']);
const dot = $derived(level.point(image).map((n) => n * 100));
let framing = $state(false);

// A `site` that is not a URL prints no host rather than throwing.
const host = $derived.by(() => {
  try {
    return site ? new URL(site).host : '';
  } catch {
    return '';
  }
});
const crumbs = $derived(
  [host, ...(servedAt ?? '').split('/').filter(Boolean).map(decodeURIComponent)].join(' › '),
);

// Every key a hole, so a description typed before a title does not land above it in the file.
const SEO_SHAPE = {
  title: undefined,
  description: undefined,
  image: undefined,
  noindex: undefined,
  canonical: undefined,
};
function put(key: string, value: unknown) {
  const held = level.read(at) as Record<string, unknown> | undefined;
  if (!level.translating && (held === undefined || !(key in held)))
    level.write(at, { ...SEO_SHAPE, ...held, [key]: value });
  else level.write([...at, key], value);
}
</script>

{#snippet previews()}
  {@const title = level.str([...at, 'title']) || inheritedSeo?.title || ''}
  {@const said = level.str([...at, 'description']) || inheritedSeo?.description || ''}
  {@const desc = said.length > SEO_DESCRIPTION_LIMIT ? `${said.slice(0, SEO_DESCRIPTION_LIMIT).trimEnd()} …` : said}
  {@const own = level.read(image) !== undefined}
  {@const picture = own ? level.src(image) : inheritedSeo?.image ? `${level.mediaBase}/${inheritedSeo.image.src}` : ''}
  {@const of = locale.toUpperCase()}
  <div class="previews">
    <div class="preview-box">
      <p class="variant-title">{m.field_seo_search_preview({ locale: of }, options)}</p>
      <div class="snippet" role="group" aria-label={m.field_seo_search_preview_label({}, options)}>
        <div class="url"><span class="fav" aria-hidden="true">{host.charAt(0).toUpperCase()}</span><span class="crumbs">{crumbs}</span></div>
        <div class="title">{title}</div>
        <div class="desc">{desc}</div>
      </div>
    </div>
    <div class="preview-box">
      <p class="variant-title">{m.field_seo_social_card({ locale: of }, options)}</p>
      <div class="social-card" role="group" aria-label={m.field_seo_social_card_label({}, options)}>
        <div class="thumb">{#if picture}<MediaImage src={picture} alt="" uiLocale={level.uiLocale} />{/if}</div>
        <div class="body"><div class="domain">{host}</div><div class="title">{title}</div><div class="desc">{desc}</div></div>
      </div>
    </div>
  </div>
{/snippet}

{#snippet words(key: string, label: string, limit: number, placeholder: string, hint: string)}
  {@const value = level.str([...at, key])}
  {@const described = [`${id}.${key}-meter`, hint ? `${id}.${key}-hint` : '']
    .filter(Boolean)
    .join(' ')}
  {@const over = value.trim().length > limit}
  <div class="field">
    <div class="label-row">
      <label for="{id}.{key}">{label}</label><span
        class={['meter', { 'is-over': over }]}
        id="{id}.{key}-meter"
        >{value.trim().length
          ? m.field_seo_meter({ count: value.trim().length, limit }, options)
          : m.field_seo_meter_empty({ limit }, options)}{over
          ? ` — ${m.field_seo_may_cut({}, options)}`
          : ''}</span
      >
    </div>
    {#if key === 'description'}
      <textarea
        class="input textarea"
        id="{id}.{key}"
        {placeholder}
        aria-describedby={described}
        {value}
        oninput={(e) => put(key, e.currentTarget.value || undefined)}></textarea>
    {:else}
      <input
        class="input"
        id="{id}.{key}"
        type="text"
        {placeholder}
        aria-describedby={described}
        {value}
        oninput={(e) => put(key, e.currentTarget.value || undefined)}
      />
    {/if}
    <div class={['gauge', { 'is-long': over }]} aria-hidden="true">
      <span style="width: {Math.min(100, Math.round((value.trim().length / limit) * 100))}%"></span>
    </div>
    {#if level.reference}<ReferencePeek
        reference={level.reference}
        path={level.childAddress(at, key)}
        uiLocale={level.uiLocale}
      />{/if}
    {#if hint}<p class="hint" id="{id}.{key}-hint">{hint}</p>{/if}
  </div>
{/snippet}

{#if level.translating}
  <!-- A translation owns the words a page is found by: title, description, alt. -->
  <div class="form" {id} role="group" aria-labelledby="{id}-l" aria-describedby={says}>
    {@render words('title', m.field_seo_search_title({}, options), SEO_TITLE_LIMIT, inheritedSeo?.title ?? '', m.field_seo_title_fallback({}, options))}
    {@render words('description', m.field_seo_description({}, options), SEO_DESCRIPTION_LIMIT, inheritedSeo?.description ?? '', '')}
    {#if level.read(image) !== undefined}
      <div class="media-card">
        <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"><MediaImage src={level.src(image)} alt="" style="object-position: {dot[0]}% {dot[1]}%" uiLocale={level.uiLocale} /></span>
        <div class="meta">
          <PerLanguageInput {level} id="{id}.image" at={image} key="alt" label={m.field_alt_text({}, options)} />
          <p class="hint">{m.field_picture_same({}, options)}</p>
        </div>
      </div>
    {/if}
    {#if host}{@render previews()}{/if}
  </div>
{:else}
  {@const hiding = level.read([...at, 'noindex']) === true}
  {@const canonical = level.str([...at, 'canonical'])}
  {@const scheme = unsafeLinkScheme('default', canonical)}
  <div class="form" {id} role="group" aria-labelledby="{id}-l" aria-describedby={says}>
    {@render words(
      'title',
      m.field_seo_search_title({}, options),
      SEO_TITLE_LIMIT,
      inheritedSeo?.title ?? '',
      m.field_seo_pattern_fallback({}, options),
    )}
    {@render words(
      'description',
      m.field_seo_description({}, options),
      SEO_DESCRIPTION_LIMIT,
      inheritedSeo?.description ?? '',
      '',
    )}
    <div class="field">
      <div class="label-row">
        <span id="{id}.image-l">{m.field_seo_social_image({}, options)}</span><span class="mode"
          >{m.field_same_every_language({}, options)}</span
        >
      </div>
      {#if level.read(image) !== undefined}
        <div
          class="media-card"
          id="{id}.image"
          role="group"
          tabindex="-1"
          aria-labelledby="{id}.image-l"
        >
          <span class="thumb" style="aspect-ratio: {aspect(SOCIAL_CARD)}"
            ><MediaImage
              src={level.src(image)}
              alt=""
              style="object-position: {dot[0]}% {dot[1]}%"
              uiLocale={level.uiLocale}
            /><span class="focal" style="left: {dot[0]}%; top: {dot[1]}%" aria-hidden="true"
            ></span></span
          >
          <div class="meta">
            <div>
              <div class="sub">
                {level.str([...image, 'src'])} · {level.num([...image, 'width'])} × {level.num([
                  ...image,
                  'height',
                ])}
              </div>
            </div>
            <PerLanguageInput
              {level}
              id="{id}.image"
              at={image}
              key="alt"
              label={m.field_alt_text({}, options)}
            />
            <div class="actions">
              <button class="btn btn-sm" type="button" onclick={() => (framing = true)}
                >{m.field_picture_set_focal({}, options)}</button
              >
              <button
                class="btn btn-sm"
                type="button"
                onclick={() => (level.picker = `${id}.image`)}
                >{m.field_replace({}, options)}</button
              >
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                onclick={() => level.write(image, undefined)}
                >{inheritedSeo?.image
                  ? m.field_seo_site_default({}, options)
                  : m.field_remove_value({}, options)}</button
              >
            </div>
          </div>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -- the child button is the control -->
        <div
          class="dropzone"
          role="group"
          aria-labelledby="{id}.image-l"
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => level.dropOn(`${id}.image`, e)}
        >
          <span
            >{inheritedSeo?.image
              ? m.field_seo_site_card({}, options)
              : m.field_image_drop({}, options)}</span
          >
          <span class="hint"
            >{SOCIAL_CARD.ratio} · {m.field_image_min_width(
              { min: SOCIAL_CARD.min ?? 0 },
              options,
            )}</span
          >
          <button class="btn btn-sm" type="button" onclick={() => (level.picker = `${id}.image`)}
            >{m.field_picture_choose({}, options)}</button
          >
        </div>
      {/if}
    </div>
    <div class="field">
      <label class="switch" for="{id}.noindex"
        ><input
          type="checkbox"
          role="switch"
          id="{id}.noindex"
          checked={hiding}
          onchange={(e) => put('noindex', e.currentTarget.checked)}
        /><span>{m.field_seo_hide({}, options)}</span></label
      >
      {#if hiding}
        <p class="notice notice-warn">{m.field_seo_hide_notice({}, options)}</p>
      {/if}
    </div>
    {#if host}{@render previews()}{/if}
    <details class="group">
      <summary
        >{m.field_seo_canonical({}, options)}{#if canonical}<span class="count">{canonical}</span
          >{/if}</summary
      >
      <div class={['field', { 'is-invalid': scheme }]}>
        <div class="label-row">
          <label for="{id}.canonical">{m.field_seo_canonical({}, options)}</label>
        </div>
        <input
          class="input"
          id="{id}.canonical"
          type="url"
          aria-invalid={scheme ? 'true' : undefined}
          aria-describedby="{id}.canonical-hint{scheme ? ` ${id}.canonical-err` : ''}"
          value={canonical}
          oninput={(e) => put('canonical', e.currentTarget.value || undefined)}
        />
        {#if scheme}<p class="error" id="{id}.canonical-err">
            {m.field_link_scheme_not_allowed({ scheme }, options)}
          </p>{/if}
        <p class="hint" id="{id}.canonical-hint">{m.field_seo_canonical_hint({}, options)}</p>
      </div>
    </details>
  </div>
{/if}
{#if framing}
  <!-- A 1.91:1 card cut from a 3:2 photo loses a band top and bottom. -->
  <Focal
    name={m.field_seo_social_image({}, options)}
    url={level.src(image)}
    focal={level.point(image)}
    presets={[{ label: m.field_seo_social_image({}, options), preset: SOCIAL_CARD }]}
    uiLocale={level.uiLocale}
    onsave={(moved) => { level.write([...image, 'focal'], centred(moved) ? undefined : moved); framing = false; }}
    onclose={() => (framing = false)}
  />
{/if}
{#if level.picker === `${id}.image`}
  <Media
    kind="images"
    label={m.field_seo_social_image({}, options)}
    preset={SOCIAL_CARD}
    base={level.mediaBase}
    dropped={level.dropped}
    uiLocale={level.uiLocale}
    onpick={(items) => { put('image', stored('image', items[0] as MediaItem)); level.picker = ''; level.dropped = []; }}
    onclose={() => { level.picker = ''; level.dropped = []; }}
  />
{/if}
