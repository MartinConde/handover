export interface GitHubApp {
  appId: string;
  privateKey: string; // PKCS#8 PEM; GitHub's download is PKCS#1, convert with `openssl pkcs8 -topk8 -nocrypt`
  installationId: string;
  owner: string;
  repo: string;
  branch?: string;
}

export interface GitFile {
  contents: string;
  blob_sha: string;
}

export interface PublishFile {
  path: string;
  /** `null` removes the file from the tree. */
  contents: string | null;
}

export interface GitClient {
  /** Authenticated call against api.github.com; `path` starts with `/`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  getHead(): Promise<string>;
  /**
   * The file as one commit has it, or as the branch does when no commit is named. Anything
   * that is about to **write** names one: see the note on the implementation.
   */
  getFile(path: string, ref?: string): Promise<GitFile | undefined>;
  publish(
    files: PublishFile[],
    opts: { base_sha: string; message: string },
  ): Promise<{ commit_sha: string }>;
}

// The branch moved past base_sha between load and publish; the non-force ref update refused it.
export class RefMovedError extends Error {
  override name = 'RefMovedError';
}

// The App cannot reach the repository at all, so every path answers 404 and no file the
// admin asks for exists as far as GitHub is concerned.
export class RepoUnreachableError extends Error {
  override name = 'RepoUnreachableError';
}

const API = 'https://api.github.com';

// A git object id is a pure function of the bytes: sha1("blob <length>\0" + bytes). Two
// of these decide whether a draft still matches the file it was loaded from, with no
// fetch per file — the length is bytes, so a multibyte character is not one.
export async function blobSha(contents: string): Promise<string> {
  const bytes = new TextEncoder().encode(contents);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function appJwt(app: GitHubApp, nowMs: number): Promise<string> {
  const der = Uint8Array.from(
    atob(app.privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(sig))}`;
}

// One client per request: the installation token is cached on it, never stored anywhere.
export function createGitClient(
  _siteId: string,
  app: GitHubApp,
  deps: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): GitClient {
  const { fetch = globalThis.fetch, now = Date.now } = deps;
  let cached: { token: string; expiresAt: number } | undefined;

  async function api(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
    return fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'astro-handover',
        authorization: token ? `token ${token}` : `Bearer ${await appJwt(app, now())}`,
        ...init.headers,
      },
    });
  }

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - now() > 60_000) return cached.token;
    const res = await api(`/app/installations/${app.installationId}/access_tokens`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return cached.token;
  }

  const repo = `/repos/${app.owner}/${app.repo}`;
  const branchRef = encodeURIComponent(`heads/${app.branch ?? 'main'}`);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return api(path, init, await token());
  }

  // GitHub answers 404 for a repository outside the installation exactly as it does for a
  // missing path, so a 404 only means "no such file" once the repository itself has answered.
  // Asked at most once per client, and never on a path that succeeds.
  let reachable: Promise<boolean> | undefined;
  async function assertRepoReachable(): Promise<void> {
    reachable ??= request(repo).then((res) => res.status !== 404);
    if (!(await reachable))
      throw new RepoUnreachableError(
        `The GitHub App cannot see ${app.owner}/${app.repo}. Add the repository to installation ${app.installationId}, or correct the repository name.`,
      );
  }

  async function json<T>(path: string, init: RequestInit = {}, what: string): Promise<T> {
    const res = await request(path, init);
    if (res.status === 404) await assertRepoReachable();
    if (!res.ok) throw new Error(`GitHub ${what} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    request,

    async getHead() {
      const body = await json<{ object: { sha: string } }>(
        `${repo}/git/ref/${branchRef}`,
        {},
        'getHead',
      );
      return body.object.sha;
    },

    /**
     * ⚠️ **Pass `ref` wherever the answer is going to be written back.** The contents API is
     * served from a replica and cached under the ref it was asked for, so two reads of the
     * branch seconds apart can be two different commits — and a `base_sha` taken beside a blob
     * from an older one is how somebody else's commit is quietly overwritten: the blobs agree,
     * no conflict is reported, and the ref update succeeds because the parent was current. A
     * commit is immutable, so a read of one is the same answer forever and a set of reads at
     * one commit is a snapshot. A read that only shows somebody something can stay on the
     * branch, where being a moment behind costs nothing.
     */
    async getFile(path, ref) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const res = await request(
        `${repo}/contents/${encoded}?ref=${encodeURIComponent(ref ?? app.branch ?? 'main')}`,
      );
      if (res.status === 404) {
        await assertRepoReachable();
        return undefined;
      }
      if (!res.ok) throw new Error(`GitHub getFile ${path} failed: ${res.status}`);
      const body = (await res.json()) as { sha: string; content: string };
      const bytes = Uint8Array.from(atob(body.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      return { contents: new TextDecoder().decode(bytes), blob_sha: body.sha };
    },

    // Text goes inline in the tree, so no blob step. base_tree keeps every unlisted file;
    // parents: [base_sha] plus a non-force ref update is what makes a concurrent push fail
    // here instead of being clobbered.
    async publish(files, { base_sha, message }) {
      const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
      const parent = await json<{ tree: { sha: string } }>(
        `${repo}/git/commits/${base_sha}`,
        {},
        'read base commit',
      );
      const tree = await json<{ sha: string }>(
        `${repo}/git/trees`,
        {
          ...post,
          body: JSON.stringify({
            base_tree: parent.tree.sha,
            tree: files.map((f) => ({
              path: f.path,
              mode: '100644',
              type: 'blob',
              ...(f.contents === null ? { sha: null } : { content: f.contents }),
            })),
          }),
        },
        'create tree',
      );
      const commit = await json<{ sha: string }>(
        `${repo}/git/commits`,
        { ...post, body: JSON.stringify({ message, tree: tree.sha, parents: [base_sha] }) },
        'create commit',
      );
      const res = await request(`${repo}/git/refs/${branchRef}`, {
        ...post,
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      if (res.status === 422)
        throw new RefMovedError(`${app.branch ?? 'main'} moved past ${base_sha}`);
      if (!res.ok) throw new Error(`GitHub update ref failed: ${res.status}`);
      return { commit_sha: commit.sha };
    },
  };
}
