import { defineConfig } from '@playwright/test';

// End-to-end tests of the dashboard against the real server and Postgres (e2e/stack.mjs).
// Run: E2E_PG=postgres://pm_board:pm_board@localhost:55433/pm_board npm run e2e
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:5199', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'node e2e/stack.mjs',
    url: 'http://localhost:5199/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
