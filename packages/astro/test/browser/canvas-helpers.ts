import { expect, type Page } from '@playwright/test';

export async function openCanvas(page: Page, query = '') {
  await page.goto('/canvas-assets');
  const entries = JSON.parse((await page.locator('body').getAttribute('data-entries')) ?? '{}');
  const script = `/admin/_assets/${entries.canvas.script}`;
  await page.route('**/canvas-fixture-image.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><path fill="#15343a" d="M0 0h1200v800H0z"/><path fill="#d1c5ab" d="M0 550Q500 300 1200 550v250H0z"/></svg>',
    }),
  );
  await page.route('**/_preview/**', async (route) => {
    const snapshot = JSON.parse(
      new URLSearchParams(route.request().postData() ?? '').get('snapshot') ?? '{}',
    );
    const manifest = JSON.stringify({
      mode: 'canvas',
      status: 'success',
      protocol: snapshot.protocol,
      requestId: snapshot.requestId,
      epoch: snapshot.epoch,
      entry: snapshot.entry,
      locale: snapshot.locale,
      contentVersion: snapshot.contentVersion,
    }).replace(/</g, '\\u003c');
    const marker = (address: string) =>
      JSON.stringify({ document: snapshot.entry, locale: snapshot.locale, address }).replace(
        /'/g,
        '&#39;',
      );
    const escaped = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const data = snapshot.snapshots[snapshot.locale];
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>body{margin:0;background:#f4f0e6;color:#15343a;font:18px/1.6 system-ui}main{padding:48px;max-width:1100px;margin:auto}section[data-hero]{position:relative;isolation:isolate;min-height:240px;margin:0 0 32px;overflow:hidden;color:white}section[data-hero] h1{position:relative;z-index:1;margin:0;padding:32px;font:48px Georgia}section[data-hero] img{position:absolute;z-index:-1;inset:0;width:100%;height:100%;object-fit:cover}section[data-prose]{margin:32px 0}h2{font:36px Georgia}p{margin:16px 0}</style></head><body><main><section data-hero><h1 data-handover-field='${marker('title')}'>${escaped(data.title)}</h1><img alt="Harbour at dusk" src="/canvas-fixture-image.svg" data-handover-field='${marker('hero')}'/></section><section data-prose data-handover-field='${marker('body')}'><p>${escaped(data.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p></section></main><script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${script}"></script></body></html>`,
    });
  });
  await page.goto(`/canvas-shell${query}`);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('iframe[data-handover-canvas-frame="active"]')).toBeVisible();
}
