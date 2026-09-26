import { expect, test } from '@playwright/test';
import { openLifecycle } from './canvas-helpers';

test('fresh POST candidates promote without polluting Back/Forward and failures retain the active page', async ({
  page,
}) => {
  await openLifecycle(page);

  const render = (title: string, behavior = 'success') =>
    page.evaluate(({ title, behavior }) => window.canvasLifecycle.render(title, behavior), {
      title,
      behavior,
    });

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
  await page.evaluate(() => window.canvasLifecycle.advance());
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
  await openLifecycle(page);
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/canvas-candidate')
      posts += 1;
  });

  const coalesced = await page.evaluate(() => {
    const lifecycle = window.canvasLifecycle;
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

  const late = page.evaluate(() => window.canvasLifecycle.render('Late obsolete result', 'late'));
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(1);
  const latest = page.evaluate(() => window.canvasLifecycle.schedule('Latest while rendering'));
  expect(await late).toMatchObject({ ok: false, reason: 'superseded' });
  expect(await latest).toMatchObject({ ok: true, contentVersion: 5 });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Latest while rendering',
  );
  await expect(page.locator('iframe')).toHaveCount(1);

  await page.evaluate(() => {
    const lifecycle = window.canvasLifecycle;
    lifecycle.interaction({
      inlineEditing: true,
      composing: true,
      dragging: true,
    });
  });
  const deferred = page.evaluate(() => window.canvasLifecycle.render('Deferred promotion', 'slow'));
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
    const lifecycle = window.canvasLifecycle;
    lifecycle.interaction({ inlineEditing: false });
    lifecycle.interaction({ composing: false });
  });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Inline edit remains live',
  );
  await page.evaluate(() => window.canvasLifecycle.interaction({ dragging: false }));
  expect(await deferred).toMatchObject({ ok: true, contentVersion: 6 });
  await expect(active.contentFrame().getByRole('heading', { level: 1 })).toHaveText(
    'Deferred promotion',
  );

  await page.evaluate(() =>
    window.canvasLifecycle.render('Scrollable baseline', 'success', {
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
    const lifecycle = window.canvasLifecycle;
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
    window.canvasLifecycle.render('Keep the viewport', 'success', {
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
  await openLifecycle(page);
  await page.evaluate(() => window.canvasLifecycle.render('Selection fixture', 'selection'));
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
}) => {
  await openLifecycle(page);
  const render = (count: number) =>
    page.evaluate(async (blocks) => {
      const started = performance.now();
      const result = await window.canvasLifecycle.render(`${blocks} block fixture`, 'performance', {
        count: blocks,
      });
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
