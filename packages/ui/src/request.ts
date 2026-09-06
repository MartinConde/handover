/** The shell supplies the site base; internal route names stay independent of deployment. */
export const siteBase = () =>
  (document.getElementById('app')?.dataset.base ?? '').replace(/\/+$/, '');
export function localPath(path: string): string {
  const base = siteBase();
  return base && (path === base || path.startsWith(`${base}/`))
    ? path.slice(base.length) || '/'
    : path;
}
export function sitePath(path: string): string {
  const base = siteBase();
  const internal = /^\/(?:admin|_preview)(?:[/?#]|$)/;
  if (base && path.startsWith(base) && internal.test(path.slice(base.length))) return path;
  return internal.test(path) ? base + path : path;
}
export const previewPath = (path: string) => sitePath(`/_preview${localPath(path)}`);

/** Treat a disconnected request like an unavailable server in every existing refusal flow. */
export const request: typeof globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? sitePath(input) : input;
  const call = () =>
    init === undefined ? globalThis.fetch(target) : globalThis.fetch(target, init);
  if (typeof input !== 'string' || !localPath(input).startsWith('/admin/api/')) return call();
  try {
    const response = await call();
    // A body stream can disconnect after fetch has already resolved.
    await response.clone().arrayBuffer();
    return response;
  } catch {
    return new Response('Connection lost. Your changes were kept. Please try again.', {
      status: 503,
    });
  }
};
