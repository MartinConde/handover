import { expect, test } from '@playwright/test';
import { openCanvas } from './canvas-helpers';

test('inline editing can end after Structure selection and Inspector changes promote', async ({
  page,
}) => {
  await openCanvas(page);
  const active = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const title = active.getByRole('heading', { level: 1 });
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.fill('Edited on the page');
  await page.getByRole('treeitem', { name: 'Body', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Title', exact: true }).click();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await page
    .locator('#canvas-inspector')
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('Edited through Inspector after Structure');
  await expect(
    active.getByRole('heading', { name: 'Edited through Inspector after Structure' }),
  ).toBeVisible();
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(0);
  await expect(page.locator('.canvas-render-state')).not.toContainText('Updating Canvas');
});

test('Structure keyboard moves one focus position with arrows, Home, and End', async ({ page }) => {
  await openCanvas(page);
  const tree = page.getByRole('tree', { name: 'Page structure' });
  const items = tree.getByRole('treeitem');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveAttribute('tabindex', '0');
  await expect(items.nth(1)).toHaveAttribute('tabindex', '-1');
  await expect(items.last()).toHaveAttribute('tabindex', '-1');
  await items.first().focus();
  await items.first().press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await items.nth(1).press('ArrowDown');
  await expect(items.last()).toBeFocused();
  await items.last().press('Home');
  await expect(items.first()).toBeFocused();
  await items.first().press('End');
  await expect(items.last()).toBeFocused();
  await items.last().press('ArrowUp');
  await expect(items.nth(1)).toBeFocused();
});

test('a renderer chunk failure offers recovery while the session keeps unsaved text', async ({
  page,
}) => {
  let blocked = 0;
  await page.route('**/*canvas-renderer*.js', (route) => {
    blocked += 1;
    return route.abort();
  });
  await page.goto('/canvas-shell');
  const title = page.getByLabel('Title');
  await title.fill('Unsaved before the renderer failed');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.canvas-failure')).toBeVisible();
  await expect(page.locator('.canvas-failure')).toContainText('Canvas could not start');
  await expect(
    page.locator('.canvas-failure').getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  expect(blocked).toBeGreaterThan(0);
  await page.locator('.canvas-failure').getByRole('button', { name: 'Go to Form' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Unsaved before the renderer failed');
});

test('Canvas fills the viewport and keeps Structure beside a contained media inspector', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openCanvas(page);
  const canvas = page.locator('.canvas-stage');
  await expect
    .poll(async () => {
      const rect = await canvas.boundingBox();
      return rect ? Math.abs(rect.y + rect.height - (1100 - 28)) : 1100;
    })
    .toBeLessThan(20);
  await expect(page.locator('.canvas-statusbar')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Canvas size' })).toHaveCount(0);
  await expect(page.locator('.entry-header')).toBeHidden();
  await expect(page.locator('.canvas-rail')).toBeVisible();
  expect((await page.locator('.canvas-rail').boundingBox())?.y).toBe(0);
  expect(
    await page.locator('.canvas-stage-shell').evaluate((shell) => {
      const canvas = shell.querySelector<HTMLElement>('.canvas-stage');
      if (!canvas) return Number.POSITIVE_INFINITY;
      const style = getComputedStyle(shell);
      const availableWidth =
        shell.getBoundingClientRect().width -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      return Math.abs(canvas.getBoundingClientRect().width - availableWidth);
    }),
  ).toBeLessThan(2);
  const inspectorButton = page.getByRole('button', { name: 'Inspector', exact: true });
  await expect(inspectorButton).toBeEnabled();
  await inspectorButton.click();
  const inspector = page.locator('#canvas-inspector');
  await expect(inspector.getByRole('heading', { name: 'Nothing selected' })).toBeVisible();
  await expect(inspector).toContainText('Choose an element on the canvas or in Structure');
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await page.getByRole('treeitem', { name: 'Hero', exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Hero', exact: true })).toBeVisible();
  await expect(inspector.getByLabel('Block actions')).toHaveCount(0);
  await expect
    .poll(async () => (await page.locator('.canvas-inspector-slot').boundingBox())?.width ?? 0)
    .toBeGreaterThan(280);
  const inspectorSlot = page.locator('.canvas-inspector-slot');
  const stageShell = page.locator('.canvas-stage-shell');
  const inspectorResize = page.getByRole('separator', { name: 'Resize Inspector panel' });
  await expect.poll(async () => (await inspectorSlot.boundingBox())?.width ?? 0).toBe(380);
  const stageBeforeResize = await stageShell.boundingBox();
  const inspectorBeforeResize = await inspectorSlot.boundingBox();
  const inspectorHandle = await inspectorResize.boundingBox();
  if (!stageBeforeResize || !inspectorBeforeResize || !inspectorHandle)
    throw new Error('Resizable Canvas panels were not laid out');
  await page.mouse.move(
    inspectorHandle.x + inspectorHandle.width / 2,
    inspectorHandle.y + inspectorHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    inspectorHandle.x + inspectorHandle.width / 2 - 160,
    inspectorHandle.y + inspectorHandle.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await inspectorSlot.boundingBox())?.width ?? 0)
    .toBeGreaterThan(inspectorBeforeResize.width + 140);
  await expect
    .poll(async () => (await stageShell.boundingBox())?.width ?? 0)
    .toBeLessThan(stageBeforeResize.width - 140);
  await inspectorResize.press('ArrowRight');
  await expect(inspectorResize).toHaveAttribute('aria-valuenow', '524');

  const structureResize = page.getByRole('separator', { name: 'Resize Structure panel' });
  await structureResize.press('ArrowRight');
  await expect(structureResize).toHaveAttribute('aria-valuenow', '266');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem('handover.canvas.panel-widths') ?? '{}');
        return [stored.structure, stored.inspector];
      }),
    )
    .toEqual([266, 524]);
  await expect(inspector.locator('.thumb img')).toBeVisible();
  expect(
    await inspector.locator('.media-card').evaluate((card) => {
      const thumb = card.querySelector('.thumb');
      const content = card.querySelector('.meta');
      if (!thumb || !content) throw new Error('Image field preview is missing');
      const preview = thumb.getBoundingClientRect();
      const meta = content.getBoundingClientRect();
      return preview.bottom <= meta.top && !card.querySelector('.sub');
    }),
  ).toBe(true);
  await expect(page.locator('#canvas-structure')).toBeVisible();
  await expect(page.getByLabel('Alt text')).toHaveValue('Harbour at dusk');
  await inspector.getByRole('button', { name: 'Set focal point' }).click();
  const focal = page.getByRole('dialog', { name: 'Focal point — Hero image' });
  await expect(focal).toBeVisible();
  await expect(focal.locator('p')).toHaveCount(1);
  await expect(focal.locator('.ratio-item .lbl')).toHaveText([
    '3:2',
    '16:9',
    '4:3',
    '1:1',
    '4:5',
    '9:16',
  ]);
  await expect(focal.locator('.focal-dialog')).toHaveCSS('outline-style', 'none');
  const previewRatios = await focal.locator('.ratio-preview').evaluateAll((previews) =>
    previews.map((preview) => {
      const box = preview.getBoundingClientRect();
      const ratio = getComputedStyle(preview).aspectRatio.split('/').map(Number);
      return { actual: box.width / box.height, expected: (ratio[0] ?? 1) / (ratio[1] ?? 1) };
    }),
  );
  for (const { actual, expected } of previewRatios) expect(actual).toBeCloseTo(expected, 2);
  await page.screenshot({ path: testInfo.outputPath('focal-editor.png') });
  await focal.getByRole('button', { name: 'Cancel', exact: true }).click();

  await frame.locator('[data-handover-canvas-overlay]').evaluate((host) => {
    const replace = host.shadowRoot?.querySelector<HTMLButtonElement>(
      '[aria-label="Replace Hero"]',
    );
    if (!replace) throw new Error('On-canvas image replacement action is missing');
    replace.click();
  });
  const picker = page.getByRole('dialog', { name: /Choose an image for/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel' }).click();
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('desktop-media.png') });
  await page.getByLabel('Alt text').fill('Evening on the coast');
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await expect(page.locator('#canvas-structure')).toBeVisible();
  await page.getByRole('treeitem', { name: 'Hero', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await inspectorButton.click();
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
  await expect(inspector).toHaveCount(0);
  await inspectorButton.click();
  await expect(page.getByLabel('Alt text')).toHaveValue('Evening on the coast');
});

test('rich text remains one copy while editing and the toolbar fits a phone canvas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page);
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const prose = frame.locator('[data-prose]');
  await prose.click({ trial: true });
  const renderedBounds = await prose.boundingBox();
  await prose.dblclick();
  const editor = frame.getByRole('textbox', { name: 'Rich text in Canvas' });
  await expect(editor).toBeVisible();
  const editingBounds = await prose.boundingBox();
  if (!editingBounds || !renderedBounds) throw new Error('Prose bounds are missing');
  for (const dimension of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(editingBounds[dimension] - renderedBounds[dimension])).toBeLessThan(1);
  await expect(prose).toHaveAttribute('contenteditable', 'true');
  await expect(prose.locator(':scope > p')).toHaveCount(1);
  await expect(prose).toHaveText('Room for everyone.');
  await expect(prose.locator('p')).toHaveCount(1);
  await expect(frame.locator('[data-handover-canvas-overlay]').locator('.box')).toHaveCount(1);
  await expect(
    frame.locator('[data-handover-canvas-overlay]').locator('.path:not(.hover-path)'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-editing.png') });
  await editor.fill('Room by the coast.');
  await editor.press('Escape');
  await expect(prose).toHaveText('Room by the coast.');
  await prose.dblclick();
  await expect(editor).toHaveText('Room by the coast.');
  // Editing in place leaves the Inspector shut; the overlay button is what opens it, mid-edit.
  const inspector = page.locator('#canvas-inspector');
  await expect(inspector).toHaveCount(0);
  await expect(editor).toBeVisible();
  await frame.locator('[data-canvas-action="inspect"]').click();
  await expect(inspector).toHaveCount(1);
  await expect(inspector.getByText('Edit in Inspector', { exact: true })).toHaveCount(0);
  await expect(inspector.getByText('Open in form', { exact: true })).toHaveCount(0);
  await frame.locator('[data-canvas-action="inspect"]').click();
  await expect(inspector).toHaveCount(0);
  await frame.locator('[data-canvas-action="inspect"]').click();
  await expect(inspector).toHaveCount(1);
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
  await expect(page.locator('#canvas-inspector')).toBeVisible();
  await expect(page.locator('#canvas-inspector input[aria-invalid="true"]')).toBeFocused();
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  const frame = page.frameLocator('iframe[data-handover-canvas-frame="active"]');
  await expect(frame.locator('.box.invalid')).toHaveCount(1);
});

test('full-screen controls switch viewport and return to form without losing edits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page);
  await page.getByRole('button', { name: 'Phone', exact: true }).click();
  await expect(page.locator('.canvas-stage')).toHaveClass(/is-phone/);
  expect((await page.locator('.canvas-stage').boundingBox())?.width).toBeCloseTo(390, 2);
  await page.getByRole('button', { name: 'Desktop', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Title', exact: true }).click();
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
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
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
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

test('one click opens the text editor with the caret where the pointer landed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openCanvas(page);
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const heading = frame.getByRole('heading', { level: 1 });

  // A few pixels into the first glyph, so the caret belongs at the very start of the text.
  const start = await heading.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const first = range.getClientRects()[0];
    const box = element.getBoundingClientRect();
    return { x: first.left - box.left + 2, y: first.top - box.top + first.height / 2 };
  });
  await heading.click({ position: start });

  await expect(heading).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  expect(
    await heading.evaluate((element) => {
      const selection = element.ownerDocument.getSelection();
      return { caret: selection?.focusOffset, length: element.textContent?.length };
    }),
  ).toEqual({ caret: 0, length: (await heading.textContent())?.length });
});

test('required field highlights clear after fixing the field without leaving Canvas', async ({
  page,
}) => {
  await openCanvas(page);
  await page.getByRole('treeitem', { name: 'Title', exact: true }).click();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  const inspector = page.locator('#canvas-inspector');
  await inspector.getByRole('textbox', { name: 'Title', exact: true }).fill('');
  await expect(page.locator('.canvas-validation')).toBeVisible();
  const frame = page.frameLocator('iframe[data-handover-canvas-frame="active"]');
  await expect(frame.locator('.box.invalid')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await page.locator('.canvas-validation').getByRole('button', { name: 'Review fields' }).click();
  await expect(inspector.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
  await inspector.getByRole('textbox', { name: 'Title', exact: true }).fill('Ready for guests');
  await expect(page.locator('.canvas-validation')).toHaveCount(0);
  await expect(frame.locator('.box.invalid')).toHaveCount(0);
  await expect(frame.getByRole('heading', { name: 'Ready for guests' })).toBeVisible();
});

test('floating link dialogs stay above canvas labels', async ({ page }) => {
  await openCanvas(page);
  const frame = page.frameLocator('iframe[data-handover-canvas-frame="active"]');
  await frame.locator('[data-prose]').click();
  const editor = frame.getByRole('textbox', { name: 'Rich text in Canvas' });
  await expect(editor).toBeVisible();
  await editor.press('ControlOrMeta+a');
  await frame.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = frame.getByRole('dialog', { name: 'Edit link' });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((panel) => {
      const label = panel.ownerDocument
        .querySelector('[data-handover-canvas-overlay]')
        ?.shadowRoot?.querySelector<HTMLElement>('.path');
      if (!label) throw new Error('Canvas label is missing');
      const previous = label.style.cssText;
      const bounds = panel.getBoundingClientRect();
      label.style.left = `${bounds.left + 20}px`;
      label.style.top = `${bounds.top + 20}px`;
      const hit = panel.ownerDocument.elementFromPoint(bounds.left + 30, bounds.top + 25);
      label.style.cssText = previous;
      return panel.contains(hit);
    }),
  ).toBe(true);
});

test('image clicks open shared controls in a floating panel and preserve edits across dialogs', async ({
  page,
}, testInfo) => {
  await openCanvas(page);
  const frame = page.frameLocator('iframe[data-handover-canvas-frame="active"]');
  const hero = frame.locator('[data-hero]');
  await hero.click({ trial: true });
  const bounds = await hero.boundingBox();
  if (!bounds) throw new Error('Hero bounds are missing');
  await hero.click({ position: { x: bounds.width - 30, y: bounds.height - 30 } });
  const popover = page.locator('.canvas-image-popover');
  await expect(popover).toBeVisible();
  await expect(page.locator('.canvas-inspector-slot')).toHaveAttribute('aria-hidden', 'true');
  await expect(popover.getByLabel('Alt text')).toHaveValue('Harbour at dusk');
  await popover.getByLabel('Alt text').fill('Evening on the harbour');
  await popover.getByRole('button', { name: 'Set focal point' }).click();
  const focal = page.getByRole('dialog', { name: 'Focal point — Hero image' });
  await expect(focal).toBeVisible();
  await focal.locator('.focal-handle').focus();
  await focal.locator('.focal-handle').press('ArrowRight');
  await focal.getByRole('button', { name: 'Save focal point' }).click();
  await expect(popover).toBeVisible();
  await expect(popover.getByLabel('Alt text')).toHaveValue('Evening on the harbour');
  await expect(popover.locator('.thumb .focal')).toHaveAttribute('style', /left: 51%/);
  await page.screenshot({ path: testInfo.outputPath('image-popover.png') });
  await popover.press('Escape');
  await expect(popover).toHaveCount(0);
  await hero.click({ position: { x: bounds.width - 30, y: bounds.height - 30 } });
  await expect(popover.getByLabel('Alt text')).toHaveValue('Evening on the harbour');
  await frame.locator('[data-prose]').click();
  await expect(popover).toHaveCount(0);
  await frame.getByRole('textbox', { name: 'Rich text in Canvas' }).press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  const structureToggle = page.getByRole('button', { name: 'Structure', exact: true });
  if ((await structureToggle.getAttribute('aria-expanded')) === 'true')
    await structureToggle.click();
  await hero.click({ trial: true });
  const phoneBounds = await hero.boundingBox();
  if (!phoneBounds) throw new Error('Phone hero bounds are missing');
  await hero.click({ position: { x: phoneBounds.width - 20, y: phoneBounds.height - 20 } });
  await expect(popover).toBeVisible();
  expect(
    await popover.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return (
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('phone-image-popover.png') });
  await popover.getByRole('button', { name: 'Close image editor' }).click();
  await expect(popover).toHaveCount(0);
});
