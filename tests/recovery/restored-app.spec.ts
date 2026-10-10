import { test, expect } from '@playwright/test';

// Run only after restoring the fictional disposable E2E fixture into an
// isolated Compose project. No real user credential or production database.
test('clean browser unlocks restored ciphertext, history and independent avatar assets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('登录名', { exact: true }).fill('fictional-ui');
  await page.getByLabel('登录密码', { exact: true }).fill('fictional-login-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '打开你的资料库' })).toBeVisible();
  await page.getByLabel('资料库解锁口令', { exact: true }).fill('fictional browser vault unlock phrase');
  await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
  await expect(page.getByText(/^虚构散步/).first()).toBeVisible();
  await page.getByRole('button', { name: '人物', exact: true }).first().click();
  const card = page.locator('.person-card').filter({ hasText: '虚构林青' }).first();
  await expect(card.locator('img')).toHaveAttribute('src', /^blob:/);
  await card.click();
  const avatar = page.locator('.profile-header img');
  await expect(avatar).toHaveAttribute('src', /^blob:/);
  const pixels = await avatar.evaluate(async node => {
    const img = node as HTMLImageElement; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0, 128, 128);
    return { top: Array.from(ctx.getImageData(64, 32, 1, 1).data), bottom: Array.from(ctx.getImageData(64, 96, 1, 1).data) };
  });
  expect(pixels.top[0]).toBeGreaterThan(pixels.top[2] + 80);
  expect(pixels.bottom[2]).toBeGreaterThan(pixels.bottom[0] + 80);
  await page.getByRole('button', { name: '历史', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/版本/).first()).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/desktop-restored-history.png', fullPage: true });
  expect(errors).toEqual([]);
});
