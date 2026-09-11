import { expect, type Page, test } from '@playwright/test';

async function openCanvas(page: Page, query = '') {
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
      body: `<!doctype html><html><head><style>body{margin:0;background:#f4f0e6;color:#15343a;font:18px/1.6 system-ui}main{padding:48px;max-width:1100px;margin:auto}h1{font:48px Georgia}img{width:100%;max-height:240px;object-fit:cover}section{margin:32px 0}h2{font:36px Georgia}p{margin:16px 0}</style></head><body><main><h1 data-handover-field='${marker('title')}'>${escaped(data.title)}</h1><img alt="Harbour at dusk" src="/canvas-fixture-image.svg" data-handover-field='${marker('hero')}'/><section data-prose data-handover-field='${marker('body')}'><p>${escaped(data.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p></section></main><script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${script}"></script></body></html>`,
    });
  });
  await page.goto(`/canvas-shell${query}`);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('iframe[data-handover-canvas-frame="active"]')).toBeVisible();
}

test('Canvas fills the viewport and keeps Structure beside a contained media inspector', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openCanvas(page);
  const canvas = page.locator('.canvas-stage');
  await expect
    .poll(async () => {
      const rect = await canvas.boundingBox();
      return rect ? Math.abs(rect.y + rect.height - (1100 - 60)) : 1100;
    })
    .toBeLessThan(20);
  await expect(page.locator('.entry-header')).toBeHidden();
  await expect(page.locator('.canvas-rail')).toBeVisible();
  expect((await page.locator('.canvas-rail').boundingBox())?.y).toBe(0);
  await page.getByRole('treeitem', { name: 'Hero', exact: true }).click();
  const inspector = page.locator('#canvas-inspector');
  await expect(inspector).toBeVisible();
  await expect
    .poll(async () => (await page.locator('.canvas-inspector-slot').boundingBox())?.width ?? 0)
    .toBeGreaterThan(280);
  await expect(inspector.locator('.thumb img')).toBeVisible();
  await expect(page.locator('#canvas-structure')).toBeVisible();
  await expect(page.getByLabel('Alt text')).toHaveValue('Harbour at dusk');
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('desktop-media.png') });
  await page.getByLabel('Alt text').fill('Evening on the coast');
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await expect(page.locator('#canvas-structure')).toBeVisible();
  await page.getByRole('treeitem', { name: 'Hero', exact: true }).click();
  await expect(page.getByLabel('Alt text')).toHaveValue('Evening on the coast');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  await expect(page.locator('#canvas-structure')).toBeHidden();
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Alt text').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('phone-media.png') });
  await page.getByRole('button', { name: 'Structure', exact: true }).click();
  await expect(page.locator('#canvas-structure')).toBeVisible();
  await page.getByRole('treeitem', { name: 'Hero', exact: true }).click();
  await expect(page.getByLabel('Alt text')).toHaveValue('Evening on the coast');
});

test('rich text remains one copy while editing and the toolbar fits a phone canvas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page);
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const prose = frame.locator('[data-prose]');
  await prose.dblclick();
  const editor = frame.getByRole('textbox', { name: 'Rich text in Canvas' });
  await expect(editor).toBeVisible();
  await expect(prose).toHaveText('Room for everyone.');
  await expect(prose.locator('p')).toHaveCount(1);
  await expect(frame.locator('[data-handover-canvas-overlay]').locator('.box')).toHaveCount(1);
  await expect(frame.locator('[data-handover-canvas-overlay]').locator('.path')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('desktop-editing.png') });
  await editor.fill('Room by the coast.');
  await editor.press('Escape');
  await expect(prose).toHaveText('Room by the coast.');
  await prose.dblclick();
  await expect(editor).toHaveText('Room by the coast.');
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await page.getByRole('button', { name: 'Close Structure' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await prose.dblclick();
  const toolbar = frame.getByRole('toolbar', { name: 'Rich text formatting' });
  await expect(toolbar).toBeVisible();
  expect(
    await toolbar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
      );
    }),
  ).toBe(true);
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('phone-editing.png') });
});

test('validation is visible with Inspector closed and Review fields focuses the problem', async ({
  page,
}, testInfo) => {
  await openCanvas(page, '?polish-invalid');
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  const notice = page.locator('.canvas-validation');
  await expect(notice).toContainText('1 field needs attention');
  await expect(notice).toContainText('Enter a page title');
  await page.screenshot({ path: testInfo.outputPath('validation.png') });
  await notice.getByRole('button', { name: 'Review fields' }).click();
  await expect(page.locator('#f-title')).toBeFocused();
});

test('full-screen controls switch viewport and return to form without losing edits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page);
  await page.getByRole('button', { name: 'Phone', exact: true }).click();
  await expect(page.locator('.canvas-stage')).toHaveClass(/is-phone/);
  expect((await page.locator('.canvas-stage').boundingBox())?.width).toBe(390);
  await page.getByRole('button', { name: 'Desktop', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Title', exact: true }).click();
  await page
    .locator('#canvas-inspector')
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('A room by the sea');
  await page.getByRole('button', { name: 'Back to form' }).click();
  await expect(page.locator('.entry-header')).toBeVisible();
  await expect(page.locator('#f-title')).toHaveValue('A room by the sea');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.canvas-identity strong')).toHaveText('A room by the sea');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Publish A room by the sea?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused();
});

test('the compact language selector saves pending edits before changing locale', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page, '?c30');
  await page.getByRole('treeitem', { name: 'Title', exact: true }).click();
  await page
    .locator('#canvas-inspector')
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('English canvas draft');
  await page.locator('.canvas-locale').selectOption('de');
  await expect(page.locator('.canvas-locale')).toHaveValue('de');
  const heading = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Canvas-Testseite');
  await page.locator('.canvas-locale').selectOption('en');
  await expect(heading).toHaveText('English canvas draft');
});
