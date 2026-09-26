import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.__audio = [];
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        window.__audio.push(this);
      }
    };
  });
  await page.goto(process.env.BROWSER_URL || 'http://localhost:5173');
  await page.locator('#nickname').waitFor();
  assert.equal(await page.evaluate(() => window.__audio.length), 0, 'No audio before interaction');
  await page.locator('#nickname').fill('Neon Pilot');
  await page.locator('#name-form button').click();
  await page.waitForFunction(() => window.__audio[0]?.state === 'running');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const music = page.getByRole('checkbox', { name: 'Synthwave music' });
  await music.uncheck();
  await page.waitForFunction(() => window.__audio[0]?.state === 'suspended');
  assert.equal(
    await page.getByRole('checkbox', { name: 'Sound effects', exact: true }).isChecked(),
    true,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await music.isChecked(), false, 'Mute persisted');
  assert.equal(await page.evaluate(() => window.__audio.length), 0);
  await music.check();
  await page.waitForFunction(() => window.__audio[0]?.state === 'running');
  const before = await page.evaluate(() => window.__audio[0].currentTime);
  await page.waitForTimeout(1200);
  assert.ok((await page.evaluate(() => window.__audio[0].currentTime)) > before + 0.5);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__audio[0]?.state === 'suspended');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__audio[0]?.state === 'running');
  assert.equal(
    await page.evaluate(() => window.__audio.length),
    1,
    'One music context after resume',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Music checks passed: gesture start, independent mute, saved preference, playback clock, visibility pause/resume, no browser errors.',
  );
} finally {
  await browser.close();
}
