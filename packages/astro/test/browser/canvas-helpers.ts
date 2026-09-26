import { type BrowserContext, expect, type Page } from '@playwright/test';

type PreviewData = {
  title?: string;
  summary?: string;
  body?: string;
  legacy?: string;
  button?: { type?: string; href?: string; label?: string };
  blocks?: Record<string, unknown>[];
};

type Target = {
  document: { collection: string; id: string };
  locale: string;
  address: string;
  occurrence?: Target;
};

type PreviewSnapshot = {
  protocol: number;
  requestId: string;
  epoch: string;
  entry: { collection: string; id: string };
  locale: string;
  contentVersion: number;
  snapshots: Record<string, PreviewData>;
};

type RenderResult = Record<string, unknown>;

declare global {
  interface Window {
    canvasLifecycle: {
      render(
        title: string,
        behavior?: string,
        layout?: Record<string, number>,
      ): Promise<RenderResult>;
      schedule(title: string): Promise<RenderResult>;
      interaction(state: Record<string, boolean>): void;
      resize(width: number, height: number): void;
      advance(): void;
    };
    canvasFailNextSave(): void;
    canvasDraftWrites: Array<{
      data?: {
        blocks?: Array<{
          _id?: string;
          columns?: Array<{ _id?: string; blocks?: Array<{ _id?: string }> }>;
        }>;
      };
    }>;
  }
}

export async function loadCanvasScript(page: Page) {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string }>;
  return `/admin/_assets/${entries.canvas?.script ?? ''}`;
}

export async function openLifecycle(page: Page) {
  await page.goto('/canvas-lifecycle');
  await expect(page.locator('html')).toHaveAttribute('data-lifecycle-ready', 'true');
}

// Renders each POSTed snapshot; `body` returns the page markup or an error for the manifest.
export async function serveCanvasPreview(
  page: Page,
  body: (
    data: PreviewData,
    marker: (target: string | Target) => string,
    snapshot: PreviewSnapshot,
  ) => string | { error: { status: number; message: string } },
  {
    pattern = '**/_preview/canvas-fixture',
    shell = '/canvas-shell',
    head = '',
    get,
    routes = page,
  }: {
    pattern?: string;
    shell?: string;
    head?: string;
    get?: () => string;
    routes?: Page | BrowserContext;
  } = {},
) {
  const canvasScript = await loadCanvasScript(page);
  let posts = 0;
  await routes.route(pattern, async (route) => {
    if (get && route.request().method() === 'GET')
      return route.fulfill({ contentType: 'text/html', body: get() });
    posts += 1;
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as PreviewSnapshot;
    const { protocol, requestId, epoch, entry, locale, contentVersion } = snapshot;
    const marker = (target: string | Target) =>
      JSON.stringify(
        typeof target === 'string' ? { document: entry, locale, address: target } : target,
      )
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;');
    const rendered = body(snapshot.snapshots[locale] ?? {}, marker, snapshot);
    const ok = typeof rendered === 'string';
    const manifest = ok
      ? {
          mode: 'canvas',
          status: 'success',
          protocol,
          requestId,
          epoch,
          entry,
          locale,
          contentVersion,
        }
      : {
          mode: 'canvas',
          status: 'error',
          protocol,
          requestId,
          epoch,
          contentVersion,
          error: rendered.error,
        };
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html>${head}<body>${ok ? rendered : ''}<script type="application/json" data-handover-canvas-manifest>${JSON.stringify(manifest).replace(/</g, '\\u003c')}</script>${ok ? `<script type="module" src="${canvasScript}"></script>` : ''}</body></html>`,
    });
  });
  await page.goto(shell);
  return { posts: () => posts };
}

export async function openCanvas(page: Page, query = '') {
  await page.route('**/canvas-fixture-image.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><path fill="#15343a" d="M0 0h1200v800H0z"/><path fill="#d1c5ab" d="M0 550Q500 300 1200 550v250H0z"/></svg>',
    }),
  );
  const escaped = (value = '') =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await serveCanvasPreview(
    page,
    (data, marker) =>
      `<main><section data-hero><h1 data-handover-field='${marker('title')}'>${escaped(data.title)}</h1><img alt="Harbour at dusk" src="/canvas-fixture-image.svg" data-handover-field='${marker('hero')}'/></section><section data-prose data-handover-field='${marker('body')}'><p>${escaped(data.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p></section></main>`,
    {
      pattern: '**/_preview/**',
      shell: `/canvas-shell${query}`,
      head: '<head><style>body{margin:0;background:#f4f0e6;color:#15343a;font:18px/1.6 system-ui}main{padding:48px;max-width:1100px;margin:auto}section[data-hero]{position:relative;isolation:isolate;min-height:240px;margin:0 0 32px;overflow:hidden;color:white}section[data-hero] h1{position:relative;z-index:1;margin:0;padding:32px;font:48px Georgia}section[data-hero] img{position:absolute;z-index:-1;inset:0;width:100%;height:100%;object-fit:cover}section[data-prose]{margin:32px 0}h2{font:36px Georgia}p{margin:16px 0}</style></head>',
    },
  );
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('iframe[data-handover-canvas-frame="active"]')).toBeVisible();
}
