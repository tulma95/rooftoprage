import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/effects-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<canvas style="width:1280px;height:720px"></canvas>',
    }),
  );
  await page.goto(`${process.env.BROWSER_URL || 'http://localhost:5173'}/effects-test`);
  const result = await page.evaluate(async () => {
    const { GameScene } = await import('/client/scene.ts');
    const { makePlayer, EMPTY_INPUT } = await import('/shared/game.ts');
    const game = new GameScene(document.querySelector('canvas'));
    game.renderer.setAnimationLoop(null);
    const players = ['cannon', 'scattergun', 'railgun', 'flamethrower'].map((weapon, i) => {
      const p = makePlayer(String(i), `Pilot ${i}`, 'saw', weapon, i);
      p.x = i * 3 - 4;
      p.z = 0;
      return p;
    });
    const state = { code: 'TEST', round: 1, phase: 'combat', players, events: [], projectiles: [] };
    game.update(state, '0', EMPTY_INPUT);
    // Keep the camera fixed so newly revealed scenery cannot affect resource counts.
    game.setCameraShake(false);
    game.target.set(-4, 0.6, 3);
    game.frame();
    const idleCalls = game.renderer.info.render.calls;
    const sample = () => ({
      ...game.renderer.info.memory,
      programs: game.renderer.info.programs.length,
    });
    const volley = (frame) => {
      state.projectiles = Array.from({ length: 20 }, (_, i) => ({
        id: frame * 20 + i,
        weapon: 'scattergun',
        x: (i % 5) - 2,
        z: 3 + Math.floor(i / 5),
        yaw: 0,
      }));
      for (let i = 0; i < 4; i++) {
        game.effects.shot(i * 3 - 4, 1.4, 0, 0, players[i].top);
        game.effects.impact(i * 3 - 4, 5, i === 0);
        game.effects.flame(5, 1.4, 0, 0, 1 / 60);
      }
      game.effects.step(1 / 60);
      game.frame();
    };
    volley(0);
    const warm = sample();
    let peakCalls = 0;
    for (let frame = 1; frame <= 120; frame++) {
      game.effects.step(1 / 60);
      volley(frame);
      peakCalls = Math.max(peakCalls, game.renderer.info.render.calls);
    }
    const sustained = sample();
    window.weaponEffectsGame = game;
    game.effects.clear();
    state.projectiles = [];
    game.frame();
    return { idleCalls, peakCalls, warm, sustained, clearedSparks: game.effects.sparks.count };
  });
  await page.evaluate(() => {
    const game = window.weaponEffectsGame;
    game.effects.shot(-4, 1.4, 0, 0, 'cannon');
    game.effects.shot(2, 1.4, 0, 0, 'railgun');
    game.effects.impact(-1, 4, true);
    game.effects.step(0.08);
    game.renderer.render(game.scene, game.camera);
  });
  await page.screenshot({ path: 'artifacts/weapon-effects.png' });
  assert.deepEqual(result.sustained, result.warm, 'sustained fire must not allocate GPU resources');
  assert.ok(
    result.peakCalls <= result.idleCalls + 24,
    '20 pellets and the four particle batches need at most 24 draw calls',
  );
  assert.equal(result.clearedSparks, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
