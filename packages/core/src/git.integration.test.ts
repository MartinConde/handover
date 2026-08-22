import { expect, test } from 'vitest';
import { createGitClient, RefMovedError } from './git.js';
import { deleteEntry, renameEntry } from './lifecycle.js';

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

test.skipIf(!configured)(
  'rename and delete are one commit each and add exactly one redirect rule',
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
    const loc = { collection: 'listings', route: '/listings/[slug]', locales: ['en', 'de'] };
    const name = `it-${(await git.getHead()).slice(0, 7)}`;
    const redirects = 'src/content/redirects.yaml';
    const compare = async (from: string, to: string) => {
      const res = await git.request(`/repos/${app.owner}/${app.repo}/compare/${from}...${to}`);
      const body = (await res.json()) as {
        total_commits: number;
        files: { filename: string; status: string; previous_filename?: string; patch?: string }[];
      };
      return {
        commits: body.total_commits,
        files: body.files
          .map(
            (f) =>
              `${f.status} ${f.previous_filename ? `${f.previous_filename} -> ` : ''}${f.filename}`,
          )
          .sort(),
        newRules: (body.files.find((f) => f.filename === redirects)?.patch ?? '')
          .split('\n')
          .filter((l) => l.startsWith('+  - _id:')).length,
      };
    };
    const { commit_sha: seeded } = await git.publish(
      [
        {
          path: `src/content/listings/en/${name}.yaml`,
          contents: `_version: 1\ntitle: "${name}"\n`,
        },
      ],
      { base_sha: await git.getHead(), message: `Seed ${name}` },
    );

    const { commit_sha: renamed } = await renameEntry('default', git, loc, name, `${name}-b`);

    expect(await compare(seeded, renamed)).toEqual({
      commits: 1,
      files: [
        `renamed src/content/listings/en/${name}.yaml -> src/content/listings/en/${name}-b.yaml`,
        expect.stringMatching(new RegExp(`^(added|modified) ${redirects}$`)),
      ].sort(),
      newRules: 1,
    });

    const { commit_sha: deleted } = await deleteEntry('default', git, loc, `${name}-b`, '/');

    expect(await compare(renamed, deleted)).toEqual({
      commits: 1,
      files: [`modified ${redirects}`, `removed src/content/listings/en/${name}-b.yaml`],
      newRules: 1,
    });

    await git.publish([{ path: redirects, contents: null }], {
      base_sha: deleted,
      message: `Clean up after ${name}`,
    });
  },
  60_000,
);
