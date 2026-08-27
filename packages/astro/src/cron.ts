import { type GitClient, runDue } from '@handover/core';
import { db, gitClient, mediaStore } from './routes/api.js';

/**
 * The site's one scheduled handler. `wrangler.jsonc` carries a single trigger and the dispatcher
 * decides which jobs this tick belongs to, so a package upgrade that adds a job changes nothing
 * there. What ran goes to `wrangler tail`; the durable record is the activity log.
 */
export async function scheduled(controller: { cron: string }): Promise<void> {
  let git: GitClient | undefined;
  // A site whose App is not configured has no repository for a job to ask about, and the one
  // that wants it answers nothing rather than failing the tick.
  try {
    git = gitClient();
  } catch {
    git = undefined;
  }
  const report = await runDue('default', { db: db(), store: mediaStore(), git });
  const ran = Object.entries(report).map(([job, done]) => `${job}: ${done}`);
  console.log(`cron ${controller.cron} — ${ran.length ? ran.join(', ') : 'nothing was due'}`);
}
