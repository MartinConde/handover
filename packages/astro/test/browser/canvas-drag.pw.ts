import { expect, test } from '@playwright/test';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Canvas centers the blocks overview inside a fixed canvas (${reducedMotion})`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/canvas-assets');
    const entries = JSON.parse((await page.locator('body').getAttribute('data-entries')) ?? '{}');
    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:100%;height:800px;border:0';
      document.body.replaceChildren(iframe);
    });
    const frame = page.locator('iframe').contentFrame();
    const child = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!child) throw new Error('Missing canvas iframe');
    await child.evaluate(async (script) => {
      const { createCanvasSelectionRuntime } = await import(script);
      const target = (address: string) => ({
        document: { collection: 'pages', id: 'home' },
        locale: 'en',
        address,
      });
      const mark = (kind: string, address: string) =>
        `data-handover-${kind}='${JSON.stringify(target(address))}'`;
      document.body.innerHTML = `<style>
      body { margin: 40px; font: 18px system-ui; }
      h2 { margin:0; font:inherit; width:180px; }
      article { height: 100px; padding: 20px; margin: 16px 0; background: #d9edca; }
      #two { height: 160px; background: #ccdeec; }
    </style><aside style="height:900px"></aside><main ${mark('list', 'blocks')}><section ${mark('block', 'blocks[_id=parent]')}>
      <div id="blocks-wrapper" ${mark('list', 'blocks[_id=parent].items')}>
        <article id="one" ${mark('block', 'blocks[_id=parent].items[_id=one]')}><h2 id="heading" ${mark('field', 'blocks[_id=parent].items[_id=one].heading')}>One</h2></article>
        <article id="two" ${mark('block', 'blocks[_id=parent].items[_id=two]')}>Two</article>
        <article id="three" ${mark('block', 'blocks[_id=parent].items[_id=three]')}>Three</article>
      </div></section></main><aside style="height:900px"></aside>`;
      let locale = 'en';
      const listeners = new Set<(locale: string) => void>();
      document.addEventListener('test-locale', () => {
        locale = 'de';
        for (const listener of listeners) listener(locale);
      });
      const runtime = createCanvasSelectionRuntime({
        uiLocale: {
          current: () => locale,
          subscribe: (listener: (locale: string) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        onAction: (action: string, selection: unknown, destination: unknown) => {
          document.body.dataset.action = JSON.stringify({ action, selection, destination });
        },
      });
      runtime.start();
      const selection = { kind: 'block', target: target('blocks[_id=parent].items[_id=one]') };
      runtime.select(selection);
      const selectBlock = () => {
        runtime.select(selection);
        runtime.actions(selection, ['move', 'move-down', 'duplicate', 'delete', 'replace']);
      };
      document.addEventListener('test-select-block', selectBlock);
      document.addEventListener('test-select-field', () => {
        const field = {
          kind: 'field',
          target: target('blocks[_id=parent].items[_id=one].heading'),
        };
        runtime.select(field);
        runtime.actions(field, ['inspect']);
      });
      selectBlock();
      scrollTo(0, 860);
    }, `http://127.0.0.1:4329/admin/_assets/${entries.canvas.script}`);
    const handle = frame.getByRole('button', { name: /Drag Block 1|Block 1 ziehen/ });
    await expect(handle).toBeVisible();
    const row = frame.locator('.action-row');
    const label = frame.locator('.path:not(.hover-path)');
    const checkAlignment = async (selector: string) => {
      await expect(row).toBeVisible();
      await expect
        .poll(async () => {
          const element = await frame.locator(selector).boundingBox();
          const actions = await row.boundingBox();
          const caption = await label.boundingBox();
          if (!element || !actions || !caption) return false;
          return (
            Math.abs(actions.y - caption.y) < 1 &&
            Math.abs(actions.y + actions.height - element.y) < 1 &&
            Math.abs(actions.x + actions.width - element.x - element.width) < 1 &&
            caption.x + caption.width <= actions.x
          );
        })
        .toBe(true);
    };
    await checkAlignment('#one');
    await page.screenshot({ path: testInfo.outputPath('block-actions.png') });
    await expect(row.getByRole('button')).toHaveCount(4);
    await expect(frame.locator('[data-canvas-action="replace"]')).toHaveCount(0);
    await expect(frame.locator('[data-canvas-actions-toggle]')).toHaveCount(0);
    await child.evaluate(() => document.dispatchEvent(new Event('test-select-field')));
    await expect(row.getByRole('button', { name: 'Open Heading in the Inspector' })).toBeVisible();
    await checkAlignment('#heading');
    await page.screenshot({ path: testInfo.outputPath('field-actions.png') });
    await child.evaluate(() => document.dispatchEvent(new Event('test-select-block')));
    await expect(handle).toBeVisible();
    const originalFrame = await page.locator('iframe').boundingBox();
    const originalWidth = await child.evaluate(() => innerWidth);
    const wrapper = frame.locator('#blocks-wrapper');
    const originalWrapper = await wrapper.boundingBox();
    const surrounding = await frame.locator('aside').first().boundingBox();
    if (!originalWrapper) throw new Error('Missing blocks wrapper');
    if (!originalFrame) throw new Error('Missing frame geometry');
    const original = await frame.locator('#two').boundingBox();
    if (!original) throw new Error('Missing sibling geometry');
    const expectPosition = async (position: number) => {
      // Keep the pointer still until sibling animations finish: a transient reorder is insufficient.
      await expect(frame.locator('.live')).toContainText(`position ${position}`, {
        ignoreCase: true,
      });
      await expect
        .poll(() =>
          child.evaluate(
            () =>
              [...document.querySelectorAll('article')]
                .flatMap((element) => element.getAnimations())
                .filter((animation) => animation.playState === 'running').length,
          ),
        )
        .toBe(0);
      await expect(frame.locator('.live')).toContainText(`position ${position}`, {
        ignoreCase: true,
      });
    };
    const begin = async () => {
      const block = await frame.locator('#one').boundingBox();
      const box = await handle.boundingBox();
      if (!box || !block || !original) throw new Error('Missing drag geometry');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10, { steps: 3 });
      await expect
        .poll(async () => (await wrapper.boundingBox())?.width)
        .toBeCloseTo(originalWrapper.width * 0.65, 0);
      expect(await page.locator('iframe').boundingBox()).toEqual(originalFrame);
      expect(await frame.locator('aside').first().boundingBox()).toEqual(surrounding);
      const overview = await wrapper.boundingBox();
      if (!overview) throw new Error('Missing overview');
      expect(overview.x + overview.width / 2).toBeCloseTo(
        originalWrapper.x + originalWrapper.width / 2,
        0,
      );
      expect(await child.evaluate(() => innerWidth)).toBe(originalWidth);
      const destination = await frame.locator('#two').boundingBox();
      if (!destination) throw new Error('Missing drop target');
      const ghost = await frame.locator('[data-dnd-dragging]').boundingBox();
      if (!ghost) throw new Error('Missing drag preview');
      expect(ghost.width).toBeCloseTo(block.width * 0.65, 0);
      expect(ghost.height).toBeCloseTo(block.height * 0.65, 0);
      const rx = (box.x + box.width / 2 - block.x) / block.width;
      const ry = (box.y + box.height / 2 - block.y) / block.height;
      // The handle is above the block: move the preview's center past the destination's midpoint.
      const x = destination.x + destination.width / 2 + ghost.width * (rx - 0.5);
      const y = destination.y + destination.height / 2 + ghost.height * (ry - 0.5) + 20;
      await page.mouse.move(x, y, { steps: 15 });
      await expectPosition(2);
      return { x, y, rx, ry };
    };
    const pointer = await begin();
    await expect(frame.locator('[data-dnd-dragging]')).toBeVisible();
    await expect(frame.locator('[data-canvas-drop-preview]')).toBeVisible();
    await expect(frame.locator('[data-canvas-drop-preview]')).toHaveCSS(
      'border-top-style',
      'dashed',
    );
    await expect
      .poll(async () => (await frame.locator('#two').boundingBox())?.y)
      .toBeLessThan(original.y - 80);
    await expect(frame.locator('.live')).toContainText('position 2', { ignoreCase: true });
    await expect
      .poll(async () => {
        const ghost = await frame.locator('[data-dnd-dragging]').boundingBox();
        return ghost ? Math.abs(ghost.x + ghost.width * pointer.rx - pointer.x) : Infinity;
      })
      .toBeLessThan(6);
    await expect
      .poll(async () => {
        const ghost = await frame.locator('[data-dnd-dragging]').boundingBox();
        return ghost ? Math.abs(ghost.y + ghost.height * pointer.ry - pointer.y) : Infinity;
      })
      .toBeLessThan(6);
    await page.screenshot({ path: testInfo.outputPath('drag-overview.png') });
    await child.evaluate(() => document.dispatchEvent(new Event('test-locale')));
    await expect(frame.locator('.live')).toContainText('Vorschau: Position 2 von 3.');
    // Holding a drop position must not prevent reversing direction or choosing it again.
    const reverseTarget = await frame.locator('#two').boundingBox();
    if (!reverseTarget) throw new Error('Missing reverse drop target');
    await page.mouse.move(pointer.x, reverseTarget.y + reverseTarget.height / 2, { steps: 15 });
    await expectPosition(1);
    const returnedTarget = await frame.locator('#two').boundingBox();
    const returnedGhost = await frame.locator('[data-dnd-dragging]').boundingBox();
    if (!returnedTarget || !returnedGhost) throw new Error('Missing reverse drag geometry');
    await page.mouse.move(
      returnedTarget.x + returnedTarget.width / 2 + returnedGhost.width * (pointer.rx - 0.5),
      returnedTarget.y + returnedTarget.height / 2 + returnedGhost.height * (pointer.ry - 0.5) + 20,
      { steps: 15 },
    );
    await expectPosition(2);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(frame.locator('[data-dnd-dragging]')).toHaveCount(0);
    await expect
      .poll(async () => (await wrapper.boundingBox())?.width)
      .toBeCloseTo(originalWrapper.width, 0);
    await expect(frame.locator('[data-canvas-drop-preview]')).toBeHidden();
    await expect(page.locator('iframe')).toHaveCSS('transform', 'none');
    expect((await page.locator('iframe').boundingBox())?.height).toBe(originalFrame.height);
    await expect
      .poll(() => frame.locator('article').evaluateAll((items) => items.map((item) => item.id)))
      .toEqual(['one', 'two', 'three']);
    await expect(frame.locator('body')).not.toHaveAttribute('data-action');
    expect(await child.evaluate(() => scrollY)).toBe(860);
    await expect(frame.locator('.live')).toContainText('Verschieben abgebrochen.');
    await expect(handle).toBeVisible();
    await begin();
    await expect
      .poll(async () => (await frame.locator('#two').boundingBox())?.y)
      .toBeLessThan(original.y - 80);
    await page.mouse.up();
    await expect(frame.locator('[data-dnd-dragging]')).toHaveCount(0);
    await expect
      .poll(async () => (await wrapper.boundingBox())?.width)
      .toBeCloseTo(originalWrapper.width, 0);
    await expect(frame.locator('[data-canvas-drop-preview]')).toBeHidden();
    await expect(page.locator('iframe')).toHaveCSS('transform', 'none');
    expect((await page.locator('iframe').boundingBox())?.height).toBe(originalFrame.height);
    await expect(frame.locator('body')).toHaveAttribute('data-action', /"action":"move"/);
    const action = JSON.parse((await frame.locator('body').getAttribute('data-action')) ?? '{}');
    expect(action.destination.target.address).toBe('blocks[_id=parent].items[_id=two]');
    await expect(frame.locator('article')).toHaveText(['Two', 'One', 'Three']);
  });
}
