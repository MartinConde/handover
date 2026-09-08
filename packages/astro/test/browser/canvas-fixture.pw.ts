import { expect, test } from '@playwright/test';

test('the built integration renders the Canvas fixture in Chromium', async ({ page }) => {
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

  await page.goto('/de/canvas-fixture');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Canvas-Testseite');
});
