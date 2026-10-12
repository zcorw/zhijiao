import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const phrase = 'fictional browser vault unlock phrase';
async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[name="login"]').fill('fictional-ui');
  await page.locator('[name="password"]').fill('fictional-login-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const create = page.getByRole('heading', { name: '创建私人资料库' });
  await expect(create.or(page.getByRole('heading', { name: '打开你的资料库' }))).toBeVisible();
  if (await create.isVisible()) {
    await page.locator('[name="setupPassphrase"]').fill(phrase); await page.locator('[name="setupRepeated"]').fill(phrase);
    await page.getByRole('button', { name: '创建资料库', exact: true }).click();
    await page.getByRole('checkbox', { name: '我已安全保存，并理解丢失后的风险' }).check();
    await page.getByRole('button', { name: '进入知交', exact: true }).click();
  } else {
    await page.locator('[name="unlockSecret"]').fill(phrase); await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
  }
  await page.getByRole('button', { name: '人物', exact: true }).first().click();
}
async function newPerson(page: Page, name: string) {
  await page.getByRole('button', { name: '新建人物', exact: true }).first().click();
  const person = page.getByRole('dialog', { name: '新建人物', exact: true });
  await person.locator('[name="displayName"]').fill(name); return person;
}
async function openDate(page: Page, person: Locator) {
  await person.getByRole('button', { name: '选择相识日期', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择相识日期', exact: true });
  await expect(picker).toBeVisible(); return picker;
}
async function editPerson(page: Page, name: string) {
  await page.locator('.person-card').filter({ hasText: name }).click();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  return page.getByRole('dialog', { name: '编辑人物', exact: true });
}
async function capture(page: Page, name: string) {
  // Only fictional date/person states. Never capture the recovery-secret screen.
  await mkdir('.local/date-check/screenshots', { recursive: true });
  await page.screenshot({ path: `.local/date-check/screenshots/${name}.png` });
}

test.describe('desktop partial dates', () => {
  test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 1440, height: 1000 } });
  test('exact precision, cancellation, encrypted save/reopen, legacy values and validation', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await enter(page); const name = `虚构日期往返${Date.now()}`;
    let person = await newPerson(page, name); const input = () => person.locator('[name="metOn"]');
    await input().fill('2024-02-29');
    await expect(person.locator('[name="birthday"]')).toHaveAttribute('type', 'text');
    let picker = await openDate(page, person);
    await expect(picker.getByRole('button', { name: '日', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: '月', exact: true }).click();
    await expect(picker.locator('.date-preview')).toHaveText('2024-02');
    await expect(input()).toHaveValue('2024-02-29');
    await picker.getByRole('button', { name: '取消日期选择' }).click();
    await expect(input()).toHaveValue('2024-02-29'); await expect(person).toBeVisible();
    picker = await openDate(page, person); await picker.getByRole('button', { name: '月', exact: true }).click();
    await picker.getByRole('button', { name: '确定日期' }).click(); await expect(input()).toHaveValue('2024-02');
    picker = await openDate(page, person); await picker.getByRole('button', { name: '日', exact: true }).click();
    await expect(picker.getByRole('button', { name: '确定日期' })).toBeDisabled();
    await picker.getByRole('gridcell', { name: '选择 2024-02-29', exact: true }).click();
    await expect(picker.locator('.date-preview')).toHaveText('2024-02-29');
    await expect(input()).toHaveValue('2024-02');
    await picker.getByRole('button', { name: '确定日期' }).click(); await expect(input()).toHaveValue('2024-02-29');
    picker = await openDate(page, person);
    const green = await picker.locator('.dp--active').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(green).toBe('rgb(84, 115, 83)');
    await capture(page, 'met-date-desktop');
    await picker.getByRole('button', { name: '年', exact: true }).click();
    await picker.getByRole('option', { name: '1990年', exact: true }).click();
    await picker.getByRole('button', { name: '确定日期' }).click(); await expect(input()).toHaveValue('1990');
    await person.getByRole('button', { name: '保存', exact: true }).dblclick(); await expect(person).not.toBeVisible();
    person = await editPerson(page, name); await expect(input()).toHaveValue('1990');
    picker = await openDate(page, person); await picker.getByRole('button', { name: '月', exact: true }).click();
    await expect(picker.getByRole('button', { name: '确定日期' })).toBeDisabled();
    await picker.getByRole('option', { name: '3月', exact: true }).click();
    await picker.getByRole('button', { name: '确定日期' }).click(); await expect(input()).toHaveValue('1990-03');
    await person.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await expect(input()).toHaveValue('1990');
    await input().fill('2025-02-29'); await person.getByRole('button', { name: '保存', exact: true }).click();
    await expect(input()).toBeFocused(); await expect(input()).toHaveAttribute('aria-invalid', 'true');
    await expect(person.getByText(/相识日期不合法/)).toBeVisible();
    const describedBy = await input().getAttribute('aria-describedby');
    expect(describedBy?.split(' ').length).toBe(2);
    for (const boundary of ['0001', '0078-03-01', '9999-12-31']) {
      await input().fill(boundary); await expect(input()).not.toHaveAttribute('aria-invalid', 'true');
      picker = await openDate(page, person); await picker.getByRole('button', { name: '取消日期选择' }).click();
      await expect(input()).toHaveValue(boundary);
    }
    await input().fill('--05-12'); await person.getByRole('button', { name: '保存', exact: true }).click();
    await expect(person).not.toBeVisible(); await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await expect(input()).toHaveValue('--05-12'); picker = await openDate(page, person);
    await expect(picker.getByRole('button', { name: '确定日期' })).toBeDisabled();
    await picker.getByRole('button', { name: '取消日期选择' }).click(); await expect(input()).toHaveValue('--05-12');
    await person.getByRole('button', { name: '清空相识日期' }).click(); await expect(input()).toHaveValue('');
    await person.getByRole('button', { name: '保存', exact: true }).click(); await expect(person).not.toBeVisible();
    await page.getByRole('button', { name: '锁定', exact: true }).first().click();
    await page.locator('[name="unlockSecret"]').fill(phrase); await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
    await page.getByRole('button', { name: '人物', exact: true }).first().click();
    person = await editPerson(page, name); await expect(input()).toHaveValue('');
    expect(errors).toEqual([]);
  });
});

test.describe('phone partial dates', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati', viewport: { width: 390, height: 844 } });
  test('timezone-safe day selection, keyboard, repeated opening and contained viewport', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await enter(page); const person = await newPerson(page, `虚构手机日期${Date.now()}`); const input = person.locator('[name="metOn"]');
    await input.fill('2024-02-29'); await input.press('Enter');
    let picker = page.getByRole('dialog', { name: '选择相识日期', exact: true }); await expect(picker).toBeVisible();
    await expect(person).toBeVisible(); await expect(input).toHaveAttribute('aria-expanded', 'true');
    await picker.getByRole('gridcell', { name: '选择 2024-02-29', exact: true }).click();
    await picker.getByRole('button', { name: '确定日期' }).click(); await expect(input).toHaveValue('2024-02-29');
    picker = await openDate(page, person);
    const box = await picker.boundingBox(); expect(box?.x).toBeGreaterThanOrEqual(0); expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    expect(box && box.y + box.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, 'met-date-mobile');
    const confirm = picker.getByRole('button', { name: '确定日期' }); await confirm.focus(); await confirm.press('Tab');
    await expect(picker.getByRole('button', { name: '日', exact: true })).toBeFocused();
    await picker.getByRole('button', { name: '日', exact: true }).press('Shift+Tab'); await expect(confirm).toBeFocused();
    await confirm.press('Escape'); await expect(picker).not.toBeVisible(); await expect(input).toBeFocused();
    for (let i = 0; i < 2; i++) {
      picker = await openDate(page, person); await picker.getByRole('button', { name: '日', exact: true }).press('Escape');
      await expect(picker).not.toBeVisible(); await expect(person).toBeVisible();
    }
    await input.fill('2024'); picker = await openDate(page, person);
    await picker.getByRole('button', { name: '日', exact: true }).click(); await expect(confirm).toBeDisabled();
    await picker.getByRole('gridcell', { name: '选择 2024-01-02', exact: true }).focus();
    await picker.getByRole('gridcell', { name: '选择 2024-01-02', exact: true }).press('Enter');
    await expect(picker.locator('.date-preview')).toHaveText('2024-01-02');
    await expect(input).toHaveValue('2024');
    await page.setViewportSize({ width: 390, height: 520 });
    await expect.poll(async () => { const short = await picker.boundingBox(); return short ? short.y + short.height : Infinity; }).toBeLessThanOrEqual(520);
    await expect.poll(async () => { const footer = await confirm.boundingBox(); return footer ? footer.y + footer.height : Infinity; }).toBeLessThanOrEqual(520);
    await confirm.click(); await expect(input).toHaveValue('2024-01-02');
    await person.getByRole('button', { name: '保存', exact: true }).click(); await expect(person).not.toBeVisible();
    expect(errors).toEqual([]);
  });
});
