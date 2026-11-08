import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Only run against an explicitly selected disposable fictional-data instance.
const phrase = 'fictional browser vault unlock phrase';
async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[name="login"]').fill('fictional-ui');
  await page.locator('[name="password"]').fill('fictional-login-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const create = page.getByRole('heading', { name: '创建私人资料库', exact: true });
  await expect(create.or(page.getByRole('heading', { name: '打开你的资料库', exact: true }))).toBeVisible();
  if (await create.isVisible()) {
    await page.locator('[name="setupPassphrase"]').fill(phrase);
    await page.locator('[name="setupRepeated"]').fill(phrase);
    await page.getByRole('button', { name: '创建资料库', exact: true }).click();
    await page.getByRole('checkbox', { name: '我已安全保存，并理解丢失后的风险' }).check();
    await page.getByRole('button', { name: '进入知交', exact: true }).click();
  } else await unlock(page);
  await expect(page.getByRole('heading', { name: '留住值得记住的细节', exact: true })).toBeVisible();
}
async function unlock(page: Page) {
  await page.locator('[name="unlockSecret"]').fill(phrase);
  await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
}
async function navigate(page: Page, name: string) {
  const navigation = page.viewportSize()!.width < 700 ? page.locator('nav.mobile-nav') : page.locator('.sidebar nav');
  await navigation.getByRole('button', { name, exact: true }).click();
}
async function journal(page: Page) {
  await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
  return page.getByRole('dialog', { name: '记一笔', exact: true });
}
async function save(form: Locator, name = '保存') {
  await form.getByRole('button', { name, exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(form.page().locator('.status-dot.warning')).toHaveCount(0);
}
function card(page: Page, title: string) {
  return page.locator('.record-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
async function edit(page: Page, title: string) {
  await card(page, title).getByRole('button', { name: '编辑记录', exact: true }).click();
  return page.getByRole('dialog', { name: '编辑交往', exact: true });
}
async function choosePerson(page: Page, form: Locator, name: string) {
  await form.locator('[name="people"]').click();
  const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
  await picker.getByRole('textbox', { name: '搜索人物', exact: true }).fill(name);
  await picker.locator('.person-row').filter({ hasText: name }).click();
  await picker.getByRole('button', { name: '确认（1）', exact: true }).click();
}
async function unlinkPerson(page: Page, form: Locator, name: string, clearAll = false) {
  await form.locator('[name="people"]').click();
  const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
  if (clearAll) await picker.getByRole('button', { name: '取消全部关联', exact: true }).click();
  else {
    await picker.getByRole('textbox', { name: '搜索人物', exact: true }).fill(name);
    await picker.locator('.person-row').filter({ hasText: name }).click();
  }
  await expect(picker.getByRole('button', { name: '确认（0）', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: '确认（0）', exact: true }).click();
}
async function timeline(page: Page, name: string) {
  await navigate(page, '人物');
  await page.locator('.person-card').filter({ hasText: name }).click();
  await page.locator('.detail-tabs').getByRole('button', { name: /^交往/ }).click();
}
async function screenshot(page: Page, name: string) {
  await mkdir('.local/optional-participants-verified/screenshots', { recursive: true });
  await page.screenshot({ path: `.local/optional-participants-verified/screenshots/${name}.png`, fullPage: true });
}

test.describe('optional participants on desktop', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test('the account owner is available as a default person and can be linked to an interaction', async ({ page }) => {
    await enter(page);
    await navigate(page, '人物');
    const self = page.locator('.person-card').filter({ has: page.getByText('账号本人', { exact: true }) });
    await expect(self).toHaveCount(1);
    await expect(page.locator('.person-card').first()).toContainText('账号本人');
    await page.getByRole('textbox', { name: '搜索全部人物' }).fill('我');
    await self.click();
    await expect(page.getByRole('heading', { name: '我', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除人物', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '归档人物', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑人物', exact: true });
    const summary = '虚构账号的个人简介';
    await editor.locator('[name="summary"]').fill(summary);
    await save(editor);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();

    await navigate(page, '首页');
    const form = await journal(page);
    await form.locator('[name="people"]').click();
    const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
    await picker.locator('.person-row').filter({ has: page.getByText('账号本人', { exact: true }) }).click();
    await picker.getByRole('button', { name: '确认（1）', exact: true }).click();
    const title = `虚构个人记录${Date.now()}`;
    await form.locator('[name="title"]').fill(title);
    await save(form, '保存这一笔');
    await page.reload(); await unlock(page);
    await timeline(page, '账号本人');
    await expect(card(page, title)).toBeVisible();
  });

  test('complete unlinked records survive reload, edits, linking, unlinking, history and person timeline regression', async ({ page, context }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await enter(page); await navigate(page, '人物');
    const originalPeople = await page.locator('.person-card').count(); await navigate(page, '首页');
    const suffix = Date.now(); const event = `虚构无人物散步${suffix}`;
    const feeling = `虚构独自整理感受${suffix}`; const linked = `虚构既有人物交往${suffix}`; const person = `虚构可选关联人物${suffix}`;
    // Keep these three fictional records eligible for the home's latest-five list even when other suites ran first.
    const dates = [14, 13, 12].map(days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10));

    let form = await journal(page);
    await expect(form.locator('[name="people"]')).not.toHaveAttribute('aria-required', 'true');
    await form.getByRole('button', { name: '保存这一笔', exact: true }).click();
    await expect(form.locator('[name="content"]')).toBeFocused();
    await expect(form.locator('[name="people"]')).not.toHaveAttribute('aria-invalid', 'true');
    await form.locator('[name="title"]').fill(event);
    await form.locator('[name="date"]').fill(dates[0]);
    // Explicitly confirming zero people is a valid choice even in an empty directory.
    await form.locator('[name="people"]').click();
    const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
    await expect(picker.getByRole('button', { name: '确认（0）', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: '确认（0）', exact: true }).click();
    await save(form, '保存这一笔');
    await expect(card(page, event)).toBeVisible();

    form = await journal(page);
    // A feeling can be written directly in the existing interaction body without a person or manually named title.
    await form.locator('[name="content"]').fill(feeling);
    await form.locator('[name="date"]').fill(dates[1]);
    await save(form, '保存这一笔');
    await expect(card(page, feeling)).toBeVisible();
    await navigate(page, '人物');
    await expect(page.locator('.person-card')).toHaveCount(originalPeople);
    await expect(page.getByText('陌生人', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '新建人物', exact: true }).first().click();
    form = page.getByRole('dialog', { name: '新建人物', exact: true });
    await form.locator('[name="displayName"]').fill(person); await save(form);
    await page.locator('.person-card').filter({ hasText: person }).click();
    form = await journal(page); await expect(form.locator('[name="people"]')).toContainText(person);
    await form.locator('[name="title"]').fill(linked); await form.locator('[name="date"]').fill(dates[2]);
    await save(form, '保存这一笔');
    await page.locator('.detail-tabs').getByRole('button', { name: /^交往/ }).click();
    await expect(card(page, linked)).toBeVisible(); await expect(card(page, event)).toHaveCount(0);

    await navigate(page, '交往');
    await expect(page.locator('.record-card').filter({ hasText: String(suffix) }).locator('h3')).toHaveText([event, feeling, linked]);
    const search = page.getByRole('textbox', { name: '搜索交往', exact: true });
    await search.fill(feeling); await expect(page.locator('.record-card')).toHaveCount(1);
    await expect(card(page, feeling)).toBeVisible();
    await search.fill(dates[0]); await expect(card(page, event)).toBeVisible();
    await expect(card(page, feeling)).toHaveCount(0); await search.fill('');
    await expect(page.locator('.status-dot.warning')).toHaveCount(0);
    await page.reload(); await unlock(page); await navigate(page, '交往');
    await expect(card(page, event)).toBeVisible(); await expect(card(page, feeling)).toBeVisible();

    // EntityEditor shares QuickJournal's body-only semantics.
    form = await edit(page, feeling); await form.locator('[name="title"]').fill('');
    await expect(form.locator('[name="content"]')).toHaveValue(feeling); await save(form);
    await expect(card(page, feeling)).toBeVisible();

    form = await edit(page, event);
    await expect(form.locator('[name="content"]')).toHaveValue('');
    await form.locator('[name="content"]').fill('虚构事件编辑后正文，保留独立记录。'); await save(form);
    form = await edit(page, event); await choosePerson(page, form, person); await save(form);
    await timeline(page, person); await expect(card(page, event)).toBeVisible(); await expect(card(page, linked)).toBeVisible();
    form = await edit(page, event); await unlinkPerson(page, form, person); await save(form);
    await expect(card(page, event)).toHaveCount(0); await expect(card(page, linked)).toBeVisible();
    await navigate(page, '交往'); await expect(card(page, event)).toBeVisible();
    form = await edit(page, event); await expect(form.locator('[name="content"]')).toHaveValue('虚构事件编辑后正文，保留独立记录。');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.status-dot.warning')).toHaveCount(0);
    await card(page, event).getByRole('button', { name: /虚构无人物散步/ }).first().click();
    await page.getByRole('dialog', { name: event, exact: true }).getByRole('button', { name: '查看历史', exact: true }).click();
    const history = page.getByRole('dialog', { name: '历史版本', exact: true });
    await expect(history.locator('.version-card')).toHaveCount(4);
    const firstVersion = history.locator('.version-card').filter({ has: page.getByText('版本 1', { exact: true }) });
    await firstVersion.getByRole('button', { name: '预览内容', exact: true }).click();
    await expect(firstVersion.locator('.history-preview')).toContainText('"participantIds": []');
    await firstVersion.getByRole('button', { name: '将此版恢复为新版本', exact: true }).click();
    await expect(history).not.toBeVisible();
    form = await edit(page, event); await expect(form.locator('[name="content"]')).toHaveValue('');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await timeline(page, person); await expect(card(page, event)).toHaveCount(0); await expect(card(page, linked)).toBeVisible();

    // A second browser has no IndexedDB cache and must obtain the record through encrypted server sync.
    const secondContext = await context.browser()!.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
    const second = await secondContext.newPage(); await enter(second); await navigate(second, '交往');
    await expect(card(second, event)).toBeVisible(); await expect(card(second, feeling)).toBeVisible(); await expect(card(second, linked)).toBeVisible();
    await secondContext.close();
    await navigate(page, '首页'); await screenshot(page, 'desktop-home');
    await navigate(page, '交往'); await screenshot(page, 'desktop-interactions');
    expect(errors).toEqual([]);
  });
});

test.describe('optional participants on phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('body-only feeling, selection cancellation, linking and clearing remain usable on a narrow viewport', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await enter(page);
    const name = `虚构手机关联人物${Date.now()}`;
    await navigate(page, '人物'); await page.getByRole('button', { name: '新建人物', exact: true }).click();
    let form = page.getByRole('dialog', { name: '新建人物', exact: true });
    await form.locator('[name="displayName"]').fill(name); await save(form); await navigate(page, '首页');
    const feeling = `虚构手机独立感受${Date.now()}`;
    form = await journal(page); await form.locator('[name="content"]').fill(feeling);
    await form.locator('[name="people"]').click();
    const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
    await picker.getByRole('textbox', { name: '搜索人物', exact: true }).fill('虚构取消后不创建的人');
    await picker.getByRole('button', { name: '新建「虚构取消后不创建的人」并选中', exact: true }).click();
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await expect(form.locator('[name="people"]')).not.toContainText('虚构取消后不创建的人');
    await screenshot(page, 'mobile-journal'); await save(form, '保存这一笔');
    await navigate(page, '交往');
    await expect(card(page, feeling)).toBeVisible();
    form = await edit(page, feeling);
    await expect(form.locator('[name="content"]')).toHaveValue(feeling);
    await form.locator('[name="people"]').click();
    await picker.getByRole('textbox', { name: '搜索人物', exact: true }).fill(name);
    await picker.locator('.person-row').filter({ hasText: name }).click();
    await picker.getByRole('button', { name: '确认（1）', exact: true }).click(); await save(form);
    await timeline(page, name); await expect(card(page, feeling)).toBeVisible();
    form = await edit(page, feeling); await unlinkPerson(page, form, name, true);
    await page.setViewportSize({ width: 390, height: 520 });
    const button = await form.getByRole('button', { name: '保存', exact: true }).boundingBox();
    expect(button && button.y + button.height).toBeLessThanOrEqual(520);
    await save(form); await page.setViewportSize({ width: 390, height: 844 });
    await expect(card(page, feeling)).toHaveCount(0); await navigate(page, '交往'); await expect(card(page, feeling)).toBeVisible();
    await screenshot(page, 'mobile-interactions');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload(); await unlock(page); await navigate(page, '交往'); await expect(card(page, feeling)).toBeVisible();
    await navigate(page, '人物'); await expect(page.locator('.person-card').filter({ hasText: '虚构取消后不创建的人' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
