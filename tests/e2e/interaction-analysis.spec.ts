import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { InteractionAnalysisInput as InteractionAnalysis } from '../../packages/shared/src/index.js';

// Real authentication and encrypted vault writes use only the explicitly selected
// disposable fictional-data instance. Analysis responses never reach a provider.
const phrase = 'fictional browser vault unlock phrase';
const emptyResult: InteractionAnalysis = { people: [], reflections: [], followUps: [] };

test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.continue();
  });
  // Page-specific mocks below override this guard. An unhandled analysis request
  // must never fall through to a configured live AI service.
  await context.route('**/api/analysis/**', route => route.abort('blockedbyclient'));
});

async function unlock(page: Page) {
  await page.locator('[name="unlockSecret"]').fill(phrase);
  await page.getByRole('button', { name: '解锁资料库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '留住值得记住的细节', exact: true })).toBeVisible();
}

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
  await expect(page.locator('.status-dot.warning')).toHaveCount(0);
}

async function navigate(page: Page, name: string) {
  const navigation = page.viewportSize()!.width < 700 ? page.locator('nav.mobile-nav') : page.locator('.sidebar nav');
  await navigation.getByRole('button', { name, exact: true }).click();
}

function card(page: Page, title: string) {
  return page.locator('.record-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

function personCard(page: Page, name: string) {
  return page.locator('.person-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function saveForm(form: Locator, name: string) {
  await form.getByRole('button', { name, exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(form.page().locator('.status-dot.warning')).toHaveCount(0);
}

async function createPerson(page: Page, name: string) {
  await navigate(page, '人物');
  await page.getByRole('button', { name: '新建人物', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '新建人物', exact: true });
  await form.locator('[name="displayName"]').fill(name);
  await saveForm(form, '保存');
}

async function createInteraction(page: Page, title: string, content: string) {
  await navigate(page, '首页');
  await page.getByRole('button', { name: '记一笔', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '记一笔', exact: true });
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="content"]').fill(content);
  await saveForm(form, '保存这一笔');
}

async function openAnalysis(page: Page, title: string) {
  await navigate(page, '交往');
  await card(page, title).locator('.card-content').click();
  const details = page.getByRole('dialog', { name: title, exact: true });
  await details.getByRole('button', { name: '分析人物与事项', exact: true }).click();
  const analysis = page.getByRole('dialog', { name: '分析人物与事项', exact: true });
  await expect(analysis).toBeVisible();
  return analysis;
}

async function closeDetails(page: Page, title: string) {
  await page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
}

async function mockAnalysis(page: Page, initial: InteractionAnalysis = emptyResult) {
  let available = true;
  let result = initial;
  let delayed = false;
  let release: (() => void) | undefined;
  const requests: Array<{ title: string; content: string; occurredOn?: string }> = [];
  await page.route('**/api/analysis/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/analysis/status' && request.method() === 'GET') {
      await route.fulfill({ json: { available, providerLabel: 'fictional-mock' } });
    } else if (path === '/api/analysis/interaction' && request.method() === 'POST') {
      requests.push(request.postDataJSON());
      const response = result;
      if (delayed) await new Promise<void>(resolve => { release = resolve; });
      // Cancellation can abort this browser request before the delayed mock ends.
      await route.fulfill({ json: response }).catch(() => {});
    } else await route.abort('blockedbyclient');
  });
  return {
    requests,
    setAvailable(value: boolean) { available = value; },
    setResult(value: InteractionAnalysis) { result = value; },
    setDelayed(value: boolean) { delayed = value; },
    release() { release?.(); release = undefined; },
  };
}

function trackWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/vaults\/[^/]+\/operations$/.test(new URL(request.url()).pathname)) writes.push(request.postData() ?? '');
  });
  return writes;
}

async function screenshot(page: Page, name: string) {
  await mkdir('.tools/analysis-v2-screenshots', { recursive: true });
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: `.tools/analysis-v2-screenshots/${name}.png` });
}

test.describe('interaction analysis on desktop', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('review is explicit, selected edits persist with sources, and repeat analysis skips duplicates', async ({ page }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const suffix = Date.now();
    const existing = `虚构分析已有人物${suffix}`;
    const newcomer = `虚构分析新人物${suffix}`;
    const ignored = `虚构分析未选人物${suffix}`;
    const title = `虚构分析交往${suffix}`;
    const firstEvidence = `我觉得${existing}这次很周到`;
    const secondEvidence = `我和${newcomer}聊天感觉轻松`;
    const omittedFeeling = `我还觉得${existing}安排清楚`;
    const taskEvidence = `我答应给${existing}发送资料`;
    const otherTaskEvidence = `${newcomer}说他会发路线`;
    const content = `我和${existing}、${newcomer}见面，只提到了${ignored}。${firstEvidence}。${secondEvidence}。${omittedFeeling}。${taskEvidence}。${otherTaskEvidence}。`;
    const originalTask = `给${existing}发送资料`;
    const editedFeeling = `我对${existing}这次耐心说明的感受是安心，仅限本次。`;
    const editedTask = `核对后给${existing}发送资料`;
    const editedDetails = `先核对虚构资料，再发送给${existing}。`;
    const payload: InteractionAnalysis = {
      people: [
        { key: 'p1', name: '我（当前用户）', mention: '我和', isSelf: true },
        { key: 'p2', name: existing, mention: existing, isSelf: false },
        { key: 'p3', name: newcomer, mention: newcomer, isSelf: false },
        { key: 'p4', name: ignored, mention: ignored, isSelf: false },
      ],
      reflections: [
        { personKey: 'p2', type: 'feeling', content: firstEvidence, evidence: firstEvidence },
        { personKey: 'p3', type: 'experience', content: secondEvidence, evidence: secondEvidence },
        { personKey: 'p2', type: 'hypothesis', content: omittedFeeling, evidence: omittedFeeling },
      ],
      followUps: [
        { personKeys: ['p1', 'p2'], title: originalTask, details: taskEvidence, type: 'promise', responsibility: 'me', evidence: taskEvidence },
        { personKeys: ['p3'], title: `${newcomer}发路线`, details: otherTaskEvidence, type: 'promise', responsibility: 'other', evidence: otherTaskEvidence },
      ],
    };
    const mocked = await mockAnalysis(page, payload);
    const writes = trackWrites(page);
    await enter(page);
    await createPerson(page, existing);
    await navigate(page, '人物');
    const peopleBefore = await page.locator('.person-card').count();
    await createInteraction(page, title, content);
    const writesBefore = writes.length;

    let analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(analysis.getByText('候选默认均未选中。', { exact: false })).toBeVisible();
    await expect(analysis.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(analysis.getByRole('checkbox', { name: '选择人物：我（当前用户）', exact: true })).toHaveCount(0);
    await expect(analysis.getByText('当前用户 · 不建人物档案', { exact: true })).toBeVisible();
    await expect(analysis.getByRole('checkbox', { name: `选择感受与印象：${existing}，第1条`, exact: true })).toBeDisabled();
    await expect(analysis.getByRole('button', { name: /^确认写入/ })).toBeDisabled();
    await screenshot(page, 'desktop-candidates');
    expect(mocked.requests[0]).toEqual({ title, content, occurredOn: expect.any(String) });
    expect(Object.keys(mocked.requests[0]).sort()).toEqual(['content', 'occurredOn', 'title']);
    // Even a partly reviewed new person remains a draft when the user cancels.
    await analysis.getByRole('checkbox', { name: `选择人物：${newcomer}`, exact: true }).check();
    await analysis.getByRole('combobox', { name: `${newcomer}对应人物档案`, exact: true }).selectOption('new');
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${newcomer}，第2条`, exact: true }).check();
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await expect(analysis).not.toBeVisible();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await expect(page.locator('.person-card')).toHaveCount(peopleBefore);
    await expect(personCard(page, newcomer)).toHaveCount(0);
    await expect(personCard(page, ignored)).toHaveCount(0);
    expect(writes).toHaveLength(writesBefore);

    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await analysis.getByRole('checkbox', { name: `选择人物：${existing}`, exact: true }).check();
    await expect(analysis.getByRole('combobox', { name: `${existing}对应人物档案`, exact: true })).toHaveValue(/^[0-9a-f-]{36}$/);
    await analysis.getByRole('checkbox', { name: `选择人物：${newcomer}`, exact: true }).check();
    await analysis.getByRole('combobox', { name: `${newcomer}对应人物档案`, exact: true }).selectOption('new');
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${existing}，第1条`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '感受1内容', exact: true }).fill(editedFeeling);
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${newcomer}，第2条`, exact: true }).check();
    await analysis.getByRole('checkbox', { name: `选择事项：${originalTask}`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '事项1标题', exact: true }).fill(editedTask);
    await analysis.getByRole('textbox', { name: '事项1细节', exact: true }).fill(editedDetails);
    await expect(analysis.getByRole('checkbox', { name: `选择人物：${ignored}`, exact: true })).not.toBeChecked();
    await expect(analysis.getByRole('checkbox', { name: `选择感受与印象：${existing}，第3条`, exact: true })).not.toBeChecked();
    await analysis.getByRole('button', { name: '确认写入（4）', exact: true }).click();
    await expect(analysis.getByRole('status')).toContainText('在本机加密保存');
    await expect(page.locator('.status-dot.warning')).toHaveCount(0);
    expect(writes).toHaveLength(writesBefore + 1);
    expect(writes.at(-1)).not.toContain(editedFeeling);
    expect(writes.at(-1)).not.toContain(editedDetails);
    await analysis.locator('.drawer-footer').getByRole('button', { name: '关闭', exact: true }).click();
    const details = page.getByRole('dialog', { name: title, exact: true });
    await expect(details.locator('.link-card')).toHaveCount(2);
    await details.locator('.link-card').filter({ hasText: editedFeeling }).click();
    const reflection = page.getByRole('dialog', { name: editedFeeling, exact: true });
    await expect(reflection).toContainText(firstEvidence);
    await reflection.locator('.link-card').filter({ hasText: title }).click();
    await expect(page.getByRole('dialog', { name: title, exact: true })).toContainText(content);
    await closeDetails(page, title);

    await navigate(page, '人物');
    await expect(page.locator('.person-card')).toHaveCount(peopleBefore + 1);
    await expect(personCard(page, ignored)).toHaveCount(0);
    await expect(personCard(page, '我（当前用户）')).toHaveCount(0);
    await personCard(page, existing).click();
    await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
    await expect(page.locator('.record-card')).toHaveCount(1);
    await expect(card(page, editedFeeling)).toBeVisible();
    await page.locator('.detail-tabs').getByRole('button', { name: /^事项/ }).click();
    await expect(page.locator('.record-card')).toHaveCount(1);
    await card(page, editedTask).locator('.card-content').click();
    const task = page.getByRole('dialog', { name: editedTask, exact: true });
    await expect(task).toContainText(editedDetails);
    await expect(task).toContainText(taskEvidence);
    await expect(task.locator('.record-definition')).toContainText(title);
    await closeDetails(page, editedTask);
    await navigate(page, '人物');
    await personCard(page, newcomer).click();
    await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
    await expect(page.locator('.record-card')).toHaveCount(1);
    await expect(card(page, secondEvidence)).toBeVisible();
    await page.locator('.detail-tabs').getByRole('button', { name: /^事项/ }).click();
    await expect(page.locator('.record-card')).toHaveCount(0);

    await page.reload();
    await unlock(page);
    await navigate(page, '人物');
    await expect(personCard(page, newcomer)).toHaveCount(1);
    await personCard(page, existing).click();
    await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
    await expect(card(page, editedFeeling)).toBeVisible();
    const beforeRepeat = writes.length;
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    for (const name of [existing, newcomer]) {
      await analysis.getByRole('checkbox', { name: `选择人物：${name}`, exact: true }).check();
      await expect(analysis.getByRole('combobox', { name: `${name}对应人物档案`, exact: true })).toHaveValue(/^[0-9a-f-]{36}$/);
    }
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${existing}，第1条`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '感受1内容', exact: true }).fill(editedFeeling);
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${newcomer}，第2条`, exact: true }).check();
    await analysis.getByRole('checkbox', { name: `选择事项：${originalTask}`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '事项1标题', exact: true }).fill(editedTask);
    await analysis.getByRole('textbox', { name: '事项1细节', exact: true }).fill(editedDetails);
    await analysis.getByRole('button', { name: '确认写入（3）', exact: true }).click();
    await expect(analysis.getByRole('alert')).toContainText('没有需要新增的内容');
    expect(writes).toHaveLength(beforeRepeat);
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await personCard(page, existing).click();
    await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
    await expect(page.locator('.record-card')).toHaveCount(1);
    expect(mocked.requests).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  test('facts require explicit source review, persist encrypted with their interaction, and skip duplicates', async ({ page }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const suffix = Date.now();
    const person = `虚构事实人物${suffix}`;
    const title = `虚构事实交往${suffix}`;
    const knownQuote = `${person}说自己喜欢水彩画`;
    const extraQuote = '他说周末会画风景';
    const unknownQuote = `有人提到${person}可能不喝咖啡`;
    const backgroundQuote = '这次交谈在虚构北岸公园进行';
    const knownContent = '喜欢水彩画，周末画风景';
    const unclearContent = '可能不喝咖啡，尚未向本人核实';
    const sourceNote = '虚构转述者未具名；记录为未向本人核实的转述。';
    const payload: InteractionAnalysis = {
      people: [{ key: 'p1', name: person, mention: person, isSelf: false, evidenceQuotes: [knownQuote] }],
      reflections: [], followUps: [],
      facts: [
        { personKey: 'p1', type: 'preference', content: knownContent, category: '兴趣偏好', basis: 'self-reported', factStatus: 'candidate', evidence: knownQuote,
          statementId: 's1', classificationReason: '本人明确表达的兴趣偏好', source: { type: 'person', personId: 'p1' }, uncertainty: null, evidenceQuotes: [knownQuote, extraQuote], polarity: 'affirmed' },
        { personKey: 'p1', type: 'preference', content: unclearContent, category: null, basis: null, factStatus: 'ambiguous', evidence: unknownQuote,
          statementId: 's2', classificationReason: '可能是饮食偏好，但转述来源和确定性不清楚', source: { type: 'unknown', personId: null }, uncertainty: '说话者未具名，且使用了“可能”', evidenceQuotes: [unknownQuote], polarity: 'uncertain' },
      ],
      backgrounds: [{ personKeys: ['p1'], content: backgroundQuote, evidence: backgroundQuote, statementId: 's3', classificationReason: '交谈场景属于交往背景', source: { type: 'narrator', personId: null }, uncertainty: null, evidenceQuotes: [backgroundQuote], polarity: 'affirmed' }],
    };
    const mocked = await mockAnalysis(page, payload);
    const writes = trackWrites(page);
    await enter(page);
    await createPerson(page, person);
    await createInteraction(page, title, `${knownQuote}。${extraQuote}。${unknownQuote}。${backgroundQuote}。`);
    const before = writes.length;
    let analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(analysis.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(analysis.getByRole('heading', { name: /^事实与偏好/ })).toBeVisible();
    await expect(analysis.getByRole('heading', { name: /^交往背景/ })).toBeVisible();
    await expect(analysis.locator('.analysis-background')).toContainText(backgroundQuote);
    await expect(analysis.locator('.analysis-background').locator('input, select, textarea')).toHaveCount(0);
    await expect(analysis.locator('.analysis-background')).toContainText('交谈场景属于交往背景');
    await expect(analysis.getByRole('checkbox', { name: /^选择感受与印象/ })).toHaveCount(0);
    await expect(analysis.getByRole('checkbox', { name: /^选择事项/ })).toHaveCount(0);
    const known = analysis.getByRole('checkbox', { name: `选择事实与偏好：${person}，第1条`, exact: true });
    const unclear = analysis.getByRole('checkbox', { name: `选择事实与偏好：${person}，第2条`, exact: true });
    await expect(known).toBeDisabled();
    await analysis.getByRole('checkbox', { name: `选择人物：${person}`, exact: true }).check();
    await expect(analysis.getByRole('combobox', { name: `${person}对应人物档案`, exact: true })).toHaveValue(/^[0-9a-f-]{36}$/);
    const knownCard = analysis.locator('.analysis-candidate').filter({ has: page.getByRole('checkbox', { name: `选择事实与偏好：${person}，第1条`, exact: true }) });
    await expect(knownCard.getByRole('checkbox')).toHaveCount(1);
    await expect(knownCard.locator('.analysis-evidence')).toHaveCount(2);
    await expect(knownCard).toContainText(extraQuote);
    await unclear.check();
    await expect(analysis.getByRole('button', { name: '确认写入（1）', exact: true })).toBeDisabled();
    await expect(analysis.locator('.analysis-candidate').filter({ has: page.getByRole('checkbox', { name: `选择事实与偏好：${person}，第2条`, exact: true }) })).toContainText('来源待澄清');
    expect(writes).toHaveLength(before);
    await unclear.uncheck();
    await known.check();
    await expect(analysis.getByRole('button', { name: '确认写入（1）', exact: true })).toBeEnabled();
    await screenshot(page, 'desktop-facts-and-backgrounds');
    await page.setViewportSize({ width: 390, height: 844 });
    await known.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const factConfirmation = await analysis.getByRole('button', { name: '确认写入（1）', exact: true }).boundingBox();
    expect(factConfirmation).not.toBeNull();
    expect(factConfirmation!.y + factConfirmation!.height).toBeLessThanOrEqual(844);
    await screenshot(page, 'mobile-facts-and-backgrounds');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await analysis.getByRole('button', { name: '确认写入（1）', exact: true }).click();
    await expect(analysis.getByRole('status')).toContainText('在本机加密保存');
    await expect.poll(() => writes.length).toBe(before + 1);
    expect(writes.at(-1)).not.toContain(knownContent);
    expect(writes.at(-1)).not.toContain(backgroundQuote);
    await analysis.locator('.drawer-footer').getByRole('button', { name: '关闭', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await personCard(page, person).click();
    await expect(card(page, knownContent)).toBeVisible();
    await expect(card(page, unclearContent)).toHaveCount(0);
    await card(page, knownContent).locator('.card-content').click();
    let factDetails = page.getByRole('dialog', { name: knownContent, exact: true });
    await expect(factDetails.locator('.record-definition')).toContainText('本人陈述');
    await expect(factDetails.locator('.record-definition')).toContainText(title);
    await expect(factDetails).toContainText(knownQuote);
    await expect(factDetails).toContainText(extraQuote);
    await closeDetails(page, knownContent);

    await page.reload();
    await unlock(page);
    await navigate(page, '人物');
    await personCard(page, person).click();
    await expect(card(page, knownContent)).toHaveCount(1);
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await analysis.getByRole('checkbox', { name: `选择人物：${person}`, exact: true }).check();
    await analysis.getByRole('checkbox', { name: `选择事实与偏好：${person}，第2条`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '事实2类别', exact: true }).fill('饮食偏好');
    await analysis.getByRole('combobox', { name: '事实2来源性质', exact: true }).selectOption('third-party');
    await analysis.getByRole('textbox', { name: '事实2来源说明', exact: true }).fill(sourceNote);
    await expect(analysis.getByRole('button', { name: '确认写入（1）', exact: true })).toBeDisabled();
    await analysis.getByRole('checkbox', { name: '事实2已补全并确认来源与含义', exact: true }).check();
    await analysis.getByRole('button', { name: '确认写入（1）', exact: true }).click();
    await expect(analysis.getByRole('status')).toContainText('在本机加密保存');
    await expect.poll(() => writes.length).toBe(before + 2);
    expect(writes.at(-1)).not.toContain(unclearContent);
    expect(writes.at(-1)).not.toContain(sourceNote);
    await analysis.locator('.drawer-footer').getByRole('button', { name: '关闭', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await personCard(page, person).click();
    await expect(card(page, unclearContent)).toHaveCount(1);
    await card(page, unclearContent).locator('.card-content').click();
    factDetails = page.getByRole('dialog', { name: unclearContent, exact: true });
    await expect(factDetails.locator('.record-definition')).toContainText('转述');
    await expect(factDetails).toContainText(sourceNote);
    await expect(factDetails).toContainText(title);
    await expect(factDetails).toContainText('未具名');
    await closeDetails(page, unclearContent);

    await page.reload();
    await unlock(page);
    await navigate(page, '人物');
    await personCard(page, person).click();
    await expect(card(page, knownContent)).toHaveCount(1);
    await expect(card(page, unclearContent)).toHaveCount(1);
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await analysis.getByRole('checkbox', { name: `选择人物：${person}`, exact: true }).check();
    for (const index of [1, 2]) await analysis.getByRole('checkbox', { name: `选择事实与偏好：${person}，第${index}条`, exact: true }).check();
    await analysis.getByRole('textbox', { name: '事实2类别', exact: true }).fill('饮食偏好');
    await analysis.getByRole('combobox', { name: '事实2来源性质', exact: true }).selectOption('third-party');
    await analysis.getByRole('textbox', { name: '事实2来源说明', exact: true }).fill(sourceNote);
    await analysis.getByRole('checkbox', { name: '事实2已补全并确认来源与含义', exact: true }).check();
    await analysis.getByRole('button', { name: '确认写入（2）', exact: true }).click();
    await expect(analysis.getByRole('alert')).toContainText('没有需要新增的内容');
    expect(writes).toHaveLength(before + 2);
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    expect(mocked.requests).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  test('other perspectives require rewritten adoption and unclear tasks require confirmed responsibility', async ({ page }) => {
    test.setTimeout(90000);
    const suffix = Date.now();
    const person = `虚构视角人物${suffix}`;
    const title = `虚构视角交往${suffix}`;
    const quote = `${person}说自己最近觉得做事谨慎`;
    const taskQuote = `下次和${person}碰面时也许带上画册，谁来带尚未说好`;
    const rewritten = `听${person}谈起最近的谨慎，我这次感到彼此能坦诚说明顾虑。`;
    const taskTitle = `与${person}核对画册`;
    const payload: InteractionAnalysis = {
      people: [{ key: 'p1', name: person, mention: person, isSelf: false }],
      reflections: [{ personKey: 'p1', type: 'feeling', content: '最近觉得做事谨慎', evidence: quote,
        classificationReason: '本人对自己的感受，观点属于被记录的人', source: { type: 'person', personId: 'p1' }, perspective: { type: 'person', personId: 'p1' }, temporalScope: 'this-interaction', evidenceQuotes: [quote], uncertainty: null }],
      followUps: [{ personKeys: ['p1'], title: taskTitle, details: taskQuote, type: 'plan', responsibility: 'unknown', status: 'unclear', dueAtText: '下次', evidence: taskQuote,
        classificationReason: '存在后续意向，责任与时间尚未明确', source: { type: 'narrator', personId: null }, uncertainty: '尚未确定由谁负责', evidenceQuotes: [taskQuote] }],
      facts: [], backgrounds: [],
    };
    await mockAnalysis(page, payload);
    const writes = trackWrites(page);
    await enter(page);
    await createPerson(page, person);
    await createInteraction(page, title, `${quote}。${taskQuote}。`);
    const before = writes.length;
    const analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(analysis.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(analysis.locator('.analysis-attribution')).toContainText(`${person}的陈述`);
    await expect(analysis.locator('.analysis-attribution')).toContainText('仅限本次交往');
    await analysis.getByRole('checkbox', { name: `选择人物：${person}`, exact: true }).check();
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${person}，第1条`, exact: true }).check();
    await analysis.getByRole('checkbox', { name: '感受1明确采用为自己的感受', exact: true }).check();
    await expect(analysis.getByRole('button', { name: '确认写入（1）', exact: true })).toBeDisabled();
    await analysis.getByRole('textbox', { name: '感受1内容', exact: true }).fill(rewritten);
    await expect(analysis.getByRole('button', { name: '确认写入（1）', exact: true })).toBeEnabled();
    await analysis.getByRole('checkbox', { name: `选择事项：${taskTitle}`, exact: true }).check();
    await expect(analysis.getByRole('combobox', { name: '事项1责任', exact: true })).toHaveValue('unknown');
    await expect(analysis.getByRole('checkbox', { name: '事项1已补全并确认责任与约定', exact: true })).toBeDisabled();
    await expect(analysis.getByRole('button', { name: '确认写入（2）', exact: true })).toBeDisabled();
    await analysis.getByRole('combobox', { name: '事项1责任', exact: true }).selectOption('me');
    await expect(analysis.getByRole('button', { name: '确认写入（2）', exact: true })).toBeDisabled();
    await analysis.getByRole('checkbox', { name: '事项1已补全并确认责任与约定', exact: true }).check();
    await expect(analysis).toContainText('原文期限：下次');
    await expect(analysis.getByRole('button', { name: '确认写入（2）', exact: true })).toBeEnabled();
    expect(writes).toHaveLength(before);
    await analysis.getByRole('button', { name: '确认写入（2）', exact: true }).click();
    await expect(analysis.getByRole('status')).toContainText('在本机加密保存');
    await expect.poll(() => writes.length).toBe(before + 1);
    expect(writes.at(-1)).not.toContain(rewritten);
    await analysis.locator('.drawer-footer').getByRole('button', { name: '关闭', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await personCard(page, person).click();
    await page.locator('.detail-tabs').getByRole('button', { name: /^感受与印象/ }).click();
    await card(page, rewritten).locator('.card-content').click();
    const reflection = page.getByRole('dialog', { name: rewritten, exact: true });
    await expect(reflection).toContainText('用户已显式采用并改写');
    await expect(reflection).toContainText('最近觉得做事谨慎');
    await closeDetails(page, rewritten);
    await page.locator('.detail-tabs').getByRole('button', { name: /^事项/ }).click();
    await card(page, taskTitle).locator('.card-content').click();
    const task = page.getByRole('dialog', { name: taskTitle, exact: true });
    await expect(task).toContainText('用户已澄清责任');
    await expect(task).toContainText('下次');
  });

  test('a background-only result remains readable without creating any entities', async ({ page }) => {
    const suffix = Date.now();
    const title = `虚构背景交往${suffix}`;
    const content = '虚构东风书店今天更换了展架，雨停后窗边透进了阳光。';
    const payload: InteractionAnalysis = {
      people: [], reflections: [], followUps: [], facts: [],
      backgrounds: [{ personKeys: [], content, evidence: content, classificationReason: '环境描写只属于本次交往背景', source: { type: 'narrator', personId: null }, uncertainty: null, evidenceQuotes: [content] }],
    };
    await mockAnalysis(page, payload);
    const writes = trackWrites(page);
    await enter(page);
    await navigate(page, '人物');
    const beforePeople = await page.locator('.person-card').count();
    await createInteraction(page, title, content);
    const before = writes.length;
    const analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(analysis.locator('.analysis-background')).toContainText(content);
    await expect(analysis).toContainText('仅供查看，不写入人物档案');
    await expect(analysis.getByRole('heading', { name: '这次没有可写入的候选', exact: true })).toHaveCount(0);
    await expect(analysis.getByRole('checkbox')).toHaveCount(0);
    await expect(analysis.getByRole('button', { name: '确认写入（0）', exact: true })).toBeDisabled();
    await expect(analysis).toContainText('没有明确的感受与印象候选');
    await expect(analysis).toContainText('没有明确的待跟进事项');
    await expect(analysis).toContainText('没有事实与偏好候选');
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await expect(page.locator('.person-card')).toHaveCount(beforePeople);
    expect(writes).toHaveLength(before);
  });
});

test.describe('interaction analysis on phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('unconfigured and empty states, cancellation during analysis, and narrow review stay usable without writes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const suffix = Date.now();
    const title = `虚构手机分析${suffix}`;
    const person = `虚构手机候选${suffix}`;
    const evidence = `我觉得和${person}这次相处轻松`;
    const mocked = await mockAnalysis(page);
    const writes = trackWrites(page);
    await enter(page);
    await createInteraction(page, title, `我和${person}散步。${evidence}。`);
    const before = writes.length;

    mocked.setAvailable(false);
    let analysis = await openAnalysis(page, title);
    await expect(analysis).toContainText(/尚未配置.*分析服务/);
    await expect(analysis.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
    expect(mocked.requests).toHaveLength(0);
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await closeDetails(page, title);

    mocked.setAvailable(true);
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(analysis.getByRole('heading', { name: '这次没有可写入的候选', exact: true })).toBeVisible();
    await expect(analysis.getByRole('button', { name: /^确认写入/ })).toHaveCount(0);
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await closeDetails(page, title);

    mocked.setDelayed(true);
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect.poll(() => mocked.requests.length).toBe(2);
    await expect(analysis).toContainText('正在整理人物');
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await expect(analysis).not.toBeVisible();
    mocked.release();
    mocked.setDelayed(false);
    await closeDetails(page, title);

    mocked.setResult({
      people: [{ key: 'p1', name: person, mention: person, isSelf: false }],
      reflections: [{ personKey: 'p1', type: 'feeling', content: evidence, evidence }],
      followUps: [],
    });
    analysis = await openAnalysis(page, title);
    await analysis.getByRole('button', { name: '开始分析', exact: true }).click();
    await analysis.getByRole('checkbox', { name: `选择人物：${person}`, exact: true }).check();
    await analysis.getByRole('combobox', { name: `${person}对应人物档案`, exact: true }).selectOption('new');
    await analysis.getByRole('checkbox', { name: `选择感受与印象：${person}，第1条`, exact: true }).check();
    await page.setViewportSize({ width: 390, height: 520 });
    const confirmation = analysis.getByRole('button', { name: '确认写入（2）', exact: true });
    await expect(confirmation).toBeEnabled();
    const bounds = await confirmation.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(520);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, 'mobile-candidates');
    await analysis.getByRole('button', { name: '取消', exact: true }).click();
    await closeDetails(page, title);
    await navigate(page, '人物');
    await expect(personCard(page, person)).toHaveCount(0);
    expect(writes).toHaveLength(before);
    expect(mocked.requests).toHaveLength(3);
    expect(errors).toEqual([]);
  });
});
