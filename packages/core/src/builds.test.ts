import { expect, test, vi } from 'vitest';
import { commitBuild } from './builds.js';

// The shapes below are a real answer from the deployed demo's worker, trimmed.

const ACCOUNT = '2e4dff78a4af5223c7940d6b41d7c9a7';
const TAG = '1ccd6a35aa294a8fab84992db9f7fcce';
const SHA = '0147c1defa9dd84b07a80bf5bbfcc2ee488d9017';
// When Publish was pressed: the window a commit may go unnamed for runs from here.
const AT = Date.parse('2026-08-25T16:36:00.000Z');
const commit = (at = AT) => ({ sha: SHA, at });
const HOUR = 60 * 60 * 1000;

type Build = {
  status: string;
  build_outcome: string | null;
  created_on: string;
  stopped_on?: string | null;
  build_trigger_metadata: { commit_hash: string };
};
const build = (over: Partial<Build> = {}): Build => ({
  status: 'stopped',
  build_outcome: 'success',
  created_on: '2026-08-25T16:36:24.712Z',
  stopped_on: '2026-08-25T16:37:51.781Z',
  build_trigger_metadata: { commit_hash: SHA },
  ...over,
});

// The service lookup and that tag's builds; `calls` is every URL asked for, in order.
const cloudflare = (builds: Build[], name: string, ok = true) => {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    if (!ok) return new Response('{}', { status: 403 });
    if (url.endsWith(`/workers/services/${name}`))
      return Response.json({ result: { default_environment: { script: { tag: TAG } } } });
    return Response.json({ result: builds });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
};
const worker = (name: string) => ({ worker: `${ACCOUNT}/${name}`, token: 'cf-token' });

test('a commit whose build succeeded is live', async () => {
  const cf = cloudflare([build()], 'w-live');
  expect(await commitBuild(worker('w-live'), commit(), { fetch: cf.fetch })).toEqual({
    commit_sha: SHA,
    state: 'live',
    started_at: Date.parse('2026-08-25T16:36:24.712Z'),
    // What the pill's "Live since 14:02" reads.
    live_at: Date.parse('2026-08-25T16:37:51.781Z'),
  });
});

test('a build that is still running is building', async () => {
  const cf = cloudflare([build({ status: 'running', build_outcome: null })], 'w-running');
  expect((await commitBuild(worker('w-running'), commit(), { fetch: cf.fetch })).state).toBe(
    'building',
  );
});

test('a build that stopped without succeeding has failed', async () => {
  const cf = cloudflare([build({ build_outcome: 'fail' })], 'w-failed');
  expect((await commitBuild(worker('w-failed'), commit(), { fetch: cf.fetch })).state).toBe(
    'failed',
  );
});

// Between the ref update and the build appearing, saying live would put the pill ahead of the site.
test('a commit no build has been made for yet is building', async () => {
  const cf = cloudflare(
    [build({ build_trigger_metadata: { commit_hash: 'f'.repeat(40) } })],
    'w-none',
  );
  expect(
    await commitBuild(worker('w-none'), commit(), { fetch: cf.fetch, now: AT + 60_000 }),
  ).toEqual({ commit_sha: SHA, state: 'building' });
});

test("the builds are asked for by the worker's tag, which its name is looked up for", async () => {
  const cf = cloudflare([build()], 'w-tag');
  await commitBuild(worker('w-tag'), commit(), { fetch: cf.fetch });
  expect(cf.calls).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/services/w-tag`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/builds/workers/${TAG}/builds?per_page=10`,
  ]);
});

test('the tag is looked up once, however often the build is polled', async () => {
  const cf = cloudflare([build()], 'w-once');
  await commitBuild(worker('w-once'), commit(), { fetch: cf.fetch });
  await commitBuild(worker('w-once'), commit(), { fetch: cf.fetch });
  expect(cf.calls.filter((u) => u.includes('/workers/services/'))).toHaveLength(1);
});

// The API's own example abbreviates the hash; the deployed worker answers with all forty.
test('an abbreviated commit hash still matches the commit', async () => {
  const cf = cloudflare(
    [build({ build_trigger_metadata: { commit_hash: SHA.slice(0, 12) } })],
    'w-short',
  );
  expect((await commitBuild(worker('w-short'), commit(), { fetch: cf.fetch })).state).toBe('live');
});

test('an API that refuses is an error rather than a state', async () => {
  const cf = cloudflare([], 'w-403', false);
  await expect(commitBuild(worker('w-403'), commit(), { fetch: cf.fetch })).rejects.toThrow('403');
});

// With no commit of ours to ask about, a blank top bar misreads a perfectly live site.
test('with no commit named it is the worker’s newest build', async () => {
  const cf = cloudflare([build({ status: 'running', build_outcome: null }), build()], 'w-newest');
  expect(await commitBuild(worker('w-newest'), undefined, { fetch: cf.fetch })).toEqual({
    state: 'building',
    started_at: Date.parse('2026-08-25T16:36:24.712Z'),
  });
});

test('a worker nothing has ever built, asked about no commit, is live', async () => {
  const cf = cloudflare([], 'w-never');
  expect(await commitBuild(worker('w-never'), undefined, { fetch: cf.fetch })).toEqual({
    state: 'live',
  });
});

// The list endpoint takes no commit filter.
test('a commit older than the window no build names it reads as the newest build', async () => {
  const cf = cloudflare(
    [build({ build_trigger_metadata: { commit_hash: 'f'.repeat(40) } })],
    'w-stale',
  );
  expect(
    await commitBuild(worker('w-stale'), commit(), { fetch: cf.fetch, now: AT + 16 * HOUR }),
  ).toEqual({
    state: 'live',
    started_at: Date.parse('2026-08-25T16:36:24.712Z'),
    live_at: Date.parse('2026-08-25T16:37:51.781Z'),
  });
});

// A missing newest build must not mark an older commit live.
test('a stale commit on a worker nothing has ever built is building, and bare', async () => {
  const cf = cloudflare([], 'w-stale-never');
  expect(
    await commitBuild(worker('w-stale-never'), commit(), { fetch: cf.fetch, now: AT + 16 * HOUR }),
  ).toEqual({ state: 'building' });
});
