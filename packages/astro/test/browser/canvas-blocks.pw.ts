import { expect, type Page, test } from '@playwright/test';
import { serveCanvasPreview } from './canvas-helpers';

// Serves the block-controls page from the POSTed snapshot so each command re-renders for real.
async function openBlockControls(page: Page) {
  let failNext = false;
  const { posts } = await serveCanvasPreview(
    page,
    (data, marker, snapshot) => {
      if (failNext) {
        failNext = false;
        return { error: { status: 422, message: 'Fixture render refused.' } };
      }
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
              ? marker({
                  document: { collection: 'globals', id: 'shared-promo' },
                  locale: snapshot.locale,
                  address: 'blocks[_id=shared-promo]',
                  occurrence: { document: snapshot.entry, locale: snapshot.locale, address: at },
                })
              : marker(at);
            const heading = block.heading
              ? `<h2 data-handover-field='${marker(`${at}.heading`)}'>${safe(block.heading)}</h2>`
              : '';
            const columns = Array.isArray(block.columns)
              ? `<div>${(block.columns as Record<string, unknown>[])
                  .map((column) => {
                    const columnAt = `${at}.columns[_id=${String(column._id ?? '')}]`;
                    const nested = Array.isArray(column.blocks)
                      ? (column.blocks as Record<string, unknown>[])
                      : [];
                    return `<div data-column-id="${safe(column._id)}" data-handover-block='${marker(columnAt)}' data-handover-list='${marker(`${columnAt}.blocks`)}'>${nested.length ? renderBlocks(nested, `${columnAt}.blocks`) : '<p data-empty-list>Empty nested list</p>'}</div>`;
                  })
                  .join('')}</div>`
              : '';
            return `<section style="padding:20px" data-block-id="${safe(id)}" data-handover-block='${blockMarker}'>${heading}${columns}</section>`;
          })
          .join('');
      return `<main data-handover-list='${marker('blocks')}'>${renderBlocks(data.blocks ?? [], 'blocks')}</main>`;
    },
    { shell: '/canvas-shell?c30' },
  );

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  const structureButton = page.getByRole('button', { name: 'Structure', exact: true });
  const openStructure = async () => {
    if ((await structureButton.getAttribute('aria-expanded')) !== 'true')
      await structureButton.click();
    await expect(page.locator('#canvas-structure')).toBeVisible();
  };
  const useCanvasAction = async (
    name: 'Delete' | 'Insert after' | 'Duplicate',
    selectedLabel: string,
  ) => {
    const action = frame.getByRole('button', {
      name: `${name} ${selectedLabel}`,
    });
    await expect(action).toBeVisible();
    await action.evaluate((button) => button.click());
  };
  const editor = page.locator('.canvas-block-editor');
  const inspector = page.locator('#canvas-inspector');
  const structure = page.locator('#canvas-structure');
  const treeRow = (address: string) =>
    structure.locator(
      `[role="treeitem"][data-target-address="${address}"] > .canvas-structure-row`,
    );
  const first = frame.locator('[data-block-id="repeat01"]');
  // The page-top block's hover label is drawn over its top edge, so click its bottom padding.
  const clickFirst = async () => {
    const box = await first.boundingBox();
    if (!box) throw new Error('Missing first block');
    await first.click({ position: { x: 5, y: box.height - 5 } });
  };
  return {
    frame,
    editor,
    inspector,
    structure,
    openStructure,
    useCanvasAction,
    treeRow,
    clickFirst,
    posts,
    failNextRender: () => {
      failNext = true;
    },
  };
}

test('Structure drags blocks by pointer and keyboard, cancels with Escape, and undoes', async ({
  page,
}, testInfo) => {
  const { frame, structure, openStructure, treeRow, posts } = await openBlockControls(page);
  await openStructure();
  expect(
    await treeRow('blocks[_id=columns1].columns[_id=column01]').evaluate((row) => {
      const group = row.parentElement?.closest('[role="group"]');
      const parent = group?.parentElement;
      return (
        parent?.getAttribute('role') === 'treeitem' &&
        parent.getAttribute('aria-expanded') === 'true'
      );
    }),
  ).toBe(true);
  const treeDrag = async (cancel: boolean) => {
    const handle = treeRow('blocks[_id=repeat01]').locator('.canvas-structure-drag');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    if (!box) throw new Error('Missing Structure drag handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 4 });
    await expect(structure.locator('[data-dnd-dragging]')).toBeVisible();
    await expect(treeRow('blocks[_id=columns1]')).toHaveCSS('opacity', '1');
    await expect(treeRow('blocks[_id=columns1].columns[_id=column01]')).toHaveCSS('opacity', '0.3');
    const target = await treeRow('blocks[_id=columns1]').boundingBox();
    if (!target) throw new Error('Missing Structure drop target');
    await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2, { steps: 15 });
    await page.screenshot({ path: testInfo.outputPath(`structure-drag-${cancel}.png`) });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(structure.locator('[data-dnd-dragging]')).toHaveCount(0);
    await expect(treeRow('blocks[_id=columns1].columns[_id=column01]')).toHaveCSS('opacity', '1');
  };
  const rootOrder = async () => {
    try {
      return await frame
        .locator('main > [data-block-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-block-id')));
    } catch (error) {
      if (error instanceof Error && error.message.includes('Frame was detached')) return [];
      throw error;
    }
  };
  const beforeTreeDrag = await rootOrder();
  const rendersBeforeCancel = posts();
  await treeDrag(true);
  expect(await rootOrder()).toEqual(beforeTreeDrag);
  expect(posts()).toBe(rendersBeforeCancel);
  await treeDrag(false);
  await expect.poll(rootOrder).toEqual(['columns1', 'repeat01', ...beforeTreeDrag.slice(2)]);
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]')).toHaveCount(
    1,
  );
  await page.screenshot({ path: testInfo.outputPath('structure-sorting.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(rootOrder).toEqual(beforeTreeDrag);
  const columnsHandle = treeRow('blocks[_id=columns1]').locator('.canvas-structure-drag');
  await columnsHandle.focus();
  await page.keyboard.press('Space');
  await expect(structure.locator('[data-dnd-dragging]')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect.poll(rootOrder).toEqual(['columns1', 'repeat01', ...beforeTreeDrag.slice(2)]);
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(rootOrder).toEqual(beforeTreeDrag);
});

test('Add block in Structure opens the block editor and Back returns focus', async ({
  page,
}, testInfo) => {
  const { editor, structure, openStructure } = await openBlockControls(page);
  await openStructure();
  await structure.getByRole('button', { name: 'Add block', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(structure.locator('.canvas-block-editor')).toBeVisible();
  await expect(page.locator('#canvas-inspector')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('structure-add-block.png') });
  await editor.getByRole('button', { name: 'Back to Structure' }).click();
  await expect(editor).toHaveCount(0);
  await expect(structure.getByRole('tree')).toBeVisible();
  await expect(structure.getByRole('button', { name: 'Add block', exact: true })).toBeFocused();
});

test('an inserted block saves while incomplete, renders once completed, and deletes', async ({
  page,
}, testInfo) => {
  const { frame, editor, inspector, openStructure, useCanvasAction, clickFirst, posts } =
    await openBlockControls(page);
  await clickFirst();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(inspector.locator('.canvas-inspector-context')).toContainText('Block 1');
  const insertAfterFirst = frame.getByRole('button', { name: 'Insert after Block 1' });
  await expect(insertAfterFirst).toBeVisible();
  await insertAfterFirst.click();
  await expect(
    editor.getByRole('list', { name: 'Allowed block types' }).getByRole('button'),
  ).toHaveText([/repeated/, /promo/, /columns/]);
  const postsBeforeIncompleteBlock = posts();
  await editor.getByRole('button', { name: /repeated/ }).click();
  await expect(editor).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(page.locator('.canvas-validation.is-incomplete')).toContainText(
    'Complete required fields',
  );
  await page.waitForFunction(() => window.canvasDraftWrites.length > 0);
  await expect(page.locator('.canvas-entry-actions .autosave')).toContainText('Saved');
  expect(posts()).toBe(postsBeforeIncompleteBlock);
  await expect(page.locator('.canvas-failure')).toHaveCount(0);
  await expect(inspector.locator('.error')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('incomplete-block.png') });

  await inspector.getByLabel('Heading').fill('Inserted beside the first block');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(frame.getByText('Inserted beside the first block')).toBeVisible();

  await frame
    .getByText('Inserted beside the first block')
    .locator('..')
    .click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Delete', 'Block 2');
  await expect(frame.getByText('Inserted beside the first block')).toHaveCount(0);
});

test('Insert after renders the new block, Back cancels without a render, and empty lists take blocks', async ({
  page,
}) => {
  const { frame, editor, inspector, openStructure, useCanvasAction, clickFirst, posts } =
    await openBlockControls(page);
  await clickFirst();
  await useCanvasAction('Insert after', 'Block 1');
  await editor.getByRole('button', { name: /promo/ }).click();
  await inspector.getByLabel('Heading').fill('New promotion');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(frame.getByText('New promotion')).toBeVisible();

  const beforeCancel = posts();
  await frame
    .getByText('New promotion')
    .locator('..')
    .click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Insert after', 'Block 2');
  await editor.getByRole('button', { name: 'Back to Structure' }).click();
  await expect(editor).toHaveCount(0);
  expect(posts()).toBe(beforeCancel);

  await frame.locator('[data-empty-list]').click();
  await frame.getByRole('button', { name: 'Add block to Blocks' }).click();
  await editor.getByRole('button', { name: /repeated/ }).click();
  await inspector.getByLabel('Heading').fill('Nested list insertion');
  await inspector.getByLabel('Heading').press('Tab');
  await expect(frame.getByText('Nested list insertion')).toBeVisible();
});

test('duplicating a block gives every nested copy a fresh ID', async ({ page }) => {
  const { frame, openStructure, useCanvasAction } = await openBlockControls(page);
  const columns = frame.locator('[data-block-id="columns1"]');
  await columns.click({ position: { x: 5, y: 5 } });
  await openStructure();
  await useCanvasAction('Duplicate', 'Block 2');
  await expect(frame.locator('main > [data-block-id]')).toHaveCount(3);
  const generated = await frame
    .locator('[data-block-id], [data-column-id]')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => node.getAttribute('data-block-id') ?? node.getAttribute('data-column-id') ?? '',
      ),
    );
  expect(new Set(generated).size).toBe(generated.length);
  expect(generated).not.toContain('');
});

test('nested blocks reorder by pointer, Structure keyboard, and Alt+Arrow, and Escape cancels', async ({
  page,
}, testInfo) => {
  const { frame, structure, openStructure, treeRow } = await openBlockControls(page);
  const originalNested = frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]');
  const pointerDrag = async (finish: 'drop' | 'escape') => {
    await originalNested.click({ position: { x: 5, y: 5 } });
    await expect(frame.getByRole('button', { name: /^Drag Block/ })).toBeVisible();
    let handle: { x: number; y: number; width: number; height: number } | null = null;
    await expect
      .poll(async () => {
        handle = await frame.getByRole('button', { name: /^Drag Block/ }).boundingBox();
        return handle;
      })
      .not.toBeNull();
    const box = handle as { x: number; y: number; width: number; height: number } | null;
    if (!box) throw new Error('Missing drag handle');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 10, { steps: 3 });
    await expect(frame.locator('[data-dnd-dragging]')).toBeVisible();
    await expect
      .poll(() =>
        frame
          .locator('[data-dnd-dragging]')
          .evaluate((node) =>
            node.parentElement ? getComputedStyle(node.parentElement).scale : '',
          ),
      )
      .toBe('0.65');
    const sibling = await frame
      .locator('[data-block-id="columns1"] [data-block-id="promo001"]')
      .boundingBox();
    if (!sibling) throw new Error('Missing drop target');
    await page.mouse.move(x, sibling.y + sibling.height / 2 + 10, { steps: 15 });
    await expect(frame.locator('.live')).toContainText('position 2');
    if (finish === 'escape') await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(frame.locator('[data-dnd-dragging]')).toHaveCount(0);
    await expect(frame.locator('.actions')).toHaveCSS('opacity', '1');
  };
  const nestedOrder = async () => {
    try {
      return await frame
        .locator('[data-block-id="columns1"] [data-column-id="column01"] > [data-block-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-block-id')));
    } catch (error) {
      // The fixture intentionally replaces its preview frame after a block command. A concurrent
      // assertion can observe that handoff; let expect.poll retry against the replacement frame.
      if (error instanceof Error && error.message.includes('Frame was detached')) return [];
      throw error;
    }
  };
  await pointerDrag('escape');
  await expect.poll(nestedOrder).toEqual(['repeat02', 'promo001']);
  await openStructure();
  const nestedTreeHandle = treeRow(
    'blocks[_id=columns1].columns[_id=column01].blocks[_id=promo001]',
  ).locator('.canvas-structure-drag');
  await nestedTreeHandle.focus();
  await page.keyboard.press('Space');
  await expect(structure.locator('[data-dnd-dragging]')).toBeVisible();
  await expect(treeRow('blocks[_id=columns1]')).toHaveCSS('opacity', '0.3');
  await expect(
    treeRow('blocks[_id=columns1].columns[_id=column01].blocks[_id=repeat02]'),
  ).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('structure-drag-scope.png') });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect.poll(nestedOrder).toEqual(['promo001', 'repeat02']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(nestedOrder).toEqual(['repeat02', 'promo001']);
  await pointerDrag('drop');
  await expect.poll(nestedOrder).toEqual(['promo001', 'repeat02']);
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="repeat02"]')
    .click({ position: { x: 5, y: 5 } });
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
  await expect(frame.getByRole('button', { name: /^Move Block.* down/ })).toBeVisible();
  await originalNested.evaluate((node) =>
    node.ownerDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    ),
  );
  await expect.poll(nestedOrder).toEqual(['promo001', 'repeat02']);
});

test('deleting nested blocks writes the draft and Undo restores them', async ({ page }) => {
  const { frame } = await openBlockControls(page);
  const promoAddress = 'blocks[_id=columns1].columns[_id=column01].blocks[_id=promo001]';
  await frame
    .locator('[data-block-id="columns1"] [data-block-id="promo001"]')
    .click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.canvas-workspace')).toHaveAttribute(
    'data-selected-address',
    promoAddress,
  );
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
  const deleteRepeated = frame.getByRole('button', { name: /^Delete Block/ });
  await expect(deleteRepeated).toBeVisible();
  await deleteRepeated.evaluate((button) => button.click());
  await expect(frame.locator('[data-block-id="columns1"] [data-block-id="repeat02"]')).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.canvasDraftWrites.some((write) =>
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
});

test('Canvas comes back updated after a language round trip through Form', async ({ page }) => {
  await openBlockControls(page);
  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await page.getByRole('button', { name: /^DE(?: —|$)/ }).click();
  await expect
    .poll(() =>
      page
        .locator('input')
        .evaluateAll((inputs) => inputs.some((input) => input.value === 'Verschachteltes Feld')),
    )
    .toBe(true);
  await page.getByRole('button', { name: /^EN(?: —|$)/ }).click();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.canvas-render-state')).toHaveText('Canvas updated');
  await expect(page.locator('iframe[data-handover-canvas-frame="candidate"]')).toHaveCount(0);
});

test('a failed render keeps the last page and the edit, and Retry renders it', async ({ page }) => {
  const { frame, editor, inspector, openStructure, useCanvasAction, clickFirst, failNextRender } =
    await openBlockControls(page);
  await clickFirst();
  await openStructure();
  await useCanvasAction('Insert after', 'Block 1');
  await editor.getByRole('button', { name: /repeated/ }).click();
  failNextRender();
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
