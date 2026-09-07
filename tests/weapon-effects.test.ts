import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { WeaponEffects } from '../client/weapon-effects.js';
import type { Projectile, ProjectileWeapon } from '../shared/game.js';

const projectile = (id: number, weapon: ProjectileWeapon = 'cannon'): Projectile => ({
  id,
  weapon,
  ownerId: 'pilot',
  hitIds: [],
  x: id,
  z: 2,
  yaw: 0.4,
  distance: 0,
});

test('sustained effects keep scene objects and GPU resources fixed and recycle after expiry', () => {
  const scene = new THREE.Scene(),
    effects = new WeaponEffects(scene);
  const children = [...scene.children];
  const geometries = children.map((child) => (child as THREE.Mesh).geometry);
  const materials = children.map((child) => (child as THREE.Mesh).material);
  for (let frame = 0; frame < 600; frame++) {
    effects.burst(0, 0, frame % 30 === 0);
    effects.sync(Array.from({ length: 20 }, (_, i) => projectile(frame * 20 + i, 'scattergun')));
    effects.step(1 / 60);
    assert.ok(effects.sparks.count <= 256);
    assert.equal(
      scene.children.filter((child) => child !== effects.sparks && child.visible).length,
      20,
    );
  }
  assert.deepEqual(scene.children, children);
  assert.deepEqual(
    children.map((child) => (child as THREE.Mesh).geometry),
    geometries,
  );
  assert.deepEqual(
    children.map((child) => (child as THREE.Mesh).material),
    materials,
  );
  effects.sync([]);
  effects.step(2);
  assert.equal(effects.sparks.count, 0);
  assert.ok(children.every((child) => child === effects.sparks || !child.visible));
  effects.burst(3, 4, true);
  effects.step(0);
  assert.equal(effects.sparks.count, 22);
  effects.clear();
  assert.equal(effects.sparks.count, 0);
});

test('projectile pools accommodate all four pilots and overlapping cannon volleys', () => {
  const scene = new THREE.Scene(),
    effects = new WeaponEffects(scene);
  const volley = [
    ...Array.from({ length: 8 }, (_, i) => projectile(i)),
    ...Array.from({ length: 20 }, (_, i) => projectile(i + 8, 'scattergun')),
    ...Array.from({ length: 4 }, (_, i) => projectile(i + 28, 'railgun')),
  ];
  effects.sync(volley);
  assert.equal(
    scene.children.filter((child) => child !== effects.sparks && child.visible).length,
    32,
  );
  const bolt = scene.children.find(
    (child) => child !== effects.sparks && child.visible && child.position.x === 0,
  )!;
  effects.sync([{ ...volley[0]!, x: 42 }]);
  assert.equal(bolt.position.x, 42);
  effects.clear();
  effects.sync(volley);
  assert.equal(
    scene.children.filter((child) => child !== effects.sparks && child.visible).length,
    32,
  );
});
