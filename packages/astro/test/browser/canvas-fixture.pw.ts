import { expect, test } from '@playwright/test';

test('the built integration renders the Canvas fixture', async ({ page }) => {
  const editingAssets: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/admin/_assets/')) editingAssets.push(url.pathname);
  });
  await page.goto('/canvas-fixture');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Canvas fixture');
  await expect(page.locator('[data-nested-list] [data-repeated-heading]')).toHaveCount(2);
  await expect(page.locator('[data-empty-list]')).toHaveCount(1);
  await expect(page.locator('[data-shared-promo]')).toHaveText('Shared English promotion');

  const styledBlock = page.locator('[data-fixture-block]').first();
  await expect(styledBlock).toHaveCSS('border-left-width', '4px');

  const island = page.locator('[data-client-island]');
  await expect(island).toHaveText('Island count 0');
  await expect(island).toHaveAttribute('data-hydrated', 'true');
  await island.click();
  await expect(island).toHaveText('Island count 1');
  await expect(page.locator('[data-handover-canvas-manifest]')).toHaveCount(0);
  await expect(
    page.locator('[data-handover-field], [data-handover-list], [data-handover-block]'),
  ).toHaveCount(0);
  expect(editingAssets).toEqual([]);

  await page.goto('/de/canvas-fixture');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Canvas-Testseite');
});

test('the built UI selects one entry while every split asset remains servable', async ({
  page,
  request,
}) => {
  await page.route('**/admin/api/ping', (route) => route.fulfill({ status: 401, body: '' }));
  await page.goto('/admin');
  const adminScripts = await page
    .locator('script[type="module"]')
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src));
  const adminStyles = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  const adminResources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name),
  );

  await page.goto('/canvas-assets');
  const body = page.locator('body');
  const entries = JSON.parse((await body.getAttribute('data-entries')) ?? '{}') as Record<
    string,
    { script: string; styles: string[] }
  >;
  const files = JSON.parse((await body.getAttribute('data-files')) ?? '[]') as string[];
  const assetUrl = (file: string) => new URL(`/admin/_assets/${file}`, page.url()).href;

  expect(adminScripts).toEqual([assetUrl(entries.admin?.script ?? '')]);
  expect(adminStyles).toEqual((entries.admin?.styles ?? []).map(assetUrl));
  expect(adminScripts).not.toContain(assetUrl(entries.canvas?.script ?? ''));
  expect(adminResources).not.toContain(assetUrl(entries.canvas?.script ?? ''));

  const canvasScripts = await page
    .locator('script[type="module"]')
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src));
  expect(canvasScripts).toEqual([assetUrl(entries.canvas?.script ?? '')]);
  expect(canvasScripts).not.toContain(assetUrl(entries.admin?.script ?? ''));
  const loaded = await page.evaluate(async (script) => {
    const canvas = await import(script);
    const editor = await canvas.loadCanvasRichTextEditor();
    return {
      editor: typeof editor.createCanvasRichTextRuntime === 'function',
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    };
  }, canvasScripts[0] ?? '');
  expect(loaded.editor).toBe(true);
  expect(loaded.resources).not.toContain(assetUrl(entries.admin?.script ?? ''));

  for (const file of files) {
    const response = await request.get(`/admin/_assets/${file}`);
    expect(response.ok(), `${file} should resolve`).toBe(true);
    expect(response.headers()['content-type']).toContain(
      file.endsWith('.css') ? 'text/css' : 'text/javascript',
    );
  }
});

test('fresh POST candidates promote without polluting Back/Forward and failures retain the active page', async ({
  page,
}) => {
  await page.goto('/canvas-lifecycle');
  await expect(page.locator('html')).toHaveAttribute('data-lifecycle-ready', 'true');

  const render = (title: string, behavior = 'success') =>
    page.evaluate(
      ({ title, behavior }) =>
        (
          window as unknown as {
            canvasLifecycle: {
              render(title: string, behavior: string): Promise<Record<string, unknown>>;
            };
          }
        ).canvasLifecycle.render(title, behavior),
      { title, behavior },
    );

  await page.evaluate(() => history.pushState({}, '', '?point=after'));
  const first = await render('First candidate');
  expect(first).toMatchObject({ ok: true, contentVersion: 1 });
  const firstFrame = page.locator('iframe[data-handover-canvas-frame="active"]');
  await expect(firstFrame).toHaveCount(1);
  await expect(firstFrame).not.toHaveAttribute('style', /display\s*:\s*none/);
  await expect(firstFrame.contentFrame().locator('body')).toHaveAttribute('data-method', 'POST');
  await expect(firstFrame.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'First candidate',
  );
  const firstName = await firstFrame.getAttribute('name');

  const second = await render('Second candidate');
  expect(second).toMatchObject({ ok: true, contentVersion: 2 });
  await expect(firstFrame).toHaveCount(1);
  await expect(firstFrame.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Second candidate',
  );
  expect(await firstFrame.getAttribute('name')).not.toBe(firstName);
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(0);

  await page.goBack();
  expect(new URL(page.url()).search).toBe('');
  await page.goForward();
  expect(new URL(page.url()).search).toBe('?point=after');

  const invalid = await render('Invalid candidate', 'invalid');
  expect(invalid).toMatchObject({
    ok: false,
    reason: 'render',
    status: 422,
    message: 'The fixture snapshot is invalid.',
  });
  await expect(firstFrame.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Second candidate',
  );
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.locator('#canvas-state')).toHaveAttribute('data-phase', 'failed');

  const stale = render('Obsolete candidate', 'slow');
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { canvasLifecycle: { advance(): void } }).canvasLifecycle.advance(),
  );
  expect(await stale).toMatchObject({ ok: false, reason: 'stale' });
  await expect(firstFrame.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Second candidate',
  );
  await expect(page.locator('iframe')).toHaveCount(1);

  const failedBootstrap = await render('Never ready', 'bootstrap-failure');
  expect(failedBootstrap).toMatchObject({ ok: false, reason: 'timeout' });
  await expect(firstFrame.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Second candidate',
  );
  await expect(page.locator('iframe')).toHaveCount(1);
});

test('scheduled renders coalesce, discard late results, and restore live Canvas context', async ({
  page,
}) => {
  await page.goto('/canvas-lifecycle');
  await expect(page.locator('html')).toHaveAttribute('data-lifecycle-ready', 'true');
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/canvas-candidate')
      posts += 1;
  });

  const coalesced = await page.evaluate(() => {
    const lifecycle = (
      window as unknown as {
        canvasLifecycle: {
          schedule(title: string): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle;
    return Promise.all([
      lifecycle.schedule('Coalesced one'),
      lifecycle.schedule('Coalesced two'),
      lifecycle.schedule('Coalesced latest'),
    ]);
  });
  expect(coalesced).toHaveLength(3);
  expect(coalesced.every((result) => result.ok && result.contentVersion === 3)).toBe(true);
  expect(posts).toBe(1);
  const active = page.locator('iframe[data-handover-canvas-frame="active"]');
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Coalesced latest',
  );

  const late = page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          render(title: string, behavior: string): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle.render('Late obsolete result', 'late'),
  );
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(1);
  const latest = page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          schedule(title: string): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle.schedule('Latest while rendering'),
  );
  expect(await late).toMatchObject({ ok: false, reason: 'superseded' });
  expect(await latest).toMatchObject({ ok: true, contentVersion: 5 });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Latest while rendering',
  );
  await expect(page.locator('iframe')).toHaveCount(1);

  await page.evaluate(() => {
    const lifecycle = (
      window as unknown as {
        canvasLifecycle: {
          interaction(state: Record<string, boolean>): void;
        };
      }
    ).canvasLifecycle;
    lifecycle.interaction({
      inlineEditing: true,
      composing: true,
      dragging: true,
    });
  });
  const deferred = page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          render(title: string, behavior: string): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle.render('Deferred promotion', 'slow'),
  );
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(1);
  await page.waitForTimeout(250);
  await active
    .contentFrame()
    .getByRole('heading', { level: 1 })
    .evaluate((heading) => {
      heading.textContent = 'Inline edit remains live';
    });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Inline edit remains live',
  );
  await page.evaluate(() => {
    const lifecycle = (
      window as unknown as {
        canvasLifecycle: { interaction(state: Record<string, boolean>): void };
      }
    ).canvasLifecycle;
    lifecycle.interaction({ inlineEditing: false });
    lifecycle.interaction({ composing: false });
  });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Inline edit remains live',
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: { interaction(state: Record<string, boolean>): void };
      }
    ).canvasLifecycle.interaction({ dragging: false }),
  );
  expect(await deferred).toMatchObject({ ok: true, contentVersion: 6 });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Deferred promotion',
  );

  await page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          render(
            title: string,
            behavior: string,
            layout: Record<string, number>,
          ): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle.render('Scrollable baseline', 'success', {
      before: 700,
      between: 500,
      after: 800,
    }),
  );
  const baselineTop = await active
    .contentFrame()
    .getByRole('heading', { level: 1 })
    .evaluate((heading) => {
      heading.scrollIntoView({ block: 'center' });
      return heading.getBoundingClientRect().top;
    });
  await page.locator('#inspector-control').focus();
  const resized = page.evaluate(() => {
    const lifecycle = (
      window as unknown as {
        canvasLifecycle: {
          render(
            title: string,
            behavior: string,
            layout: Record<string, number>,
          ): Promise<Record<string, unknown>>;
          resize(width: number, height: number): void;
        };
      }
    ).canvasLifecycle;
    const result = lifecycle.render('Restored context', 'slow', {
      before: 1100,
      between: 300,
      after: 1200,
    });
    lifecycle.resize(500, 250);
    return result;
  });
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(1);
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveJSProperty(
    'clientWidth',
    500,
  );
  expect(await resized).toMatchObject({ ok: true, contentVersion: 8 });
  await expect(page.locator('#inspector-control')).toBeFocused();
  await expect(active).toHaveJSProperty('clientWidth', 500);
  await expect(active).toHaveJSProperty('clientHeight', 250);
  const restoredTop = await active
    .contentFrame()
    .getByRole('heading', { level: 1 })
    .evaluate((heading) => heading.getBoundingClientRect().top);
  expect(Math.abs(restoredTop - baselineTop)).toBeLessThan(3);

  // Scrolling away from a selection must survive the asynchronous restoration message.
  await active.contentFrame().getByRole('heading', { level: 1 }).click();
  await expect(page.locator('#selection-state')).toHaveJSProperty('value', 'field:title');
  const scrolledTop = await active.evaluate((iframe: HTMLIFrameElement) => {
    iframe.contentWindow?.scrollTo({ top: 1450, behavior: 'instant' });
    return iframe.contentWindow?.scrollY ?? 0;
  });
  expect(scrolledTop).toBeGreaterThan(1000);
  await page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          render(title: string, behavior: string, layout: Record<string, number>): Promise<unknown>;
        };
      }
    ).canvasLifecycle.render('Keep the viewport', 'success', {
      before: 1100,
      between: 300,
      after: 1200,
    }),
  );
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Keep the viewport',
  );
  await page.waitForTimeout(250);
  expect(await active.evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow?.scrollY)).toBe(
    scrolledTop,
  );
});

test('Canvas selection follows explicit nested annotations, repeated roots, empty lists, and the keyboard', async ({
  page,
}) => {
  await page.goto('/canvas-lifecycle');
  await expect(page.locator('html')).toHaveAttribute('data-lifecycle-ready', 'true');
  await page.evaluate(() =>
    (
      window as unknown as {
        canvasLifecycle: {
          render(title: string, behavior: string): Promise<Record<string, unknown>>;
        };
      }
    ).canvasLifecycle.render('Selection fixture', 'selection'),
  );
  const active = page.locator('iframe[data-handover-canvas-frame="active"]');
  const frame = active.contentFrame();
  await expect(frame.locator('[data-handover-canvas-overlay]')).toHaveCount(1);
  await expect(page.locator('#selection-structure button')).toHaveCount(12);
  await expect(
    page.locator('#selection-structure button[data-target-address="blocks[_id=repeat01].heading"]'),
  ).toHaveText('Heading · 2 occurrences');
  await expect(
    page.locator(
      '#selection-structure button[data-target-address="blocks[_id=columns1].columns[_id=column02].blocks"]',
    ),
  ).toHaveText('Blocks · Empty');

  const repeated = frame.locator('[data-repeated-heading]');
  await repeated.nth(1).hover();
  expect(
    await frame.locator('[data-handover-canvas-overlay]').evaluate((host) => ({
      hover: host.shadowRoot?.querySelectorAll('.box.hover').length,
      path: host.shadowRoot?.querySelector('.path')?.textContent,
    })),
  ).toMatchObject({ hover: 1, path: expect.stringContaining('2 occurrences') });

  await repeated.nth(1).click();
  await expect(page.locator('#selection-state')).toHaveText('field:blocks[_id=repeat01].heading');
  await expect
    .poll(() =>
      frame
        .locator('[data-handover-canvas-overlay]')
        .evaluate((host) => host.shadowRoot?.querySelectorAll('.box.selected').length ?? 0),
    )
    .toBe(2);

  await frame.locator('.unsupported-region').click();
  await expect(page.locator('#selection-state')).toHaveText('field:blocks[_id=repeat01].heading');

  await frame.locator('[data-empty-list]').click();
  await expect(page.locator('#selection-state')).toHaveText(
    'list:blocks[_id=columns1].columns[_id=column02].blocks',
  );

  await frame.locator('[data-selection-block="first"]').click({ position: { x: 6, y: 6 } });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#selection-state')).toHaveText('block:blocks[_id=columns1]');

  await frame.locator('[data-nested-heading]').click();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('#selection-state')).toHaveText(
    'block:blocks[_id=columns1].columns[_id=column01].blocks[_id=repeat02]',
  );

  await active.evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow?.scrollTo(0, 0));
  await page
    .locator(
      '#selection-structure button[data-target-address="blocks[_id=columns1].columns[_id=column01].blocks[_id=repeat02].heading"]',
    )
    .click();
  await expect
    .poll(() => active.evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow?.scrollY ?? 0))
    .toBeGreaterThan(500);
});

test('50 and 200 block Canvas fixtures stay within the local render and overlay budgets', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'C32 performance measurements run in Chromium.');
  await page.goto('/canvas-lifecycle');
  await expect(page.locator('html')).toHaveAttribute('data-lifecycle-ready', 'true');
  const render = (count: number) =>
    page.evaluate(async (blocks) => {
      const started = performance.now();
      const result = await (
        window as unknown as {
          canvasLifecycle: {
            render(
              title: string,
              behavior: string,
              layout: { count: number },
            ): Promise<Record<string, unknown>>;
          };
        }
      ).canvasLifecycle.render(`${blocks} block fixture`, 'performance', { count: blocks });
      return { elapsed: performance.now() - started, result };
    }, count);

  const typical: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const measured = await render(50);
    expect(measured.result).toMatchObject({ ok: true });
    typical.push(measured.elapsed);
  }
  const stress = await render(200);
  expect(stress.result).toMatchObject({ ok: true });
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await expect(frame.locator('[data-performance-block]')).toHaveCount(200);

  const overlayFrames = await frame.locator('body').evaluate(async () => {
    const measured: number[] = [];
    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      nativeFrame((time) => {
        const started = performance.now();
        callback(time);
        measured.push(performance.now() - started);
      });
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-performance-block]'));
    for (const index of [0, 49, 99, 149, 199]) {
      const block = blocks[index];
      block?.scrollIntoView({ block: 'center' });
      block?.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 120 }),
      );
      await new Promise<void>((resolve) => nativeFrame(() => resolve()));
    }
    window.requestAnimationFrame = nativeFrame;
    return measured;
  });
  const percentile = (values: number[], ratio: number) =>
    [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
  const metrics = {
    typicalP95: percentile(typical, 0.95),
    stressRender: stress.elapsed,
    overlayP95: percentile(overlayFrames, 0.95),
    overlayMax: Math.max(0, ...overlayFrames),
  };
  console.log(`C32 Canvas performance ${JSON.stringify(metrics)}`);
  expect(metrics.typicalP95).toBeLessThan(1500);
  expect(metrics.overlayP95).toBeLessThan(16);
});

test('the narrow editor shell switches panes without losing its working snapshot', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/canvas-shell');

  const title = page.getByLabel('Title');
  await expect(title).toHaveValue('Canvas fixture');
  await title.fill('Unsaved narrow edit');

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.shell')).toHaveClass(/is-canvas/);
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await expect(title).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Unsaved narrow edit');

  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const panes = page.getByRole('group', { name: 'Split view pane' });
  await expect(panes).toBeVisible();
  await panes.getByRole('button', { name: 'Page' }).click();
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await expect(page.getByLabel('Title')).not.toBeVisible();
  await panes.getByRole('button', { name: 'Form' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Unsaved narrow edit');
});

test('Canvas mediates Interact links through saves, new sessions, previews, and history', async ({
  page,
  context,
}) => {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string }>;
  const canvasScript = `/admin/_assets/${entries.canvas?.script ?? ''}`;
  let previewGets = 0;
  let canvasPosts = 0;
  await context.route('**/_preview/**', async (route) => {
    if (route.request().method() === 'GET') {
      previewGets += 1;
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Ordinary preview</title><p>Ordinary GET preview</p>',
      });
      return;
    }
    canvasPosts += 1;
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as {
      protocol: number;
      requestId: string;
      epoch: string;
      entry: { collection: string; id: string };
      locale: string;
      contentVersion: number;
      snapshots: Record<
        string,
        { title?: string; button?: { type?: string; href?: string; label?: string } }
      >;
    };
    const marker = JSON.stringify({
      document: snapshot.entry,
      locale: snapshot.locale,
      address: 'title',
    })
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;');
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
    const title = snapshot.snapshots[snapshot.locale]?.title ?? '';
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><nav><a data-next href="/second">Second page</a><a data-new href="/second" target="_blank">Second preview</a><a data-hash href="#details">Details</a></nav><h1 data-handover-field='${marker}'>${title}</h1><div style="height:1000px"></div><h2 id="details">Details</h2><script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${canvasScript}"></script></body></html>`,
    });
  });

  await page.goto('/canvas-shell');
  await page.evaluate(() => history.replaceState({}, '', '/admin/c/pages/canvas-fixture'));
  await page.getByLabel('Title').fill('Saved before navigation');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  let frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Saved before navigation');

  await frame.locator('[data-next]').click();
  await expect(page.locator('.canvas-navigation-notice')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/c/pages/canvas-fixture');

  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Structure', exact: true })).toBeDisabled();
  expect(
    await frame.locator('[data-handover-canvas-overlay]').evaluate((host) => ({
      boxes: host.shadowRoot?.querySelectorAll('.box').length ?? -1,
      pathHidden: (host.shadowRoot?.querySelector('.path') as HTMLElement | null)?.hidden,
    })),
  ).toEqual({ boxes: 0, pathHidden: true });

  await page.evaluate(() =>
    (window as unknown as { canvasFailNextSave: () => void }).canvasFailNextSave(),
  );
  await frame.locator('[data-next]').click();
  await expect(page.locator('.canvas-navigation-notice')).toContainText('Navigation stopped');
  expect(new URL(page.url()).pathname).toBe('/admin/c/pages/canvas-fixture');
  await page.getByRole('button', { name: 'Dismiss' }).click();

  await frame.locator('[data-next]').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/c/pages/second');
  frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Second page');
  expect(canvasPosts).toBeGreaterThanOrEqual(2);

  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/c/pages/canvas-fixture');
  frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Canvas fixture');
  await page.goForward();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/c/pages/second');
  await page.goBack();

  frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await frame.locator('[data-hash]').click();
  await expect
    .poll(() =>
      page
        .locator('iframe[data-handover-canvas-frame="active"]')
        .evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow?.location.hash ?? ''),
    )
    .toBe('#details');
  expect(new URL(page.url()).pathname).toBe('/admin/c/pages/canvas-fixture');

  await frame.locator('[data-new]').click();
  await expect(page.locator('.canvas-navigation-notice')).toContainText('normal preview');
  const popupPromise = page.waitForEvent('popup');
  await page
    .locator('.canvas-navigation-notice')
    .getByRole('button', { name: 'Open preview' })
    .click();
  const popup = await popupPromise;
  await expect(popup.getByText('Ordinary GET preview')).toBeVisible();
  expect(previewGets).toBe(1);
});

test('Canvas Inspector and acknowledged plain-text editing share the entry session', async ({
  page,
}) => {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string; styles: string[] }>;
  const canvasScript = `/admin/_assets/${entries.canvas?.script ?? ''}`;
  await page.route('**/_preview/canvas-fixture', async (route) => {
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as {
      protocol: number;
      requestId: string;
      epoch: string;
      entry: { collection: string; id: string };
      locale: string;
      contentVersion: number;
      snapshots: Record<
        string,
        { title?: string; button?: { type?: string; href?: string; label?: string } }
      >;
    };
    const target = JSON.stringify({
      document: snapshot.entry,
      locale: snapshot.locale,
      address: 'title',
    })
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;');
    const buttonTarget = JSON.stringify({
      document: snapshot.entry,
      locale: snapshot.locale,
      address: 'button',
    })
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;');
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
    const title = snapshot.snapshots[snapshot.locale]?.title ?? '';
    const button = snapshot.snapshots[snapshot.locale]?.button;
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1 data-handover-field='${target}'>${title}</h1>${button ? `<a data-handover-field='${buttonTarget}' href="${button.href ?? '#'}">${button.label ?? ''}</a>` : ''}<script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${canvasScript}"></script></body></html>`,
    });
  });
  await page.goto('/canvas-shell');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();

  const inlineHeading = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('heading', { level: 1 });
  await inlineHeading.click();
  await inlineHeading.dblclick();
  await expect(inlineHeading).toHaveAttribute('contenteditable', 'true');
  await inlineHeading.evaluate((element) => {
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    element.dispatchEvent(before);
    element.textContent = 'Typed in Canvas';
    const input = new Event('input', { bubbles: true });
    Object.defineProperty(input, 'inputType', { value: 'insertText' });
    element.dispatchEvent(input);
  });
  await expect(inlineHeading).toHaveText('Typed in Canvas');
  const textStatus = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .locator('[data-handover-canvas-text-status]');
  await expect(textStatus).toHaveAttribute('data-handover-canvas-text-version', /\d+/);
  const typedVersion = Number(await textStatus.getAttribute('data-handover-canvas-text-version'));

  await inlineHeading.evaluate((element) => {
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', ' <b>as plain text</b>');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: data });
    element.dispatchEvent(paste);
  });
  await expect(inlineHeading).toHaveText('Typed in Canvas <b>as plain text</b>');
  await expect(inlineHeading.locator('b')).toHaveCount(0);
  await expect
    .poll(async () => Number(await textStatus.getAttribute('data-handover-canvas-text-version')))
    .toBeGreaterThan(typedVersion);
  const pastedVersion = Number(await textStatus.getAttribute('data-handover-canvas-text-version'));

  await inlineHeading.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.textContent = '日本語の見出し';
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '日本語の見出し',
        inputType: 'insertCompositionText',
      }),
    );
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '日本語の見出し' }),
    );
  });
  await expect(inlineHeading).toHaveText('日本語の見出し');
  await expect
    .poll(async () => Number(await textStatus.getAttribute('data-handover-canvas-text-version')))
    .toBeGreaterThan(pastedVersion);
  await inlineHeading.evaluate((element) => {
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'inputType', { value: 'historyUndo' });
    element.dispatchEvent(event);
  });
  await expect(inlineHeading).toHaveText('Typed in Canvas <b>as plain text</b>');
  await inlineHeading.evaluate((element) => {
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'inputType', { value: 'historyRedo' });
    element.dispatchEvent(event);
  });
  await expect(inlineHeading).toHaveText('日本語の見出し');
  await page.keyboard.press('Escape');
  await expect(inlineHeading).not.toHaveAttribute('contenteditable');

  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await expect(page.locator('#f-title')).toHaveValue('日本語の見出し');

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.canvas-render-state')).toHaveText('Canvas updated');
  const inspectedHeading = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('heading', { level: 1 });
  await inspectedHeading.click();
  const inspectorButton = page.getByRole('button', { name: 'Inspector', exact: true });
  await expect(inspectorButton).toBeEnabled();
  if ((await inspectorButton.getAttribute('aria-expanded')) !== 'true')
    await inspectorButton.click();
  const inspector = page.locator('#canvas-inspector');
  await expect(inspector.getByLabel('Title')).toHaveValue('日本語の見出し');
  await inspector.getByLabel('Title').fill('Edited through Inspector');
  await inspector.getByLabel('Title').dispatchEvent('change');
  await expect(
    page
      .locator('iframe[data-handover-canvas-frame="active"]')
      .contentFrame()
      .getByRole('heading', { level: 1 }),
  ).toHaveText('Edited through Inspector');
  await inspector.getByRole('button', { name: 'Close Inspector' }).click();

  const canvasButton = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('link', { name: 'Book a viewing' });
  await canvasButton.click();
  await expect(page.locator('.canvas-navigation-notice')).toHaveCount(0);
  const linkEditor = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('dialog', { name: 'Edit link' });
  await expect(linkEditor).toBeVisible();
  await expect(linkEditor.getByLabel('Label')).toHaveValue('Book a viewing');
  await expect(linkEditor.getByLabel('Address')).toHaveValue('https://example.com/book');
  await linkEditor.getByLabel('Label').fill('Book by phone');
  await linkEditor.getByLabel('Address').fill('https://example.com/phone');
  await linkEditor.getByLabel('Open in new tab').check();
  await linkEditor.getByRole('button', { name: 'Apply' }).click();
  await expect(linkEditor).toBeHidden();
  const updatedCanvasButton = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('link', { name: 'Book by phone' });
  await expect(updatedCanvasButton).toHaveAttribute('href', 'https://example.com/phone');
  await expect(page.locator('#canvas-inspector').getByLabel('Label')).toHaveValue('Book by phone');
  await expect(page.locator('#canvas-inspector').getByLabel('Address')).toHaveValue(
    'https://example.com/phone',
  );
  await expect(page.locator('#canvas-inspector').getByLabel('Open in new tab')).toBeChecked();
  await expect(page.locator('#canvas-inspector')).not.toContainText('Edit in Form');
  await inspector.getByRole('button', { name: 'Page / Entry' }).click();
  await inspector.getByRole('button', { name: 'Choose a page or entry' }).click();
  await inspector.getByRole('option', { name: /Canvas fixture/ }).click();
  await inspector.locator('.ref-item .title').evaluate((element) => {
    element.textContent = 'Café & Bar / 2026 with a deliberately long destination title';
  });
  await inspector.locator('.ref-item .path').evaluate((element) => {
    element.textContent = 'listings/cafe-and-bar-2026-with-an-intentionally-long-destination-path';
  });
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.locator('#canvas-inspector').getByRole('button', { name: 'Close Inspector' }).click();

  await page.getByRole('button', { name: 'Back to form' }).click();
  await expect(page.locator('#f-button\\.label')).toHaveValue('Book by phone');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const splitHeading = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('heading', { level: 1 });
  await splitHeading.click();
  await splitHeading.dblclick();
  await expect(splitHeading).toHaveAttribute('contenteditable', 'true');
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-handover-canvas-frame="active"]',
    );
    const heading = frame?.contentDocument?.querySelector<HTMLElement>('h1');
    const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(
      (candidate) => candidate.value === 'Edited through Inspector',
    );
    if (!heading || !input) throw new Error('Split text fixtures are missing.');
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    heading.dispatchEvent(before);
    heading.textContent = 'Rejected stale edit';
    const changed = new Event('input', { bubbles: true });
    Object.defineProperty(changed, 'inputType', { value: 'insertText' });
    heading.dispatchEvent(changed);
    input.value = 'External Form edit';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await expect(splitHeading).toHaveText('External Form edit');
  await expect(splitHeading).toHaveAttribute('data-handover-inline-refusal', 'stale-version');
  await page.keyboard.press('Escape');
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  await expect(page.getByLabel('Title')).toHaveValue('External Form edit');
});

test('drift blocks editing until reconciliation reloads a fresh Canvas session', async ({
  page,
}) => {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string }>;
  const canvasScript = `/admin/_assets/${entries.canvas?.script ?? ''}`;
  await page.route('**/_preview/canvas-fixture', async (route) => {
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as {
      protocol: number;
      requestId: string;
      epoch: string;
      entry: { collection: string; id: string };
      locale: string;
      contentVersion: number;
      snapshots: Record<string, { title?: string }>;
    };
    const target = JSON.stringify({
      document: snapshot.entry,
      locale: snapshot.locale,
      address: 'title',
    }).replace(/'/g, '&#39;');
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
    const title = snapshot.snapshots[snapshot.locale]?.title ?? '';
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1 data-handover-field='${target}'>${title}</h1><script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${canvasScript}"></script></body></html>`,
    });
  });
  await page.goto('/canvas-shell?c33-drift');

  await expect(
    page.getByRole('heading', { name: "The languages disagree about this entry's blocks" }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Title')).toHaveCount(0);

  await page.getByRole('radio', { name: /Add it to German/ }).check();
  await page.getByRole('button', { name: 'Apply these answers' }).click();

  await expect(page.getByLabel('Title')).toHaveValue('Canvas fixture');
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Canvas' })).toBeVisible();
  await expect(page.locator('.canvas-render-state')).toHaveText('Canvas updated');
});

test('Canvas rich text lazily reuses formatting, selection, composition, and Form history', async ({
  page,
}) => {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string; styles: string[] }>;
  const canvasScript = `/admin/_assets/${entries.canvas?.script ?? ''}`;
  const escaped = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const prose = (value: string) => {
    const safe = escaped(value);
    const linked = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const marked = linked.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return marked.startsWith('# ') ? `<h1>${marked.slice(2)}</h1>` : `<p>${marked || '<br>'}</p>`;
  };
  await page.route('**/_preview/canvas-fixture', async (route) => {
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as {
      protocol: number;
      requestId: string;
      epoch: string;
      entry: { collection: string; id: string };
      locale: string;
      contentVersion: number;
      snapshots: Record<
        string,
        { title?: string; summary?: string; body?: string; legacy?: string }
      >;
    };
    const marker = (address: string) =>
      JSON.stringify({ document: snapshot.entry, locale: snapshot.locale, address })
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;');
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
    const data = snapshot.snapshots[snapshot.locale] ?? {};
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><h1 data-handover-field='${marker('title')}'>${escaped(data.title ?? '')}</h1><div data-rich-summary data-handover-field='${marker('summary')}'>${prose(data.summary ?? '')}</div><div data-rich-body data-handover-field='${marker('body')}'>${prose(data.body ?? '')}</div><div data-rich-legacy data-handover-field='${marker('legacy')}'>${prose(data.legacy ?? '')}</div><script type="application/json" data-handover-canvas-manifest>${manifest}</script><script type="module" src="${canvasScript}"></script></body></html>`,
    });
  });

  await page.goto('/canvas-shell');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const summary = frame.locator('[data-rich-summary]');
  await summary.dblclick();
  const richEditor = frame.getByRole('textbox', { name: 'Rich text in Canvas' });
  await expect(richEditor).toBeVisible();
  await expect(summary).toHaveText('Harbour home');
  await expect(summary.locator('p')).toHaveCount(1);
  await expect(frame.getByRole('toolbar', { name: 'Rich text formatting' })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Heading 2' })).toHaveCount(0);
  await richEditor.selectText();
  await frame.getByRole('button', { name: 'Bold' }).click();
  await expect(summary.locator('strong')).toHaveText('Harbour home');
  const status = frame.locator('[data-handover-canvas-richtext-status]');
  await expect(status).toHaveAttribute('data-handover-canvas-richtext-version', /\d+/);

  await richEditor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await expect(summary.locator('strong')).toHaveCount(0);
  await expect
    .poll(() => richEditor.evaluate(() => getSelection()?.toString() ?? ''))
    .toBe('Harbour home');
  await richEditor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+z`);
  await expect(summary.locator('strong')).toHaveText('Harbour home');
  await richEditor.selectText();
  await frame.getByRole('button', { name: 'Link' }).click();
  const linkEditor = frame.getByRole('dialog', { name: 'Edit link' });
  await expect(linkEditor).toBeVisible();
  await expect(linkEditor.getByLabel('Label')).toHaveValue('Harbour home');
  await linkEditor.getByLabel('Address').fill('/harbour');
  await linkEditor.getByRole('button', { name: 'Apply' }).click();
  const proseLink = summary.getByRole('link', { name: 'Harbour home' });
  await expect(proseLink).toHaveAttribute('href', '/harbour');
  await richEditor.press('Escape');
  await expect(frame.getByRole('toolbar', { name: 'Rich text formatting' })).toBeHidden();
  await proseLink.click();
  await expect(linkEditor).toBeVisible();
  await expect(linkEditor.getByLabel('Address')).toHaveValue('/harbour');
  await linkEditor.getByRole('button', { name: 'Cancel' }).click();
  await frame.getByRole('textbox', { name: 'Rich text in Canvas' }).press('Escape');
  await expect(frame.getByRole('toolbar', { name: 'Rich text formatting' })).toBeHidden();

  const body = frame.locator('[data-rich-body]');
  await body.dblclick();
  const fullEditor = frame.getByRole('textbox', { name: 'Rich text in Canvas' });
  await expect(frame.getByRole('button', { name: 'Heading 2' })).toBeVisible();
  await fullEditor.evaluate(async (node) => {
    const editor = node as HTMLElement;
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const paragraph = editor.querySelector('p');
    if (!paragraph) throw new Error('Canvas rich-text paragraph missing');
    paragraph.textContent = '日本語の本文';
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '日本語の本文',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    );
    await new Promise(requestAnimationFrame);
    editor.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '日本語の本文' }),
    );
  });
  await expect(fullEditor).toHaveText('日本語の本文');
  await fullEditor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await expect(fullEditor).toContainText('Room for everyone.');
  await fullEditor.press('Escape');

  const legacy = frame.locator('[data-rich-legacy]');
  await legacy.dblclick();
  await expect(legacy.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('#canvas-inspector')).toBeVisible();
  await expect(page.locator('#canvas-inspector')).toContainText('edited in code');

  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await expect(page.locator('#f-summary strong')).toHaveText('Harbour home');
  await expect(page.locator('#f-body')).toContainText('Room for everyone.');
  await expect(page.locator('#f-legacy-hint')).toContainText('edited in code');
});

test('Canvas block controls configure, duplicate, delete, reorder, restore, and retain failed renders', async ({
  page,
}, testInfo) => {
  await page.goto('/canvas-assets');
  const entries = JSON.parse(
    (await page.locator('body').getAttribute('data-entries')) ?? '{}',
  ) as Record<string, { script: string }>;
  const canvasScript = `/admin/_assets/${entries.canvas?.script ?? ''}`;
  let failNext = false;
  let posts = 0;
  await page.route('**/_preview/canvas-fixture', async (route) => {
    posts += 1;
    const encoded = new URLSearchParams(route.request().postData() ?? '');
    const snapshot = JSON.parse(encoded.get('snapshot') ?? '{}') as {
      protocol: number;
      requestId: string;
      epoch: string;
      entry: { collection: string; id: string };
      locale: string;
      contentVersion: number;
      snapshots: Record<string, { blocks?: Record<string, unknown>[] }>;
    };
    const failing = failNext;
    const manifest = failing
      ? {
          mode: 'canvas',
          status: 'error',
          protocol: snapshot.protocol,
          requestId: snapshot.requestId,
          epoch: snapshot.epoch,
          contentVersion: snapshot.contentVersion,
          error: { status: 422, message: 'Fixture render refused.' },
        }
      : {
          mode: 'canvas',
          status: 'success',
          protocol: snapshot.protocol,
          requestId: snapshot.requestId,
          epoch: snapshot.epoch,
          entry: snapshot.entry,
          locale: snapshot.locale,
          contentVersion: snapshot.contentVersion,
        };
    failNext = false;
    const encodedTarget = (target: Record<string, unknown>) =>
      JSON.stringify(target).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
    const attr = (address: string) =>
      encodedTarget({ document: snapshot.entry, locale: snapshot.locale, address });
    const safe = (value: unknown) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const renderBlocks = (blocks: Record<string, unknown>[], address: string): string =>
      blocks
        .map((block) => {
          const id = String(block._id ?? '');
          const at = `${address}[_id=${id}]`;
          const blockMarker = block._ref
            ? encodedTarget({
                document: { collection: 'globals', id: 'shared-promo' },
                locale: snapshot.locale,
                address: 'blocks[_id=shared-promo]',
                occurrence: {
                  document: snapshot.entry,
                  locale: snapshot.locale,
                  address: at,
                },
              })
            : attr(at);
          const heading = block.heading
            ? `<h2 data-handover-field='${attr(`${at}.heading`)}'>${safe(block.heading)}</h2>`
            : '';
          const columns = Array.isArray(block.columns)
            ? `<div>${(block.columns as Record<string, unknown>[])
                .map((column) => {
                  const columnAt = `${at}.columns[_id=${String(column._id ?? '')}]`;
                  const nested = Array.isArray(column.blocks)
                    ? (column.blocks as Record<string, unknown>[])
                    : [];
                  return `<div data-column-id="${safe(column._id)}" data-handover-block='${attr(columnAt)}' data-handover-list='${attr(`${columnAt}.blocks`)}'>${nested.length ? renderBlocks(nested, `${columnAt}.blocks`) : '<p data-empty-list>Empty nested list</p>'}</div>`;
                })
                .join('')}</div>`
            : '';
          return `<section style="padding:20px" data-block-id="${safe(id)}" data-handover-block='${blockMarker}'>${heading}${columns}</section>`;
        })
        .join('');
    const blocks = snapshot.snapshots[snapshot.locale]?.blocks ?? [];
    const body = failing
      ? ''
      : `<main data-handover-list='${attr('blocks')}'>${renderBlocks(blocks, 'blocks')}</main>`;
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>${body}<script type="application/json" data-handover-canvas-manifest>${JSON.stringify(manifest).replace(/</g, '\\u003c')}</script>${manifest.status === 'success' ? `<script type="module" src="${canvasScript}"></script>` : ''}</body></html>`,
    });
  });

  await page.goto('/canvas-shell?c30');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const structureButton = page.getByRole('button', { name: 'Structure', exact: true });
  const openStructure = async () => {
    if ((await structureButton.getAttribute('aria-expanded')) !== 'true')
      await structureButton.click();
    await expect(page.locator('#canvas-structure')).toBeVisible();
  };
  const useCanvasAction = async (
    name: 'Replace' | 'Insert after' | 'Duplicate',
    selectedLabel: string,
  ) => {
    if (name === 'Replace' || name === 'Duplicate')
      await frame.getByRole('button', { name: `Actions for ${selectedLabel}` }).click();
    const action = frame.getByRole('button', {
      name: name === 'Replace' ? `Replace ${selectedLabel}` : `${name} ${selectedLabel}`,
    });
    await expect(action).toBeVisible();
    await action.evaluate((button) => button.click());
  };
  const editor = page.locator('.canvas-block-editor');
  const inspector = page.locator('#canvas-inspector');
  const structure = page.locator('#canvas-structure');
  await openStructure();
  await structure.getByRole('button', { name: 'Add block', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(structure.locator('.canvas-block-editor')).toBeVisible();
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: testInfo.outputPath('structure-add-block.png') });
  await editor.getByRole('button', { name: 'Back to Structure' }).click();
  await expect(editor).toHaveCount(0);
  await expect(structure.getByRole('tree')).toBeVisible();
  await expect(structure.getByRole('button', { name: 'Add block', exact: true })).toBeFocused();
  const first = frame.locator('[data-block-id="repeat01"]');
  await first.click({ position: { x: 5, y: 5 } });
  await expect(inspector.locator('.canvas-inspector-context')).toContainText('Block 1');
  const insertAfterFirst = frame.getByRole('button', { name: 'Insert after Block 1' });
  await expect(insertAfterFirst).toBeVisible();
  await insertAfterFirst.click();
  await expect(
    editor.getByRole('list', { name: 'Allowed block types' }).getByRole('button'),
  ).toHaveText([/repeated/, /promo/, /columns/]);
  const postsBeforeIncompleteBlock = posts;
  await editor.getByRole('button', { name: /repeated/ }).click();
  await expect(editor).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(page.locator('.canvas-validation.is-incomplete')).toContainText(
    'Complete required fields',
  );
  await page.waitForFunction(
    () => (window as unknown as { canvasDraftWrites: unknown[] }).canvasDraftWrites.length > 0,
  );
  await expect(page.locator('.canvas-entry-actions .autosave')).toContainText('Saved');
  expect(posts).toBe(postsBeforeIncompleteBlock);
  await expect(page.locator('.canvas-failure')).toHaveCount(0);
  await expect(inspector.locator('.error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('incomplete-block.png') });

  await inspector.getByLabel('Heading').fill('Inserted beside the first block');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(frame.getByText('Inserted beside the first block')).toBeVisible();

  await frame
    .getByText('Inserted beside the first block')
    .locator('..')
    .click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Replace', 'Block 2');
  await editor.getByRole('button', { name: /promo/ }).click();
  await editor.getByLabel('Heading').fill('Replacement promotion');
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(frame.getByText('Replacement promotion')).toBeVisible();
  await expect(frame.getByText('Inserted beside the first block')).toHaveCount(0);

  const beforeCancel = posts;
  await frame
    .getByText('Replacement promotion')
    .locator('..')
    .click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Insert after', 'Block 2');
  await editor.getByRole('button', { name: 'Back to Structure' }).click();
  await expect(editor).toHaveCount(0);
  expect(posts).toBe(beforeCancel);

  await frame.locator('[data-empty-list]').click();
  await frame.getByRole('button', { name: 'Add block to Blocks' }).click();
  await editor.getByRole('button', { name: /repeated/ }).click();
  await inspector.getByLabel('Heading').fill('Nested list insertion');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(frame.getByText('Nested list insertion')).toBeVisible();

  const columns = frame.locator('[data-block-id="columns1"]');
  await columns.click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Duplicate', 'Block 3');
  await expect(frame.locator('main > [data-block-id]')).toHaveCount(4);
  const generated = await frame
    .locator('[data-block-id], [data-column-id]')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute('data-block-id') ?? node.getAttribute('data-column-id') ?? '',
      ),
    );
  expect(new Set(generated).size).toBe(generated.length);
  expect(generated).not.toContain('');

  const originalNested = frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]');
  await originalNested.click({ position: { x: 5, y: 5 } });
  const pointerDrag = async (finish: 'drop' | 'escape') => {
    await frame.getByRole('button', { name: /^Drag Block/ }).evaluate((button, finish) => {
      const source = button as HTMLButtonElement;
      const sibling = source.ownerDocument.querySelector(
        '[data-block-id="columns1"] [data-block-id="promo001"]',
      );
      const y = sibling?.getBoundingClientRect().top ?? 0;
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientY: source.getBoundingClientRect().top,
          pointerId: 31,
        }),
      );
      source.ownerDocument.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientY: y + 2,
          pointerId: 31,
        }),
      );
      source.ownerDocument.dispatchEvent(
        finish === 'escape'
          ? new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })
          : new PointerEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              clientY: y + 2,
              pointerId: 31,
            }),
      );
    }, finish);
  };
  const nestedOrder = () =>
    frame
      .locator('[data-block-id="columns1"] [data-column-id="column01"] > [data-block-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-block-id')));
  await pointerDrag('escape');
  expect(await nestedOrder()).toEqual(['repeat02', 'promo001']);
  await pointerDrag('drop');
  await expect.poll(nestedOrder).toEqual(['promo001', 'repeat02']);
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="repeat02"]')
    .click({ position: { x: 5, y: 5 } });
  await frame.getByRole('button', { name: /^Actions for Block/ }).click();
  await expect(frame.getByRole('button', { name: /^Move Block.* up/ })).toBeVisible();
  await originalNested.evaluate((node) =>
    node.ownerDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
    ),
  );
  await expect.poll(nestedOrder).toEqual(['repeat02', 'promo001']);
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="repeat02"]')
    .click({ position: { x: 5, y: 5 } });
  await frame.getByRole('button', { name: /^Actions for Block/ }).click();
  await expect(frame.getByRole('button', { name: /^Move Block.* down/ })).toBeVisible();
  await originalNested.evaluate((node) =>
    node.ownerDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    ),
  );
  await expect.poll(nestedOrder).toEqual(['promo001', 'repeat02']);

  const promoAddress = 'blocks[_id=columns1].columns[_id=column01].blocks[_id=promo001]';
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="promo001"]')
    .click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.canvas-workspace')).toHaveAttribute(
    'data-selected-address',
    promoAddress,
  );
  await frame.getByRole('button', { name: /^Actions for Block/ }).click();
  const deletePromo = frame.getByRole('button', { name: /^Delete Block/ });
  await expect(deletePromo).toBeVisible();
  await deletePromo.evaluate((button) => button.click());
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="promo001"]')).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="promo001"]')).toHaveCount(
    1,
  );

  const repeatedAddress = 'blocks[_id=columns1].columns[_id=column01].blocks[_id=repeat02]';
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="repeat02"]')
    .click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.canvas-workspace')).toHaveAttribute(
    'data-selected-address',
    repeatedAddress,
  );
  await frame.getByRole('button', { name: /^Actions for Block/ }).click();
  const deleteRepeated = frame.getByRole('button', { name: /^Delete Block/ });
  await expect(deleteRepeated).toBeVisible();
  await deleteRepeated.evaluate((button) => button.click());
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]')).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            canvasDraftWrites: Array<{
              data?: {
                blocks?: Array<{
                  _id?: string;
                  columns?: Array<{ _id?: string; blocks?: Array<{ _id?: string }> }>;
                }>;
              };
            }>;
          }
        ).canvasDraftWrites.some((write) =>
          write.data?.blocks
            ?.find((block) => block._id === 'columns1')
            ?.columns?.find((column) => column._id === 'column01')
            ?.blocks?.every((block) => block._id !== 'repeat02'),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await page.getByRole('button', { name: 'DE', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('input')
        .evaluateAll((inputs) => inputs.some((input) => input.value === 'Verschachteltes Feld')),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.canvas-render-state')).toHaveText('Canvas updated');
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(0);

  await frame
    .getByText('Replacement promotion')
    .locator('..')
    .click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Insert after', 'Block 2');
  await editor.getByRole('button', { name: /repeated/ }).click();
  failNext = true;
  await inspector.getByLabel('Heading').fill('Retained after render failure');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(page.getByText('Canvas could not update')).toBeVisible();
  await expect(frame.getByText('Retained after render failure')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(frame.getByText('Retained after render failure')).toBeVisible();
  await expect(page.getByText('Canvas could not update')).toHaveCount(0);
  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await expect
    .poll(() =>
      page
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.some(
            (input) => (input as HTMLInputElement).value === 'Retained after render failure',
          ),
        ),
    )
    .toBe(true);
});
