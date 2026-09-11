export type CanvasInteractionMode = 'edit' | 'interact';

export type CanvasNavigationRequest =
  | {
      kind: 'link';
      href: string;
      newTab: boolean;
      download: boolean;
    }
  | {
      kind: 'form';
      href: string;
      method: 'get' | 'post';
    };

export interface CanvasNavigationEntry {
  collection: string;
  path: string;
  locales: string[];
  urls: Record<string, string>;
  index?: true;
}

export interface CanvasNavigationIndex {
  entries: CanvasNavigationEntry[];
  indexes?: CanvasNavigationEntry[];
}

export type CanvasNavigationDestination =
  | {
      kind: 'entry';
      href: string;
      collection: string;
      id: string;
      locale: string;
    }
  | { kind: 'preview'; href: string }
  | { kind: 'external'; href: string };

const normalizedPath = (path: string) => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed || '/';
};

/** Resolve a site link against the real page URL, not its `/_preview` transport URL. */
export function canvasDocumentUrl(value: string | URL): URL {
  const url = new URL(String(value));
  const marker = '/_preview';
  const at = url.pathname.lastIndexOf(marker);
  if (at >= 0) {
    const after = url.pathname[at + marker.length];
    if (after === undefined || after === '/')
      url.pathname = `${url.pathname.slice(0, at)}${url.pathname.slice(at + marker.length) || '/'}`;
  }
  return url;
}

/** Match an exact localized page address from the same index used by Handover's page picker. */
export function classifyCanvasNavigation(
  href: string,
  index: CanvasNavigationIndex,
  origin: string,
): CanvasNavigationDestination {
  const url = new URL(href, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
    return { kind: 'external', href: url.href };

  const wanted = normalizedPath(url.pathname);
  for (const entry of index.entries ?? []) {
    for (const [locale, address] of Object.entries(entry.urls)) {
      const resolved = new URL(address, origin);
      if (resolved.origin !== origin || normalizedPath(resolved.pathname) !== wanted) continue;
      const id = entry.path.slice(entry.collection.length + 1);
      if (id)
        return {
          kind: 'entry',
          href: url.href,
          collection: entry.collection,
          id,
          locale,
        };
    }
  }
  return { kind: 'preview', href: url.href };
}

export interface CanvasNavigationRuntimeOptions {
  root?: Document;
  owner?: Window;
  documentUrl?: string | URL;
  onNavigate: (request: CanvasNavigationRequest) => void;
}

/** Owns browser intents before editing overlays can consume the same pointer event. */
export function createCanvasNavigationRuntime(options: CanvasNavigationRuntimeOptions) {
  const root = options.root ?? document;
  const owner = options.owner ?? window;
  const pageUrl = canvasDocumentUrl(options.documentUrl ?? owner.location.href);
  let disposed = false;

  const link = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const raw = anchor.getAttribute('href');
    if (!raw) return;
    let target: URL;
    try {
      target = new URL(raw, pageUrl);
    } catch {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (target.protocol === 'javascript:' || target.protocol === 'data:') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const hashOnly =
      target.origin === pageUrl.origin &&
      normalizedPath(target.pathname) === normalizedPath(pageUrl.pathname) &&
      target.search === pageUrl.search &&
      Boolean(target.hash);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (hashOnly) {
      owner.location.hash = target.hash;
      return;
    }
    options.onNavigate({
      kind: 'link',
      href: target.href,
      newTab:
        event.button === 1 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        anchor.target.toLowerCase() === '_blank',
      download: anchor.hasAttribute('download'),
    });
  };

  const submit = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const submitter = event.submitter;
    const action =
      submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
        ? (submitter.getAttribute('formaction') ?? form.getAttribute('action') ?? '')
        : (form.getAttribute('action') ?? '');
    const method = (
      submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
        ? submitter.formMethod || form.method
        : form.method
    ).toLowerCase();
    options.onNavigate({
      kind: 'form',
      href: new URL(action || pageUrl.href, pageUrl).href,
      method: method === 'post' ? 'post' : 'get',
    });
  };

  return {
    start() {
      if (disposed) return;
      root.addEventListener('click', link, true);
      root.addEventListener('auxclick', link, true);
      root.addEventListener('submit', submit, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', link, true);
      root.removeEventListener('auxclick', link, true);
      root.removeEventListener('submit', submit, true);
    },
  };
}
