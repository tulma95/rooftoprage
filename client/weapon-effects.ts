import * as THREE from 'three';
import { PROJECTILE_RULES, type Projectile, type ProjectileWeapon } from '../shared/game.js';

const MAX_SPARKS = 256;

/** Fixed GPU resources: firing only updates transforms and instance colors. */
export class WeaponEffects {
  readonly sparks = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    MAX_SPARKS,
  );
  private particles = Array.from({ length: MAX_SPARKS }, () => ({
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, max: 1, size: 0, color: new THREE.Color(),
  }));
  private active = 0;
  private transform = new THREE.Object3D();
  private color = new THREE.Color();
  private projectiles = new Map<number, THREE.Mesh>();
  private pools: Record<ProjectileWeapon, THREE.Mesh[]> = { cannon: [], scattergun: [], railgun: [] };
  private ids = new Set<number>();

  constructor(private scene: THREE.Scene) {
    this.sparks.count = 0;
    this.sparks.frustumCulled = false;
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the color buffer before the first shot (and shader compilation).
    this.sparks.setColorAt(0, new THREE.Color());
    this.sparks.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.sparks);
    for (const weapon of Object.keys(this.pools) as ProjectileWeapon[]) {
      const rail = weapon === 'railgun', pellet = weapon === 'scattergun';
      const geometry = rail ? new THREE.BoxGeometry(.12, .12, 1.9) : new THREE.SphereGeometry(pellet ? .085 : .16, 6, 6);
      const material = new THREE.MeshBasicMaterial({ color: rail ? '#76f3ff' : pellet ? '#ff9e45' : '#ffda79' });
      // Four pilots, including two overlapping cannon volleys at maximum range.
      const capacity = 4 * PROJECTILE_RULES[weapon].angles.length * (weapon === 'cannon' ? 2 : 1);
      for (let i = 0; i < capacity; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.userData.weapon = weapon;
        scene.add(mesh);
        this.pools[weapon].push(mesh);
      }
    }
  }

  burst(x: number, z: number, big: boolean): void {
    for (let i = 0; i < (big ? 22 : 9) && this.active < MAX_SPARKS; i++) {
      const particle = this.particles[this.active++]!;
      particle.position.set(x, .8, z);
      particle.velocity.set((Math.random() - .5) * 9, Math.random() * 6, (Math.random() - .5) * 9);
      particle.life = particle.max = .3 + Math.random() * (big ? .8 : .4);
      particle.size = big ? .16 : .065;
      particle.color.set(i % 2 ? '#ffc456' : '#ff642e');
    }
  }

  sync(projectiles: readonly Projectile[]): void {
    this.ids.clear();
    for (const projectile of projectiles) this.ids.add(projectile.id);
    for (const [id, mesh] of this.projectiles) {
      if (this.ids.has(id)) continue;
      mesh.visible = false;
      this.pools[mesh.userData.weapon as ProjectileWeapon].push(mesh);
      this.projectiles.delete(id);
    }
    for (const projectile of projectiles) {
      let mesh = this.projectiles.get(projectile.id);
      if (!mesh) {
        mesh = this.pools[projectile.weapon].pop();
        if (!mesh) continue;
        this.projectiles.set(projectile.id, mesh);
      }
      mesh.visible = true;
      mesh.position.set(projectile.x, 1.35, projectile.z);
      mesh.rotation.y = projectile.yaw;
    }
  }

  clear(): void {
    this.sync([]);
    this.active = this.sparks.count = 0;
  }

  step(dt: number): void {
    for (let i = 0; i < this.active;) {
      const particle = this.particles[i]!;
      particle.life -= dt;
      if (particle.life <= 0) {
        this.particles[i] = this.particles[--this.active]!;
        this.particles[this.active] = particle;
        continue;
      }
      particle.velocity.y -= dt * 10;
      particle.position.addScaledVector(particle.velocity, dt);
      this.transform.position.copy(particle.position);
      this.transform.scale.setScalar(particle.size);
      this.transform.updateMatrix();
      this.sparks.setMatrixAt(i, this.transform.matrix);
      this.sparks.setColorAt(i, this.color.copy(particle.color).multiplyScalar(particle.life / particle.max));
      i++;
    }
    this.sparks.count = this.active;
    if (this.active) {
      this.sparks.instanceMatrix.needsUpdate = true;
      this.sparks.instanceColor!.needsUpdate = true;
    }
  }
}
