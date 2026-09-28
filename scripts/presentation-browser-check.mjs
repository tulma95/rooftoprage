import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/visual-check', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body style="margin:0"><canvas style="width:100vw;height:100vh"></canvas></body>',
    }),
  );
  await page.goto(`${process.env.BROWSER_URL || 'http://localhost:5173'}/visual-check`);
  await page.evaluate(async () => {
    const { GameScene } = await import('/client/scene.ts');
    const { makePlayer, EMPTY_INPUT } = await import('/shared/game.ts');
    const { makeHazards } = await import('/shared/hazards.ts');
    const scene = new GameScene(document.querySelector('canvas'));
    const a = makePlayer('a', 'Winner', 'hammer', 'cannon', 0),
      b = makePlayer('b', 'Loser', 'ram', 'cannon', 1);
    Object.assign(a, { x: 0, z: 0, yaw: Math.PI / 2 });
    Object.assign(b, { x: 4, z: 4, yaw: Math.PI / 2 });
    const state = {
      code: 'TEST',
      round: 1,
      phase: 'combat',
      players: [a, b],
      events: [],
      projectiles: [],
      ...makeHazards(),
      winnerId: null,
      draw: false,
      remaining: 120,
      countdown: 0,
      hostId: 'a',
      notice: '',
    };
    window.visual = { scene, state, input: EMPTY_INPUT };
    scene.update(state, 'a', EMPTY_INPUT);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/presentation-center.png' });
  const grounding = await page.evaluate(async () => {
    const { scene, state, input } = window.visual;
    let lowestRoot = Infinity,
      lowestWheel = Infinity,
      lowestBody = Infinity;
    for (let frame = 0; frame < 90; frame++) {
      const next = structuredClone(state);
      next.events = [{ id: frame + 1, type: 'hit', playerId: 'a', x: 0, z: 0 }];
      scene.update(next, 'a', input);
      await new Promise(requestAnimationFrame);
      const robot = scene.robots.get('a');
      lowestRoot = Math.min(lowestRoot, robot.group.position.y);
      lowestBody = Math.min(lowestBody, robot.suspension.position.y);
      // Relative to the scaled resting height: chassis scale shrinks lighter robots' wheels.
      for (const wheel of robot.wheels)
        lowestWheel = Math.min(
          lowestWheel,
          wheel.getWorldPosition(wheel.position.clone()).y /
            (robot.wheelRadius * robot.group.scale.y),
        );
    }
    return { lowestRoot, lowestWheel, lowestBody };
  });
  assert.ok(grounding.lowestRoot >= 0, 'Repeated hits must not lower the robot root');
  assert.ok(grounding.lowestWheel >= 0.976, 'Wheel centers must remain at their resting height');
  assert.ok(grounding.lowestBody >= -0.031, 'Suspension compression must stay bounded');
  await page.evaluate(() => {
    const { scene, state, input } = window.visual;
    state.players[0].x = 26;
    state.players[1].x = 27;
    scene.update(structuredClone(state), 'a', input);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/presentation-edge.png' });
  await page.evaluate(() => {
    const { scene, state, input } = window.visual;
    const next = structuredClone(state);
    next.players[1].alive = false;
    next.players[1].x = 29;
    next.phase = 'results';
    next.winnerId = 'a';
    next.events = [
      { id: 1000, type: 'elimination', playerId: 'b', reason: 'fell off the roof', x: 29, z: 0 },
    ];
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
  console.log(
    'Center skyline, grounded repeated hits, edge view, final fall, cinematic expiry, and round reset pass without browser errors.',
  );
} finally {
  await browser.close();
}
