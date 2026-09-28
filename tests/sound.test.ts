import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineStack, gearbox, GEARS, metalIR, modes } from '../client/audio-dsp.js';
import { combatSection } from '../client/music.js';
import { moodFor, spatial } from '../client/sound.js';
import type { PlayerState, RoomState } from '../shared/game.js';

test('combat sounds pan to the screen side and fade with distance', () => {
  const listener = { x: 0, z: 0, yaw: 0 } as PlayerState;
  // Facing +z with the camera behind, screen-right is -x.
  assert.ok(spatial(listener, -5, 0).pan > 0);
  assert.ok(spatial(listener, 5, 0).pan < 0);
  assert.equal(spatial(listener, 0, 8).pan, 0);
  assert.ok(spatial(listener, 0, 2).gain > spatial(listener, 0, 20).gain);
  assert.equal(spatial(listener, 0, 80).gain, 0);
  assert.equal(spatial(undefined, 5, 5).pan, 0);
});

test('the soundtrack mood follows the fight', () => {
  const p = (hp: number, alive = true) =>
    ({ id: String(hp), chassis: 'mule', hp, alive }) as PlayerState;
  const room = (phase: string, players: PlayerState[]) => ({ phase, players }) as RoomState;
  const full = [p(100), p(90), p(80, false)];
  assert.equal(moodFor(room('lobby', full), full[0]), 'menu');
  assert.equal(moodFor(room('combat', [...full, p(70)]), full[0]), 'combat');
  assert.equal(moodFor(room('combat', full), full[0]), 'tension', 'final duel');
  assert.equal(moodFor(room('combat', [p(20), p(90), p(80)]), p(20)), 'tension', 'low HP');
});

test('the gearbox upshifts under acceleration and drops the revs on each shift', () => {
  let gear = 0,
    last = 0,
    shifts = 0;
  for (let s = 0; s <= 1.5; s += 0.01) {
    const box = gearbox(gear, s);
    if (box.gear > gear) {
      shifts++;
      assert.ok(box.rpm < last - 0.2, `rpm falls on the shift into gear ${box.gear}`);
    }
    assert.ok(box.rpm >= 0 && box.rpm <= 1.08);
    gear = box.gear;
    last = box.rpm;
  }
  assert.equal(shifts, GEARS.length - 1);
  // Hysteresis: easing off slightly after a shift does not hunt back down.
  const up = gearbox(0, GEARS[0]! * 0.95);
  assert.equal(gearbox(up.gear, GEARS[0]! * 0.9).gear, up.gear);
});

test('engine stacks put their energy on the firing orders, nothing below the half order', () => {
  const { real, imag } = engineStack(4, 0.3);
  const amp = (k: number) => Math.hypot(real[k]!, imag[k]!);
  assert.equal(amp(1), 0);
  assert.ok(amp(4) > amp(3) * 2 && amp(8) > amp(7) * 2);
});

test('struck metal is inharmonic and dense', () => {
  for (const material of ['plate', 'sheet', 'bar'] as const) {
    const set = modes(material, 1);
    assert.ok(set.length >= 14, material);
    const offInteger = set.filter((m) => Math.abs(m.ratio - Math.round(m.ratio)) > 0.05);
    assert.ok(offInteger.length > set.length / 2, `${material} partials are inharmonic`);
  }
  const [l, r] = metalIR(48000);
  const energy = [...l!, ...r!].reduce((s, x) => s + x * x, 0) / 2;
  assert.ok(Math.abs(energy - 1) < 1e-3, 'metal IR is unit energy');
});

test('the combat score has an intro, build, two drops and a breakdown', () => {
  const form = Array.from({ length: 56 }, (_, bar) => combatSection(bar)[0]);
  assert.deepEqual([...new Set(form)], ['intro', 'build', 'dropA', 'breakdown', 'dropB']);
});
