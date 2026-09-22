import { expect, test } from '@playwright/test';

// The fixture's own component is only in this bundle because the site's build compiled it in.
test('a screen the site declared is served by the admin the site built', async ({ page }) => {
  await page.route('**/admin/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/admin/api/ping')
      await route.fulfill({
        json: {
          ok: true,
          collections: ['pages'],
          user: { id: 'u1', name: 'Martin', email: 'martin@example.com', uiLocale: 'en' },
          role: 'owner',
          screens: [{ key: 'probe', label: 'Probe' }],
        },
      });
    else await route.fulfill({ json: {} });
  });

  await page.goto('/admin/x/probe');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Screen from the fixture');
  await expect(page.getByText('owner · en')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Probe' })).toBeVisible();
});
