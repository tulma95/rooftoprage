import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/melee-effects-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<body style="margin:0"><canvas style="width:100vw;height:100vh"></canvas></body>',
    }),
  );
  await page.goto(`${process.env.BROWSER_URL || 'http://localhost:5173'}/melee-effects-test`);
  await page.evaluate(async () => {
    const { GameScene } = await import('/client/scene.ts');
    const { makePlayer, EMPTY_INPUT, WEAPONS } = await import('/shared/game.ts');
    const { makeHazards } = await import('/shared/hazards.ts');
    const game = new GameScene(document.querySelector('canvas'));
    game.renderer.setAnimationLoop(null);
    game.setCameraShake(false);
    let elapsed = 0;
    game.timer.getDelta = () => 1 / 60;
    game.timer.getElapsed = () => (elapsed += 1 / 60);
    window.fixture = { game, makePlayer, EMPTY_INPUT, WEAPONS, makeHazards };
  });
  for (const weapon of ['hammer', 'sweeper', 'flipper', 'hook', 'ram', 'wedge', 'saw', 'drill']) {
    const result = await page.evaluate((weapon) => {
      const { game, makePlayer, EMPTY_INPUT, WEAPONS, makeHazards } = window.fixture;
      const a = makePlayer('a', 'Attacker', weapon, 'cannon', 0);
      const b = makePlayer('b', 'Target', 'saw', 'cannon', 1);
      Object.assign(a, {
        x: 0,
        z: 0,
        yaw: 0,
        frontCooldown: WEAPONS[weapon].cooldown,
        frontActive: true,
      });
      Object.assign(b, { x: 0, z: 2.5, yaw: Math.PI });
      const state = {
        ...makeHazards(),
        code: weapon,
        round: 1,
        phase: 'combat',
        players: [a, b],
        events: [],
        projectiles: [],
      };
      game.update(state, 'a', EMPTY_INPUT);
      for (let i = 0; i < 60; i++) game.frame();
      const attacker = game.robots.get('a'),
        victim = game.robots.get('b');
      const missFlash = victim.flash;
      state.events = [
        { id: 1, type: 'hit', playerId: 'b', attackerId: 'a', melee: weapon, x: 0, z: 2.5 },
      ];
      game.frame();
      const hold = attacker.meleeHold;
      const flash = victim.flash;
      // The attachment slams into its contact pose over 40 ms before holding it.
      while (attacker.slam > 0) game.frame();
      const pose = attacker.hammer?.rotation.x;
      const x = attacker.group.position.x;
      a.x = 0.5;
      game.frame();
      const movesDuringHold = attacker.group.position.x !== x;
      const heldPose = attacker.hammer?.rotation.x;
      const wheelsGrounded = attacker.group.position.y === 0 && victim.group.position.y === 0;
      // Rendering alone has no audio system; capture the visual contact cue at a fixed time.
      game.camera.position.set(6, 5, -5);
      game.camera.lookAt(0, 0.8, 1.5);
      game.renderer.render(game.scene, game.camera);
      const colorIsLocal =
        victim.paint !== attacker.paint &&
        victim.paint.emissiveIntensity > attacker.paint.emissiveIntensity;
      window.fixture.state = state;
      return {
        weapon,
        hold,
        flash,
        missFlash,
        pose,
        heldPose,
        movesDuringHold,
        wheelsGrounded,
        colorIsLocal,
        particles: game.effects.sparks.count,
      };
    }, weapon);
    assert.equal(result.missFlash, 0);
    assert.ok(result.flash > 0 && result.particles > 0);
    assert.ok(result.movesDuringHold && result.wheelsGrounded && result.colorIsLocal);
    if (weapon === 'hammer') {
      assert.ok(result.hold >= 0.06);
      assert.equal(result.pose, result.heldPose);
    }
    await page.screenshot({ path: `artifacts/melee-impact-${weapon}.png` });
    const reset = await page.evaluate(() => {
      const { game, state, EMPTY_INPUT } = window.fixture;
      for (let i = 0; i < 6; i++) game.frame();
      const attacker = game.robots.get('a');
      if (attacker.hammer && attacker.hammer.rotation.x < 0.4)
        throw new Error('hammer rewound into its windup after the contact hold');
      for (let i = 0; i < 20; i++) game.frame();
      if (game.robots.get('b').flash !== 0)
        throw new Error('an already-seen hit retriggered the flash');
      game.update(
        {
          ...state,
          round: 2,
          events: [],
          players: state.players.map((p) => ({ ...p, frontActive: false, frontCooldown: 0 })),
        },
        'a',
        EMPTY_INPUT,
      );
      game.frame();
      return [...game.robots.values()].every(
        (r) => r.flash === 0 && r.meleeHold === 0 && r.kick.length() === 0,
      );
    });
    assert.ok(reset, 'round reset clears contact reactions');
    console.log(`${weapon}: contact, flash, grounded reaction, live movement and reset passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
