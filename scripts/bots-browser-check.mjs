import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BROWSER_URL || 'http://localhost:5173');
  await page.locator('#nickname').fill('Solo Pilot');
  await page.locator('#name-form button').click();
  await page.getByRole('button', { name: 'Play with bots', exact: true }).click();
  await expect(page.locator('.roster .pilot')).toHaveCount(4);
  await expect(page.locator('.roster')).toContainText('Rivet · BOT');
  await expect(page.locator('.room-code')).toContainText('YOU + 3 BOTS');
  await page.getByRole('button', { name: 'Ready up', exact: true }).click();
  await page.getByRole('button', { name: 'Launch round' }).click();
  await page.locator('#aim').waitFor({ timeout: 10000 });
  await expect(page.locator('.hud-roster')).toContainText('Cinder');
  // An idle solo player must still see bots fight and the round finish.
  await page.locator('.results').waitFor({ timeout: 90000 });
  await expect(page.locator('.results tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Play again', exact: true }).click();
  await expect(page.locator('.roster .pilot')).toHaveCount(4);
  assert.equal(await page.locator('.roster .ready').count(), 3);
  await page.getByRole('button', { name: 'Ready up', exact: true }).click();
  await page.getByRole('button', { name: 'Launch round' }).click();
  await page.locator('#aim').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Menu / Esc' }).click();
  await page.getByRole('button', { name: 'Leave match', exact: true }).click();
  await page.getByRole('button', { name: 'Leave match', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Play with bots', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'Solo practice: three bots, combat, results, rematch, and leaving pass with no browser errors.',
  );
} finally {
  await browser.close();
}
