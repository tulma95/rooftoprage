import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Finale, finalElimination } from '../client/finale.js';
import { Simulation } from '../server/simulation.js';
import { makePlayer } from '../shared/game.js';

function finish(reason = 'fell off the roof') {
  const sim = new Simulation();
  sim.state.players = [makePlayer('a', 'A', 'ram', 'cannon', 0), makePlayer('b', 'B', 'saw', 'cannon', 1)];
  sim.start(); sim.state.phase = 'combat';
  sim.state.players[1]!.x = 29;
  const previous = structuredClone(sim.state);
  sim.eliminate(sim.state.players[1]!, reason, 'a'); sim.finishIfNeeded();
  return { previous, next: sim.state };
}
test('finale selects only a fresh decisive combat elimination', () => {
  const { previous, next } = finish();
  assert.equal(finalElimination(previous, next)?.playerId, 'b');
  assert.equal(finalElimination(next, next), undefined);
  assert.equal(finalElimination(null, next), undefined);
  assert.equal(finalElimination(previous, { ...next, draw: true }), undefined);
  assert.equal(finalElimination(previous, { ...next, round: next.round + 1 }), undefined);
  assert.equal(finalElimination({ ...previous, events: next.events }, next), undefined);
  const disconnected = finish('disconnected');
  assert.equal(finalElimination(disconnected.previous, disconnected.next), undefined);
});
test('fall cinematic descends, destruction stays on roof, and skip/expiry clears debris', () => {
  for (const reason of ['fell off the roof', 'destroyed']) {
    const { previous, next } = finish(reason), scene = new THREE.Scene(), finale = new Finale(scene);
    const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(), victim = new THREE.Group();
    const before = structuredClone(next);
    finale.start(finalElimination(previous, next)!, 0);
    for (let i = 0; i < 120; i++) finale.step(1 / 60, victim, camera, target);
    assert.equal(finale.active, true);
    assert.equal(victim.position.y < 0, reason === 'fell off the roof');
    assert.deepEqual(next, before);
    finale.step(2, victim, camera, target);
    assert.equal(finale.active, false);
    assert.equal(scene.children[0]!.visible, false);
    finale.start(finalElimination(previous, next)!, 0); finale.stop();
    assert.equal(finale.active, false);
  }
});
