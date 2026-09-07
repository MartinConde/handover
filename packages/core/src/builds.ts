/** Where a commit is between the ref update and the site serving it. */
export type BuildState = 'building' | 'live' | 'failed';

export interface BuildStatus {
  /** The requested commit, or the worker's newest when absent. */
  commit_sha?: string;
  state: BuildState;
  /** Epoch ms the build was created, so the pill can say how long it has been going. */
  started_at?: number;
  /** Epoch ms the build that carried it finished, which is when the site changed. */
  live_at?: number;
}

export interface WorkerBuilds {
  /** `<account_id>/<worker-name>` — the same `owner/repo` shape `GITHUB_REPO` uses. */
  worker: string;
  /** A read-only API token; Workers Scripts: Read is the whole of what this needs. */
  token: string;
}

const API = 'https://api.cloudflare.com/client/v4';

// A tag is the script's, not this Worker's lifetime's, so one lookup covers every poll.
const tags = new Map<string, Promise<string>>();

async function json<T>(url: string, token: string, fetch: typeof globalThis.fetch, what: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Cloudflare ${what} failed: ${res.status}`);
  return (await res.json()) as { result: T };
}

/** ⚠️ Keyed on the worker's tag, not its name: a name answers `200` with an empty list. */
function tagOf(account: string, name: string, token: string, fetch: typeof globalThis.fetch) {
  const key = `${account}/${name}`;
  const found =
    tags.get(key) ??
    json<{ default_environment?: { script?: { tag?: string } } }>(
      `${API}/accounts/${account}/workers/services/${name}`,
      token,
      fetch,
      `worker ${name}`,
    ).then((body) => {
      const tag = body.result.default_environment?.script?.tag;
      if (!tag) throw new Error(`Cloudflare worker ${name} has no script tag`);
      return tag;
    });
  // Cached only once it answers, so a refused lookup is asked again rather than remembered.
  tags.set(key, found);
  found.catch(() => tags.delete(key));
  return found;
}

interface Build {
  status?: string;
  build_outcome?: string | null;
  created_on?: string;
  stopped_on?: string | null;
  build_trigger_metadata?: { commit_hash?: string };
}

/** ⚠️ Covers the build row appearing, not running; past it the commit has scrolled off the page. */
const NAMED_WITHIN = 10 * 60 * 1000;

/** A commit no build names yet is `building`, not live; throws when the account cannot be asked. */
export async function commitBuild(
  builds: WorkerBuilds,
  commit: { sha: string; at: number } | undefined,
  deps: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<BuildStatus> {
  const { fetch = globalThis.fetch, now = Date.now() } = deps;
  const [account = '', name = ''] = builds.worker.split('/');
  const tag = await tagOf(account, name, builds.token, fetch);
  const { result } = await json<Build[]>(
    `${API}/accounts/${account}/builds/workers/${tag}/builds?per_page=10`,
    builds.token,
    fetch,
    'builds',
  );
  const sha = commit?.sha.toLowerCase();
  // The worker gives forty characters but the API's example abbreviates, so the shorter decides.
  const matched = sha
    ? result.find((b) => {
        const hash = b.build_trigger_metadata?.commit_hash?.toLowerCase() ?? '';
        return hash !== '' && (hash.startsWith(sha) || sha.startsWith(hash));
      })
    : undefined;
  // Once the answer is no longer about the commit it is the newest build, first in the list.
  const named = !!commit && (!!matched || now - commit.at <= NAMED_WITHIN);
  const found = named ? matched : result[0];
  const started = found?.created_on ? Date.parse(found.created_on) : undefined;
  // An unbuilt worker is live only when no commit is named; a commit nothing built is building.
  const state: BuildState =
    !found && !commit
      ? 'live'
      : found?.status !== 'stopped'
        ? 'building'
        : found.build_outcome === 'success'
          ? 'live'
          : 'failed';
  const stopped = state === 'live' && found?.stopped_on ? Date.parse(found.stopped_on) : undefined;
  return {
    ...(named && commit ? { commit_sha: commit.sha } : {}),
    state,
    ...(started ? { started_at: started } : {}),
    ...(stopped ? { live_at: stopped } : {}),
  };
}
