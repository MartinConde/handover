import type { ContentFile } from './entries.js';

export interface GitHubApp {
  appId: string;
  privateKey: string; // PKCS#8 PEM; GitHub's PKCS#1 download needs `openssl pkcs8 -topk8 -nocrypt`
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

/** One commit as a history list needs to know it. */
export interface FileCommit {
  sha: string;
  /** When it was authored, ISO 8601 as GitHub writes it. */
  date: string;
  message: string;
  /** Who git records; absent where the App committed on somebody's behalf. */
  author?: string;
}

/** One language file's page of commits, and whether GitHub still had older ones. */
export interface CommitPage {
  locale: string;
  commits: FileCommit[];
  more: boolean;
  /** The file name the entry had at these commits, where it is not the one it has now. */
  name?: string;
}

/** A commit of one entry: the same commit however many of its language files it touched. */
export interface EntryVersion extends FileCommit {
  locales: string[];
  /** The name the entry's files had at this commit, when it was not the name it has now. */
  name?: string;
}

/** Cut where the shallowest unfinished page ends, or a commit between two pages would be a hole. */
export function mergeFileCommits(pages: CommitPage[]): { versions: EntryVersion[]; more: boolean } {
  const found = new Map<string, EntryVersion>();
  for (const page of pages)
    for (const commit of page.commits) {
      const seen = found.get(commit.sha);
      if (!seen)
        found.set(commit.sha, {
          ...commit,
          locales: [page.locale],
          ...(page.name ? { name: page.name } : {}),
        });
      else if (!seen.locales.includes(page.locale)) seen.locales.push(page.locale);
    }
  const at = (date: string | undefined) => Date.parse(date ?? '') || 0;
  const versions = [...found.values()].sort((a, b) => at(b.date) - at(a.date));
  const ends = pages.filter((p) => p.more).map((p) => at(p.commits.at(-1)?.date));
  if (ends.length === 0) return { versions, more: false };
  const floor = Math.max(...ends);
  return { versions: versions.filter((v) => at(v.date) >= floor), more: true };
}

/** One commit as undoing it needs to know it. */
export interface GitCommit {
  sha: string;
  /** A root commit has no parent or inverse. */
  parent?: string;
  message: string;
  /** Every path it touched, a rename counting as both of its names. */
  paths: string[];
}

export interface GitClient {
  /** Authenticated call against api.github.com; `path` starts with `/`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  getHead(): Promise<string>;
  /** Anything about to write names a `ref`: see the note on the implementation. */
  getFile(path: string, ref?: string): Promise<GitFile | undefined>;
  /** One blob's text by its object id, for bytes no branch names any more. */
  getBlob(sha: string): Promise<string | undefined>;
  /** One request for every file: per-file reads would exhaust the Free plan's fifty subrequests. */
  contentFiles(): Promise<ContentFile[]>;
  /** A caller merging several paths asks each for the same depth — see `mergeFileCommits`. */
  fileCommits(path: string, opts?: { perPage?: number; page?: number }): Promise<FileCommit[]>;
  getCommit(sha: string): Promise<GitCommit>;
  publish(
    files: PublishFile[],
    opts: { base_sha: string; message: string },
  ): Promise<{ commit_sha: string }>;
}

// The branch moved past base_sha between load and publish; the non-force ref update refused it.
export class RefMovedError extends Error {
  override name = 'RefMovedError';
}

// The App cannot reach the repository, so every path answers 404.
export class RepoUnreachableError extends Error {
  override name = 'RepoUnreachableError';
}

const API = 'https://api.github.com';

interface TreeNode {
  entries?: { name: string; object?: TreeNode & { text?: string | null; isTruncated?: boolean } }[];
}

// One level of the GraphQL tree walk: a blob's own text, or the entries below it.
const BLOB = '...on Blob{text isTruncated}';
const level = (depth: number): string =>
  `entries{name object{${BLOB}${depth > 1 ? `...on Tree{${level(depth - 1)}}` : ''}}}`;

function collect(node: TreeNode | undefined, prefix: string, found: ContentFile[]) {
  for (const entry of node?.entries ?? []) {
    const path = `${prefix}${entry.name}`;
    const object = entry.object;
    if (object?.entries) {
      collect(object, `${path}/`, found);
      continue;
    }
    // A folder below the depth an entry may live at would be a file nobody saw, so it is an error.
    if (!object || !('text' in object))
      throw new Error(`${path} is deeper than src/content/<collection>/<locale>/<name>.yaml`);
    if (!path.endsWith('.yaml')) continue;
    // A file cut off would read as one that says nothing.
    if (typeof object.text !== 'string' || object.isTruncated)
      throw new Error(`GitHub would not answer ${path} in full`);
    found.push({ path, contents: object.text });
  }
}

// Decides whether a draft still matches its file without a fetch; the length is bytes, not chars.
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

interface TokenSlot {
  cached?: { token: string; expiresAt: number };
  pending?: Promise<string>;
}

// One shared token per GitHub: a fresh token reads the branch head from a replica seconds behind.
const tokens = new WeakMap<typeof globalThis.fetch, Map<string, TokenSlot>>();

export function createGitClient(
  _siteId: string,
  app: GitHubApp,
  deps: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): GitClient {
  const { fetch = globalThis.fetch, now = Date.now } = deps;
  const perGitHub = tokens.get(fetch) ?? new Map<string, TokenSlot>();
  tokens.set(fetch, perGitHub);
  const slot = perGitHub.get(`${app.appId}/${app.installationId}`) ?? {};
  perGitHub.set(`${app.appId}/${app.installationId}`, slot);

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
    if (slot.cached && slot.cached.expiresAt - now() > 60_000) return slot.cached.token;
    slot.pending ??= (async () => {
      const res = await api(`/app/installations/${app.installationId}/access_tokens`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status}`);
      const body = (await res.json()) as { token: string; expires_at: string };
      slot.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
      return slot.cached.token;
    })().finally(() => {
      slot.pending = undefined;
    });
    return slot.pending;
  }

  const repo = `/repos/${app.owner}/${app.repo}`;
  const branchRef = encodeURIComponent(`heads/${app.branch ?? 'main'}`);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return api(path, init, await token());
  }

  // GitHub answers 404 for a repository outside the installation exactly as for a missing path.
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

    /** ⚠️ Pass `ref` for a read that is written back: branch reads come from a lagging replica. */
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

    /** By id: the source bytes may be many commits back; `undefined` once git has collected it. */
    async getBlob(sha) {
      const res = await request(`${repo}/git/blobs/${encodeURIComponent(sha)}`);
      if (res.status === 404) {
        await assertRepoReachable();
        return undefined;
      }
      if (!res.ok) throw new Error(`GitHub getBlob ${sha} failed: ${res.status}`);
      const body = (await res.json()) as { content: string };
      const bytes = Uint8Array.from(atob(body.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    },

    /** GraphQL makes this one request; three levels because the build refuses deeper paths. */
    async contentFiles() {
      const res = await request('/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){object(expression:$expr){...on Tree{${level(3)}}}}}`,
          variables: {
            owner: app.owner,
            name: app.repo,
            expr: `${app.branch ?? 'main'}:src/content`,
          },
        }),
      });
      if (!res.ok) throw new Error(`GitHub read content failed: ${res.status}`);
      const body = (await res.json()) as {
        data?: { repository?: { object?: TreeNode | null } | null };
        errors?: { message: string }[];
      };
      if (body.errors?.length)
        throw new Error(`GitHub read content failed: ${body.errors[0]?.message}`);
      // A repository outside the installation resolves to nothing, like one with no `src/content/`.
      if (!body.data?.repository) await assertRepoReachable();
      const found: ContentFile[] = [];
      collect(body.data?.repository?.object ?? undefined, 'src/content/', found);
      return found;
    },

    async fileCommits(path, { perPage = 30, page = 1 } = {}) {
      const query = new URLSearchParams({
        path,
        sha: app.branch ?? 'main',
        per_page: String(perPage),
        page: String(page),
      });
      const body = await json<
        {
          sha: string;
          commit: { message: string; author?: { name?: string; date?: string } };
          author: { type?: string } | null;
        }[]
      >(`${repo}/commits?${query}`, {}, 'list commits');
      return body.map((c) => ({
        sha: c.sha,
        date: c.commit.author?.date ?? '',
        message: c.commit.message,
        // A commit the App made carries the App's name, so only a person who pushed is named.
        ...(c.author?.type && c.author.type !== 'Bot' && c.commit.author?.name
          ? { author: c.commit.author.name }
          : {}),
      }));
    },

    async getCommit(sha) {
      const body = await json<{
        sha: string;
        parents: { sha: string }[];
        commit: { message: string };
        files?: { filename: string; previous_filename?: string }[];
      }>(`${repo}/commits/${sha}`, {}, 'read commit');
      return {
        sha: body.sha,
        parent: body.parents[0]?.sha,
        message: body.commit.message,
        // ⚠️ GitHub stops listing files at 300; a commit the admin made is a handful.
        paths: [
          ...new Set(
            (body.files ?? []).flatMap((f) =>
              f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
            ),
          ),
        ],
      };
    },

    // parents: [base_sha] plus a non-force ref update makes a concurrent push fail, not clobber.
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
