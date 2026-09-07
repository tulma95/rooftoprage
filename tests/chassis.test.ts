import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_HALF,
  CHASSIS,
  EMPTY_INPUT,
  drive,
  makePlayer,
  validEquipment,
  type Chassis,
} from '../shared/game.js';
import { driveTerrain, COOLING_POOLS } from '../shared/hazards.js';
import { Simulation } from '../server/simulation.js';

test('chassis trade speed and handling for durability, including reverse and terrain', () => {
  const keys: Chassis[] = ['dart', 'mule', 'bruiser', 'bulwark'];
  for (const [i, chassis] of keys.entries()) {
    const p = makePlayer('a', 'Pilot', 'ram', 'cannon', 0, chassis);
    drive(p, { ...EMPTY_INPUT, forward: 1 }, 1);
    assert.equal(p.z, CHASSIS[chassis].speed);
    drive(p, { ...EMPTY_INPUT, forward: -1 }, 1);
    assert.equal(p.z, CHASSIS[chassis].speed - CHASSIS[chassis].reverse);
    drive(p, { ...EMPTY_INPUT, turn: 1 }, 1);
    assert.equal(p.yaw, CHASSIS[chassis].turn);
    Object.assign(p, COOLING_POOLS[0], { yaw: 0 });
    driveTerrain(p, { ...EMPTY_INPUT, forward: 1 }, 0.1);
    assert.ok(Math.abs(p.z - COOLING_POOLS[0]!.z - CHASSIS[chassis].speed * 0.06) < 1e-10);
    if (i) {
      const previous = CHASSIS[keys[i - 1]!];
      assert.ok(previous.hp < p.hp);
      assert.ok(previous.speed > CHASSIS[chassis].speed);
      assert.ok(previous.turn > CHASSIS[chassis].turn);
    }
  }
});

test('rounds restore each chassis health and the expanded roof permits play beyond the old edge', () => {
  const sim = new Simulation();
  sim.state.players = (Object.keys(CHASSIS) as Chassis[]).map((c, i) =>
    makePlayer(String(i), c, 'ram', 'cannon', i, c),
  );
  sim.state.players.forEach((p) => {
    p.hp = 1;
  });
  sim.start();
  sim.state.phase = 'combat';
  for (const p of sim.state.players) assert.equal(p.hp, CHASSIS[p.chassis].hp);
  const p = sim.state.players[0]!;
  p.x = 25;
  p.z = 0;
  sim.step(0.05);
  assert.equal(p.alive, true);
  p.x = ARENA_HALF + 0.1;
  sim.step(0.05);
  assert.equal(p.alive, false);
});

test('loadout validation accepts legacy defaults and rejects forged chassis', () => {
  const equipment = { front: 'ram', top: 'cannon' };
  assert.ok(validEquipment(equipment));
  for (const chassis of Object.keys(CHASSIS)) assert.ok(validEquipment({ ...equipment, chassis }));
  for (const chassis of ['unknown', 'constructor', '__proto__', null, {}, 2])
    assert.equal(validEquipment({ ...equipment, chassis }), false);
});
