import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Explicitly selected disposable instance; all people, events and quotations are fictional.
const phrase = 'fictional browser vault unlock phrase';
test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await context.route('**/api/analysis/**', route => route.abort('blockedbyclient'));
});
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
  } else {
    await page.locator('[name="unlockSecret"]').fill(phrase);
    await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '留住值得记住的细节', exact: true })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  if (name === '设置' && page.viewportSize()!.width < 700) await page.locator('.top-settings').click();
  else await (page.viewportSize()!.width < 700 ? page.locator('nav.mobile-nav') : page.locator('.sidebar nav')).getByRole('button', { name, exact: true }).click();
}
async function save(form: Locator, repeated = false) {
  const button = form.getByRole('button', { name: '保存', exact: true });
  if (repeated) await button.dblclick(); else await button.click();
  await expect(form).not.toBeVisible();
  await expect(form.page().locator('.status-dot.warning')).toHaveCount(0);
}
async function createPerson(page: Page, name: string) {
  await navigate(page, '人物');
  await page.getByRole('button', { name: '新建人物', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '新建人物', exact: true });
  await form.getByLabel('常用称呼').fill(name); await save(form);
}
async function selectPerson(page: Page, form: Locator, name: string) {
  await form.locator('[name="people"]').click();
  const picker = page.getByRole('dialog', { name: '选择人物', exact: true });
  await picker.getByRole('textbox', { name: '搜索人物', exact: true }).fill(name);
  await picker.locator('.person-row').filter({ hasText: name }).click();
  // Single selection confirms immediately; multi selection has an explicit footer.
  const confirm = picker.getByRole('button', { name: '确认（1）', exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await expect(picker).not.toBeVisible();
}
async function interaction(page: Page, title: string, person?: string) {
  await navigate(page, '首页');
  await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '记一笔', exact: true });
  if (person) await selectPerson(page, form, person);
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="content"]').fill('虚构样例：讨论原则的适用范围，也保留不同解释。');
  await form.locator('[name="date"]').fill('2024-05-12');
  await form.getByRole('button', { name: '保存这一笔', exact: true }).click(); await expect(form).not.toBeVisible();
}
function card(page: Page, title: string) { return page.locator('.record-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }); }
async function openInteraction(page: Page, title: string) {
  await navigate(page, '交往'); await card(page, title).locator('.card-content').click();
  return page.getByRole('dialog', { name: title, exact: true });
}
async function capture(page: Page, name: string) {
  await expect(page.locator('.toast')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await mkdir('.local/topics-evidence', { recursive: true });
  await page.screenshot({ path: `.local/topics-evidence/${name}.png`, fullPage: page.viewportSize()!.width > 680 });
}

test('desktop: topic identity, multiple sources, quote attribution, editing history and evolving thoughts', async ({ page }) => {
  test.setTimeout(120000); await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await enter(page);
  const suffix = Date.now().toString().slice(-5), person = `虚构林青 ${suffix}`;
  const first = `读书会讨论 · 虚构 ${suffix}`, second = `独自复盘 · 虚构 ${suffix}`;
  const topic = `怎样表达不同意见 · 虚构 ${suffix}`, renamed = `合作中如何表达不同意见 · 虚构 ${suffix}`;
  const thought = `先澄清原则的适用条件 ${suffix}`, next = `分歧也需要共同约定 ${suffix}`;
  await createPerson(page, person); await interaction(page, first, person); await interaction(page, second);
  let details = await openInteraction(page, first);
  await details.getByRole('button', { name: '添加议题思考', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await expect(form.locator('[name="people"]')).toHaveCount(0);
  await form.getByLabel('所属议题').selectOption('__new__');
  await form.getByLabel('新议题名称').fill(topic);
  await form.getByLabel('新议题说明').fill('虚构样例：对问题的认识逐步积累，保留每次交往的来源。');
  await form.getByLabel('思考标题').fill(thought);
  await form.getByLabel('思考正文').fill('对一个原则有疑问时，先询问它成立的条件；这不意味着对表达者的人格作判断。');
  await form.locator('[name="recordedOn"]').fill('2026-10-30');
  await form.locator('[name="recordedAt"]').fill('2026-10-30T09:15');
  await expect(form.getByLabel('具体交往')).toHaveValue(/^[0-9a-f-]{36}$/);
  await form.locator('[name="evidenceCount"]').click();
  await form.getByLabel('具体交往').nth(1).selectOption({ label: first });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeVisible(); await expect(form.locator('.field-error')).not.toHaveCount(0);
  await form.getByLabel('具体交往').nth(1).selectOption({ label: second });
  await form.getByLabel('如何影响这条思考').nth(1).selectOption('supports');
  await form.getByLabel('添加引用（可选）').check();
  await form.getByLabel('引用方式').selectOption('paraphrase');
  await form.getByLabel('引用内容').fill('虚构转述：先讨论适用条件，再讨论是否赞同。');
  await form.getByLabel('引用表达者（已有的人物）').selectOption({ label: person });
  await form.getByLabel('引用来源交往（可选）').selectOption({ label: first });
  await form.getByLabel('新标签名称').fill('沟通与合作');
  await form.getByRole('button', { name: '添加', exact: true }).click(); await save(form, true);
  await navigate(page, '议题'); await expect(page.locator('.topic-card').filter({ hasText: topic })).toHaveCount(1);
  await page.locator('.topic-card').filter({ hasText: topic }).click();
  await expect(page.locator('.thought-entry')).toHaveCount(1);
  await expect(page.locator('.thought-sources button')).toHaveCount(2);
  const topicUrl = page.url();
  await page.getByRole('button', { name: '编辑议题', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑议题', exact: true });
  await form.getByLabel('议题名称').fill(renamed); await save(form);
  await expect(page.locator('.topic-detail h1')).toHaveText(renamed); expect(page.url()).toBe(topicUrl);
  await card(page, thought).locator('.card-content').click(); details = page.getByRole('dialog', { name: thought, exact: true });
  await expect(details).toContainText('思考作者：我'); await expect(details).toContainText(`表达者：${person}`);
  await expect(details.getByRole('heading', { name: '引用 · 转述', exact: true })).toBeVisible();
  await expect(details).toContainText('2026');
  await details.getByRole('button', { name: '编辑', exact: true }).click();
  form = page.getByRole('dialog', { name: '编辑议题思考', exact: true });
  await form.getByLabel('思考正文').fill('修正表述：先询问原则成立的条件，再判断它是否适用于眼前的情境。');
  await form.getByRole('button', { name: '移除此关联', exact: true }).nth(1).click(); await save(form);
  await expect(page.locator('.thought-sources button')).toHaveCount(1);
  await card(page, thought).locator('.card-content').click(); details = page.getByRole('dialog', { name: thought, exact: true });
  await details.getByRole('button', { name: '查看历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '历史版本', exact: true });
  await expect(history.locator('.version-card')).toHaveCount(2);
  await history.getByRole('button', { name: '预览内容', exact: true }).first().click();
  await expect(history.locator('pre')).toContainText('对一个原则有疑问时');
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  await card(page, thought).locator('.card-content').click(); details = page.getByRole('dialog', { name: thought, exact: true });
  await details.getByRole('button', { name: '追加新思考', exact: true }).click();
  form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await expect(form.getByLabel('认识变化所关联的旧思考')).toHaveValue(/^[0-9a-f-]{36}$/);
  await form.getByLabel('思考标题').fill(next);
  await form.getByLabel('思考正文').fill('新的认识：分歧持续出现时，可以共同约定表达和复盘的方式。');
  await form.locator('[name="evidenceCount"]').click();
  await form.getByLabel('具体交往').selectOption({ label: second }); await save(form);
  await expect(page.locator('.thought-entry')).toHaveCount(2);
  await capture(page, 'desktop-topic-timeline');
  await card(page, next).locator('.card-content').click();
  await expect(page.getByRole('dialog', { name: next, exact: true }).getByRole('button', { name: new RegExp(thought) })).toBeVisible();
  await page.getByRole('dialog', { name: next, exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(page, '人物'); await page.locator('.person-card').filter({ hasText: person }).click();
  await expect(page.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
  await expect(page.locator('.record-card')).toHaveCount(0);
  const localCiphertext = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('zhijiao-encrypted-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise<unknown[]>((resolve, reject) => { const request = db.transaction('vaults', 'readonly').objectStore('vaults').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close(); return JSON.stringify(rows);
  });
  for (const text of [renamed, thought, next, person, phrase, '虚构转述']) expect(localCiphertext).not.toContain(text);
  expect(errors).toEqual([]);
});

test('phone: five navigation slots, top settings, cancellation, Back and 320px layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await enter(page);
  await expect(page.locator('nav.mobile-nav button')).toHaveCount(5);
  await expect(page.locator('nav.mobile-nav button')).toHaveText(['首页', '人物', '交往', '议题', '事项']);
  await expect(page.locator('nav.mobile-nav').getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  await expect(page.locator('.top-settings')).toBeVisible(); await navigate(page, '设置');
  await expect(page.getByRole('heading', { name: '隐私与数据', exact: true })).toBeVisible();
  await navigate(page, '议题');
  const cancelled = `虚构取消议题 ${Date.now()}`;
  await page.getByRole('button', { name: '新建议题', exact: true }).first().click();
  let form = page.getByRole('dialog', { name: '新建议题', exact: true });
  await form.getByLabel('议题名称').fill(cancelled);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.topic-card').filter({ hasText: cancelled })).toHaveCount(0);
  await page.getByRole('button', { name: '新建议题', exact: true }).first().click();
  form = page.getByRole('dialog', { name: '新建议题', exact: true });
  await form.getByLabel('议题名称').fill(cancelled); await page.goBack();
  await expect(form).not.toBeVisible(); await navigate(page, '议题');
  await expect(page.locator('.topic-card').filter({ hasText: cancelled })).toHaveCount(0);
  await capture(page, 'mobile-topics');
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.locator('.top-settings')).toBeVisible(); await expect(page.locator('nav.mobile-nav button')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const settingsBounds = await page.locator('.top-settings').boundingBox(); expect(settingsBounds!.x + settingsBounds!.width).toBeLessThanOrEqual(320);
  await navigate(page, '设置'); await expect(page.getByRole('heading', { name: '隐私与数据', exact: true })).toBeVisible();
  await navigate(page, '议题'); await capture(page, 'mobile-topics-320');
  const suffix = Date.now().toString().slice(-5), event = `独自整理问题 · 虚构 ${suffix}`, topic = `怎样保留疑问 · 虚构 ${suffix}`;
  await interaction(page, event);
  const details = await openInteraction(page, event);
  await expect(details).toContainText('未关联人物');
  await details.getByRole('button', { name: '添加议题思考', exact: true }).click();
  form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await expect(form.locator('[name="people"]')).toHaveCount(0);
  await form.getByLabel('所属议题').selectOption('__new__');
  await form.getByLabel('新议题名称').fill(topic);
  await form.getByLabel('思考标题').fill(`保留尚未解决的问题 ${suffix}`);
  await form.getByLabel('思考正文').fill('虚构样例：没有人物参与的记录，也能成为问题思考的来源。');
  await save(form); await navigate(page, '议题'); await page.locator('.topic-card').filter({ hasText: topic }).click();
  await page.getByRole('button', { name: '添加思考', exact: true }).first().click();
  form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await form.getByLabel('思考标题').fill('取消的无来源思考');
  await form.getByLabel('思考正文').fill('沿用至少一条来源交往的规则。');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeVisible(); await expect(form).toContainText('请关联至少一条具体交往');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.thought-entry')).toHaveCount(1);
});

test('phone: one interaction yields separate person evaluation and topic thought without inferred attribution', async ({ page }) => {
  test.setTimeout(120000); await page.setViewportSize({ width: 390, height: 844 }); await enter(page);
  const suffix = Date.now().toString().slice(-5), person = `虚构周宁 ${suffix}`, event = `合作复盘 · 虚构 ${suffix}`;
  const topic = `怎样安排共同复盘 · 虚构 ${suffix}`, thought = `把复盘安排在决策之后 ${suffix}`, reflection = `这次沟通让我感到安心 ${suffix}`;
  await createPerson(page, person); await interaction(page, event, person);
  let details = await openInteraction(page, event); await details.getByRole('button', { name: '添加人物感受', exact: true }).click();
  let form = page.getByRole('dialog', { name: '新建感受与印象', exact: true });
  await expect(form.locator('[name="people"]')).toHaveText(/选择人物/);
  await form.locator('[name="content"]').fill(reflection); await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeVisible(); await selectPerson(page, form, person); await save(form);
  details = await openInteraction(page, event); await details.getByRole('button', { name: '添加议题思考', exact: true }).click();
  form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await expect(form.locator('[name="people"]')).toHaveCount(0);
  await form.getByLabel('所属议题').selectOption('__new__');
  await form.getByLabel('新议题名称').fill(`取消的${topic}`);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await navigate(page, '议题'); await expect(page.locator('.topic-card').filter({ hasText: `取消的${topic}` })).toHaveCount(0);
  details = await openInteraction(page, event); await details.getByRole('button', { name: '添加议题思考', exact: true }).click();
  form = page.getByRole('dialog', { name: '新建议题思考', exact: true });
  await form.getByLabel('所属议题').selectOption('__new__');
  await form.getByLabel('新议题名称').fill(topic);
  await form.getByLabel('思考标题').fill(thought);
  await form.getByLabel('思考正文').fill('虚构认识：把复盘与当下决策分开，让双方有时间整理不同意见。');
  await save(form, true);
  details = await openInteraction(page, event);
  await expect(details.getByRole('heading', { name: '人物感受', exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: '议题思考', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: new RegExp(thought) })).toHaveCount(1);
  await details.getByRole('heading', { name: '人物感受', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'mobile-interaction-two-lines'); await details.getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(page, '人物'); await page.locator('.person-card').filter({ hasText: person }).click();
  await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
  await expect(page.locator('.record-card')).toHaveCount(1); await expect(card(page, reflection)).toBeVisible(); await expect(card(page, thought)).toHaveCount(0);
  await navigate(page, '议题'); await page.locator('.topic-card').filter({ hasText: topic }).click();
  await expect(page.locator('.thought-entry')).toHaveCount(1); await capture(page, 'mobile-topic-timeline');
  await page.reload(); await page.locator('[name="unlockSecret"]').fill(phrase); await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
  await navigate(page, '议题'); await page.locator('.topic-card').filter({ hasText: topic }).click(); await expect(card(page, thought)).toBeVisible();
});
