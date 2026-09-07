import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botInput } from '../server/bots.js';
import { Simulation } from '../server/simulation.js';
import { ARENA_HALF, EMPTY_INPUT, makePlayer, validInput } from '../shared/game.js';

function pair() {
  const bot = makePlayer('bot', 'Rivet', 'ram', 'cannon', 0);
  bot.bot = true;
  const human = makePlayer('human', 'Pilot', 'saw', 'flamethrower', 1);
  human.z = 8;
  return { bot, human };
}

test('bots aim, approach, and fire only at live opponents in their forward arc', () => {
  const { bot, human } = pair();
  let input = botInput(bot, [bot, human]);
  assert.ok(validInput(input));
  assert.equal(input.top, true); assert.equal(input.front, false); assert.equal(input.forward, 1);
  human.z = 2.4;
  input = botInput(bot, [bot, human]);
  assert.equal(input.front, true); assert.equal(input.forward, 0);
  human.z = -8;
  input = botInput(bot, [bot, human]);
  assert.equal(input.top, false); assert.equal(input.forward, 0); assert.notEqual(input.turn, 0);
  human.alive = false;
  assert.deepEqual(botInput(bot, [bot, human]), EMPTY_INPUT);
  bot.alive = false; human.alive = true;
  assert.deepEqual(botInput(bot, [bot, human]), EMPTY_INPUT);
});

test('bots stop driving outward at the edge and steer toward the center', () => {
  const { bot, human } = pair();
  bot.z = ARENA_HALF - 2; human.z = ARENA_HALF - 1;
  let input = botInput(bot, [bot, human]);
  assert.equal(input.forward, 0); assert.notEqual(input.turn, 0); assert.equal(input.top, false);
  bot.yaw = Math.PI;
  input = botInput(bot, [bot, human]);
  assert.equal(input.forward, 1); assert.ok(Math.abs(input.turn) < .001);
});

test('bots fight through authoritative simulation and load automatically on every round', () => {
  const { bot, human } = pair(), sim = new Simulation();
  sim.state.players = [human, bot];
  sim.start();
  assert.equal(bot.loaded, true); assert.equal(human.loaded, false);
  sim.state.phase = 'combat';
  for (let i = 0; i < 1200 && sim.state.phase === 'combat'; i++) sim.step(.05);
  assert.ok(bot.stats.shots > 0); assert.ok(bot.stats.damage > 0);
  assert.equal(sim.state.phase, 'results'); assert.equal(sim.state.winnerId, bot.id);
  sim.start();
  assert.equal(bot.loaded, true); assert.equal(bot.hp, 100); assert.equal(bot.stats.shots, 0);
});
