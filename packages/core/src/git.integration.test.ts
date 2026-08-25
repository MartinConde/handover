import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import { parseEntry, staleLocales } from './content.js';
import {
  DraftConflictError,
  loadDraft,
  openDb,
  pendingDrafts,
  publishDrafts,
  saveDraft,
} from './db.js';
import { createGitClient, RefMovedError } from './git.js';
import { deleteEntry, renameEntry } from './lifecycle.js';
import type { Form } from './schema.js';
import * as tables from './tables.js';

/**
 * Wait for the contents API to serve what a commit put in a file. It answers from a cache keyed
 * on the branch, so a read straight after a publish can still be the bytes before it — and
 * `saveDraft` and the translation stamp both read through it, so every test here waits for the
 * repository to agree with the commit it just made before doing anything else. It gives up
 * loudly: a timeout here is that cache, and reading it as the assertion below would be wrong.
 */
const serving = async (
  git: { getFile: (path: string) => Promise<{ contents: string } | undefined> },
  path: string,
  mark: string,
) => {
  for (let i = 0; i < 60; i++) {
    if ((await git.getFile(path))?.contents.includes(mark)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`GitHub is still not serving ${mark} in ${path} after 30s`);
};

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
  'publishing two drafts is one commit with both paths and nothing left pending',
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
      await generateSQLiteDrizzleJson({ ...tables }),
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
    // The rows are re-seeded on the commit rather than deleted, so what says they went out is
    // that nothing about them is waiting any more.
    expect(await pendingDrafts('default', db)).toEqual([]);

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
      await generateSQLiteDrizzleJson({ ...tables }),
    );
    await binding.batch(ddl.map((sql) => binding.prepare(sql)));
    const db = openDb('default', binding);

    const name = `it-${(await git.getHead()).slice(0, 7)}`;
    const en = `src/content/listings/en/${name}.yaml`;
    const de = `src/content/listings/de/${name}.yaml`;
    const sourceOf = async (path: string) =>
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
    await serving(git, en, 'A mill.');
    await serving(git, de, 'Eine Mühle.');

    // Somebody translates the German, and the publish writes down which English it came from.
    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine restaurierte Mühle.',
      price: 425000,
    });
    await publishDrafts('default', db, git, sourceOf);
    await serving(git, de, '_i18n:');

    expect((await git.getFile(de))?.contents).toContain('_i18n:');
    expect(await stale()).toEqual([]);

    // The English moves on without it.
    await saveDraft('default', db, git, en, {
      title: `${name} EN`,
      summary: 'A restored mill above the weir.',
      price: 425000,
    });
    await publishDrafts('default', db, git, sourceOf);
    await serving(git, en, 'above the weir');

    expect(await stale()).toEqual(['de']);

    // And the German catches up. The stamp is made from the English the publish reads back, so
    // that read is warmed here rather than left to whatever the cache still holds.
    await serving(git, en, 'above the weir');
    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine restaurierte Mühle am Wehr.',
      price: 425000,
    });
    const caught = await publishDrafts('default', db, git, sourceOf);
    await serving(git, de, 'am Wehr');

    expect(await stale()).toEqual([]);

    await git.publish(
      [en, de].map((path) => ({ path, contents: null })),
      { base_sha: caught?.commit_sha ?? seeded.commit_sha, message: `Clean up after ${name}` },
    );
    await mf.dispose();
  },
  120_000,
);

/**
 * 3.11's four cases, the ones the spec says will not happen by accident in development: a
 * publish that follows your own, a commit that rewrites a file with the bytes it already had,
 * one that changes it, and one that changes something else. A real repository is the only place
 * they mean anything — blob SHAs are git's, and a commit that moves HEAD without moving a file
 * is not something a fake can be trusted to reproduce.
 */
const harness = async () => {
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
    await generateSQLiteDrizzleJson({ ...tables }),
  );
  await binding.batch(ddl.map((sql) => binding.prepare(sql)));
  const parentOf = async (sha: string) => {
    const res = await git.request(`/repos/${app.owner}/${app.repo}/git/commits/${sha}`);
    return ((await res.json()) as { parents: { sha: string }[] }).parents[0]?.sha;
  };
  // GitHub serves the ref and the contents from replicas, so a read straight after a commit can
  // still answer the one before it. These tests wait for it rather than race it: a person's next
  // click is seconds away and none of the four is about that window. What they wait for is what
  // the commit put in the repository, never what the drafts table says about it.
  const settled = async (sha: string) => {
    for (let i = 0; i < 20 && (await git.getHead()) !== sha; i++)
      await new Promise((r) => setTimeout(r, 500));
  };
  return {
    app,
    git,
    db: openDb('default', binding),
    parentOf,
    settled,
    dispose: () => mf.dispose(),
  };
};

const LISTING = (name: string) =>
  `_version: 1\ntitle: "${name}"\nsummary: "A mill."\nprice: 425000\n`;

/**
 * A publish, with the branch read again when the ref update was refused. A ref that has not
 * caught up with the commit before it is the replica lag above and not somebody else's push —
 * one retry tells them apart, and a conflict is never retried, since that is what these tests
 * are about.
 */
const publishing = async (...args: Parameters<typeof publishDrafts>) => {
  try {
    return await publishDrafts(...args);
  } catch (err) {
    if (!(err instanceof RefMovedError)) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return publishDrafts(...args);
  }
};

test.skipIf(!configured)(
  'a publish that follows your own is not a conflict with it',
  async () => {
    const { git, db, parentOf, settled, dispose } = await harness();
    const name = `it-self-${(await git.getHead()).slice(0, 7)}`;
    const en = `src/content/listings/en/${name}.yaml`;
    const de = `src/content/listings/de/${name}.yaml`;
    // The translation is the sequence that bites: the publish stamps the file on its way past,
    // so the bytes in the repository are not the bytes the row was published from.
    const sourceOf = async (path: string) =>
      path === de ? { locale: 'en', path: en, form: TRANSLATED } : undefined;
    const seed = await git.publish(
      [
        { path: en, contents: LISTING(name) },
        { path: de, contents: LISTING(`${name} DE`) },
      ],
      { base_sha: await git.getHead(), message: `Seed ${name}` },
    );
    await settled(seed.commit_sha);
    // Both files: the publish stamps the German with the English it was made from, and an
    // English the contents API has not caught up with is one the stamp is left off for.
    await serving(git, en, `${name}`);
    await serving(git, de, `${name} DE`);

    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine Mühle.',
      price: 425000,
    });
    const first = await publishing('default', db, git, sourceOf);
    await settled(first?.commit_sha ?? '');
    // The publish stamped the German on its way past; the next one reads that file back.
    await serving(git, de, '_i18n:');
    await saveDraft('default', db, git, de, {
      title: `${name} DE`,
      summary: 'Eine restaurierte Mühle.',
      price: 425000,
    });
    const second = await publishing('default', db, git, sourceOf);

    expect(second?.paths).toEqual([de]);
    expect(await parentOf(second?.commit_sha ?? '')).toBe(first?.commit_sha);
    // And the row is on the file as the commit left it, which is what made that true.
    const row = await loadDraft('default', db, de);
    expect(row?.baseSha).toBe(second?.commit_sha);
    expect(row?.baseBlob).toBe((await git.getFile(de))?.blob_sha);

    await git.publish(
      [en, de].map((path) => ({ path, contents: null })),
      { base_sha: second?.commit_sha ?? '', message: `Clean up after ${name}` },
    );
    await dispose();
  },
  120_000,
);

test.skipIf(!configured)(
  'a commit that rewrites the file with identical bytes is not a conflict',
  async () => {
    const { git, db, parentOf, settled, dispose } = await harness();
    const name = `it-same-${(await git.getHead()).slice(0, 7)}`;
    const path = `src/content/listings/en/${name}.yaml`;
    const { commit_sha: seeded } = await git.publish([{ path, contents: LISTING(name) }], {
      base_sha: await git.getHead(),
      message: `Seed ${name}`,
    });
    await settled(seeded);
    await serving(git, path, name);
    await saveDraft('default', db, git, path, {
      title: name,
      summary: 'A restored mill.',
      price: 425000,
    });

    // Somebody commits the same file again — a formatting pass that changed nothing.
    const { commit_sha: reformatted } = await git.publish([{ path, contents: LISTING(name) }], {
      base_sha: seeded,
      message: `Reformat ${name}`,
    });
    await settled(reformatted);
    const published = await publishing('default', db, git);

    // The commit moved and the file did not, which is the whole of the case: the publish went
    // on top of theirs rather than being refused over bytes that never changed.
    expect(reformatted).not.toBe(seeded);
    expect(published?.paths).toEqual([path]);
    expect(await parentOf(published?.commit_sha ?? '')).toBe(reformatted);

    await git.publish([{ path, contents: null }], {
      base_sha: published?.commit_sha ?? '',
      message: `Clean up after ${name}`,
    });
    await dispose();
  },
  120_000,
);

test.skipIf(!configured)(
  'a commit that changed the file is a conflict, and nothing is written',
  async () => {
    const { git, db, settled, dispose } = await harness();
    const name = `it-theirs-${(await git.getHead()).slice(0, 7)}`;
    const path = `src/content/listings/en/${name}.yaml`;
    const { commit_sha: seeded } = await git.publish([{ path, contents: LISTING(name) }], {
      base_sha: await git.getHead(),
      message: `Seed ${name}`,
    });
    await settled(seeded);
    await serving(git, path, name);
    await saveDraft('default', db, git, path, {
      title: name,
      summary: 'A restored mill.',
      price: 425000,
    });
    const loaded = await loadDraft('default', db, path);

    // A developer edits the same file straight in the repository.
    const { commit_sha: theirs } = await git.publish(
      [{ path, contents: LISTING(name).replace('A mill.', 'A mill above the weir.') }],
      { base_sha: seeded, message: `Edit ${name} in code` },
    );
    await settled(theirs);
    // The precondition, not the assertion: the publish below is refused because the blob at HEAD
    // is no longer the one the draft was loaded from, and it can only be refused once the
    // contents API is serving that blob at all.
    await serving(git, path, 'A mill above the weir.');
    await new Promise((r) => setTimeout(r, 1000));
    expect((await git.getFile(path))?.blob_sha).not.toBe(loaded?.baseBlob);
    const caught = await publishing('default', db, git).catch((err) => err);

    expect(caught).toBeInstanceOf(DraftConflictError);
    expect((caught as DraftConflictError).paths).toEqual([path]);
    expect(await git.getHead()).toBe(theirs);
    expect((await git.getFile(path))?.contents).toContain('A mill above the weir.');

    await git.publish([{ path, contents: null }], {
      base_sha: theirs,
      message: `Clean up after ${name}`,
    });
    await dispose();
  },
  120_000,
);

test.skipIf(!configured)(
  'a commit to a different file leaves the publish alone',
  async () => {
    const { app, git, db, settled, dispose } = await harness();
    const name = `it-other-${(await git.getHead()).slice(0, 7)}`;
    const mine = `src/content/listings/en/${name}.yaml`;
    const theirs = `src/content/listings/en/${name}-theirs.yaml`;
    const { commit_sha: seeded } = await git.publish(
      [mine, theirs].map((path) => ({ path, contents: LISTING(name) })),
      { base_sha: await git.getHead(), message: `Seed ${name}` },
    );
    await settled(seeded);
    await serving(git, mine, name);
    await saveDraft('default', db, git, mine, {
      title: name,
      summary: 'A restored mill.',
      price: 425000,
    });

    const { commit_sha: elsewhere } = await git.publish(
      [{ path: theirs, contents: LISTING(name).replace('A mill.', 'Somebody else.') }],
      { base_sha: seeded, message: `Edit ${name}-theirs in code` },
    );
    await settled(elsewhere);
    const published = await publishing('default', db, git);

    expect(published?.paths).toEqual([mine]);
    const res = await git.request(
      `/repos/${app.owner}/${app.repo}/compare/${elsewhere}...${published?.commit_sha}`,
    );
    const diff = (await res.json()) as { total_commits: number; files: { filename: string }[] };
    expect(diff.total_commits).toBe(1);
    expect(diff.files.map((f) => f.filename)).toEqual([mine]);

    await git.publish(
      [mine, theirs].map((path) => ({ path, contents: null })),
      { base_sha: published?.commit_sha ?? '', message: `Clean up after ${name}` },
    );
    await dispose();
  },
  120_000,
);
