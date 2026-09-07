import { type GitClient, runDue } from '@handover/core';
import { db, gitClient, mediaStore } from './routes/api/environment.js';

/** One trigger in `wrangler.jsonc`; `runDue` decides which jobs the tick belongs to. */
export async function scheduled(controller: { cron: string }): Promise<void> {
  let git: GitClient | undefined;
  // A site without the App configured has no repository; the jobs that want one answer nothing.
  try {
    git = gitClient();
  } catch {
    git = undefined;
  }
  const report = await runDue('default', { db: db(), store: mediaStore(), git });
  const ran = Object.entries(report).map(([job, done]) => `${job}: ${done}`);
  console.log(`cron ${controller.cron} — ${ran.length ? ran.join(', ') : 'nothing was due'}`);
}
