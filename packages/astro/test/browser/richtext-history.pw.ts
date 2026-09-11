import { expect, test } from '@playwright/test';

const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ page }) => {
  await page.goto('/richtext-history');
  await expect(page.locator('#f-summary')).toHaveAttribute('contenteditable', 'true');
});

test('typing uses session undo and redo and restores the cursor', async ({ page }) => {
  const richtext = page.locator('#f-summary');
  await richtext.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' coast');
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home coast');

  await page.keyboard.press(`${shortcut}+z`);
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = getSelection();
        return selection?.isCollapsed ? selection.anchorOffset : -1;
      }),
    )
    .toBe(12);

  await page.keyboard.press(`${shortcut}+Shift+z`);
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home coast');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = getSelection();
        return selection?.isCollapsed ? selection.anchorOffset : -1;
      }),
    )
    .toBe(18);
});

test('formatting and native beforeinput history intents use session history', async ({ page }) => {
  await page.locator('#f-summary').selectText();
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect(page.locator('[data-markdown]')).toHaveText('**Harbour home**');

  const prevented = await page.locator('#f-summary').evaluate((node) => {
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'historyUndo',
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home');
  await expect(page.locator('#f-summary strong')).toHaveCount(0);
});

test('paste is one reversible rich-text transaction', async ({ page }) => {
  await page.locator('#f-summary').selectText();
  await page.locator('#f-summary').evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Pasted words');
    node.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
    // Firefox does not apply synthetic clipboard payloads, but it does run the editor's paste
    // hook. Complete that same synchronous paste intent through its editing command there.
    if (node.textContent === 'Harbour home')
      node.ownerDocument.execCommand('insertText', false, 'Pasted words');
  });
  await expect(page.locator('[data-markdown]')).toHaveText('Pasted words');

  await page.keyboard.press(`${shortcut}+z`);
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home');
});

test('composition updates undo atomically', async ({ page }) => {
  await page.locator('#f-summary').selectText();
  await page.locator('#f-summary').evaluate(async (node) => {
    const editor = node as HTMLElement;
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    for (const value of ['に', '日本']) {
      const paragraph = editor.querySelector('p');
      if (!paragraph) throw new Error('rich-text paragraph missing');
      paragraph.textContent = value;
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      );
      await new Promise(requestAnimationFrame);
    }
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  });
  await expect(page.locator('[data-markdown]')).toHaveText('日本');

  await page.keyboard.press(`${shortcut}+z`);
  await expect(page.locator('[data-markdown]')).toHaveText('Harbour home');
});
