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

test('saved interface language wins before first paint and an Account switch preserves work', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'handover_ui_locale', value: 'de', url: 'http://127.0.0.1:4329/admin' },
  ]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['de-DE'] });
    const observer = new MutationObserver(() => {
      if (document.querySelector('.shell') && !document.documentElement.dataset.firstAdminLang) {
        document.documentElement.dataset.firstAdminLang = document.documentElement.lang;
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.route('**/admin/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/admin/api/ping') {
      await route.fulfill({
        json: {
          ok: true,
          collections: ['pages'],
          user: { id: 'u1', name: 'Martin', email: 'martin@example.com', uiLocale: 'en' },
          role: 'owner',
        },
      });
    } else if (path === '/admin/api/auth/update-user') {
      const body = request.postDataJSON() as { name?: string; uiLocale?: string };
      await route.fulfill(
        body.uiLocale
          ? { json: { status: true } }
          : { status: 502, json: { error: 'provider trace 7A' } },
      );
    } else if (path === '/admin/api/account')
      await route.fulfill({ json: { hasPassword: true, sessions: [] } });
    else if (path === '/admin/api/build') await route.fulfill({ json: {} });
    else if (path === '/admin/api/dashboard')
      await route.fulfill({ json: { recent: [], published: null, translations: null } });
    else await route.fulfill({ json: { entries: [] } });
  });

  await page.goto('/admin');
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-first-admin-lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await page.locator('.user-menu > button').click();
  await expect(page.locator('.user-menu .menu select')).toHaveCount(0);
  await page.getByRole('link', { name: 'Account' }).click();
  const picker = page.locator('main').getByLabel('Interface language');
  await expect(picker).toHaveValue('en');
  const accountName = page.locator('#display-name');
  await accountName.fill('Unsaved account name');
  await accountName.evaluate((input) => (input.dataset.localeProof = 'same-account-node'));
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('alert')).toContainText('Your name could not be saved.');
  await picker.selectOption('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Konto');
  await expect(page.getByRole('alert')).toContainText('Dein Name konnte nicht gespeichert werden.');
  await expect(accountName).toHaveValue('Unsaved account name');
  await expect(accountName).toHaveAttribute('data-locale-proof', 'same-account-node');
  expect(new URL(page.url()).pathname).toBe('/admin/account');
  const cookies = await context.cookies();
  expect(
    cookies.find((cookie) => cookie.name === 'handover_ui_locale' && cookie.path === '/admin'),
  ).toMatchObject({ value: 'de' });
  expect(cookies.some((cookie) => cookie.name === 'PARAGLIDE_LOCALE')).toBe(false);
});
