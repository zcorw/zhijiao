import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const phrase = 'fictional browser vault unlock phrase';
async function enter(page: Page) {
  await page.goto('/'); await page.locator('[name="login"]').fill('fictional-ui'); await page.locator('[name="password"]').fill('fictional-login-password');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  const create = page.getByRole('heading', {name:'创建私人资料库'});
  await expect(create.or(page.getByRole('heading', {name:'打开你的资料库'}))).toBeVisible();
  if (await create.isVisible()) {
    await page.locator('[name="setupPassphrase"]').fill(phrase); await page.locator('[name="setupRepeated"]').fill(phrase);
    await page.getByRole('button', {name:'创建资料库',exact:true}).click();
    await page.getByRole('checkbox', {name:'我已安全保存，并理解丢失后的风险'}).check(); await page.getByRole('button', {name:'进入知交',exact:true}).click();
  } else {
    await page.locator('[name="unlockSecret"]').fill(phrase); await page.getByRole('button', {name:'解锁资料库',exact:true}).click();
  }
  await page.getByRole('button', {name:'人物',exact:true}).first().click();
}
async function person(page: Page, name: string) {
  await page.getByRole('button', {name:'新建人物',exact:true}).first().click();
  const form = page.getByRole('dialog', {name:'新建人物',exact:true}); await form.locator('[name="displayName"]').fill(name); return form;
}
async function openDate(page: Page, form: Locator, label: string) {
  await form.getByRole('button', {name:`选择${label}`,exact:true}).click();
  const picker = page.getByRole('dialog', {name:`选择${label}`,exact:true}); await expect(picker).toBeVisible(); return picker;
}
async function partial(page: Page, form: Locator, name: string, label: string, value: string, precision: '日'|'月'|'年', expected: string) {
  const input = form.locator(`[name="${name}"]`); await input.fill(value);
  const picker = await openDate(page, form, label); await picker.getByRole('button', {name:precision,exact:true}).click();
  await expect(input).toHaveValue(value); await expect(picker.locator('.date-preview')).toHaveText(expected);
  await picker.getByRole('button', {name:'确定日期',exact:true}).click(); await expect(input).toHaveValue(expected); await expect(input).toBeFocused();
}
async function save(form: Locator) { await form.getByRole('button', {name:'保存',exact:true}).dblclick(); await expect(form).not.toBeVisible(); }
async function editCard(page: Page, title: string, dialog: string) {
  await page.locator('.record-card').filter({hasText:title}).getByRole('button', {name:'编辑记录',exact:true}).click(); return page.getByRole('dialog', {name:dialog,exact:true});
}
async function screenshot(page: Page, name: string) {
  await mkdir('.local/all-date-check/screenshots', {recursive:true}); await page.screenshot({path:`.local/all-date-check/screenshots/${name}.png`});
}

test.describe('all editable dates on desktop', () => {
  test.use({timezoneId:'America/Los_Angeles',viewport:{width:1440,height:1000}});
  test('all 13 entries stage, validate, save and re-display their original date semantics', async ({page}) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await enter(page); const stamp = Date.now(); const name = `虚构全日期${stamp}`;
    let form = await person(page, name);
    await partial(page, form, 'metOn', '相识日期', '2024-02-29', '年', '2024');
    await form.locator('[name="birthday"]').fill('--02-29');
    let picker = await openDate(page, form, '生日'); await expect(picker.getByRole('button', {name:'确定日期'})).toBeDisabled();
    await picker.getByRole('button', {name:'取消日期选择'}).click(); await expect(form.locator('[name="birthday"]')).toHaveValue('--02-29');
    await save(form); await page.locator('.person-card').filter({hasText:name}).click();
    await page.getByRole('button', {name:'编辑资料',exact:true}).click(); form=page.getByRole('dialog', {name:'编辑人物',exact:true});
    await expect(form.locator('[name="metOn"]')).toHaveValue('2024'); await expect(form.locator('[name="birthday"]')).toHaveValue('--02-29');
    await form.getByRole('button', {name:'取消',exact:true}).click();
    await page.locator('section').filter({has:page.getByRole('heading', {name:'事实与偏好',exact:true})}).getByRole('button', {name:'补充',exact:true}).click();
    form = page.getByRole('dialog', {name:'新建事实与偏好',exact:true}); const fact=`虚构偏好${stamp}`;
    await form.getByRole('button', {name:'保存',exact:true}).click(); await expect(form.locator('[name="content"]')).toBeFocused(); await expect(form.locator('[name="content"]')).toHaveAttribute('aria-invalid','true');
    await form.locator('[name="content"]').fill(fact);
    await partial(page, form, 'learnedOn', '获知日期', '2024-02-29', '月', '2024-02');
    await partial(page, form, 'validFrom', '有效期起', '2024-02-29', '年', '2024');
    await partial(page, form, 'validTo', '有效期止', '2025-05-12', '日', '2025-05-12'); await save(form);
    form=await editCard(page, fact, '编辑事实与偏好');
    for(const [field,value] of [['learnedOn','2024-02'],['validFrom','2024'],['validTo','2025-05-12']]) await expect(form.locator(`[name="${field}"]`)).toHaveValue(value);
    await form.getByRole('button', {name:'取消',exact:true}).click();
    await page.getByRole('button', {name:'记一笔',exact:true}).first().click(); form=page.getByRole('dialog', {name:'记一笔',exact:true});
    const event=`虚构全时间交往${stamp}`, reflection=`虚构全时间感受${stamp}`, task=`虚构全时间事项${stamp}`;
    await form.locator('[name="title"]').fill(event); await partial(page, form, 'date', '日期', '2024-02-29', '月', '2024-02');
    await form.locator('summary').click(); await form.locator('[name="exactTime"]').fill('2024-02-29T10:30');
    picker=await openDate(page, form, '精确时间（可不填）'); await expect(picker.getByRole('group', {name:'日期精度'})).toHaveCount(0);
    await picker.getByRole('button', {name:'增加小时',exact:true}).click(); await expect(picker.locator('.date-preview')).toHaveText('2024-02-29T11:30');
    await expect(form.locator('[name="exactTime"]')).toHaveValue('2024-02-29T10:30'); await screenshot(page, 'all-date-desktop');
    await picker.getByRole('button', {name:'确定日期'}).click(); await form.locator('[name="timezone"]').fill('America/Los_Angeles');
    await form.locator('section').filter({has:page.getByRole('heading', {name:'我的感受与印象',exact:true})}).getByRole('button', {name:'添加',exact:true}).click();
    await form.getByRole('combobox', {name:'针对谁',exact:true}).selectOption({label:name});
    await form.getByLabel('我的想法').fill(reflection); await form.getByRole('button', {name:'添加事项',exact:true}).click();
    await form.locator('[name="taskTitle"]').fill(task); await partial(page, form, 'dueDate', '期限日期（可不填）', '2025-05-12', '年', '2025');
    await form.getByRole('button', {name:'保存这一笔',exact:true}).dblclick(); await expect(form).not.toBeVisible();
    await page.locator('.detail-tabs').getByRole('button', {name:/交往/}).click(); form=await editCard(page, event, '编辑交往');
    await expect(form.locator('[name="occurredOn"]')).toHaveValue('2024-02'); await expect(form.locator('[name="occurredAt"]')).toHaveValue('2024-02-29T11:30'); await expect(form.locator('[name="content"]')).toHaveValue('');
    await partial(page, form, 'occurredOn', '发生日期', '2024-02-29', '日', '2024-02-29');
    picker=await openDate(page, form, '精确时间（知道时才填）'); await picker.getByRole('button', {name:'增加分钟',exact:true}).click();
    await expect(picker.locator('.date-preview')).toHaveText('2024-02-29T11:31'); await picker.getByRole('button', {name:'取消日期选择'}).click();
    await expect(form.locator('[name="occurredAt"]')).toHaveValue('2024-02-29T11:30'); await save(form);
    form=await editCard(page, event, '编辑交往'); await expect(form.locator('[name="occurredOn"]')).toHaveValue('2024-02-29'); await expect(form.locator('[name="content"]')).toHaveValue(''); await form.getByRole('button', {name:'取消',exact:true}).click();
    await page.locator('.detail-tabs').getByRole('button', {name:/感受与印象/}).click(); form=await editCard(page, reflection, '编辑感受与印象');
    await form.locator('[name="content"]').fill(''); await form.getByRole('button', {name:'保存',exact:true}).click(); await expect(form.locator('[name="content"]')).toBeFocused(); await expect(form.locator('[name="content"]')).toHaveAttribute('aria-invalid','true'); await form.locator('[name="content"]').fill(reflection);
    await partial(page, form, 'recordedOn', '记录日期', '2024-02-29', '年', '2024'); await save(form);
    form=await editCard(page, reflection, '编辑感受与印象'); await expect(form.locator('[name="recordedOn"]')).toHaveValue('2024'); await form.getByRole('button', {name:'取消',exact:true}).click();
    await page.locator('.detail-tabs').getByRole('button', {name:/事项/}).click(); form=await editCard(page, task, '编辑事项');
    await expect(form.locator('[name="dueDate"]')).toHaveValue('2025'); await partial(page, form, 'dueDate', '期限日期', '2025-05-12', '月', '2025-05');
    await form.locator('[name="dueAt"]').fill('2025-02-29T09:30'); await form.getByRole('button', {name:'保存',exact:true}).click();
    await expect(form.locator('[name="dueAt"]')).toBeFocused(); await expect(form.locator('[name="dueAt"]')).toHaveAttribute('aria-invalid','true');
    await form.locator('[name="dueAt"]').fill('2024-02-29T23:59'); picker=await openDate(page, form, '精确截止时间'); await picker.getByRole('button', {name:'确定日期'}).click();
    await form.locator('[name="timezone"]').fill(''); await form.getByRole('button', {name:'保存',exact:true}).click(); await expect(form.locator('[name="timezone"]')).toBeFocused();
    await form.locator('[name="timezone"]').fill('America/Los_Angeles'); await save(form); form=await editCard(page, task, '编辑事项');
    await expect(form.locator('[name="dueAt"]')).toHaveValue('2024-02-29T23:59'); await expect(form.locator('[name="dueDate"]')).toHaveValue('2025-05');
    await form.getByRole('button', {name:'清空精确截止时间',exact:true}).click(); await save(form); form=await editCard(page, task, '编辑事项');
    await expect(form.locator('[name="dueAt"]')).toHaveValue(''); await expect(form.locator('input[type="datetime-local"],input[type="date"],input[type="time"]')).toHaveCount(0);
    await form.getByRole('button', {name:'取消',exact:true}).click(); expect(errors).toEqual([]);
  });
});

test.describe('phone date and time popup', () => {
  test.use({timezoneId:'Pacific/Kiritimati',viewport:{width:390,height:844}});
  test('24h staging, cancellation, short viewport, clear, focus and encrypted re-display', async ({page}) => {
    const errors: string[]=[]; page.on('pageerror',error=>errors.push(error.message)); await enter(page); const name=`虚构手机时间${Date.now()}`;
    let form=await person(page,name); await save(form); await page.locator('.person-card').filter({hasText:name}).click();
    await page.getByRole('button', {name:'记一笔',exact:true}).first().click(); form=page.getByRole('dialog', {name:'记一笔',exact:true}); const event=`虚构手机日期事件${Date.now()}`;
    await form.locator('[name="title"]').fill(event); await form.locator('summary').click(); await form.locator('[name="exactTime"]').fill('2024-02-29T00:05');
    let picker=await openDate(page,form,'精确时间（可不填）');
    const hourButton=picker.getByRole('button', {name:'增加小时',exact:true}); const hitArea=await hourButton.boundingBox(); expect(hitArea!.width).toBeGreaterThanOrEqual(44); expect(hitArea!.height).toBeGreaterThanOrEqual(44);
    await hourButton.click();
    await expect(picker.locator('.date-preview')).toHaveText('2024-02-29T01:05'); await expect(form.locator('[name="exactTime"]')).toHaveValue('2024-02-29T00:05');
    await screenshot(page,'all-date-mobile'); await picker.getByRole('button', {name:'取消日期选择'}).click(); await expect(form.locator('[name="exactTime"]')).toBeFocused();
    for(let i=0;i<2;i++){picker=await openDate(page,form,'精确时间（可不填）');await picker.press('Escape');await expect(form).toBeVisible();await expect(form.locator('[name="exactTime"]')).toHaveValue('2024-02-29T00:05');}
    picker=await openDate(page,form,'精确时间（可不填）'); await page.setViewportSize({width:390,height:520});
    await expect.poll(async()=>{const p=await picker.boundingBox(),button=await picker.getByRole('button',{name:'确定日期'}).boundingBox();return !!p&&!!button&&p.y>=0&&p.y+p.height<=520&&button.y+button.height<=520;}).toBe(true);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await picker.getByRole('button', {name:'确定日期'}).click(); await form.locator('[name="timezone"]').fill('Pacific/Kiritimati');
    await form.getByRole('button', {name:'保存这一笔',exact:true}).click(); await expect(form).not.toBeVisible(); await page.setViewportSize({width:390,height:844});
    await page.locator('.detail-tabs').getByRole('button', {name:/交往/}).click(); form=await editCard(page,event,'编辑交往');
    await expect(form.locator('[name="occurredAt"]')).toHaveValue('2024-02-29T00:05'); await expect(form.locator('[name="timezone"]')).toHaveValue('Pacific/Kiritimati');
    await form.getByRole('button',{name:'清空精确时间（知道时才填）',exact:true}).click(); await save(form); form=await editCard(page,event,'编辑交往');
    await expect(form.locator('[name="occurredAt"]')).toHaveValue(''); await form.getByRole('button',{name:'取消',exact:true}).click(); expect(errors).toEqual([]);
  });
});
