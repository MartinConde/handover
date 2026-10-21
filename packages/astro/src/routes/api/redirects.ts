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
import { pickable } from '../../content.js';
import type { RequestContext } from '../../environment.js';
import { readJson } from './body.js';
import { codedError } from './respond.js';

// What a `from` is held against: a redirect over a live page takes it off the site silently.
function sitePages(entries: Awaited<ReturnType<typeof pickable>>): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const [collection, collected] of Object.entries(config.collections))
    for (const locale of config.i18n.locales) {
      const url = entryUrl(config.i18n, collected.index, '', locale);
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
    readRedirects(ctx.git()),
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

// A rule the entry owns: hiding wrote it and showing the entry again takes it back out.
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
  const current = await readRedirects(git, head);
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
    prior ? readRedirects(git, baseSha) : current,
    pickable(ctx),
  ]);
  const bad = redirectError(typed, {
    pages: sitePages(entries),
    rules,
    base: config.i18n.base,
  });
  if (bad) return Response.json(bad, { status: 422 });
  const requested =
    ruleDetail(prior?.detail) ?? redirectRule({ ...typed, reason: 'manual' }, Date.now());
  const operation =
    prior ??
    (await beginOperation('default', database, {
      retryKey: `redirect-added:${baseSha}:${requested.from}:${requested.to}:${requested.status}`,
      kind: 'redirect-added',
      paths: ['src/content/redirects.yaml'],
      baseSha,
      userId: session?.user.id,
      subject: requested._id,
      detail: { rule: requested },
    }));
  const completed = operation.result as { commit_sha?: unknown; rule?: unknown } | null;
  if (operation.state === 'finalized' && completed?.rule)
    return Response.json({ rule: completed.rule });
  // Read back from the file: a destination that already forwarded is collapsed onto its target.
  let rule = requested;
  let commitSha: string | undefined = operation.commitSha ?? undefined;
  if (!commitSha) commitSha = await recoverOperationCommit('default', database, git, operation);
  if (!commitSha) {
    const committed = await editRedirects(
      git,
      `Add redirect ${rule.from}`,
      (all) => {
        const written = collapseRedirects(all, [requested]);
        rule = written.find((candidate) => candidate._id === requested._id) ?? requested;
        return written;
      },
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commitSha = committed.commitSha;
  } else {
    rule =
      (await readRedirects(git, commitSha)).find((candidate) => candidate._id === requested._id) ??
      requested;
  }
  await markOperationCommitted('default', database, operation.id, commitSha, {
    commit_sha: commitSha,
    rule,
  });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commitSha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-added',
    subject: rule._id,
    commitSha,
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
  const current = await readRedirects(git, head);
  const prior = (await recentOperations('default', database, 'redirect-changed')).find(
    (operation) =>
      operation.subject === id &&
      sameTypedRule(ruleDetail(operation.detail), typed) &&
      (operation.state !== 'finalized' ||
        current.some((rule) => rule._id === id && sameTypedRule(rule, typed))),
  );
  const baseSha = prior?.baseSha ?? head;
  const [rules, entries] = await Promise.all([
    prior ? readRedirects(git, baseSha) : current,
    pickable(ctx),
  ]);
  const found = rules.find((rule) => rule._id === id);
  if (!found) return codedError(404, 'REDIRECT_NOT_FOUND', 'Not found');
  if (found.reason === 'hidden') return codedError(409, 'REDIRECT_MANAGED', MANAGED);
  const bad = redirectError(
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
  let commitSha: string | undefined = operation.commitSha ?? undefined;
  if (!commitSha) commitSha = await recoverOperationCommit('default', database, git, operation);
  if (!commitSha) {
    const committed = await editRedirects(
      git,
      `Edit redirect ${found.from}`,
      (all) => collapseRedirects(all, [{ ...found, ...typed }]),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commitSha = committed.commitSha;
  }
  await markOperationCommitted('default', database, operation.id, commitSha, {
    commit_sha: commitSha,
  });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commitSha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-changed',
    subject: id,
    commitSha,
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
  const current = await readRedirects(git, head);
  const prior = (await recentOperations('default', database, 'redirect-deleted')).find(
    (operation) =>
      operation.subject === id &&
      (operation.state !== 'finalized' || !current.some((rule) => rule._id === id)),
  );
  if (prior?.state === 'finalized') return Response.json({ deleted: id });
  const baseSha = prior?.baseSha ?? head;
  const rules = prior ? await readRedirects(git, baseSha) : current;
  const found = rules.find((rule) => rule._id === id);
  if (!found) return codedError(404, 'REDIRECT_NOT_FOUND', 'Not found');
  if (found.reason === 'hidden') return codedError(409, 'REDIRECT_MANAGED', MANAGED);
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
  let commitSha: string | undefined = operation.commitSha ?? undefined;
  if (!commitSha) commitSha = await recoverOperationCommit('default', database, git, operation);
  if (!commitSha) {
    const committed = await editRedirects(
      git,
      `Delete redirect ${found.from}`,
      (all) => all.filter((rule) => rule._id !== id),
      { baseSha: operation.baseSha, operationId: operation.id },
    );
    commitSha = committed.commitSha;
  }
  await markOperationCommitted('default', database, operation.id, commitSha, {
    commit_sha: commitSha,
  });
  try {
    await finalizeOperation('default', database, operation.id);
  } catch (cause) {
    throw new OperationFinalizationError(operation.id, commitSha, { cause });
  }
  await logActivity('default', database, {
    userId: session?.user.id,
    kind: 'redirect-deleted',
    subject: id,
    commitSha,
    detail: { from: found.from, to: found.to },
  });
  return Response.json({ deleted: id });
}
