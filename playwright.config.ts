import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./tests/e2e', fullyParallel:false, workers:1, timeout:60000,
  expect:{timeout:10000}, reporter:'list',
  use:{baseURL:process.env.E2E_BASE_URL??'http://127.0.0.1:3308',trace:'retain-on-failure',screenshot:'only-on-failure'},
});
