import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [];
try {
  for (const [key, name, role] of [
    ['sweeper', 'Side Sweeper', 'SIDE SHOVE + SPIN'],
    ['flipper', 'Flip Fork', 'LAUNCH + LIFT'],
    ['hook', 'Tow Hook', 'PULL TOGETHER'],
  ]) {
    const contexts = [];
    const pages = [];
    for (const nickname of [name, 'Target Pilot']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto(process.env.BROWSER_URL || 'http://localhost:5173');
      await page.locator('#nickname').fill(nickname);
      await page.locator('#name-form button').click();
    }
    const [p, q] = pages;
    await p.getByRole('button', { name: 'Customize machine' }).click();
    await p.locator(`[data-equip="${key}"]`).click();
    assert.ok((await p.locator(`[data-equip="${key}"]`).textContent()).includes(role));
    await p.screenshot({ path: `artifacts/${key}-garage.png` });
    await p.getByRole('button', { name: 'Save loadout' }).click();
    await p.reload();
    await p.getByRole('button', { name: 'Customize machine' }).click();
    assert.match(await p.locator(`[data-equip="${key}"]`).getAttribute('class'), /selected/);
    await p.getByRole('button', { name: 'Save loadout' }).click();
    for (const page of pages) await page.getByRole('button', { name: 'Find a fight' }).click();
    await p.getByRole('button', { name: 'Create private room' }).click();
    await p.locator('.room-code>span').waitFor();
    await q.locator('#code').fill(await p.locator('.room-code>span').textContent());
    await q.locator('#join-form button').click();
    await q.locator('.room-code').waitFor();
    for (const page of pages)
      await page.getByRole('button', { name: 'Ready up', exact: true }).click();
    await p.getByRole('button', { name: 'Launch round' }).click();
    await p.locator('#aim').waitFor({ timeout: 10000 });
    assert.ok((await p.locator('[data-slot="front"] strong').textContent()).includes(name));
    await p.keyboard.down('Space');
    await p
      .locator('[data-slot="front"] small')
      .filter({ hasText: 'COOLING DOWN' })
      .waitFor({ timeout: 5000 });
    await p.keyboard.up('Space');
    await p.screenshot({ path: `artifacts/${key}-combat.png` });
    await p
      .locator('[data-slot="front"] small')
      .filter({ hasText: 'READY' })
      .waitFor({ timeout: 5000 });
    for (const context of contexts) await context.close();
    console.log(`${name}: selection, persistence, garage mesh, combat HUD and activation passed.`);
  }
  assert.deepEqual(failures, []);
  console.log('All three movement attachments passed browser checks without page errors.');
} finally {
  await browser.close();
}
