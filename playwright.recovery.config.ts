import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/recovery', workers: 1, timeout: 60000,
  expect: { timeout: 15000 }, reporter: 'list',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3318', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
