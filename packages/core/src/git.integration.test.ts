import { expect, test } from 'vitest';
import { createGitClient } from './git.js';

// Opt-in: needs a real GitHub App installed on the throwaway repo, see .env.test.example.
try {
  process.loadEnvFile(new URL('../../../.env.test', import.meta.url));
} catch {}
const env = process.env;
const configured = Boolean(
  env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID && env.GITHUB_REPO,
);

test.skipIf(!configured)('getFile reads a file from the throwaway repo', async () => {
  const [owner, repo] = (env.GITHUB_REPO ?? '').split('/');
  const git = createGitClient('default', {
    appId: env.GITHUB_APP_ID ?? '',
    privateKey: (env.GITHUB_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    installationId: env.GITHUB_INSTALLATION_ID ?? '',
    owner: owner ?? '',
    repo: repo ?? '',
    branch: env.GITHUB_BRANCH,
  });

  const file = await git.getFile(env.GITHUB_TEST_PATH ?? 'README.md');

  expect(file?.blob_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(file?.contents.length).toBeGreaterThan(0);
});
