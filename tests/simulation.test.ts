import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../server/simulation.js';
import {
  ARENA_HALF,
  EMPTY_INPUT,
  makePlayer,
  validEquipment,
  validInput,
  validName,
  type Input,
} from '../shared/game.js';

function match() {
  const sim = new Simulation();
  sim.state.players = [
    makePlayer('a', 'Same name', 'ram', 'cannon', 0),
    makePlayer('b', 'Same name', 'saw', 'flamethrower', 1),
  ];
  sim.start();
  sim.state.phase = 'combat';
  return sim;
}
function input(sim: Simulation, id: string, values: Partial<Input>) {
  sim.inputs.set(id, { input: { ...EMPTY_INPUT, ...values }, time: sim.time });
}

test('wire validation rejects invalid names, slots, and forged controls', () => {
  for (const name of ['', '   ', 'x'.repeat(21), 'bad\nname', null, 7])
    assert.equal(validName(name), false);
  assert.ok(validName(' Robot '));
  assert.equal(validEquipment({ front: 'cannon', top: 'ram' }), false);
  assert.equal(validInput({ ...EMPTY_INPUT, forward: Infinity }), false);
  assert.equal(validInput({ ...EMPTY_INPUT, turn: 2 }), false);
  assert.equal(validInput({ ...EMPTY_INPUT, top: 1 }), false);
  assert.ok(validInput(EMPTY_INPUT));
});
test('round reset restores health, stats and fair distinct spawns', () => {
  const sim = match();
  sim.state.players[0]!.hp = 2;
  sim.state.players[0]!.stats.kills = 8;
  sim.start();
  assert.equal(sim.state.remaining, 300);
  assert.equal(sim.state.round, 2);
  assert.equal(sim.state.players[0]!.hp, 100);
  assert.equal(sim.state.players[0]!.stats.kills, 0);
  assert.ok(
    Math.hypot(
      sim.state.players[0]!.x - sim.state.players[1]!.x,
      sim.state.players[0]!.z - sim.state.players[1]!.z,
    ) > 20,
  );
});
test('stale controls stop motion and eliminated robots cannot drive', () => {
  const sim = match(),
    a = sim.state.players[0]!;
  input(sim, a.id, { forward: 1 });
  sim.step(0.1);
  const moved = a.z;
  sim.step(0.3);
  assert.equal(a.z, moved);
  sim.eliminate(a, 'disconnected');
  input(sim, a.id, { forward: 1 });
  sim.step(0.05);
  assert.equal(a.z, moved);
});
test('ram pushes and damages only forward targets and obeys cooldown', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  Object.assign(a!, { x: 0, z: 0, yaw: 0 });
  Object.assign(b!, { x: 0, z: 2.5 });
  input(sim, 'a', { front: true });
  sim.step(0.05);
  assert.equal(b!.hp, 88);
  assert.ok(b!.z > 5);
  assert.equal(a!.stats.damage, 12);
  b!.z = 2.5;
  input(sim, 'a', { front: true });
  sim.step(0.05);
  assert.equal(b!.hp, 88);
  a!.frontCooldown = 0;
  b!.z = -2.5;
  sim.step(0.05);
  assert.equal(b!.hp, 88);
});
test('cannon uses swept hits, awards damage, and obeys cooldown', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  Object.assign(a!, { x: 0, z: 0, yaw: 0 });
  Object.assign(b!, { x: 0, z: 5 });
  input(sim, 'a', { top: true });
  sim.step(0.2);
  assert.equal(b!.hp, 76);
  assert.equal(a!.stats.shots, 1);
  input(sim, 'a', { top: true });
  sim.step(0.05);
  assert.equal(a!.stats.shots, 1);
});
test('flamethrower has a forward cone and heat lockout', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  Object.assign(a!, { x: 0, z: 0, yaw: 0, top: 'flamethrower' });
  Object.assign(b!, { x: 0, z: 4 });
  input(sim, 'a', { top: true });
  sim.step(0.1);
  assert.ok(Math.abs(b!.hp - 98.3) < 0.001);
  b!.z = -4;
  for (let n = 0; n < 65; n++) {
    input(sim, 'a', { top: true });
    sim.step(0.05);
  }
  assert.equal(b!.hp, 98.3);
  assert.equal(a!.overheated, true);
  assert.equal(a!.topActive, false);
  for (let n = 0; n < 90; n++) sim.step(0.05);
  assert.equal(a!.heat, 0);
  assert.equal(a!.overheated, false);
});
test('simultaneous lethal saw hits draw and credit both attackers', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  Object.assign(a!, { x: 0, z: 0, yaw: 0, front: 'saw', hp: 1 });
  Object.assign(b!, { x: 0, z: 2.5, yaw: Math.PI, hp: 1 });
  input(sim, 'a', { front: true });
  input(sim, 'b', { front: true });
  sim.step(0.05);
  assert.equal(sim.state.phase, 'results');
  assert.equal(sim.state.draw, true);
  assert.equal(sim.state.winnerId, null);
  assert.equal(a!.stats.kills, 1);
  assert.equal(b!.stats.kills, 1);
});
test('roof falls decide winner; timeout with survivors is a draw', () => {
  const sim = match();
  sim.state.players[0]!.x = ARENA_HALF + 1;
  sim.step(0.05);
  assert.equal(sim.state.winnerId, 'b');
  assert.equal(sim.state.players[0]!.alive, false);
  assert.equal(sim.state.events.at(-1)!.reason, 'fell off the roof');
  const timed = match();
  timed.state.remaining = 0.01;
  timed.step(0.05);
  assert.equal(timed.state.phase, 'results');
  assert.equal(timed.state.remaining, 0);
  assert.equal(timed.state.draw, true);
});

test('later zero-damage attacks cannot steal a lethal hit in the same tick', () => {
  for (const flame of [false, true]) {
    const sim = match();
    const [a, b] = sim.state.players;
    const c = makePlayer('c', 'Late attacker', 'saw', 'flamethrower', 2);
    sim.state.players.push(c);
    Object.assign(a!, { x: 0, z: 0, yaw: 0, front: 'saw' });
    Object.assign(b!, { x: 0, z: 2.5, hp: 1 });
    Object.assign(c, { x: 0, z: flame ? 8 : 5, yaw: Math.PI });
    input(sim, 'a', { front: true });
    input(sim, 'c', flame ? { top: true } : { front: true });
    sim.step(0.05);
    assert.equal(a!.stats.kills, 1);
    assert.equal(c.stats.damage, 0);
    assert.equal(c.stats.kills, 0);
    assert.equal(sim.state.events.filter((e) => e.type === 'hit' && e.playerId === 'b').length, 1);
  }
});
