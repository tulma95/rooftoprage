import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [];
try {
  const pages = [];
  for (const name of ['Wedge Pilot', 'Ram Pilot']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    pages.push(page);
    await page.goto(process.env.BROWSER_URL || 'http://localhost:5173');
    await page.locator('#nickname').fill(name);
    await page.locator('#name-form button').click();
  }
  const [p, q] = pages;
  const inputs = await p.evaluate(async () => {
    const { KeyboardInput } = await import('/client/input.ts');
    const keyboard = new KeyboardInput(
      () => true,
      () => {},
    );
    const down = (code, repeat = false) =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code, repeat, bubbles: true }));
    const sample = (yaw = 0) => ({ ...keyboard.sample(true, yaw) });
    down('ArrowLeft');
    down('ShiftLeft');
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowLeft', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true }));
    const left = sample();
    const held = sample();
    down('ShiftLeft', true);
    const repeated = sample();
    keyboard.clear();
    down('ShiftRight');
    const forward = sample(Math.PI / 2);
    keyboard.clear();
    down('KeyD');
    down('KeyS');
    down('ShiftLeft');
    const diagonal = sample();
    keyboard.clear();
    down('ShiftLeft');
    keyboard.clear();
    const cleared = sample();
    return { left, held, repeated, forward, diagonal, cleared };
  });
  assert.equal(inputs.left.boost, true);
  assert.equal(inputs.left.boostX, 1);
  assert.equal(inputs.left.boostZ, 0);
  assert.equal(inputs.held.boost, false);
  assert.equal(inputs.repeated.boost, false);
  assert.ok(Math.abs(inputs.forward.boostX - 1) < 1e-8);
  assert.ok(Math.abs(inputs.forward.boostZ) < 1e-8);
  assert.ok(Math.abs(Math.hypot(inputs.diagonal.boostX, inputs.diagonal.boostZ) - 1) < 1e-8);
  assert.equal(inputs.cleared.boost, false);

  await p.getByRole('button', { name: 'Customize machine' }).click();
  await p.locator('[data-equip="wedge"]').click();
  assert.match(await p.locator('[data-equip="wedge"]').textContent(), /LIFT \+ PUSH/);
  await mkdir('artifacts', { recursive: true });
  await p.screenshot({ path: 'artifacts/wedge-garage.png' });
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
  await p.locator('[data-slot="boost"] small').filter({ hasText: 'READY' }).waitFor();
  await p.keyboard.down('ShiftLeft');
  await p.locator('[data-slot="boost"] small').filter({ hasText: 'RECHARGING' }).waitFor();
  await p
    .locator('[data-slot="boost"] small')
    .filter({ hasText: 'READY' })
    .waitFor({ timeout: 4000 });
  await p.waitForTimeout(400);
  assert.match(await p.locator('[data-slot="boost"] small').textContent(), /READY/);
  await p.keyboard.up('ShiftLeft');
  await p.keyboard.down('ArrowRight');
  await p.keyboard.press('ShiftLeft');
  await p.keyboard.up('ArrowRight');
  await p.locator('[data-slot="boost"] small').filter({ hasText: 'RECHARGING' }).waitFor();
  await p.screenshot({ path: 'artifacts/pushing-combat.png' });
  for (const width of [1280, 1024, 760, 390]) {
    await p.setViewportSize({ width, height: 800 });
    const bounds = await p.locator('.hud-weapons').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `HUD fits ${width}px`);
  }
  assert.deepEqual(failures, []);
  console.log(
    'Pushing browser checks passed: normalized directional bursts, one-press latch, clear/reset, wedge selection/render, live cooldown and responsive HUD.',
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) console.error(await page.locator('body').innerText());
  console.error(failures);
  throw error;
} finally {
  await browser.close();
}
