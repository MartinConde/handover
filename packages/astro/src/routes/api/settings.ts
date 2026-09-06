import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import { preview } from 'virtual:handover/index';
import type { Form, GitClient, Integration } from '@handover/core';
import {
  checkStore,
  commitBuild,
  createDraft,
  deeplTranslate,
  entryName,
  FORMAT_VERSION,
  INTEGRATIONS,
  logActivity,
  memberList,
  publishDrafts,
  removeSetting,
  SCHEMA_VERSION,
  saveDraft,
  settingFacts,
  stringifyEntry,
  writeSetting,
} from '@handover/core';
import { mailer } from '../../auth.js';
import { entryProblems } from '../../problems.js';
import { deeplKey, entryPath, formFor, sourceOf, takenNames } from './content.js';
import type { RequestContext } from './context.js';
import { mediaStore, missingMailer, NO_BUCKET, workerBuilds } from './environment.js';

export async function testEmail(session: App.Locals['handover']): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const send = mailer();
  if (!send) return Response.json({ error: missingMailer() }, { status: 503 });
  const to = session.user.email;
  try {
    const { id } = await send({
      to,
      subject: 'Handover test email',
      text: 'Your site can send email. Nothing else to do — this message was sent from the admin to check.',
    });
    return Response.json({ ok: true, to, id });
  } catch (err) {
    // The provider's own refusal, which names the rule that was broken — an unverified sending
    // domain above all — and is the whole use of the button.
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

/**
 * What the site's config came out as, for a screen that has to be readable by somebody who will
 * forward it rather than act on it. **Owner only**: it names the sending address, the
 * repository's media host and what this build serves, and a sidebar item an editor never sees
 * is not a gate.
 */
export function diagnostics(session: App.Locals['handover']): Response {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const configured = config.mailer;
  return Response.json({
    collections: Object.entries(config.collections).map(([name, collected]) => ({
      name,
      ...(collected.route ? { route: collected.route } : {}),
    })),
    locales: config.i18n.locales,
    defaultLocale: config.i18n.defaultLocale,
    mediaBase: config.media?.publicBase,
    mailer: !configured
      ? null
      : typeof configured === 'function'
        ? { provider: 'custom' }
        : { provider: configured.provider, from: configured.from },
    preview,
    // "Simulate conflict" commits to the repository, so it is offered to somebody developing
    // the site and not to somebody living on it.
    dev: import.meta.env.DEV,
  });
}

/** Something the site was never told, rather than something that refused: a different sentence. */
const unset = (why: string) => Response.json({ error: why }, { status: 503 });

/**
 * Which of the client's own keys are set and which one is in force, for the one section of the
 * settings screen that writes. The key itself is never in the answer — a value that can be read
 * back is a value that leaves in a screenshot — so what comes back is its last four characters,
 * who put it there and when. Owner only, like the rest of the page.
 */
export async function integrations(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const database = ctx.db();
  const [facts, members] = await Promise.all([
    settingFacts('default', database),
    memberList('default', database),
  ]);
  const e = env as Record<string, string | undefined>;
  // Only DeepL has an environment variable behind it: writing help has no feature to read one
  // yet, so a key stored for it is in force or nothing.
  const inEnv = (key: Integration) => (key === 'deepl' ? e.DEEPL_API_KEY : undefined);
  return Response.json({
    integrations: INTEGRATIONS.map((key) => {
      const fact = facts.find((row) => row.key === key);
      // What would be in force with no row here — which is what Remove does, and the card says
      // it before the button is pressed rather than after.
      const fallback =
        key === 'deepl' && config.i18n.translate ? 'code' : inEnv(key) ? 'env' : 'off';
      // A site that hands in its own `translate` is translated by that code whatever is stored
      // here, so the card cannot claim to be in charge while something above it is.
      const source = fact && fallback !== 'code' ? 'settings' : fallback;
      return {
        key,
        source,
        fallback,
        hint: fact?.hint ?? null,
        updatedAt: fact?.updatedAt ?? null,
        // An id on screen tells nobody anything, and a member who has since gone leaves the
        // date standing on its own.
        by: members.find((member) => member.id === fact?.updatedBy)?.name ?? null,
      };
    }),
  });
}

/**
 * Storing one of them. The key is tried against the service before it is written where there is
 * something to try it against, because the alternative is finding out on the next translation;
 * a refusal is the provider's own sentence and nothing is stored. The answer never carries the
 * value back.
 */
export async function setIntegration(
  ctx: RequestContext,
  key: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  if (!INTEGRATIONS.includes(key as Integration)) return new Response('Not found', { status: 404 });
  const body = (await request.json().catch(() => undefined)) as { value?: unknown } | undefined;
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!value) return Response.json({ error: 'Paste the key before saving it.' }, { status: 400 });
  let detail: string | undefined;
  if (key === 'deepl') {
    const to = config.i18n.locales.find((l) => l !== config.i18n.defaultLocale);
    // A one-language site has nothing to translate into, so there is no call to make with the
    // key: it is stored untried rather than refused.
    if (to) {
      try {
        await deeplTranslate('default', value)(['Hello'], config.i18n.defaultLocale, to);
        detail = `It translated "Hello" into ${to}.`;
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    }
  }
  const database = ctx.db();
  const replaced = (await settingFacts('default', database)).some((row) => row.key === key);
  try {
    await writeSetting(
      'default',
      database,
      (env as Record<string, string | undefined>).HANDOVER_SETTINGS_KEY,
      key as Integration,
      value,
      session.user.id,
    );
  } catch (err) {
    // The one thing that can be missing here is the secret the row is encrypted under, and its
    // own sentence names it.
    return unset((err as Error).message);
  }
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'setting-changed',
    // The name of the key and what happened to it. Never the value, and never its hint.
    subject: key,
    detail: { how: replaced ? 'replaced' : 'set' },
  });
  return Response.json({ ok: true, ...(detail ? { detail } : {}) });
}

/** Taking one out again. What happens next is the resolution order, and the card says which. */
export async function clearIntegration(
  ctx: RequestContext,
  key: string,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  if (!INTEGRATIONS.includes(key as Integration)) return new Response('Not found', { status: 404 });
  const database = ctx.db();
  await removeSetting('default', database, key as Integration);
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'setting-changed',
    subject: key,
    detail: { how: 'removed' },
  });
  return Response.json({ ok: true });
}

/**
 * One connection, tried for real. Every answer is a sentence and not a status, because this
 * page is read by the person who forwards it: what refused has to be in the words of the thing
 * that has to change. A check whose thing is optional and absent answers `off` rather than
 * failing — a site with no DeepL key is not broken.
 */
export async function connection(
  ctx: RequestContext,
  name: string,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const e = env as Record<string, string | undefined>;
  const ok = (detail: string) => Response.json({ ok: true, detail });
  const off = (detail: string) => Response.json({ off: true, detail });
  const refused = (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: 502 });

  if (name === 'github') {
    let git: GitClient;
    // `gitClient()` writes its own sentence naming every value that has to be set, and that
    // sentence is the one this screen exists to show.
    try {
      git = ctx.git();
    } catch (err) {
      return unset((err as Error).message);
    }
    try {
      const head = await git.getHead();
      return ok(`${e.GITHUB_REPO} — the app minted a token and read ${head.slice(0, 7)}.`);
    } catch (err) {
      return refused(err);
    }
  }

  if (name === 'storage') {
    const store = mediaStore();
    if (!store) return unset(NO_BUCKET);
    const started = Date.now();
    try {
      await checkStore(store);
    } catch (err) {
      return refused(err);
    }
    return ok(
      `Wrote, read back and deleted a test object on ${store.bucket} in ${Date.now() - started}ms.`,
    );
  }

  if (name === 'translation') {
    let stored: string | undefined;
    try {
      stored = config.i18n.translate ? undefined : await deeplKey(ctx);
    } catch (err) {
      // A key that is stored and cannot be opened: the secret changed under it, and this is
      // the one screen where that reads as a sentence somebody can act on.
      return unset((err as Error).message);
    }
    const translate =
      config.i18n.translate ?? (stored ? deeplTranslate('default', stored) : undefined);
    if (!translate)
      return off(
        'No DeepL key in Settings, no DEEPL_API_KEY and no translate hook, so the Translate button is hidden.',
      );
    const to = config.i18n.locales.find((l) => l !== config.i18n.defaultLocale);
    if (!to) return off('This site has one language, so nothing is translated.');
    try {
      await translate(['Hello'], config.i18n.defaultLocale, to);
      return ok(`It translated "Hello" into ${to}.`);
    } catch (err) {
      return refused(err);
    }
  }

  if (name === 'build') {
    const builds = workerBuilds();
    if (!builds)
      return off(
        'No CLOUDFLARE_API_TOKEN and CLOUDFLARE_WORKER, so the admin cannot say whether a publish reached the site.',
      );
    try {
      // No commit named: what is checked here is the token, and a commit nothing has built
      // would read as a token that does not work.
      await commitBuild(builds, undefined);
      return ok(`Cloudflare answered for ${builds.worker} — the token works.`);
    } catch (err) {
      return refused(err);
    }
  }

  if (name === 'database') {
    try {
      await ctx.db().query.drafts.findFirst();
    } catch (err) {
      // `openDb` names the binding to add; anything past it is the database itself refusing.
      const why = (err as Error).message;
      return why.includes('binding') ? unset(why) : refused(err);
    }
    return ok(
      `The database answered — the admin's tables are there. Schema version ${SCHEMA_VERSION}.`,
    );
  }

  return new Response('Not found', { status: 404 });
}

/**
 * "Simulate conflict": the sequence from
 * [drafts-and-publishing.md](../../../docs/publishing.md) run against the real repository on a
 * scratch entry, so the three-way view can be exercised on a live site without hand-crafting
 * commits. It publishes an entry, edits the draft, and then commits a different edit to the
 * same file — which is exactly what a developer's push does to somebody's open draft.
 *
 * It writes to the repository, so it is the owner's and it names what it made: delete that
 * entry when the walk is over. `422` when no collection here can be filled in from its schema
 * alone — a scratch file the site's own content schema rejects would break the next build.
 */
export async function simulateConflict(
  ctx: RequestContext,
  session: App.Locals['handover'],
): Promise<Response> {
  if (session?.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const git = ctx.git();
  const database = ctx.db();
  for (const [collection, collected] of Object.entries(config.collections)) {
    const form = formFor(collection, SCRATCH);
    const values = sampleValues(form.fields);
    const texts = form.fields.flatMap((f) => (f.type === 'text' ? (f.path[0] ?? []) : []));
    if (!values || !texts.length || entryProblems(collected.schema, values).length) continue;
    // Named after the commit it is made against, the way the integration tests name theirs: the
    // taken-names check reads the built index, which lags the repository by a build, so a plain
    // `conflict-check` would collide with the last run's entry on a site that has not rebuilt.
    const head = await git.getHead();
    const slug = entryName(
      'default',
      `${SCRATCH} ${head.slice(0, 7)}`,
      await takenNames(collection, database),
    );
    const path = entryPath(collection, slug, config.i18n.defaultLocale);
    await createDraft('default', database, git, path, { _version: FORMAT_VERSION, ...values });
    const seeded = await publishDrafts('default', database, git, (path) => sourceOf(ctx, path), [
      `${collection}/${slug}`,
    ]);
    if (!seeded) return new Response('The scratch entry could not be committed', { status: 502 });
    // Both sides write the first two text fields, so there is a question each and the answers
    // can differ; the two after them are one-sided, so there is something merged to read beside
    // them. A collection with fewer text fields than that simply asks fewer questions.
    const [first = '', second, third, fourth] = texts;
    const ours = { ...values, [first]: 'Your version' };
    const theirs = { ...values, [first]: 'The version in the code' };
    if (second) {
      ours[second] = 'Yours here too';
      theirs[second] = 'And the code here too';
    }
    if (third) theirs[third] = 'Changed in the code, and only there';
    if (fourth) ours[fourth] = 'Changed by you, and only you';
    await saveDraft('default', database, git, path, ours);
    const { commit_sha } = await git.publish(
      [{ path, contents: stringifyEntry('default', { _version: FORMAT_VERSION, ...theirs }) }],
      { base_sha: seeded.commit_sha, message: `Edit ${slug} in code` },
    );
    return Response.json({ entry: `${collection}/${slug}`, path, commit_sha });
  }
  return new Response(
    'No collection on this site can be filled in from its schema alone: a scratch entry needs a collection whose required fields are text, numbers, choices or true/false',
    { status: 422 },
  );
}

const SCRATCH = 'Conflict check';

/**
 * A file a collection's own schema accepts, filled from the field types alone. `undefined`
 * where the schema requires something no default can stand in for — a picture, a reference —
 * because the file this makes is committed and the site builds from it.
 */
function sampleValues(fields: Form['fields']): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.path[0];
    if (key === undefined) continue;
    if (field.type === 'group') {
      const inner = sampleValues(field.fields);
      if (!inner) return undefined;
      out[key] = inner;
    } else if (field.type === 'text') out[key] = SCRATCH;
    else if (field.type === 'richtext') out[key] = 'A scratch entry, to try a conflict out.';
    else if (field.type === 'number') out[key] = 0;
    else if (field.type === 'boolean') out[key] = false;
    else if (field.type === 'select') out[key] = field.options[0];
    else if (field.type !== 'unsupported' && field.required) return undefined;
  }
  return out;
}
