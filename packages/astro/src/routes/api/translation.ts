import config from 'virtual:handover/config';
import {
  abandonCostlyOperation,
  claimCostlyOperation,
  claimResource,
  completeCostlyOperation,
  costlyOperationResult,
  createDraft,
  DraftRevisionError,
  isDraftRace,
  parseEntry,
  ResourceLimitError,
  releaseResource,
  saveTranslated,
  syncLocale,
  translatableText,
  withSource,
} from '@handover/core';
import { readJson } from './body.js';
import {
  entryLocales,
  entryPath,
  entrySourceFor,
  formFor,
  localeData,
  offeredIn,
  schemaOf,
  sourceRefusal,
  translationSource,
  translator,
} from './content.js';
import type { RequestContext } from './context.js';

/** Structure and shared values from the source file, none of its words, as a draft. */
export async function createTranslation(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  const { loaded, source: answer } = await entrySourceFor(ctx, collection, slug);
  // A missing default language is exactly what this route is for, so no extra guard on it.
  if (loaded[locale]) return new Response('That language already has a file', { status: 409 });
  if (answer && 'problem' in answer) return sourceRefusal(answer, localeData(loaded));
  const source = answer?.locale;
  const data = source === undefined ? undefined : loaded[source]?.data;
  if (source === undefined || data === undefined) return new Response('Not found', { status: 404 });
  const { offered, problems } = offeredIn(data, Object.keys(loaded));
  // A mark the files contradict is answered before the offer it would otherwise be read as.
  if (problems.length) return new Response(problems.join('\n'), { status: 409 });
  if (!offered.includes(locale))
    return new Response(`This entry is not offered in ${locale}`, { status: 409 });
  const form = formFor(collection, slug);
  // Stamped even on an unrecorded entry: adding a language must never move the source.
  const made = withSource(
    'default',
    syncLocale('default', form, locale, { before: data, after: data }, {}),
    source,
  );
  if (offered.length < config.i18n.locales.length) made._locales = offered;
  try {
    await createDraft(
      'default',
      ctx.db(),
      ctx.git(),
      entryPath(collection, slug, locale),
      made,
      Object.fromEntries(
        config.i18n.locales.map((at) => [entryPath(collection, slug, at), loaded[at]?.revision]),
      ),
    );
  } catch (err) {
    if (err instanceof DraftRevisionError || isDraftRace(err))
      return new Response('This entry changed while the language was being created', {
        status: 409,
      });
    throw err;
  }
  return Response.json({});
}

/** Answers land in `_machine`, so the badge stands until somebody types over the field. */
export async function machineTranslate(
  ctx: RequestContext,
  collection: string,
  slug: string,
  locale: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const schema = schemaOf(collection, slug);
  if (!schema || !config.i18n.locales.includes(locale))
    return new Response('Not found', { status: 404 });
  // Checked before the entry is read: having no translator is about the site, not this entry.
  const translate = await translator(ctx);
  if (!translate)
    return new Response(
      'This site has nothing to translate with: paste a DeepL key in Settings, set DEEPL_API_KEY, or hand in an i18n.translate in cms.config.ts',
      { status: 409 },
    );
  const { loaded, source: answer } = await entrySourceFor(ctx, collection, slug);
  if (answer && 'problem' in answer) return sourceRefusal(answer, localeData(loaded));
  const from = answer?.locale;
  const source =
    from === undefined ? undefined : await translationSource(ctx, collection, slug, from);
  if (!from || !source || from === locale || !loaded[locale])
    return new Response('Not found', { status: 404 });
  const body = (await readJson(request)) as { paths?: unknown } | undefined;
  const named = Array.isArray(body?.paths) ? body.paths.map(String) : undefined;
  const form = formFor(collection, slug);
  // A pre-fill is for the gaps; a Translate button names its field whether filled or not.
  const written = new Set(
    translatableText('default', form, loaded[locale].data).map((v) => v.path),
  );
  const wanted = translatableText('default', form, parseEntry('default', source.contents)).filter(
    (v) => (named ? named.includes(v.path) : !written.has(v.path)),
  );
  if (wanted.length) {
    const database = ctx.db();
    const user = session?.user.id ?? 'unknown';
    const characters = Math.max(
      1,
      wanted.reduce((total, field) => total + field.text.length, 0),
    );
    const identity = JSON.stringify({
      user,
      collection,
      slug,
      locale,
      from,
      revision: loaded[locale].revision,
      fields: wanted.map((field) => [field.path, field.text]),
    });
    const operationKey = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const operation = await claimCostlyOperation('default', database, operationKey, user);
    if (!operation.owner) {
      if (operation.result !== undefined) return Response.json(operation.result);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const shared = await costlyOperationResult('default', database, operationKey);
        if (shared !== undefined) return Response.json(shared);
      }
      throw new ResourceLimitError('The same translation is already running; try again shortly');
    }
    const activeLeases: { key: string; token: string }[] = [];
    const budgets: Awaited<ReturnType<typeof claimResource>>[] = [];
    let providerStarted = false;
    try {
      const userActive = `translation-active:user:${user}`;
      const userLease = await claimCostlyOperation('default', database, userActive, user);
      if (!userLease.owner)
        throw new ResourceLimitError('A translation is already running for this account');
      activeLeases.push({ key: userActive, token: userLease.token as string });
      let siteLease: { key: string; token: string } | undefined;
      for (let slot = 0; slot < 3 && !siteLease; slot += 1) {
        const key = `translation-active:site:${slot}`;
        const lease = await claimCostlyOperation('default', database, key, user);
        if (lease.owner) siteLease = { key, token: lease.token as string };
      }
      if (!siteLease) throw new ResourceLimitError('The site is already translating at capacity');
      activeLeases.push(siteLease);
      budgets.push(
        await claimResource('default', database, {
          subject: 'site',
          kind: 'translation-characters',
          cost: characters,
          limit: 250_000,
        }),
      );
      budgets.push(
        await claimResource('default', database, {
          subject: user,
          kind: 'translation-characters',
          cost: characters,
          limit: 75_000,
        }),
      );
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('Translation provider timed out')),
        15_000,
      );
      let answers: string[];
      providerStarted = true;
      try {
        answers = await translate(
          wanted.map((v) => v.text),
          from,
          locale,
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
      await saveTranslated(
        'default',
        database,
        ctx.git(),
        entryPath(collection, slug, locale),
        Object.fromEntries(wanted.map((v, i) => [v.path, answers[i] ?? v.text])),
        session?.user.id,
        loaded[locale].revision,
        { form, source, ...(answer?.recorded ? { stamp: from } : {}) },
      );
      const after = await entryLocales(ctx, collection, slug, [locale]);
      const result = after[locale] ?? {};
      await completeCostlyOperation(
        'default',
        database,
        operationKey,
        operation.token as string,
        result,
      );
      return Response.json(result);
    } catch (error) {
      if (!providerStarted)
        for (const budget of budgets) await releaseResource('default', database, budget);
      await abandonCostlyOperation('default', database, operationKey, operation.token as string);
      throw error;
    } finally {
      for (const lease of activeLeases)
        await abandonCostlyOperation('default', database, lease.key, lease.token);
    }
  }
  // The column redraws from this, so an edit in the other column survives a pre-fill.
  const after = await entryLocales(ctx, collection, slug, [locale]);
  return Response.json(after[locale] ?? {});
}
