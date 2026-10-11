import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('Set E2E_BASE_URL to a disposable fictional-data instance before running browser tests.');

export default defineConfig({
  testDir:'./tests/e2e', fullyParallel:false, workers:1, timeout:60000,
  expect:{timeout:10000}, reporter:'list',
  use:{baseURL,trace:'off',screenshot:'off'},
});
