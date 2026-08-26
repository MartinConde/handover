import { eq } from 'drizzle-orm';
import { expireActivity, logActivity } from './activity.js';
import type { Db } from './db.js';
import { type R2Store, reconcileMedia } from './media.js';
import { cronState } from './tables.js';

/** Everything any job could want. A job takes what it is about and ignores the rest. */
export interface JobDeps {
  db: Db;
  /** Where the site's uploads live, or nothing where it has no bucket at all. */
  store?: R2Store;
  fetch?: typeof globalThis.fetch;
  now?: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * The one Cron Trigger dispatches to these. A job says how often it wants to run and returns how
 * many things it did; adding one is a line here and never a second trigger in `wrangler.jsonc`.
 */
const JOBS: Record<
  string,
  { every: number; run: (siteId: string, deps: JobDeps) => Promise<number> }
> = {
  reconcile: { every: HOUR, run: (siteId, d) => reconcileMedia(siteId, d.db, d.store, d) },
  retention: { every: 24 * HOUR, run: (siteId, d) => expireActivity(siteId, d.db, d.now) },
};

/** What this site runs, in the order the dispatcher walks them. */
export const JOB_NAMES = Object.keys(JOBS);

/** One named job, whatever the clock says. Nothing is registered under an unknown name. */
export async function runJob(siteId: string, name: string, deps: JobDeps): Promise<number> {
  const job = JOBS[name];
  if (!job)
    throw new Error(`there is no cron job called ${name}: this site runs ${JOB_NAMES.join(', ')}`);
  return job.run(siteId, deps);
}

/** What each job this tick belonged to did, or the message it failed with. */
export type CronReport = Record<string, number | string>;

/**
 * The tick. Every job that is due runs inside its own `try`, so one that is failing cannot
 * starve the others, and each is logged as `cron-<job>` when it did something or when it threw
 * — a quiet tick writes nothing, because on a five-minute schedule that would bury the log.
 */
export async function runDue(siteId: string, deps: JobDeps): Promise<CronReport> {
  const now = deps.now ?? Date.now();
  const state = await deps.db.select().from(cronState).where(eq(cronState.siteId, siteId));
  const last = new Map(state.map((row) => [row.job, row.lastRun]));
  const report: CronReport = {};
  for (const [name, job] of Object.entries(JOBS)) {
    const before = last.get(name);
    // A job the table has never seen is due now, which is what makes the first tick run them all.
    if (before !== undefined && now - before < job.every) continue;
    try {
      const done = await runJob(siteId, name, { ...deps, now });
      report[name] = done;
      if (done) await logActivity(siteId, deps.db, { kind: `cron-${name}`, detail: { done } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report[name] = message;
      await logActivity(siteId, deps.db, { kind: `cron-${name}`, detail: { error: message } });
    }
    // Stamped whether it worked or not: a job failing on every tick must not be retried every
    // five minutes, and its own interval is the only thing that can hold it back. A stamp that
    // will not write costs this job its interval for one tick, and must not cost the next job
    // its turn — the jobs are walked in a fixed order, so an unguarded throw here would mean
    // the last one never runs at all.
    try {
      await deps.db
        .insert(cronState)
        .values({ siteId, job: name, lastRun: now })
        .onConflictDoUpdate({
          target: [cronState.siteId, cronState.job],
          set: { lastRun: now },
        });
    } catch (err) {
      console.error(`cron: ${name} ran but its last_run was not written`, err);
    }
  }
  return report;
}
