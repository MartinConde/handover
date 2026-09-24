import { expect, test } from '@playwright/test';
import { openCanvas } from './canvas-helpers';

test('a failed inline rich-text download explains recovery and leaves Inspector editing available', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/chunks/canvas-rich-text-*.js', (route) => route.abort());
  await openCanvas(page);
  const frame = page.locator('iframe[data-handover-canvas-frame="active"]').contentFrame();
  await frame.locator('h1').click();
  await frame.locator('h1').fill('Title kept through editor failure');
  await frame.locator('h1').press('Escape');
  await expect(frame.locator('h1')).toHaveText('Title kept through editor failure');

  await frame.locator('[data-prose]').click();
  await expect(frame.getByRole('alert')).toContainText(
    'Inline text editing could not load. Open Inspector to edit this field.',
  );
  await expect(frame.locator('[data-prose]')).toHaveText('Room for everyone.');
  await expect(frame.getByRole('textbox', { name: 'Rich text in Canvas' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  const inspector = page.locator('#canvas-inspector');
  await inspector.locator('[contenteditable="true"]').fill('Recovered through Inspector.');
  await inspector.locator('[contenteditable="true"]').blur();
  await expect(frame.locator('[data-prose]')).toHaveText('Recovered through Inspector.');
  await expect(frame.locator('h1')).toHaveText('Title kept through editor failure');
});
