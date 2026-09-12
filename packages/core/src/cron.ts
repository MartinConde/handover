import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { expireActivity, logActivity } from './activity.js';
import { findHiddenLong } from './checks.js';
import { type Db, sweepOrphans } from './db.js';
import type { GitClient } from './git.js';
import { type R2Store, reconcileMedia } from './media.js';
import { newId } from './reserved.js';
import { cronState } from './tables.js';

/** Jobs receive shared dependencies and ignore what they do not need. */
export interface JobDeps {
  db: Db;
  /** Where the site's uploads live, or nothing where it has no bucket at all. */
  store?: R2Store;
  /** The repository, or nothing where the GitHub App has not been configured. */
  git?: GitClient;
  fetch?: typeof globalThis.fetch;
  now?: number;
}

const HOUR = 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
const MAX_RETRY = HOUR;
const LEASE = 15 * 60 * 1000;

/** How many things a job did — and, for the one whose answer is read back later, what it found. */
type JobDone = number | { done: number; [detail: string]: unknown };

/** Adding a job is a line here and never a second trigger in `wrangler.jsonc`. */
const JOBS: Record<
  string,
  { every: number; run: (siteId: string, deps: JobDeps) => Promise<JobDone> }
> = {
  reconcile: { every: HOUR, run: (siteId, d) => reconcileMedia(siteId, d.db, d.store, d) },
  retention: { every: 24 * HOUR, run: (siteId, d) => expireActivity(siteId, d.db, d.now) },
  orphans: { every: 24 * HOUR, run: (siteId, d) => sweepOrphans(siteId, d.db, d.git, d.now) },
  hidden: { every: 24 * HOUR, run: (siteId, d) => findHiddenLong(siteId, d.git, d.now) },
};

/** What this site runs, in the order the dispatcher walks them. */
export const JOB_NAMES = Object.keys(JOBS);

/** Unknown job names are never registered. */
export async function runJob(siteId: string, name: string, deps: JobDeps): Promise<JobDone> {
  const job = JOBS[name];
  if (!job)
    throw new Error(`there is no cron job called ${name}: this site runs ${JOB_NAMES.join(', ')}`);
  return job.run(siteId, deps);
}

/** What each job this tick belonged to did, or the message it failed with. */
export type CronReport = Record<string, number | string>;

const claimJob = async (
  siteId: string,
  name: string,
  every: number,
  deps: JobDeps,
  now: number,
) => {
  const token = newId(siteId);
  const [claim] = await deps.db
    .insert(cronState)
    .values({
      siteId,
      job: name,
      lastRun: 0,
      failures: 0,
      leaseToken: token,
      leaseUntil: now + LEASE,
    })
    .onConflictDoUpdate({
      target: [cronState.siteId, cronState.job],
      set: { leaseToken: token, leaseUntil: now + LEASE },
      setWhere: and(
        or(isNull(cronState.leaseUntil), lte(cronState.leaseUntil, now)),
        or(
          and(isNotNull(cronState.retryAt), lte(cronState.retryAt, now)),
          and(isNull(cronState.retryAt), lte(cronState.lastRun, now - every)),
        ),
      ),
    })
    .returning({ failures: cronState.failures });
  return claim && { token, failures: claim.failures };
};

const finishJob = async (
  siteId: string,
  name: string,
  token: string,
  deps: JobDeps,
  state: { lastRun?: number; retryAt: number | null; failures: number },
) => {
  await deps.db
    .update(cronState)
    .set({ ...state, leaseToken: null, leaseUntil: null })
    .where(
      and(eq(cronState.siteId, siteId), eq(cronState.job, name), eq(cronState.leaseToken, token)),
    );
};

/** A quiet tick logs nothing, because on a five-minute schedule that would bury the log. */
export async function runDue(siteId: string, deps: JobDeps): Promise<CronReport> {
  const now = deps.now ?? Date.now();
  const report: CronReport = {};
  for (const [name, job] of Object.entries(JOBS)) {
    let claim: Awaited<ReturnType<typeof claimJob>>;
    try {
      claim = await claimJob(siteId, name, job.every, deps, now);
    } catch (err) {
      console.error(`cron: ${name} could not be claimed`, err);
      continue;
    }
    if (!claim) continue;
    try {
      const out = await runJob(siteId, name, { ...deps, now });
      const done = typeof out === 'number' ? out : out.done;
      report[name] = done;
      if (done)
        await logActivity(siteId, deps.db, {
          kind: `cron-${name}`,
          detail: typeof out === 'number' ? { done } : out,
        });
      await finishJob(siteId, name, claim.token, deps, {
        lastRun: now,
        retryAt: null,
        failures: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report[name] = message;
      await logActivity(siteId, deps.db, { kind: `cron-${name}`, detail: { error: message } });
      const delay = Math.min(RETRY * 2 ** claim.failures, MAX_RETRY);
      try {
        await finishJob(siteId, name, claim.token, deps, {
          retryAt: now + delay,
          failures: claim.failures + 1,
        });
      } catch (finishError) {
        console.error(`cron: ${name} failed but its retry was not written`, finishError);
      }
    }
  }
  return report;
}
