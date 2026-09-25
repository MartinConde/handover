import config from 'virtual:handover/config';
import {
  beginOperation,
  collapseRedirects,
  editRedirects,
  entryUrl,
  finalizeOperation,
  logActivity,
  markOperationCommitted,
  OperationFinalizationError,
  pendingDrafts,
  type RedirectRule,
  readRedirects,
  recentOperations,
  recoverOperationCommit,
  redirectError,
  redirectRule,
} from '@handover/core';
import type { RequestContext } from '../../environment.js';
import { readJson } from './body.js';
import { pickable } from './content.js';

/** What a `from` is held against: a redirect over a live page takes it off the site silently. */
function sitePages(entries: Awaited<ReturnType<typeof pickable>>): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const [collection, collected] of Object.entries(config.collections))
    for (const locale of config.i18n.locales) {
      const url = entryUrl('default', config.i18n, collected.index, '', locale);
      // An entry beats an index at the same address, being the more specific thing to name.
      if (url) pages[url] = `the ${collection} index`;
    }
  for (const entry of entries)
    for (const url of Object.values(entry.urls)) pages[url] = entry.title || entry.path;
  return pages;
}

/** Committed rules in file order, then the rules waiting on an entry's draft, flagged. */
export async function redirectList(ctx: RequestContext): Promise<Response> {
  const database = ctx.db();
  const [committed, waiting, entries] = await Promise.all([
    readRedirects('default', ctx.git()),
    pendingDrafts('default', database),
    pickable(ctx),
  ]);
  const titles = new Map(entries.map((e) => [e.path, e.title || e.path]));
  // Keyed by id: a row read twice would otherwise list the same rule twice.
  const pending = new Map(
    waiting.flatMap((row) => (row.pendingRedirects ?? []).map((rule) => [rule._id, rule] as const)),
  );
  const named = (rule: RedirectRule, unpublished?: true) => ({
    ...rule,
    ...(rule.entry ? { title: titles.get(rule.entry) ?? rule.entry } : {}),
    ...(unpublished ? { pending: true } : {}),
  });
  return Response.json({
    rules: [
      ...committed.map((rule) => named(rule)),
      ...[...pending.values()].map((rule) => named(rule, true)),
    ],
  });
}

/** A rule the entry owns: hiding wrote it and showing the entry again takes it back out. */
const MANAGED =
  'This redirect belongs to the entry that is hidden. Show that entry again and the redirect goes with it.';

const typedRule = async (request: Request) => {
  const body = (await readJson(request)) as
    | { from?: unknown; to?: unknown; status?: unknown }
    | undefined;
  return {
    from: typeof body?.from === 'string' ? body.from.trim() : '',
    to: typeof body?.to === 'string' ? body.to.trim() : '',
    status: body?.status === 302 ? (302 as const) : (301 as const),
  };
};

const ruleDetail = (value: unknown): RedirectRule | undefined => {
  if (!value || typeof value !== 'object' || !('rule' in value)) return undefined;
  const rule = value.rule;
  return rule && typeof rule === 'object' && '_id' in rule ? (rule as RedirectRule) : undefined;
};

const sameTypedRule = (
  rule: RedirectRule | undefined,
  typed: { from: string; to: string; status: 301 | 302 },
) => rule?.from === typed.from && rule.to === typed.to && rule.status === typed.status;

/** Committed on add: a rule with no entry to ride on has nowhere to wait for a publish. */
export async function addRedirect(
  ctx: RequestContext,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const typed = await typedRule(request);
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-added')).find(
    (operation) => {
      const rule = ruleDetail(operation.detail);
      return (
        sameTypedRule(rule, typed) &&
        (operation.state !== 'finalized' ||
          current.some(
            (candidate) => candidate._id === rule?._id && sameTypedRule(candidate, typed),
          ))
      );
    },
  );
  const baseSha = prior?.baseSha ?? head;
  const [rules, entries] = await Promise.all([
    prior ? readRedirects('default', git, baseSha) : current,
    pickable(ctx),
  ]);
  const bad = redirectError('default', typed, {
    pages: sitePages(entries),
    rules,
    base: config.i18n.base,
  });
  if (bad) return Response.json(bad, { status: 422 });
  const typed_ =
    ruleDetail(prior?.detail) ??
    redirectRule('default', { ...typed, reason: 'manual' }, Date.now());
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-added:${baseSha}:${typed_.from}:${typed_.to}:${typed_.status}`,
      kind: 'redirect-added',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: typed_._id,
      detail: { rule: typed_ },
    }));
  const completed = operation.result as { commit_sha?: unknown; rule?: unknown } | null;
  if (operation.state === 'finalized' && completed?.rule)
    return Response.json({ rule: completed.rule });
  // Read back from the file: a destination that already forwarded is collapsed onto its target.
  let rule = typed_;
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Add redirect ${rule.from}`,
      (all) => {
        const written = collapseRedirects(all, [typed_]);
        rule = written.find((candidate) => candidate._id === typed_._id) ?? typed_;
        return written;
      },
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  } else {
    rule =
      (await readRedirects('default', git, commit_sha)).find(
        (candidate) => candidate._id === typed_._id,
      ) ?? typed_;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha, rule });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-added',
    subject: rule._id,
    commitSha: commit_sha,
    detail: { from: rule.from, to: rule.to },
  });
  return Response.json({ rule });
}

/** A hidden entry's rule is refused for the reason a delete of it is. */
export async function changeRedirect(
  ctx: RequestContext,
  id: string,
  request: Request,
  session: App.Locals['handover'],
): Promise<Response> {
  const typed = await typedRule(request);
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-changed')).find(
    (operation) =>
      operation.subject === id &&
      sameTypedRule(ruleDetail(operation.detail), typed) &&
      (operation.state !== 'finalized' ||
        current.some((rule) => rule._id === id && sameTypedRule(rule, typed))),
  );
  const baseSha = prior?.baseSha ?? head;
  const [rules, entries] = await Promise.all([
    prior ? readRedirects('default', git, baseSha) : current,
    pickable(ctx),
  ]);
  const found = rules.find((rule) => rule._id === id);
  if (!found)
    return Response.json({ code: 'REDIRECT_NOT_FOUND', error: 'Not found' }, { status: 404 });
  if (found.reason === 'hidden')
    return Response.json({ code: 'REDIRECT_MANAGED', error: MANAGED }, { status: 409 });
  const bad = redirectError(
    'default',
    typed,
    { pages: sitePages(entries), rules, base: config.i18n.base },
    id,
  );
  if (bad) return Response.json(bad, { status: 422 });
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-changed:${baseSha}:${id}:${typed.from}:${typed.to}:${typed.status}`,
      kind: 'redirect-changed',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: id,
      detail: { rule: { ...found, ...typed } },
    }));
  if (operation.state === 'finalized') return Response.json({});
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Edit redirect ${found.from}`,
      (all) => collapseRedirects(all, [{ ...found, ...typed }]),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-changed',
    subject: id,
    commitSha: commit_sha,
    detail: { from: typed.from, to: typed.to },
  });
  return Response.json({});
}

/** A hidden entry's rule is refused: it would come back at the next publish anyway. */
export async function removeRedirect(
  ctx: RequestContext,
  id: string,
  session: App.Locals['handover'],
): Promise<Response> {
  const git = ctx.git();
  const database = ctx.db();
  const head = await git.getHead();
  const current = await readRedirects('default', git, head);
  const prior = (await recentOperations('default', database, 'redirect-deleted')).find(
    (operation) =>
      operation.subject === id &&
      (operation.state !== 'finalized' || !current.some((rule) => rule._id === id)),
  );
  if (prior?.state === 'finalized') return Response.json({ deleted: id });
  const baseSha = prior?.baseSha ?? head;
  const rules = prior ? await readRedirects('default', git, baseSha) : current;
  const found = rules.find((rule) => rule._id === id);
  if (!found)
    return Response.json({ code: 'REDIRECT_NOT_FOUND', error: 'Not found' }, { status: 404 });
  if (found.reason === 'hidden')
    return Response.json({ code: 'REDIRECT_MANAGED', error: MANAGED }, { status: 409 });
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-deleted:${baseSha}:${id}`,
      kind: 'redirect-deleted',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: id,
      detail: { rule: found },
    }));
  let commit_sha: string | undefined = operation.commitSha ?? undefined;
  if (!commit_sha) commit_sha = await recoverOperationCommit('default', database, git, operation);
  if (!commit_sha) {
    const committed = await editRedirects(
      'default',
      git,
      `Delete redirect ${found.from}`,
      (all) => all.filter((rule) => rule._id !== id),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commit_sha = committed.commit_sha;
  }
  await markOperationCommitted('default', database, operation.id, commit_sha, { commit_sha });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commit_sha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-deleted',
    subject: id,
    commitSha: commit_sha,
    detail: { from: found.from, to: found.to },
  });
  return Response.json({ deleted: id });
}
