import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../server/simulation.js';
import {
  EMPTY_INPUT,
  makePlayer,
  validEquipment,
  type FrontWeapon,
  type TopWeapon,
  type Input,
} from '../shared/game.js';

function match(front: FrontWeapon = 'hammer', top: TopWeapon = 'railgun') {
  const sim = new Simulation();
  sim.state.players = [
    makePlayer('a', 'Attacker', front, top, 0),
    makePlayer('b', 'Target', 'ram', 'cannon', 1),
  ];
  sim.start();
  sim.state.phase = 'combat';
  Object.assign(sim.state.players[0]!, { x: 0, z: 0, yaw: 0 });
  Object.assign(sim.state.players[1]!, { x: 0, z: 10 });
  return sim;
}
function input(sim: Simulation, values: Partial<Input>) {
  sim.inputs.set('a', { input: { ...EMPTY_INPUT, ...values }, time: sim.time });
}
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`);
}

test('all sixteen loadouts are valid and new weapons cannot occupy the wrong slot', () => {
  for (const front of ['ram', 'saw', 'hammer', 'drill'])
    for (const top of ['cannon', 'flamethrower', 'scattergun', 'railgun']) {
      assert.equal(validEquipment({ front, top }), true, `${front}/${top}`);
      assert.equal(validEquipment({ front: top, top: front }), false);
    }
  for (const value of ['constructor', '__proto__', 'laser', null]) {
    assert.equal(validEquipment({ front: value, top: 'railgun' }), false);
    assert.equal(validEquipment({ front: 'drill', top: value }), false);
  }
});

test('hammer delivers one heavy hit and short shove per cooldown', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  b!.z = 2.5;
  input(sim, { front: true });
  sim.step(0.05);
  assert.equal(b!.hp, 68);
  close(b!.z, 3.2);
  assert.equal(a!.stats.damage, 32);
  b!.z = 2.5;
  for (let i = 0; i < 17; i++) {
    input(sim, { front: true });
    sim.step(0.1);
  }
  assert.equal(b!.hp, 68);
  input(sim, { front: true });
  sim.step(0.11);
  assert.equal(b!.hp, 36);
});

test('hammer misses behind, outside its arc, and beyond reach', () => {
  for (const [x, z] of [
    [0, -2.5],
    [2.2, 1.5],
    [0, 3.3],
  ]) {
    const sim = match();
    Object.assign(sim.state.players[1]!, { x, z });
    input(sim, { front: true });
    sim.step(0.1);
    assert.equal(sim.state.players[1]!.hp, 100);
  }
});

test('drill applies continuous damage only inside its narrow cone and reach', () => {
  const sim = match('drill'),
    [a, b] = sim.state.players;
  b!.z = 2.5;
  for (let i = 0; i < 5; i++) {
    input(sim, { front: true });
    sim.step(0.1);
  }
  close(b!.hp, 86);
  close(a!.stats.damage, 14);
  assert.equal(a!.frontCooldown, 0);
  for (const [x, z] of [
    [1.7, 2],
    [0, -2.5],
    [0, 3.1],
  ]) {
    Object.assign(b!, { x, z });
    input(sim, { front: true });
    sim.step(0.1);
    close(b!.hp, 86);
  }
  Object.assign(b!, { x: 0, z: 2.5 });
  input(sim, { front: false });
  sim.step(0.1);
  close(b!.hp, 86);
});

test('scattergun fires five symmetric pellets and counts one shot per cooldown', () => {
  const sim = match('drill', 'scattergun'),
    a = sim.state.players[0]!;
  sim.state.players[1]!.x = 15;
  input(sim, { top: true });
  sim.step(0.01);
  assert.equal(sim.state.projectiles.length, 5);
  assert.equal(a.stats.shots, 1);
  const pellets = [...sim.state.projectiles].sort((a, b) => a.yaw - b.yaw);
  [-0.18, -0.09, 0, 0.09, 0.18].forEach((yaw, i) => {
    close(pellets[i]!.yaw, yaw);
    close(pellets[i]!.distance, 0.3);
  });
  for (let i = 0; i < 11; i++) {
    input(sim, { top: true });
    sim.step(0.1);
  }
  assert.equal(a.stats.shots, 1);
  input(sim, { top: true });
  sim.step(0.11);
  assert.equal(a.stats.shots, 2);
});

test('scattergun pellets combine for 35 damage at close range', () => {
  const sim = match('drill', 'scattergun');
  sim.state.players[1]!.z = 4;
  input(sim, { top: true });
  sim.step(0.1);
  assert.equal(sim.state.players[1]!.hp, 65);
  assert.equal(sim.state.players[0]!.stats.damage, 35);
  assert.equal(sim.state.projectiles.length, 0);
});

test('railgun pierces multiple opponents and never damages one twice', () => {
  const sim = match(),
    [a, b] = sim.state.players;
  b!.z = 3;
  const c = makePlayer('c', 'Rear target', 'ram', 'cannon', 2);
  Object.assign(c, { x: 0, z: 7 });
  sim.state.players.push(c);
  input(sim, { top: true });
  sim.step(0.025);
  assert.equal(b!.hp, 58);
  assert.equal(c.hp, 100);
  assert.equal(sim.state.projectiles.length, 1);
  input(sim, { top: false });
  sim.step(0.005);
  assert.equal(b!.hp, 58);
  sim.step(0.05);
  assert.equal(c.hp, 58);
  assert.equal(b!.hp, 58);
  assert.equal(a!.stats.damage, 84);
  input(sim, { top: true });
  sim.step(0.1);
  assert.equal(a!.stats.shots, 1);
  for (let i = 0; i < 23; i++) {
    input(sim, { top: true });
    sim.step(0.1);
  }
  assert.equal(a!.stats.shots, 1);
  input(sim, { top: true });
  sim.step(0.15);
  assert.equal(a!.stats.shots, 2);
});

test('projectile travel is clipped to remaining range before checking hits', () => {
  for (const top of ['scattergun', 'railgun'] as const) {
    const sim = match('drill', top);
    sim.state.players[1]!.x = 15;
    input(sim, { top: true });
    sim.step(0.001);
    sim.state.projectiles = [sim.state.projectiles.find((q) => q.yaw === 0)!];
    const q = sim.state.projectiles[0]!;
    Object.assign(q, { x: 0, z: 0, distance: (top === 'scattergun' ? 16 : 50) - 0.1 });
    Object.assign(sim.state.players[1]!, { x: 0, z: 3 });
    input(sim, { top: false });
    sim.step(0.1);
    assert.equal(sim.state.players[1]!.hp, 100);
    assert.equal(sim.state.projectiles.length, 0);
  }
});
