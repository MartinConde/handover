import { env } from 'cloudflare:workers';
import config from 'virtual:handover/config';
import type { Db, GitClient, R2Store } from '@handover/core';
import { createGitClient, openDb } from '@handover/core';

export function gitClient(): GitClient {
  const e = env as Record<string, string | undefined>;
  const [owner, repo] = (e.GITHUB_REPO ?? '').split('/');
  if (!e.GITHUB_APP_ID || !e.GITHUB_INSTALLATION_ID || !e.GITHUB_PRIVATE_KEY || !owner || !repo) {
    throw new Error(
      'GitHub App is not configured: set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY and GITHUB_REPO (owner/repo) with `wrangler secret put`',
    );
  }
  return createGitClient('default', {
    appId: e.GITHUB_APP_ID,
    installationId: e.GITHUB_INSTALLATION_ID,
    privateKey: e.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
    owner,
    repo,
    branch: e.GITHUB_BRANCH,
  });
}

/**
 * What the Workers Builds API is asked with, or nothing where the site has not been told: build
 * status is optional the way DeepL is, and a site without it simply draws no pill.
 */
export function workerBuilds(): { worker: string; token: string } | undefined {
  const e = env as Record<string, string | undefined>;
  return e.CLOUDFLARE_API_TOKEN && e.CLOUDFLARE_WORKER
    ? { worker: e.CLOUDFLARE_WORKER, token: e.CLOUDFLARE_API_TOKEN }
    : undefined;
}

/**
 * Where the site's uploads live, or nothing where it was never told. Two of the four are not
 * secrets — an account id and a bucket name — so they sit in wrangler.jsonc beside the two that
 * are, and a site with none of them simply has no media.
 */
export function mediaStore(): R2Store | undefined {
  const e = env as Record<string, string | undefined>;
  return e.R2_ACCOUNT_ID && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY
    ? {
        accountId: e.R2_ACCOUNT_ID,
        bucket: e.R2_BUCKET,
        accessKeyId: e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      }
    : undefined;
}

export const NO_BUCKET =
  'No bucket is configured: set R2_ACCOUNT_ID and R2_BUCKET in wrangler.jsonc, and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY with `wrangler secret put`';

export function db(): Db {
  return openDb('default', (env as { DB?: Parameters<typeof openDb>[1] }).DB);
}

/**
 * The one message the admin sends on its own account: proof to whoever pasted the key that it
 * works. It goes to the person who asked for it and to nobody else — a recipient the caller
 * names is a mail relay behind a login — and only an owner may ask, which is what the settings
 * screen it sits on is. Every way it can fail is answered in words the person who configured
 * the mailer can act on rather than as a status.
 */
/**
 * Why there is no mailer, in the words of the thing that has to be set. State 2 of the settings
 * screen is a person who has done half the wiring, so it names the half that is missing rather
 * than reporting that email is off.
 */
export function missingMailer(): string {
  const configured = config.mailer;
  if (!configured || typeof configured === 'function')
    return 'No mailer is configured: add a `mailer` block to cms.config.ts';
  if (configured.provider === 'smtp')
    return 'SMTP_USER and SMTP_PASS are not both set: put them in .dev.vars, or set them with `wrangler secret put`';
  if (configured.provider === 'cloudflare')
    return 'No EMAIL binding: add `"send_email": [{ "name": "EMAIL" }]` to wrangler.jsonc and onboard the sending domain';
  if (configured.provider === 'resend')
    return 'RESEND_API_KEY is not set: put it in .dev.vars, or set it with `wrangler secret put RESEND_API_KEY`';
  return 'No mailer is configured: add a `mailer` block to cms.config.ts';
}
