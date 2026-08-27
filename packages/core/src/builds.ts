/** Where a commit is between the ref update and the site serving it. */
export type BuildState = 'building' | 'live' | 'failed';

export interface BuildStatus {
  /** The commit asked about. Absent when this is simply the worker's newest build. */
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

// Worker name → script tag. A tag is a property of the script rather than of this Worker's
// lifetime, so one lookup covers every poll an isolate serves.
const tags = new Map<string, Promise<string>>();

async function json<T>(url: string, token: string, fetch: typeof globalThis.fetch, what: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Cloudflare ${what} failed: ${res.status}`);
  return (await res.json()) as { result: T };
}

/**
 * ⚠️ The builds endpoint is keyed on the worker's **tag**, not its name: a name answers `200`
 * with an empty list, so every commit would read as one no build was ever made for. The tag is
 * not something the dashboard shows, so the config asks for the name and this looks it up.
 */
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

/**
 * ⚠️ How long a commit no build names may still read as `building`. It covers the build row
 * **appearing** — half a minute on the deployed demo — and not the build running, which the row
 * itself then reports. Past it the commit has not gone unbuilt: it has scrolled off the one page
 * that can be asked for, and a pill that keeps counting is how one reached sixteen hours.
 */
const NAMED_WITHIN = 10 * 60 * 1000;

/**
 * What the host has done with one commit. **A commit no build names yet is `building`**, not
 * unknown and certainly not live: there is a window between the ref update and the build
 * appearing, and a pill that says Live in it is a minute ahead of the site. That window is
 * `NAMED_WITHIN` long — the list endpoint takes no commit filter, so a commit older than the ten
 * builds asked for cannot be told from one nothing has built yet, and past the window the
 * likelier of the two is the one the site is already serving.
 *
 * With **no commit named**, and past the window, it is the worker's newest build instead — what
 * the site is serving on a site the admin has never published on, where there is no commit of
 * ours to ask about and a blank top bar would be the only reading of a perfectly live site. The
 * answer carries no `commit_sha` then, which is what stops the counter running from the commit.
 *
 * Throws when the account cannot be asked at all — that is the site's configuration and not a
 * state the site is in, so it is not one of the three.
 */
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
  // The deployed worker answers with all forty characters; the API's own example abbreviates,
  // so the shorter of the two decides.
  const matched = sha
    ? result.find((b) => {
        const hash = b.build_trigger_metadata?.commit_hash?.toLowerCase() ?? '';
        return hash !== '' && (hash.startsWith(sha) || sha.startsWith(hash));
      })
    : undefined;
  // Whether the answer is still about the commit. Once it is not, it is the newest build —
  // first in the list — the same one a site that has published nothing gets.
  const named = !!commit && (!!matched || now - commit.at <= NAMED_WITHIN);
  const found = named ? matched : result[0];
  const started = found?.created_on ? Date.parse(found.created_on) : undefined;
  // `status` is where the build got to and `build_outcome` is what it decided; only both
  // together are green. Everything the API can be running is one word to an editor.
  // With no commit named there is nothing waiting on a build, so a worker that has never been
  // built at all is live rather than building — but one asked about a commit is not: falling
  // through to a build that does not exist would call a commit live that nothing has built.
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
