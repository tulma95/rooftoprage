import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
await mkdir('artifacts', {recursive:true});
const baseURL = process.env.BROWSER_URL || 'http://localhost:5173';
const browser = await chromium.launch({channel:'chrome',headless:true});
const failures=[];
try {
  if (process.env.CHECK_ONLY !== 'storage') {
  const a=await browser.newContext({viewport:{width:1440,height:900}}), b=await browser.newContext({viewport:{width:1280,height:800}});
  const p=await a.newPage(), q=await b.newPage();
  for(const page of [p,q])page.on('pageerror',e=>failures.push(e.message));
  for(const [page,name] of [[p,'Iron Finch'],[q,'Rust Moth']]){await page.goto(baseURL);await page.locator('#nickname').fill(name);await page.locator('#name-form button').click();await page.getByRole('button',{name:'Customize machine'}).click();await page.locator('[data-equip="saw"]').click();await page.locator('[data-equip="flamethrower"]').click();await page.getByRole('button',{name:'Save loadout'}).click();}
  await p.screenshot({path:'artifacts/home.png'});
  await p.getByRole('button',{name:'How to play'}).click();await p.getByRole('button',{name:'Back to home'}).click();
  await p.getByRole('button',{name:'Find a fight'}).click();await p.getByRole('button',{name:'Create private room'}).click();
  await p.locator('.room-code>span').waitFor();const code=await p.locator('.room-code>span').textContent();
  await q.getByRole('button',{name:'Find a fight'}).click();await q.locator('#code').fill(code);await q.locator('#join-form button').click();await q.locator('.room-code').waitFor();
  await p.getByRole('button',{name:'Ready up',exact:true}).click();await q.getByRole('button',{name:'Ready up',exact:true}).click();await p.getByRole('button',{name:'Launch round'}).click();
  await p.locator('#aim').waitFor({timeout:10000});await q.locator('#aim').waitFor();
  await p.screenshot({path:'artifacts/combat.png'});
  await p.getByRole('button',{name:'Menu / Esc'}).click();await p.locator('[data-setting="audio"]').uncheck();await p.getByRole('button',{name:'Resume',exact:true}).click();
  // Drive away from the other robot and off the open rooftop.
  await q.keyboard.down('KeyS');await q.waitForTimeout(3500);await q.keyboard.up('KeyS');
  await p.locator('.results h1').filter({hasText:'VICTORY'}).waitFor({timeout:8000});await q.locator('.results h1').filter({hasText:'ELIMINATED'}).waitFor();
  await p.screenshot({path:'artifacts/results.png'});
  await p.getByRole('button',{name:'Play again',exact:true}).click();await p.locator('.room-code').waitFor();await q.locator('.room-code').waitFor();
  await p.getByRole('button',{name:'Change loadout'}).click();await p.locator('[data-equip="ram"]').click();await p.locator('[data-equip="cannon"]').click();await p.screenshot({path:'artifacts/garage.png'});await p.getByRole('button',{name:'Save loadout'}).click();
  await p.getByRole('button',{name:'Leave room',exact:true}).click();await q.getByRole('button',{name:'Leave room',exact:true}).click();
  for (const count of [3,4]) {
    console.log(`Checking ${count}-browser round…`);
    const contexts=[], pages=[];
    for(let i=0;i<count;i++) {
      const context=await browser.newContext({viewport:{width:i===0?1024:1280,height:768}});contexts.push(context);
      const page=await context.newPage();pages.push(page);page.on('pageerror',e=>failures.push(e.message));
      await page.goto(baseURL);await page.locator('#nickname').fill(`Pilot ${i+1}`);await page.locator('#name-form button').click();await page.getByRole('button',{name:'Find a fight'}).click();
      if(i===0)await page.getByRole('button',{name:'Create private room'}).click();
      else {await page.locator('#code').fill(await pages[0].locator('.room-code>span').textContent());await page.locator('#join-form button').click();}
      await page.locator('.room-code').waitFor();
    }
    for(const page of pages)await page.getByRole('button',{name:'Ready up',exact:true}).click();
    await pages[0].getByRole('button',{name:'Launch round'}).click();
    for(const page of pages)await page.locator('#aim').waitFor({timeout:10000});
    await pages[0].screenshot({path:`artifacts/combat-${count}-1024.png`});
    await pages[0].keyboard.down('KeyS');await pages[0].waitForTimeout(2800);await pages[0].keyboard.up('KeyS');
    await pages[0].locator('.spectator').waitFor();
    assert.equal(await pages[0].locator('#aim').count(),0);
    assert.equal(await pages[0].locator('.hud-weapons kbd').count(),0);
    const first=await pages[0].locator('.hud-health .eyebrow').textContent();
    await pages[0].getByRole('button',{name:'Next survivor'}).click();
    await pages[0].waitForTimeout(200);
    assert.notEqual(await pages[0].locator('.hud-health .eyebrow').textContent(),first);
    await pages[0].screenshot({path:`artifacts/spectating-${count}.png`});
    // Remove eliminated host; live battle must continue in the other browsers.
    await pages[0].getByRole('button',{name:'Leave match',exact:true}).click();await pages[0].getByRole('button',{name:'Leave match',exact:true}).last().click();
    for(let i=1;i<count-1;i++){await pages[i].keyboard.down('KeyS');await pages[i].waitForTimeout(2800);await pages[i].keyboard.up('KeyS');}
    await pages[count-1].locator('.results h1').filter({hasText:'VICTORY'}).waitFor({timeout:8000});
    for(const context of contexts)await context.close();
  }
  }
  // Storage exceptions and text-only nicknames must not prevent play.
  const blocked=await browser.newContext();await blocked.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error('blocked');};Storage.prototype.getItem=()=>{throw new Error('blocked');};});
  const safe=await blocked.newPage();safe.on('pageerror',e=>failures.push(e.message));await safe.goto(baseURL);await safe.locator('#nickname').fill('<img src=x>');await safe.locator('#name-form button').click();
  assert.equal(await safe.locator('img').count(),0);await safe.getByRole('button',{name:'Find a fight'}).click();await safe.locator('#code').fill('bad');await safe.locator('#join-form button').click();await safe.getByRole('alert').filter({hasText:'six-character'}).waitFor();await safe.getByRole('button',{name:'Create private room'}).click();await safe.locator('.room-code').waitFor();await safe.getByRole('button',{name:'Leave room',exact:true}).click();await blocked.close();
  if(failures.length)throw new Error(failures.join('\n'));console.log(process.env.CHECK_ONLY === 'storage' ? 'Blocked-storage browser startup, room creation, text-only nickname and invalid-code checks passed.' : 'Browser flow passed: name → garage → create/join → ready → countdown → combat/menu → falling/results → rematch → garage → leave. Three/four-browser matches, spectating, host exit, storage fallback and invalid codes also passed. No page errors.');
} finally {await browser.close();}
