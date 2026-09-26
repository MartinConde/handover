import { expect, test } from '@playwright/test';
import { serveCanvasPreview } from './canvas-helpers';

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

test('the narrow editor shell switches panes without losing its working snapshot', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/canvas-shell');

  const title = page.getByLabel('Title');
  await expect(title).toHaveValue('Canvas fixture');
  await title.fill('Unsaved narrow edit');

  const preview = page.getByRole('group', { name: 'Beside the form' }).getByRole('button', {
    name: 'Live preview',
  });
  const wasPressed = await preview.getAttribute('aria-pressed');
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', wasPressed === 'true' ? 'false' : 'true');
  if ((await preview.getAttribute('aria-pressed')) !== 'true') await preview.click();
  const panes = page.getByRole('group', { name: 'Split view pane' });
  await panes.getByRole('button', { name: 'Page' }).click();
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await expect(title).not.toBeVisible();
  await panes.getByRole('button', { name: 'Form' }).click();
  await expect(title).toHaveValue('Unsaved narrow edit');

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.shell')).toHaveClass(/is-canvas/);
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await expect(title).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await panes.getByRole('button', { name: 'Form' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Unsaved narrow edit');
});

test('Canvas mediates Interact links through saves, new sessions, previews, and history', async ({
  page,
  context,
}) => {
  let previewGets = 0;
  const { posts } = await serveCanvasPreview(
    page,
    ({ title = '' }, marker) =>
      `<nav><a data-next href="/second">Second page</a><a data-new href="/second" target="_blank">Second preview</a><a data-hash href="#details">Details</a></nav><h1 data-handover-field='${marker('title')}'>${title}</h1><div style="height:1000px"></div><h2 id="details">Details</h2>`,
    {
      pattern: '**/_preview/**',
      routes: context,
      get: () => {
        previewGets += 1;
        return '<!doctype html><title>Ordinary preview</title><p>Ordinary GET preview</p>';
      },
    },
  );
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

  await page.evaluate(() => window.canvasFailNextSave());
  await frame.locator('[data-next]').click();
  await expect(page.locator('.canvas-navigation-notice')).toContainText('Navigation stopped');
  expect(new URL(page.url()).pathname).toBe('/admin/c/pages/canvas-fixture');
  await page.getByRole('button', { name: 'Dismiss' }).click();

  await frame.locator('[data-next]').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/c/pages/second');
  frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Second page');
  expect(posts()).toBeGreaterThanOrEqual(2);

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
  await serveCanvasPreview(
    page,
    ({ title = '', button }, marker) =>
      `<h1 data-handover-field='${marker('title')}'>${title}</h1>${button ? `<a data-handover-field='${marker('button')}' href="${button.href ?? '#'}">${button.label ?? ''}</a>` : ''}`,
  );
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
  expect(
    await linkEditor.evaluate((panel) => {
      const label = panel.ownerDocument
        .querySelector('[data-handover-canvas-overlay]')
        ?.shadowRoot?.querySelector<HTMLElement>('.path');
      if (!label) throw new Error('Canvas label is missing');
      const previous = label.style.cssText;
      const rect = panel.getBoundingClientRect();
      // Force the label underneath the dialog to exercise the overlapping stacking contexts.
      label.style.left = `${rect.left + 20}px`;
      label.style.top = `${rect.top + 20}px`;
      const hit = panel.ownerDocument.elementFromPoint(rect.left + 30, rect.top + 25);
      label.style.cssText = previous;
      return panel.contains(hit);
    }),
  ).toBe(true);
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
  await expect(inspector).toHaveCount(0);
  await inspectorButton.click();
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
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const heading = page
    .locator('iframe[data-handover-canvas-frame="active"]')
    .contentFrame()
    .getByRole('heading', { level: 1 });
  await heading.click();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(page.locator('#canvas-inspector').getByLabel('Title')).toHaveValue(
    'Edited through Inspector',
  );
  await heading.click();
  await expect(heading).toHaveAttribute('contenteditable', 'true');
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-handover-canvas-frame="active"]',
    );
    const heading = frame?.contentDocument?.querySelector<HTMLElement>('h1');
    const input = document.querySelector<HTMLInputElement>('#canvas-inspector-title');
    if (!heading || !input) throw new Error('Canvas and Inspector text fixtures are missing.');
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    heading.dispatchEvent(before);
    heading.textContent = 'Rejected stale edit';
    const changed = new Event('input', { bubbles: true });
    Object.defineProperty(changed, 'inputType', { value: 'insertText' });
    heading.dispatchEvent(changed);
    input.value = 'External Inspector edit';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await expect(heading).toHaveText('External Inspector edit');
  await expect(heading).toHaveAttribute('data-handover-inline-refusal', 'stale-version');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to form' }).click();
  await expect(page.locator('#f-title')).toHaveValue('External Inspector edit');
});

test('drift blocks editing until reconciliation reloads a fresh Canvas session', async ({
  page,
}) => {
  await serveCanvasPreview(
    page,
    ({ title = '' }, marker) => `<h1 data-handover-field='${marker('title')}'>${title}</h1>`,
    { shell: '/canvas-shell?c33-drift' },
  );

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
  const escaped = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const prose = (value: string) => {
    const safe = escaped(value);
    const linked = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const marked = linked.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return marked.startsWith('# ') ? `<h1>${marked.slice(2)}</h1>` : `<p>${marked || '<br>'}</p>`;
  };
  await serveCanvasPreview(
    page,
    (data, marker) =>
      `<h1 data-handover-field='${marker('title')}'>${escaped(data.title ?? '')}</h1><div data-rich-summary data-handover-field='${marker('summary')}'>${prose(data.summary ?? '')}</div><div data-rich-body data-handover-field='${marker('body')}'>${prose(data.body ?? '')}</div><div data-rich-legacy data-handover-field='${marker('legacy')}'>${prose(data.legacy ?? '')}</div>`,
  );
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
  const legacyInspectorButton = page.getByRole('button', { name: 'Inspector', exact: true });
  if ((await legacyInspectorButton.getAttribute('aria-expanded')) !== 'true')
    await legacyInspectorButton.click();
  await expect(page.locator('#canvas-inspector')).toBeVisible();
  await expect(page.locator('#canvas-inspector')).toContainText('edited in code');

  await page.getByRole('button', { name: /^(Form|Back to form)$/ }).click();
  await expect(page.locator('#f-summary strong')).toHaveText('Harbour home');
  await expect(page.locator('#f-body')).toContainText('Room for everyone.');
  await expect(page.locator('#f-legacy-hint')).toContainText('edited in code');
});
