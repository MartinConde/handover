import { expect, test } from 'vitest';
import { createGitClient, RefMovedError } from './git.js';

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

test.skipIf(!configured)(
  'publish commits exactly one changed path and refuses a stale base_sha',
  async () => {
    const [owner, repo] = (env.GITHUB_REPO ?? '').split('/');
    const app = {
      appId: env.GITHUB_APP_ID ?? '',
      privateKey: (env.GITHUB_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      installationId: env.GITHUB_INSTALLATION_ID ?? '',
      owner: owner ?? '',
      repo: repo ?? '',
      branch: env.GITHUB_BRANCH,
    };
    const git = createGitClient('default', app);
    const path = 'handover-integration-test.txt';
    const base = await git.getHead();

    const { commit_sha } = await git.publish([{ path, contents: `publish test ${base}\n` }], {
      base_sha: base,
      message: `Integration test publish from ${base.slice(0, 7)}`,
    });

    const res = await git.request(
      `/repos/${app.owner}/${app.repo}/compare/${base}...${commit_sha}`,
    );
    const diff = (await res.json()) as { files: { filename: string }[] };
    expect(diff.files.map((f) => f.filename)).toEqual([path]);
    expect((await git.getFile(path))?.contents).toBe(`publish test ${base}\n`);

    await expect(
      git.publish([{ path, contents: 'stale\n' }], { base_sha: base, message: 'stale' }),
    ).rejects.toBeInstanceOf(RefMovedError);
  },
  30_000,
);
