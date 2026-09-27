import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spatial } from '../client/sound.js';
import type { PlayerState } from '../shared/game.js';

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
