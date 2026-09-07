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
    // The provider's refusal names the broken rule, which is the whole use of the button.
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

/** Owner only: it names the sending address and the media host, and the sidebar is not a gate. */
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
    // "Simulate conflict" commits to the repository, so only a developer is offered it.
    dev: import.meta.env.DEV,
  });
}

/** Something the site was never told, rather than something that refused: a different sentence. */
const unset = (why: string) => Response.json({ error: why }, { status: 503 });

/** The key itself is never in the answer: only its last four characters, who set it and when. */
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
  // Only DeepL has an environment variable behind it; writing help has none yet.
  const inEnv = (key: Integration) => (key === 'deepl' ? e.DEEPL_API_KEY : undefined);
  return Response.json({
    integrations: INTEGRATIONS.map((key) => {
      const fact = facts.find((row) => row.key === key);
      // What would be in force with no row, which is what Remove does; the card says so first.
      const fallback =
        key === 'deepl' && config.i18n.translate ? 'code' : inEnv(key) ? 'env' : 'off';
      // A site's own `translate` wins over whatever is stored here.
      const source = fact && fallback !== 'code' ? 'settings' : fallback;
      return {
        key,
        source,
        fallback,
        hint: fact?.hint ?? null,
        updatedAt: fact?.updatedAt ?? null,
        // An id on screen says nothing; a member who has gone leaves the date on its own.
        by: members.find((member) => member.id === fact?.updatedBy)?.name ?? null,
      };
    }),
  });
}

/** The key is tried against the service before it is written; a refusal stores nothing. */
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
    // A one-language site has nothing to translate into, so the key is stored untried.
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
    // The one thing that can be missing here is the secret the row is encrypted under.
    return unset((err as Error).message);
  }
  await logActivity('default', database, {
    userId: session.user.id,
    kind: 'setting-changed',
    // Never the value, and never its hint.
    subject: key,
    detail: { how: replaced ? 'replaced' : 'set' },
  });
  return Response.json({ ok: true, ...(detail ? { detail } : {}) });
}

/** What is in force afterwards is the resolution order, and the card says which. */
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

/** Every answer is a sentence, not a status; an optional thing that is absent answers `off`. */
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
    // `gitClient()` names every value that has to be set; this screen exists to show that.
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
      // A stored key that cannot be opened means the secret changed under it.
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
      // No commit named: a commit nothing has built would read as a token that does not work.
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

/** Commits a different edit over an open draft, which is what a developer's push does to one. */
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
    // The index lags a build, so a fixed name would collide with the last run's entry.
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
    // Two fields raise a question each; the next two are one-sided, so something merged shows too.
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

/** `undefined` where a required field has no stand-in, since the site builds from this file. */
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
