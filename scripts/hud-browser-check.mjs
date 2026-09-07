import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/hud-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="hud"></div>' }),
  );
  await page.goto(`${process.env.BROWSER_URL || 'http://localhost:5173'}/hud-test`);
  const result = await page.evaluate(async () => {
    const { BattleHud } = await import('/client/hud.ts');
    const { Simulation } = await import('/server/simulation.ts');
    const { makePlayer } = await import('/shared/game.ts');
    const sim = new Simulation();
    sim.state.players = [
      makePlayer('a', '<img src=x>', 'saw', 'cannon', 0),
      makePlayer('b', 'B', 'ram', 'railgun', 1),
    ];
    sim.start();
    sim.state.phase = 'combat';
    const hud = new BattleHud(document.querySelector('#hud'));
    const update = () =>
      hud.update({
        state: sim.state,
        sessionId: 'a',
        watched: sim.state.players.find((p) => p.alive),
        unstable: false,
        message: '',
      });
    update();
    const menu = document.querySelector('[data-action="menu"]');
    const timer = document.querySelector('.hud-timer');
    const meter = document.querySelector('.hud-health .meter i');
    const aim = document.querySelector('#aim');
    aim.style.left = '42px';
    menu.focus();
    for (let tick = 0; tick < 100; tick++) {
      sim.state.remaining -= 0.05;
      sim.state.players[0].hp -= 0.1;
      sim.state.players[0].topCooldown = tick / 100;
      update();
    }
    const stable =
      menu === document.activeElement &&
      timer === document.querySelector('.hud-timer') &&
      meter === document.querySelector('.hud-health .meter i') &&
      aim === document.querySelector('#aim') &&
      aim.style.left === '42px';
    const safeName =
      !document.querySelector('img') &&
      document.querySelector('.hud-health .eyebrow').textContent === '<img src=x>';
    sim.state.players[0].alive = false;
    update();
    const spectator =
      !document.querySelector('#aim') &&
      document.querySelectorAll('.hud-weapons kbd').length === 0 &&
      document.querySelector('.hud-health .eyebrow').textContent === 'Spectating / B';
    sim.state.phase = 'results';
    sim.state.winnerId = 'b';
    update();
    return {
      stable,
      safeName,
      spectator,
      result: document.querySelector('.results h1').textContent,
    };
  });
  assert.deepEqual(result, { stable: true, safeName: true, spectator: true, result: 'ELIMINATED' });
  console.log('HUD keeps controls, focus and aim stable; updates spectator/results safely.');
} finally {
  await browser.close();
}
