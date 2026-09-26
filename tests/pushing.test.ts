import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Simulation } from '../server/simulation.js';
import {
  ARENA_HALF,
  EMPTY_INPUT,
  drive,
  makePlayer,
  type Chassis,
  type FrontWeapon,
  type Input,
} from '../shared/game.js';

function match(front: FrontWeapon = 'saw', attacker: Chassis = 'mule', target: Chassis = 'mule') {
  const sim = new Simulation();
  sim.state.players = [
    makePlayer('a', 'Attacker', front, 'cannon', 0, attacker),
    makePlayer('b', 'Target', 'saw', 'cannon', 1, target),
  ];
  sim.start();
  sim.state.phase = 'combat';
  Object.assign(sim.state.players[0]!, { x: 0, z: 0, yaw: 0 });
  Object.assign(sim.state.players[1]!, { x: 0, z: 2.15, yaw: 0 });
  return sim;
}

function input(sim: Simulation, id: string, values: Partial<Input>) {
  sim.inputs.set(id, { input: { ...EMPTY_INPUT, ...values }, time: sim.time });
}

test('a burst travels only a few meters, and sideways dodges preserve facing', () => {
  for (const dt of [0.01, 0.05]) {
    const p = makePlayer('a', 'Pilot', 'ram', 'cannon', 0);
    for (let i = 0; i < Math.round(1 / dt); i++)
      drive(p, { ...EMPTY_INPUT, boost: i === 0, boostX: 1, boostZ: 0 }, dt);
    assert.ok(p.x >= 2 && p.x <= 3, `burst covered ${p.x}m at dt=${dt}`);
    assert.equal(p.z, 0);
    assert.equal(p.yaw, 0);
    assert.ok((p.boostCooldown ?? 0) > 1);
  }
});

test('holding burst cannot repeat it, and a fresh press waits for cooldown', () => {
  const p = makePlayer('a', 'Pilot', 'ram', 'cannon', 0);
  for (let i = 0; i < 80; i++) drive(p, { ...EMPTY_INPUT, boost: true }, 0.05);
  assert.ok(p.z >= 2 && p.z <= 3, `held boost covered ${p.z}m`);
  drive(p, EMPTY_INPUT, 0.05);
  drive(p, { ...EMPTY_INPUT, boost: true }, 0.05);
  assert.ok((p.boostCooldown ?? 0) > 2);
  const cooldown = p.boostCooldown!;
  drive(p, EMPTY_INPUT, 0.05);
  drive(p, { ...EMPTY_INPUT, boost: true }, 0.05);
  assert.ok(p.boostCooldown! < cooldown, 'early press must not reset cooldown');
  for (let i = 0; i < 20; i++) drive(p, EMPTY_INPUT, 0.05);
  assert.ok(p.z >= 4 && p.z <= 6, `two boosts covered ${p.z}m`);
});

test('a burst press survives a release before the tick while newer steering is retained', () => {
  const sim = match();
  const [a, b] = sim.state.players;
  b!.z = -15;
  sim.setInput('a', { ...EMPTY_INPUT, boost: true, boostX: 1, boostZ: 0 });
  sim.setInput('a', { ...EMPTY_INPUT, boost: false, forward: 1, turn: 1 });
  const pending = sim.inputs.get('a')!.input;
  assert.equal(pending.forward, 1);
  assert.equal(pending.turn, 1);
  sim.step(0.05);
  assert.ok(a!.vx! > 10, 'the short sideways press must still trigger a burst');
  assert.ok(a!.z > 0.3, 'the newer forward control must still drive');
  assert.ok(a!.yaw > 0, 'the newer turn control must still steer');
  const cooldown = a!.boostCooldown!;
  sim.setInput('a', { ...EMPTY_INPUT, boost: false });
  assert.equal(sim.inputs.get('a')!.input.boost, false);
  sim.step(0.05);
  assert.equal(a!.boostHeld, false);
  assert.ok(a!.boostCooldown! < cooldown);
  for (let i = 0; i < 60; i++) sim.step(0.05);
  assert.equal(a!.boostCooldown, 0);
  assert.ok(a!.x >= 2 && a!.x <= 3, 'the released pulse must not trigger a second burst');
});

test('collision speed and mass determine shove and the attacker recoils', () => {
  function impact(speed: number, attacker: Chassis = 'mule', target: Chassis = 'mule') {
    const sim = match('saw', attacker, target);
    // Begin just touching so slow and fast runs both make contact in this tick.
    sim.state.players[1]!.z = 2.1;
    input(sim, 'a', { forward: speed });
    sim.step(0.01);
    return sim.state.players;
  }
  const [fastAttacker, fastTarget] = impact(1);
  const [, slowTarget] = impact(0.25);
  assert.ok(fastTarget!.vz! > slowTarget!.vz!);
  assert.ok(fastAttacker!.vz! < 0, 'impact must also jolt the attacker');
  // Equalize commanded speed to isolate chassis mass from its speed tradeoff.
  const [, heavyAttackerTarget] = impact(0.5, 'bulwark');
  const [, lightAttackerTarget] = impact(2.5 / 11, 'dart');
  assert.ok(heavyAttackerTarget!.vz! > lightAttackerTarget!.vz!);
  const [, lightTarget] = impact(1, 'mule', 'dart');
  const [, heavyTarget] = impact(1, 'mule', 'bulwark');
  assert.ok(lightTarget!.vz! > heavyTarget!.vz!);
});

test('side impacts rotate targets and opposed driving jolts both robots backward', () => {
  const side = match();
  side.state.players[1]!.yaw = Math.PI / 2;
  input(side, 'a', { forward: 1 });
  side.step(0.05);
  assert.notEqual(side.state.players[1]!.yaw, Math.PI / 2);
  const headOn = match();
  headOn.state.players[1]!.yaw = Math.PI;
  input(headOn, 'a', { forward: 1 });
  input(headOn, 'b', { forward: 1 });
  headOn.step(0.05);
  assert.ok(headOn.state.players[0]!.vz! < 0);
  assert.ok(headOn.state.players[1]!.vz! > 0);
});

test('a wedge passively lifts on frontal contact, weakens traction, and releases afterward', () => {
  const sim = match('wedge');
  input(sim, 'a', { forward: 1 });
  sim.step(0.05);
  const [a, b] = sim.state.players;
  assert.ok((b!.lifted ?? 0) > 0);
  assert.equal(b!.hp, 100, 'lifting should displace rather than damage');
  const grounded = makePlayer('grounded', 'Grounded', 'ram', 'cannon', 2);
  const lifted = makePlayer('lifted', 'Lifted', 'ram', 'cannon', 3);
  lifted.lifted = 0.2;
  drive(grounded, { ...EMPTY_INPUT, forward: 1 }, 0.05);
  drive(lifted, { ...EMPTY_INPUT, forward: 1 }, 0.05);
  assert.ok(lifted.z < grounded.z * 0.5);
  a!.x = -15;
  for (let i = 0; i < 10; i++) sim.step(0.05);
  assert.equal(b!.lifted, 0);
});

test('round reset clears momentum, lift and burst state', () => {
  const sim = match('wedge');
  const p = sim.state.players[0]!;
  input(sim, 'a', { boost: true });
  sim.step(0.05);
  p.lifted = 0.2;
  sim.start();
  for (const p of sim.state.players) {
    assert.equal(p.vx ?? 0, 0);
    assert.equal(p.vz ?? 0, 0);
    assert.equal(p.boostCooldown ?? 0, 0);
    assert.equal(p.boostRemaining ?? 0, 0);
    assert.equal(p.lifted ?? 0, 0);
  }
  sim.state.phase = 'combat';
  input(sim, 'a', { boost: true });
  sim.step(0.05);
  assert.ok(p.boostCooldown! > 0, 'the next round must accept its first boost');
});

test('a wedge can sustain a push against an opponent driving back', () => {
  function struggle(front: FrontWeapon) {
    const sim = match(front);
    sim.state.players[1]!.yaw = Math.PI;
    for (let i = 0; i < 20; i++) {
      input(sim, 'a', { forward: 1 });
      input(sim, 'b', { forward: 1 });
      sim.step(0.05);
    }
    assert.ok(sim.state.players.every((p) => p.hp === 100));
    return sim.state.players[1]!.z;
  }
  assert.ok(struggle('wedge') > struggle('saw') + 2);
});

test('ram momentum carries an opponent off the roof and credits the attacker on a later tick', () => {
  const sim = match('ram');
  const [a, b] = sim.state.players;
  a!.z = ARENA_HALF - 3;
  b!.z = ARENA_HALF - 0.5;
  input(sim, 'a', { front: true });
  sim.step(0.01);
  assert.equal(b!.alive, true);
  input(sim, 'a', {});
  for (let i = 0; i < 20 && b!.alive; i++) sim.step(0.05);
  assert.equal(b!.alive, false);
  assert.equal(a!.stats.kills, 1);
  assert.equal(sim.state.winnerId, a!.id);
  assert.equal(sim.state.events.at(-1)!.attackerId, a!.id);
  assert.equal(sim.state.events.at(-1)!.reason, 'fell off the roof');
});

test('side and rear rams hit harder than frontal armor, independent of roster order', () => {
  function impact(yaw: number, reversed = false, piston = false) {
    const sim = match('ram');
    const [a, b] = sim.state.players;
    Object.assign(b!, { yaw, z: piston ? 2.5 : 2.1 });
    if (reversed) sim.state.players.reverse();
    input(sim, 'a', piston ? { front: true } : { forward: 1 });
    sim.step(0.01);
    return b!.vz!;
  }
  for (const piston of [false, true]) {
    const front = impact(Math.PI, false, piston);
    const side = impact(Math.PI / 2, false, piston);
    const rear = impact(0, false, piston);
    assert.ok(side > front * 1.6, 'a side ram must reward the flanking approach');
    assert.ok(rear > side, 'a rear ram must deliver the strongest shove');
    assert.ok(Math.abs(rear - impact(0, true, piston)) < 1e-9);
  }
});

test('powered wedge drives targets farther without dealing damage and releases its lift', () => {
  function push(powered: boolean) {
    const sim = match('wedge');
    sim.state.players[1]!.z = 2.5;
    for (let i = 0; i < 20; i++) {
      input(sim, 'a', { front: powered });
      sim.step(0.05);
    }
    const target = sim.state.players[1]!;
    assert.equal(target.hp, 100);
    return { sim, target };
  }
  const passive = push(false);
  const powered = push(true);
  assert.ok(powered.target.z > passive.target.z + 0.5);
  const sim = match('wedge');
  input(sim, 'a', { front: true });
  sim.step(0.01);
  sim.state.players[0]!.x = -15;
  input(sim, 'a', {});
  for (let i = 0; i < 5; i++) sim.step(0.05);
  assert.ok(sim.state.players[1]!.lifted! > 0, 'lift lasts through a brief break in contact');
  for (let i = 0; i < 5; i++) sim.step(0.05);
  assert.equal(sim.state.players[1]!.lifted, 0, 'defender regains traction after separating');
});
