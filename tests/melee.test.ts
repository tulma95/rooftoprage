import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Simulation } from '../server/simulation.js';
import {
  ARENA_HALF,
  EMPTY_INPUT,
  makePlayer,
  type Chassis,
  type FrontWeapon,
} from '../shared/game.js';

const attachments = ['sweeper', 'flipper', 'hook'] as const;

function match(front: FrontWeapon, chassis: Chassis = 'mule') {
  const sim = new Simulation();
  sim.state.players = [
    makePlayer('a', 'Attacker', front, 'cannon', 0),
    makePlayer('b', 'Target', 'saw', 'cannon', 1, chassis),
  ];
  sim.start();
  sim.state.phase = 'combat';
  resetPositions(sim);
  return sim;
}

function resetPositions(sim: Simulation) {
  Object.assign(sim.state.players[0]!, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, lifted: 0 });
  Object.assign(sim.state.players[1]!, { x: 0, z: 2.5, yaw: 0, vx: 0, vz: 0, lifted: 0 });
}

function fire(sim: Simulation, dt = 0.01) {
  sim.setInput('a', { ...EMPTY_INPUT, front: true });
  sim.step(dt);
}

test('sweeper primarily shoves sideways and rotates both robots with opposing recoil', () => {
  const sim = match('sweeper');
  const [a, b] = sim.state.players;
  fire(sim);
  assert.equal(b!.hp, 95);
  assert.ok(b!.vx! > b!.vz! * 2);
  assert.ok(b!.vz! > 0);
  assert.ok(b!.yaw > 0);
  assert.ok(a!.vx! < 0);
  assert.ok(a!.yaw < 0);
  const before = b!.x;
  sim.setInput('a', EMPTY_INPUT);
  sim.step(0.05);
  assert.ok(b!.x > before, 'the sideways impulse must move the target on following ticks');
});

test('flipper lifts and launches the target forward while recoiling backward', () => {
  const sim = match('flipper');
  const [a, b] = sim.state.players;
  fire(sim);
  assert.equal(b!.hp, 96);
  assert.ok(b!.vz! > 0);
  assert.equal(b!.vx, 0);
  assert.ok(a!.vz! < 0);
  assert.ok(b!.lifted! >= 0.5);
  sim.setInput('a', EMPTY_INPUT);
  for (let i = 0; i < 22; i++) sim.step(0.05);
  assert.equal(b!.lifted, 0, 'the launched target must regain traction');
});

test('hook pulls both robots toward each other and deals only a small hit', () => {
  const sim = match('hook');
  const [a, b] = sim.state.players;
  fire(sim);
  assert.equal(b!.hp, 98);
  assert.ok(b!.vz! < 0);
  assert.ok(a!.vz! > 0);
  assert.equal(b!.vx, 0);
  assert.equal(a!.vx, 0);
});

test('each displacement attachment moves a light target more strongly than a heavy one', () => {
  for (const front of attachments) {
    function strength(chassis: Chassis) {
      const sim = match(front, chassis);
      fire(sim);
      const target = sim.state.players[1]!;
      return Math.hypot(target.vx!, target.vz!);
    }
    assert.ok(strength('dart') > strength('bulwark'), front);
  }
});

test('new attachments cannot hit behind, outside the forward arc, or beyond reach', () => {
  for (const front of attachments)
    for (const [x, z] of [
      [0, -2.5],
      [2.5, 0],
      [0, 5],
    ]) {
      const sim = match(front);
      const [a, b] = sim.state.players;
      Object.assign(b!, { x, z });
      fire(sim);
      assert.equal(b!.hp, 100, `${front} hit (${x}, ${z})`);
      assert.equal(b!.vx, 0);
      assert.equal(b!.vz, 0);
      assert.equal(b!.lifted, 0);
      assert.equal(b!.yaw, 0);
      assert.equal(a!.vx, 0);
      assert.equal(a!.vz, 0);
    }
});

test('new attachments cannot repeat during cooldown but can strike again after recovery', () => {
  for (const [front, damage] of [
    ['sweeper', 5],
    ['flipper', 4],
    ['hook', 2],
  ] as const) {
    const sim = match(front);
    const [a, b] = sim.state.players;
    fire(sim);
    for (let i = 0; i < 10; i++) {
      resetPositions(sim);
      fire(sim, 0.05);
    }
    assert.equal(b!.hp, 100 - damage, `${front} repeated during cooldown`);
    sim.setInput('a', EMPTY_INPUT);
    b!.x = 15;
    for (let i = 0; i < 40; i++) sim.step(0.05);
    assert.equal(a!.frontCooldown, 0);
    resetPositions(sim);
    fire(sim);
    assert.equal(b!.hp, 100 - damage * 2, `${front} did not recover`);
  }
});

test('hook selects only the nearest eligible target, regardless of player ordering', () => {
  const sim = match('hook');
  const [a, near] = sim.state.players;
  Object.assign(near!, { x: -1.1, z: 2.3 });
  const far = makePlayer('far', 'Far target', 'saw', 'cannon', 2);
  Object.assign(far, { x: 1.1, z: 2.7 });
  const behind = makePlayer('behind', 'Closer but behind', 'saw', 'cannon', 3);
  behind.z = -2.2;
  sim.state.players = [a!, far, behind, near!];
  fire(sim);
  assert.equal(near!.hp, 98);
  assert.ok(near!.vx! > 0 && near!.vz! < 0);
  assert.ok(a!.vx! < 0 && a!.vz! > 0);
  for (const untouched of [far, behind]) {
    assert.equal(untouched.hp, 100);
    assert.equal(untouched.vx, 0);
    assert.equal(untouched.vz, 0);
  }
  assert.equal(a!.stats.damage, 2);
});

test('a sweep hits both sides of its arc identically regardless of roster order', () => {
  function sweep(reverse: boolean) {
    const sim = match('sweeper');
    const [a, left] = sim.state.players;
    Object.assign(left!, { x: -2.8, z: 1 });
    const right = makePlayer('right', 'Right target', 'saw', 'cannon', 2);
    Object.assign(right, { x: 2.8, z: 1 });
    sim.state.players = reverse ? [a!, right, left!] : [a!, left!, right];
    fire(sim);
    for (const target of [left!, right]) {
      assert.equal(target.hp, 95, 'the first hit must not turn the sweep away from the second');
      assert.ok(target.vx! > 0);
    }
    return [a!, left!, right].map(({ hp, vx, vz, yaw }) => ({ hp, vx, vz, yaw }));
  }
  assert.deepEqual(sweep(false), sweep(true));
});

test('passive wedge contact and powered lifting cannot shorten an existing flipper lift', () => {
  for (const powered of [false, true]) {
    const sim = match('flipper');
    const [a, b] = sim.state.players;
    fire(sim);
    const lift = b!.lifted!;
    Object.assign(a!, { front: 'wedge', frontCooldown: 0, vx: 0, vz: 0 });
    // Test physical contact separately from the powered attachment's extended reach.
    Object.assign(b!, { z: powered ? 2.5 : 2.05, vx: 0, vz: 0 });
    sim.setInput('a', { ...EMPTY_INPUT, front: powered });
    sim.step(0.01);
    assert.ok(b!.lifted! > lift - 0.02, `${powered ? 'powered' : 'passive'} wedge cut lift short`);
    assert.equal(b!.hp, 96);
  }
});

test('a flipper launch awards ring-out credit when the opponent falls on a later tick', () => {
  const sim = match('flipper');
  const [a, b] = sim.state.players;
  a!.z = ARENA_HALF - 3;
  b!.z = ARENA_HALF - 0.5;
  fire(sim);
  assert.equal(b!.alive, true);
  sim.setInput('a', EMPTY_INPUT);
  for (let i = 0; i < 20 && b!.alive; i++) sim.step(0.05);
  assert.equal(b!.alive, false);
  assert.equal(a!.stats.kills, 1);
  assert.equal(sim.state.winnerId, a!.id);
  assert.equal(sim.state.events.at(-1)!.attackerId, a!.id);
  assert.equal(sim.state.events.at(-1)!.reason, 'fell off the roof');
});

test('confirmed melee hits identify the attachment, including zero-damage wedge contact', () => {
  for (const weapon of [
    'ram',
    'wedge',
    'sweeper',
    'flipper',
    'hook',
    'saw',
    'hammer',
    'drill',
  ] as const) {
    const sim = match(weapon);
    fire(sim);
    const hits = sim.state.events.filter((event) => event.type === 'hit' && event.melee);
    assert.equal(hits.length, 1, weapon);
    assert.equal(hits[0]!.melee, weapon);
    assert.equal(hits[0]!.attackerId, 'a');
    assert.equal(hits[0]!.playerId, 'b');
    if (weapon === 'wedge') assert.equal(sim.state.players[1]!.hp, 100);
    const miss = match(weapon);
    miss.state.players[1]!.z = 12;
    fire(miss);
    assert.ok(
      miss.state.events.every((event) => !event.melee),
      'misses have no contact feedback',
    );
  }
});
