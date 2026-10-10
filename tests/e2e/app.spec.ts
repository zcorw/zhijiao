import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Deliberately fictional credentials. Create this disposable account with the interactive CLI.
const unlockPhrase='fictional browser vault unlock phrase';
async function enter(page:Page) {
  page.on('response',async response=>{
    if(new URL(response.url()).pathname.startsWith('/api')&&response.status()>=400) {
      const body=await response.json().catch(()=>({}));
      console.log('API check:',response.request().method(),new URL(response.url()).pathname,response.status(),body.code??'');
    }
  });
  await page.goto('/');
  await page.getByLabel('登录名',{exact:true}).fill('fictional-ui');
  await page.getByLabel('登录密码',{exact:true}).fill('fictional-login-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  const create=page.getByRole('heading',{name:'创建私人资料库'});
  await expect(create.or(page.getByRole('heading',{name:'打开你的资料库'}))).toBeVisible();
  if(await create.isVisible()) {
    await page.getByLabel('解锁口令（至少 12 个字符）').fill(unlockPhrase);
    await page.getByLabel('再次输入',{exact:true}).fill(unlockPhrase);
    await page.getByRole('button',{name:'创建资料库',exact:true}).click();
    await expect(page.getByRole('heading',{name:'保存独立恢复秘密'})).toBeVisible();
    await page.getByRole('checkbox',{name:'我已安全保存，并理解丢失后的风险'}).check();
    await page.getByRole('button',{name:'进入知交',exact:true}).click();
  } else {
    await page.getByLabel('资料库解锁口令',{exact:true}).fill(unlockPhrase);
    await page.getByRole('button',{name:'解锁资料库',exact:true}).click();
  }
  await expect(page.getByRole('button',{name:'记一笔',exact:true}).first()).toBeVisible();
}
async function createPerson(page:Page,name:string,summary:string) {
  await page.getByRole('button',{name:'人物',exact:true}).first().click();
  await page.getByRole('button',{name:'新建人物',exact:true}).first().click();
  const dialog=page.getByRole('dialog').filter({has:page.getByLabel('常用称呼')});
  await dialog.getByLabel('常用称呼').fill(name); await dialog.getByLabel('一句话辨识').fill(summary);
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(dialog).not.toBeVisible();
}
test('desktop: real encrypted CRUD, repeated save, search and lock', async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await enter(page);
  const suffix=Date.now().toString().slice(-6);
  const name=`虚构林青${suffix}`;
  await createPerson(page,name,'仅供测试的读书会朋友');
  await page.getByRole('button',{name:'新建人物',exact:true}).first().click();
  const duplicate=page.getByRole('dialog',{name:'新建人物'});
  await duplicate.getByLabel('常用称呼').fill(name);
  await expect(duplicate.getByText(/不会自动合并/)).toBeVisible();
  await expect(duplicate.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
  await duplicate.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'首页',exact:true}).first().click();
  await page.getByRole('button',{name:'记一笔',exact:true}).first().click();
  const journal=page.getByRole('dialog',{name:'记一笔'});
  await journal.getByRole('button',{name:'和谁在一起 *',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'选择人物'});
  await expect(picker.getByRole('textbox',{name:'搜索人物'})).not.toBeFocused();
  await picker.getByRole('textbox',{name:'搜索人物'}).fill(name);
  await picker.getByRole('button').filter({hasText:name}).first().click();
  await picker.getByRole('button',{name:'确认（1）'}).click();
  const event=`虚构散步${suffix}`;
  await journal.getByLabel('这次交往 *').fill(event);
  await journal.getByLabel('发生了什么').fill('虚构测试资料，无真实人物信息。');
  await journal.getByRole('button',{name:'保存这一笔',exact:true}).dblclick();
  await expect(journal).not.toBeVisible();
  await expect(page.getByText(event,{exact:true})).toHaveCount(1);
  const stored=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('zhijiao-encrypted-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const rows=await new Promise<unknown[]>((resolve,reject)=>{const request=db.transaction('vaults','readonly').objectStore('vaults').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return JSON.stringify(rows);
  });
  expect(stored).not.toContain(name);expect(stored).not.toContain(event);expect(stored).not.toContain(unlockPhrase);
  await mkdir('.local/screenshots',{recursive:true});
  await page.screenshot({path:'.local/screenshots/desktop-home.png',fullPage:true});
  await page.getByRole('button',{name:'人物',exact:true}).first().click();
  await page.locator('.person-card').filter({hasText:name}).click();
  await page.getByRole('button',{name:'删除人物',exact:true}).click();
  await page.getByRole('dialog',{name:'删除人物'}).getByRole('button',{name:'确认删除',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'删除人物'})).not.toBeVisible();
  await expect(page.locator('.person-card').filter({hasText:name})).toHaveCount(0);
  await page.getByRole('button',{name:'设置',exact:true}).first().click();
  const deleted=page.locator('.session-row').filter({hasText:name});
  await deleted.getByRole('button',{name:'查看历史并恢复',exact:true}).click();
  const history=page.getByRole('dialog',{name:'历史版本'});
  await expect(history.getByText(name,{exact:true}).first()).toBeVisible();
  await history.getByRole('button',{name:'将此版恢复为新版本',exact:true}).first().click();
  await expect(history).not.toBeVisible();
  await expect(deleted).toHaveCount(0);
  await page.getByRole('button',{name:'人物',exact:true}).first().click();
  await expect(page.locator('.person-card').filter({hasText:name})).toHaveCount(1);
  await page.getByRole('button',{name:'锁定',exact:true}).first().click();
  await expect(page.getByLabel('资料库解锁口令',{exact:true})).toBeVisible();
  await expect(page.getByText(event,{exact:true})).not.toBeVisible();
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('phone: cross-query selection, quick-create cancel, Back, offline reload',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await enter(page);
  await page.getByRole('button',{name:'记一笔',exact:true}).first().click();
  let journal=page.getByRole('dialog',{name:'记一笔'});
  await journal.getByRole('button',{name:'和谁在一起 *',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'选择人物'});
  const query=picker.getByRole('textbox',{name:'搜索人物'});
  await expect(query).not.toBeFocused();
  const cancelledName=`虚构取消新建${Date.now()}`;
  await query.fill(cancelledName);await picker.getByRole('button',{name:new RegExp(`新建「${cancelledName}」并选中`)}).click();
  await picker.getByRole('button',{name:'取消',exact:true}).click();
  await journal.getByRole('button',{name:'和谁在一起 *',exact:true}).click();
  await query.fill(cancelledName);await expect(picker.getByText('没有找到匹配人物',{exact:true})).toBeVisible();
  await picker.getByRole('button',{name:'取消',exact:true}).click();
  await page.screenshot({path:'.local/screenshots/mobile-journal.png',fullPage:true});
  await journal.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'记一笔',exact:true}).first().click();
  journal=page.getByRole('dialog',{name:'记一笔'});await journal.getByRole('button',{name:'和谁在一起 *',exact:true}).click();
  await query.fill('lq');await picker.getByRole('button').filter({hasText:'虚构林青'}).first().click();
  for(const name of [`虚构多选甲${Date.now()}`,`虚构多选乙${Date.now()}`]) {
    await query.fill(name);await picker.getByRole('button',{name:new RegExp(`新建「${name}」并选中`)}).click();
  }
  await expect(picker.getByRole('button',{name:'确认（3）'})).toBeEnabled();
  await expect(picker.getByRole('button',{name:'+1',exact:true})).toBeVisible();
  await query.fill('lq');await expect(picker.getByRole('button',{name:'确认（3）'})).toBeEnabled();
  await page.screenshot({path:'.local/screenshots/mobile-picker.png',fullPage:true});
  await picker.getByRole('button',{name:'取消',exact:true}).click();await journal.getByRole('button',{name:'取消',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('nav.mobile-nav').getByRole('button',{name:'人物',exact:true}).click();
  await page.getByRole('button',{name:'新建人物',exact:true}).first().click();
  const backDialog=page.getByRole('dialog',{name:'新建人物'});
  await backDialog.getByLabel('常用称呼').fill('虚构返回取消人物');
  await page.goBack();await expect(backDialog).not.toBeVisible();
  await expect(page.getByRole('heading',{name:'留住值得记住的细节'})).toBeVisible();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await context.setOffline(true);await page.reload();
  await expect(page.getByText('打开已缓存的本机资料库',{exact:true})).toBeVisible();
  await page.getByText('打开已缓存的本机资料库',{exact:true}).click();
  await page.getByRole('button',{name:/本机资料库 ·/}).first().click();
  await page.getByLabel('资料库解锁口令',{exact:true}).fill(unlockPhrase);
  await page.getByRole('button',{name:'解锁资料库',exact:true}).click();
  await expect(page.getByRole('button',{name:'记一笔',exact:true}).first()).toBeVisible();
  await page.screenshot({path:'.local/screenshots/mobile-offline.png',fullPage:true});
  await context.setOffline(false);
});
test('avatar: landscape crop and JPEG orientation, metadata-free PNG and lock revocation',async({page})=>{
  // Observe the exact Blob bytes and revocations without fetch(blob:), which the
  // application's strict connect-src policy intentionally blocks.
  await page.addInitScript(()=>{
    const observed=new Map<string,Blob>();const revoked=new Set<string>();
    const create=URL.createObjectURL.bind(URL);const revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=(blob:Blob|MediaSource)=>{const url=create(blob);if(blob instanceof Blob)observed.set(url,blob);return url;};
    URL.revokeObjectURL=(url:string)=>{observed.delete(url);revoked.add(url);revoke(url);};
    Object.assign(window,{__avatarBlobs:observed,__avatarRevoked:revoked});
  });
  await page.setViewportSize({width:1440,height:1000});await enter(page);
  await page.getByRole('button',{name:'人物',exact:true}).first().click();
  await page.locator('.person-card').filter({hasText:'虚构林青'}).first().click();
  const jpeg=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=320;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#ff0000';ctx.fillRect(0,0,320,320);ctx.fillStyle='#0000ff';ctx.fillRect(320,0,320,320);
    return {jpeg:canvas.toDataURL('image/jpeg',0.95).split(',')[1],png:canvas.toDataURL('image/png').split(',')[1]};
  });
  const upload=async(buffer:Buffer,mimeType:string,name:string)=>{
    await page.getByRole('button',{name:'编辑头像',exact:true}).click();
    const drawer=page.getByRole('dialog',{name:'编辑头像'});
    await drawer.locator('input[type=file]').setInputFiles({name,mimeType,buffer});
    await drawer.getByRole('button',{name:'保存头像',exact:true}).click();await expect(drawer).not.toBeVisible();
    await expect(page.locator('.profile-header img')).toHaveAttribute('src',/^blob:/);
  };
  await upload(Buffer.from(jpeg.png,'base64'),'image/png','fictional-landscape.png');
  const exif=Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000','hex');
  const metadata=Buffer.concat([exif,Buffer.from('FICTIONAL-GPS-AND-PREVIEW-METADATA')]);
  const app1=Buffer.alloc(4);app1[0]=0xff;app1[1]=0xe1;app1.writeUInt16BE(metadata.length+2,2);
  const source=Buffer.from(jpeg.jpeg,'base64');
  await upload(Buffer.concat([source.subarray(0,2),app1,metadata,source.subarray(2)]),'image/jpeg','fictional-orientation6.jpg');
  const output=await page.locator('.profile-header img').evaluate(async node=>{
    const img=node as HTMLImageElement;await img.decode();
    const observed=(window as unknown as {__avatarBlobs:Map<string,Blob>}).__avatarBlobs;
    const blob=observed.get(img.src);if(!blob)throw new Error('Avatar URL has no live Blob');
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const chunks:string[]=[];let offset=8;const view=new DataView(bytes.buffer);
    while(offset<bytes.length){const size=view.getUint32(offset);chunks.push(String.fromCharCode(...bytes.subarray(offset+4,offset+8)));offset+=size+12;}
    const c=document.createElement('canvas');c.width=128;c.height=128;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0,128,128);
    return {chunks,top:Array.from(ctx.getImageData(64,32,1,1).data),bottom:Array.from(ctx.getImageData(64,96,1,1).data),width:img.naturalWidth,url:img.src};
  });
  expect(output.chunks.every(c=>['IHDR','IDAT','IEND'].includes(c))).toBe(true);
  expect([128,512]).toContain(output.width);expect(output.top[0]).toBeGreaterThan(output.top[2]+80);expect(output.bottom[2]).toBeGreaterThan(output.bottom[0]+80);
  await page.screenshot({path:'.local/screenshots/desktop-person-avatar.png',fullPage:true});
  await page.getByRole('button',{name:'锁定',exact:true}).first().click();
  expect(await page.evaluate(url=>{
    const observed=window as unknown as {__avatarBlobs:Map<string,Blob>;__avatarRevoked:Set<string>};
    return observed.__avatarRevoked.has(url)&&!observed.__avatarBlobs.has(url);
  },output.url)).toBe(true);
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
});
