import { runDue } from '@handover/core';
import { db, mediaStore } from './routes/api.js';

/**
 * The site's one scheduled handler. `wrangler.jsonc` carries a single trigger and the dispatcher
 * decides which jobs this tick belongs to, so a package upgrade that adds a job changes nothing
 * there. What ran goes to `wrangler tail`; the durable record is the activity log.
 */
export async function scheduled(controller: { cron: string }): Promise<void> {
  const report = await runDue('default', { db: db(), store: mediaStore() });
  const ran = Object.entries(report).map(([job, done]) => `${job}: ${done}`);
  console.log(`cron ${controller.cron} — ${ran.length ? ran.join(', ') : 'nothing was due'}`);
}
