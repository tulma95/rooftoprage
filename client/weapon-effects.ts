import * as THREE from 'three';
import {
  PROJECTILE_RULES,
  type Projectile,
  type ProjectileWeapon,
  type TopWeapon,
  type FrontWeapon,
} from '../shared/game.js';

const MAX_SPARKS = 256;

/** Fixed GPU resources: firing only updates transforms and instance colors. */
export class WeaponEffects {
  readonly sparks = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    MAX_SPARKS,
  );
  private particles = Array.from({ length: MAX_SPARKS }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    life: 0,
    max: 1,
    size: 0,
    color: new THREE.Color(),
    gravity: 10,
    stretch: 1,
  }));
  private active = 0;
  private transform = new THREE.Object3D();
  private color = new THREE.Color();
  private lookTarget = new THREE.Vector3();
  private projectiles = new Map<number, THREE.Mesh>();
  private pools: Record<ProjectileWeapon, THREE.Mesh[]> = {
    cannon: [],
    scattergun: [],
    railgun: [],
  };
  private ids = new Set<number>();
  private trailClock = 0;

  constructor(private scene: THREE.Scene) {
    this.sparks.count = 0;
    this.sparks.frustumCulled = false;
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the color buffer before the first shot (and shader compilation).
    this.sparks.setColorAt(0, new THREE.Color());
    this.sparks.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.sparks);
    for (const weapon of Object.keys(this.pools) as ProjectileWeapon[]) {
      const rail = weapon === 'railgun',
        pellet = weapon === 'scattergun';
      const geometry = rail
        ? new THREE.BoxGeometry(0.12, 0.12, 1.9)
        : new THREE.SphereGeometry(pellet ? 0.085 : 0.16, 6, 6);
      const material = new THREE.MeshBasicMaterial({
        color: rail ? '#76f3ff' : pellet ? '#ff9e45' : '#ffda79',
      });
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
      particle.position.set(x, 0.8, z);
      particle.velocity.set(
        (Math.random() - 0.5) * 9,
        Math.random() * 6,
        (Math.random() - 0.5) * 9,
      );
      particle.life = particle.max = 0.3 + Math.random() * (big ? 0.8 : 0.4);
      particle.gravity = 10;
      particle.stretch = 1;
      particle.size = big ? 0.16 : 0.065;
      particle.color.set(i % 2 ? '#ffc456' : '#ff642e');
    }
  }

  /** Short luminous streaks share the spark batch, including muzzle flashes and trails. */
  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: string,
    size: number,
    life: number,
    gravity = 0,
    stretch = 1,
  ): void {
    if (this.active >= MAX_SPARKS) return;
    const p = this.particles[this.active++]!;
    p.position.set(x, y, z);
    p.velocity.set(vx, vy, vz);
    p.color.set(color);
    p.size = size;
    p.life = p.max = life;
    p.gravity = gravity;
    p.stretch = stretch;
  }

  shot(x: number, z: number, yaw: number, weapon: TopWeapon): void {
    const rail = weapon === 'railgun';
    const spread = weapon === 'scattergun' ? 1.2 : 0.45;
    const muzzle = rail ? 1.65 : 1.2;
    x += Math.sin(yaw) * muzzle;
    z += Math.cos(yaw) * muzzle;
    for (let i = 0; i < (rail ? 12 : 18); i++) {
      const angle = yaw + (Math.random() - 0.5) * spread;
      const speed = 4 + Math.random() * 10;
      this.emit(
        x,
        1.4,
        z,
        Math.sin(angle) * speed,
        (Math.random() - 0.5) * 3,
        Math.cos(angle) * speed,
        rail ? '#7cf5ff' : i % 3 ? '#ff9b32' : '#fff4bd',
        rail ? 0.065 : 0.12,
        0.1 + Math.random() * 0.16,
        0,
        3,
      );
    }
    this.ring(x, 1.4, z, rail ? '#65eaff' : '#ffb84c', 2.5, yaw);
  }

  private ring(x: number, y: number, z: number, color: string, speed: number, yaw?: number): void {
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const a = Math.cos(angle) * speed,
        b = Math.sin(angle) * speed;
      this.emit(
        x,
        y,
        z,
        yaw === undefined ? a : a * Math.cos(yaw),
        yaw === undefined ? 0 : b,
        yaw === undefined ? b : -a * Math.sin(yaw),
        color,
        0.075,
        0.32,
      );
    }
  }

  impact(x: number, z: number, big: boolean): void {
    this.ring(x, 0.12, z, big ? '#ff7b32' : '#ffe4a0', big ? 13 : 6);
    this.burst(x, z, big);
  }

  melee(x: number, z: number, yaw: number, weapon: FrontWeapon): void {
    const grinding = weapon === 'saw' || weapon === 'drill' || weapon === 'wedge';
    const heavy = weapon === 'hammer';
    const color = weapon === 'hook' ? '#96edff' : weapon === 'flipper' ? '#caff98' : '#ffd178';
    // A compact white contact star reads before the longer directional sparks.
    this.emit(x, 0.95, z, 0, 0, 0, '#fff8df', grinding ? 0.18 : 0.36, 0.075);
    const direction = yaw + (weapon === 'sweeper' ? Math.PI / 2 : weapon === 'hook' ? Math.PI : 0);
    for (let i = 0; i < (grinding ? 8 : heavy ? 26 : 18); i++) {
      const angle = direction + (Math.random() - 0.5) * (grinding ? 1.9 : 1.1);
      const speed = 3 + Math.random() * (heavy ? 11 : 7);
      this.emit(
        x,
        0.85,
        z,
        Math.sin(angle) * speed,
        weapon === 'flipper' ? 6 + Math.random() * 5 : Math.random() * (heavy ? 7 : 3),
        Math.cos(angle) * speed,
        color,
        grinding ? 0.045 : 0.075,
        0.16 + Math.random() * 0.25,
        12,
        grinding ? 4 : 6,
      );
    }
    if (heavy || weapon === 'ram') this.ring(x, 0.12, z, color, heavy ? 10 : 7);
  }

  /** Sparse afterimages mark the attachment's actual swept path, including misses. */
  meleeTrail(x: number, y: number, z: number, weapon: FrontWeapon): void {
    this.emit(x, y, z, 0, 0.15, 0, weapon === 'hook' ? '#96edff' : '#ffe6ab', 0.1, 0.12);
  }

  flame(x: number, z: number, yaw: number, dt: number): void {
    // Expected emission rate is independent of the display refresh rate.
    const count = Math.floor(dt * 75) + (Math.random() < (dt * 75) % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const angle = yaw + (Math.random() - 0.5) * 0.35;
      this.emit(
        x + Math.sin(yaw) * 1.4,
        1.4,
        z + Math.cos(yaw) * 1.4,
        Math.sin(angle) * 8,
        0.5 + Math.random(),
        Math.cos(angle) * 8,
        i % 2 ? '#ff752b' : '#ffd16b',
        0.09,
        0.35 + Math.random() * 0.2,
        -1,
        2,
      );
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
    this.trailClock = 0;
  }

  step(dt: number): void {
    this.trailClock += dt;
    if (this.trailClock >= 1 / 60) {
      this.trailClock %= 1 / 60;
      for (const mesh of this.projectiles.values()) {
        const rail = mesh.userData.weapon === 'railgun';
        const length = rail ? 2.4 : 0.65;
        for (let i = 0; i < (rail ? 5 : 1); i++) {
          const offset = (i / 5) * length;
          this.emit(
            mesh.position.x - Math.sin(mesh.rotation.y) * offset,
            1.35,
            mesh.position.z - Math.cos(mesh.rotation.y) * offset,
            -Math.sin(mesh.rotation.y) * 0.3,
            0,
            -Math.cos(mesh.rotation.y) * 0.3,
            rail ? '#45dfff' : '#ffaf46',
            rail ? 0.075 : 0.055,
            rail ? 0.22 : 0.13,
            0,
            rail ? 4 : 2,
          );
        }
      }
    }
    for (let i = 0; i < this.active;) {
      const particle = this.particles[i]!;
      particle.life -= dt;
      if (particle.life <= 0) {
        this.particles[i] = this.particles[--this.active]!;
        this.particles[this.active] = particle;
        continue;
      }
      particle.velocity.y -= dt * particle.gravity;
      particle.position.addScaledVector(particle.velocity, dt);
      this.transform.position.copy(particle.position);
      const fade = particle.life / particle.max;
      this.transform.scale.set(
        particle.size * Math.sqrt(fade),
        particle.size * Math.sqrt(fade),
        particle.size * particle.stretch * Math.sqrt(fade),
      );
      if (particle.velocity.lengthSq() > 0.001) {
        this.transform.lookAt(this.lookTarget.copy(particle.position).add(particle.velocity));
      }
      this.transform.updateMatrix();
      this.sparks.setMatrixAt(i, this.transform.matrix);
      this.sparks.setColorAt(
        i,
        this.color.copy(particle.color).multiplyScalar(particle.life / particle.max),
      );
      i++;
    }
    this.sparks.count = this.active;
    if (this.active) {
      this.sparks.instanceMatrix.needsUpdate = true;
      this.sparks.instanceColor!.needsUpdate = true;
    }
  }
}
