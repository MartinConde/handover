import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4329',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm fixture:build && pnpm fixture:start',
    env: { HOST: '127.0.0.1', PORT: '4329' },
    url: 'http://127.0.0.1:4329/canvas-fixture',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
