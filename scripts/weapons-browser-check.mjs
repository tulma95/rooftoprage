import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const baseURL = process.env.BROWSER_URL || 'http://localhost:5173';
const errors = [];
try {
  const contexts = await Promise.all(
    [1440, 1024].map((width) => browser.newContext({ viewport: { width, height: 900 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [i, page] of pages.entries()) {
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('#nickname').fill(`Arsenal ${i + 1}`);
    await page.locator('#name-form button').click();
    await page.getByRole('button', { name: 'Customize machine' }).click();
    assert.equal(await page.locator('[data-equip]').count(), 12);
    await page.locator(`[data-equip="${i === 0 ? 'hammer' : 'drill'}"]`).click();
    await page.locator(`[data-equip="${i === 0 ? 'railgun' : 'scattergun'}"]`).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `artifacts/weapons-garage-${i}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Save loadout' }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Customize machine' }).click();
    await expect(page.locator(`[data-equip="${i === 0 ? 'hammer' : 'drill'}"]`)).toHaveClass(
      /selected/,
    );
    await expect(page.locator(`[data-equip="${i === 0 ? 'railgun' : 'scattergun'}"]`)).toHaveClass(
      /selected/,
    );
    await page.getByRole('button', { name: 'Save loadout' }).click();
    await page.getByRole('button', { name: 'Find a fight' }).click();
  }
  const [host, guest] = pages;
  await host.getByRole('button', { name: 'Create private room' }).click();
  await host.locator('.room-code>span').waitFor();
  await guest.locator('#code').fill(await host.locator('.room-code>span').textContent());
  await guest.locator('#join-form button').click();
  for (const page of pages) {
    await expect(page.locator('.roster')).toContainText('Forge Hammer / Arc Railgun');
    await expect(page.locator('.roster')).toContainText('Auger Drill / Scrap Scattergun');
    await page.getByRole('button', { name: 'Ready up', exact: true }).click();
  }
  await host.getByRole('button', { name: 'Launch round' }).click();
  for (const page of pages) await page.locator('#aim').waitFor({ timeout: 10000 });
  await host.keyboard.down('KeyE');
  await host.waitForTimeout(130);
  await host.keyboard.up('KeyE');
  await expect(guest.locator('.hud-health strong')).toHaveText('58 / 100 HP');
  await expect(host.locator('.weapon-hud').nth(1)).toContainText('COOLING DOWN');
  await guest.keyboard.down('KeyE');
  await guest.waitForTimeout(150);
  await guest.keyboard.up('KeyE');
  await expect(guest.locator('.weapon-hud').nth(1)).toContainText('COOLING DOWN');
  // Scatter pellets cannot reach across the initial 24-unit separation.
  await guest.waitForTimeout(600);
  await expect(host.locator('.hud-health strong')).toHaveText('100 / 100 HP');
  await host.keyboard.down('KeyW');
  await host.waitForTimeout(2800);
  await host.keyboard.up('KeyW');
  await host.keyboard.down('Space');
  await host.waitForTimeout(150);
  await host.keyboard.up('Space');
  await expect(guest.locator('.hud-health strong')).toHaveText('26 / 100 HP');
  await expect(host.locator('.weapon-hud').first()).toContainText('COOLING DOWN');
  // Close the small gap left by the hammer's shove and sustain the drill.
  await guest.keyboard.down('KeyW');
  await guest.waitForTimeout(150);
  await guest.keyboard.up('KeyW');
  await guest.keyboard.down('Space');
  await guest.waitForTimeout(200);
  await expect(guest.locator('.weapon-hud').first()).toContainText('ACTIVE');
  await guest.keyboard.up('Space');
  assert.ok(Number((await host.locator('.hud-health strong').textContent()).split(' ')[0]) < 100);
  await guest.keyboard.down('KeyE');
  await guest.waitForTimeout(150);
  await guest.keyboard.up('KeyE');
  await expect(guest.locator('.weapon-hud').nth(1)).toContainText('COOLING DOWN');
  await host.screenshot({ path: 'artifacts/weapons-combat.png' });
  await host.getByRole('button', { name: 'Menu / Esc' }).click();
  await host.getByRole('button', { name: 'Leave match', exact: true }).click();
  await host.getByRole('button', { name: 'Leave match', exact: true }).last().click();
  await expect(guest.locator('.results h1')).toHaveText('VICTORY');
  assert.deepEqual(errors, []);
  console.log(
    'All four new weapons: garage models/selection, persistence, lobby synchronization, firing, cooldown/active HUD, range and damage passed in two browsers. No page errors.',
  );
} finally {
  await browser.close();
}
