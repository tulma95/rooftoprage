import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  await mkdir('artifacts', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.BROWSER_URL || 'http://localhost:5173');
  await page.locator('#nickname').fill('Chassis Pilot');
  await page.locator('#name-form button').click();
  await page.getByRole('button', { name: 'Customize machine' }).click();
  for (const chassis of ['dart', 'bruiser', 'bulwark', 'mule']) {
    await page.locator(`[data-chassis="${chassis}"]`).click();
    assert.equal(await page.locator(`[data-chassis="${chassis}"]`).getAttribute('aria-pressed'), 'true');
    await page.waitForTimeout(150);
  }
  await page.locator('[data-chassis="bulwark"]').click();
  await page.screenshot({ path: 'artifacts/chassis-garage.png', fullPage: true });
  await page.getByRole('button', { name: 'Save loadout' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Customize machine' }).click();
  assert.equal(await page.locator('[data-chassis="bulwark"]').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/chassis-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Save loadout' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Play with bots' }).click();
  await page.locator('.roster').waitFor();
  assert.match(await page.locator('.roster').innerText(), /Bulwark/);
  assert.match(await page.locator('.roster').innerText(), /Dart/);
  assert.match(await page.locator('.roster').innerText(), /Bruiser/);
  await page.getByRole('button', { name: 'Ready up', exact: true }).click();
  await page.getByRole('button', { name: 'Launch round' }).click();
  await page.locator('#aim').waitFor({ timeout: 10000 });
  assert.match(await page.locator('.hud-health').innerText(), /170\s*\/ 170 HP/);
  assert.equal(await page.locator('.hud-health .meter i').evaluate(el => el.style.width), '100%');
  await page.screenshot({ path: 'artifacts/chassis-combat.png' });
  assert.deepEqual(errors, []);
  console.log('Chassis previews, saved selection, mobile layout, bot loadouts and combat health passed.');
} finally { await browser.close(); }
