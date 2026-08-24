import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import { parseEntry, staleLocales } from './content.js';
import { drafts, openDb, publishDrafts, saveDraft } from './db.js';
import { createGitClient, RefMovedError } from './git.js';
import { deleteEntry, renameEntry } from './lifecycle.js';
import type { Form } from './schema.js';

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
    const i18n = { locales: ['en', 'de'], defaultLocale: 'en' };
    const loc = { collection: 'listings', route: '/listings/[slug]', i18n };
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

test.skipIf(!configured)(
  'publishing two drafts is one commit with both paths and no rows left behind',
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
    const mf = new Miniflare({
      modules: true,
      script: 'export default {}',
      d1Databases: { DB: ':memory:' },
    });
    const binding = await mf.getD1Database('DB');
    const ddl = await generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      await generateSQLiteDrizzleJson({ drafts }),
    );
    await binding.batch(ddl.map((sql) => binding.prepare(sql)));
    const db = openDb('default', binding);

    const name = `it-${(await git.getHead()).slice(0, 7)}`;
    const paths = [1, 2].map((n) => `src/content/listings/en/${name}-${n}.yaml`);
    const { commit_sha: seeded } = await git.publish(
      paths.map((path) => ({ path, contents: `_version: 1\ntitle: "${name}"\n` })),
      { base_sha: await git.getHead(), message: `Seed ${name}` },
    );
    for (const [i, path] of paths.entries()) {
      await saveDraft('default', db, git, path, { title: `${name} edited ${i}` });
    }

    const published = await publishDrafts('default', db, git);

    expect(published?.paths.toSorted()).toEqual(paths.toSorted());
    const res = await git.request(
      `/repos/${app.owner}/${app.repo}/compare/${seeded}...${published?.commit_sha}`,
    );
    const diff = (await res.json()) as { total_commits: number; files: { filename: string }[] };
    expect(diff.total_commits).toBe(1);
    expect(diff.files.map((f) => f.filename).toSorted()).toEqual(paths.toSorted());
    expect(await db.select().from(drafts)).toEqual([]);

    await git.publish(
      paths.map((path) => ({ path, contents: null })),
      { base_sha: published?.commit_sha ?? '', message: `Clean up after ${name}` },
    );
    await mf.dispose();
  },
  60_000,
);

// The staleness walk on the real thing: the German is a translation of the English as it stood,
// and the English moving on afterwards is what makes it stale — in the file, so a diff shows it.
const TRANSLATED: Form = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['summary'], label: 'Summary', type: 'text', required: false },
    { path: ['price'], label: 'Price', type: 'number', required: true, i18n: 'duplicate' },
  ],
  blocks: {},
};

test.skipIf(!configured)(
  'publishing the source language marks its translation stale, and translating it clears that',
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
    const mf = new Miniflare({
      modules: true,
      script: 'export default {}',
      d1Databases: { DB: ':memory:' },
    });
    const binding = await mf.getD1Database('DB');
    const ddl = await generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      await generateSQLiteDrizzleJson({ drafts }),
    );
    await binding.batch(ddl.map((sql) => binding.prepare(sql)));
    const db = openDb('default', binding);

    const name = `it-${(await git.getHead()).slice(0, 7)}`;
    const en = `src/content/listings/en/${name}.yaml`;
    const de = `src/content/listings/de/${name}.yaml`;
    const sourceOf = (path: string) =>
      path === de ? { locale: 'en', path: en, form: TRANSLATED } : undefined;
    const stale = async () =>
      staleLocales('default', TRANSLATED, {
        en: parseEntry('default', (await git.getFile(en))?.contents ?? ''),
        de: parseEntry('default', (await git.getFile(de))?.contents ?? ''),
      });
    const seeded = await git.publish(
      [
        {
          path: en,
          contents: `_version: 1\ntitle: "${name}"\nsummary: "A mill."\nprice: 425000\n`,
        },
        {
          path: de,
          contents: `_version: 1\ntitle: "${name}"\nsummary: "Eine Mühle."\nprice: 425000\n`,
        },
      ],
      { base_sha: await git.getHead(), message: `Seed ${name}` },
    );

    // Somebody translates the German, and the publish writes down which English it came from.
    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine restaurierte Mühle.',
      price: 425000,
    });
    await publishDrafts('default', db, git, sourceOf);

    expect((await git.getFile(de))?.contents).toContain('_i18n:');
    expect(await stale()).toEqual([]);

    // The English moves on without it.
    await saveDraft('default', db, git, en, {
      title: `${name} EN`,
      summary: 'A restored mill above the weir.',
      price: 425000,
    });
    await publishDrafts('default', db, git, sourceOf);

    expect(await stale()).toEqual(['de']);

    // And the German catches up.
    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine restaurierte Mühle am Wehr.',
      price: 425000,
    });
    const caught = await publishDrafts('default', db, git, sourceOf);

    expect(await stale()).toEqual([]);

    await git.publish(
      [en, de].map((path) => ({ path, contents: null })),
      { base_sha: caught?.commit_sha ?? seeded.commit_sha, message: `Clean up after ${name}` },
    );
    await mf.dispose();
  },
  120_000,
);
