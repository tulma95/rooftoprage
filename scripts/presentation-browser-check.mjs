import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/visual-check', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><canvas style="width:100vw;height:100vh"></canvas></body>' }));
  await page.goto('http://localhost:5173/visual-check');
  await page.evaluate(async () => {
    const { GameScene } = await import('/client/scene.ts');
    const { makePlayer, EMPTY_INPUT } = await import('/shared/game.ts');
    const { makeHazards } = await import('/shared/hazards.ts');
    const scene = new GameScene(document.querySelector('canvas'));
    const a = makePlayer('a', 'Winner', 'hammer', 'cannon', 0), b = makePlayer('b', 'Loser', 'ram', 'cannon', 1);
    Object.assign(a, { x: 22, z: 0, yaw: Math.PI / 2 });
    Object.assign(b, { x: 27, z: 0, yaw: Math.PI / 2 });
    const state = { code: 'TEST', round: 1, phase: 'combat', players: [a,b], events: [], projectiles: [], ...makeHazards(), winnerId: null, draw: false, remaining: 120, countdown: 0, hostId: 'a', notice: '' };
    window.visual = { scene, state, input: EMPTY_INPUT };
    scene.update(state, 'a', EMPTY_INPUT);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/presentation-edge.png' });
  await page.evaluate(() => {
    const { scene, state, input } = window.visual;
    const next = structuredClone(state);
    next.players[1].alive = false; next.players[1].x = 29;
    next.phase = 'results'; next.winnerId = 'a';
    next.events = [{ id: 1, type: 'elimination', playerId: 'b', reason: 'fell off the roof', x: 29, z: 0 }];
    scene.update(next, 'a', input);
  });
  assert.equal(await page.evaluate(() => window.visual.scene.cinematicActive), true);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'artifacts/presentation-fall.png' });
  await page.waitForFunction(() => !window.visual.scene.cinematicActive);
  await page.evaluate(() => {
    const { scene, state, input } = window.visual;
    scene.update({ ...state, round: 2, phase: 'loading' }, 'a', input);
  });
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  console.log('Edge view, final fall, cinematic expiry, and round reset render without browser errors.');
} finally { await browser.close(); }
