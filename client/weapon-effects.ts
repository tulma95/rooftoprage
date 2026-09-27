import * as THREE from 'three';
import { NOISE } from './glsl.js';
import {
  ARENA_HALF,
  PROJECTILE_RULES,
  type Projectile,
  type ProjectileWeapon,
  type TopWeapon,
  type FrontWeapon,
} from '../shared/game.js';

const MAX_SPARKS = 256,
  MAX_GLOWS = 256,
  MAX_SMOKE = 160,
  MAX_DEBRIS = 64,
  LIGHTS = 2;

// Parsed once: spawning only copies these.
const HEX = {
  white: '#ffffff',
  star: '#fff8df',
  gold: '#ffc456',
  ember: '#ff642e',
  orange: '#ff9b32',
  cream: '#fff4bd',
  amber: '#ffb84c',
  flash: '#ffd27a',
  petal: '#ffa640',
  rail: '#7cf5ff',
  railRing: '#65eaff',
  railCore: '#9ff6ff',
  railBeam: '#2fb8ff',
  railTrail: '#45dfff',
  railGlow: '#3fd9ff',
  railLight: '#6ae6ff',
  railEmber: '#7ff0ff',
  railSmoke: '#9cc7d0',
  gunSmoke: '#a39c90',
  muzzleLight: '#ffb25a',
  hitRing: '#ffe4a0',
  blast: '#ff7b32',
  hitGlow: '#ffc870',
  hitLight: '#ffc070',
  hitEmber: '#ff9a3c',
  blastLight: '#ff8a3a',
  fireWhite: '#fff6d8',
  fireYellow: '#ffd35a',
  fireOrange: '#ff7a1e',
  fireRed: '#6e0c02',
  soot: '#2f2b28',
  sootDark: '#1c1a19',
  dust: '#8c8378',
  haze: '#77716a',
  scorch: '#2a2522',
  steam: '#c9c6c0',
  wisp: '#8f8a84',
  steel: '#8a9290',
  darkSteel: '#5b605e',
  hook: '#96edff',
  hookGlow: '#3aa8c8',
  flip: '#caff98',
  melee: '#ffd178',
  trail: '#ffe6ab',
  trailGlow: '#a06a2a',
  grind: '#ffb24a',
  grindEmber: '#ffa040',
  meleeEmber: '#ffb050',
  hammerLight: '#ffd08a',
  flameA: '#ff752b',
  flameB: '#ffd16b',
  tracer: '#ffaf46',
  boltGlow: '#ff9d3a',
  contrail: '#9a948b',
};
const C = Object.fromEntries(
  Object.entries(HEX).map(([name, hex]) => [name, new THREE.Color(hex)]),
) as Record<keyof typeof HEX, THREE.Color>;

// Camera-facing quads placed by each instance's translation and uniform scale.
const BILLBOARD_VERT = /* glsl */ `
attribute vec2 fx;
varying vec2 vUv;
varying vec2 vFx;
varying vec3 vColor;
void main() {
  vUv = uv;
  vFx = fx;
  vColor = instanceColor;
  float s = length(instanceMatrix[0].xyz), a = fx.y * 6.2832;
  vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  mv.xy += mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;
// Additive: soft halo plus a hot core that saturates toward white.
const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float halo = max(0.0, 1.0 - d);
  gl_FragColor = vec4(vColor * (halo * halo + exp(-d * d * 16.0) * 1.6), 1.0);
}`;
const SMOKE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vFx;
varying vec3 vColor;
${NOISE}
void main() {
  float n = fbm(vUv * 3.0 + vFx.y * 17.0);
  float a = smoothstep(1.0, 0.2, length(vUv - 0.5) * 2.0 + (n - 0.5) * 0.8) * vFx.x;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * (0.7 + n * 0.6), a);
}`;

type Kind = 'spark' | 'glow' | 'smoke' | 'debris';
interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
  to: THREE.Color;
  rotation: THREE.Euler;
  spin: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  gravity: number;
  stretch: number;
  grow: number;
  drag: number;
  alpha: number;
  seed: number;
}
interface Spawn {
  color: THREE.Color;
  /** Color the particle shifts toward as it ages; defaults to `color`. */
  to?: THREE.Color;
  size: number;
  life: number;
  vx?: number;
  vy?: number;
  vz?: number;
  gravity?: number;
  stretch?: number;
  grow?: number;
  drag?: number;
  alpha?: number;
}

/** One fixed-size instanced batch; expired particles swap to the end so the live range stays packed. */
class Pool {
  particles: Particle[];
  active = 0;
  private fx?: THREE.InstancedBufferAttribute;
  private transform = new THREE.Object3D();
  private matrix = new THREE.Matrix4();
  private color = new THREE.Color();
  private look = new THREE.Vector3();

  constructor(
    readonly mesh: THREE.InstancedMesh,
    private kind: Kind,
  ) {
    const n = mesh.instanceMatrix.count;
    this.particles = Array.from({ length: n }, () => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      color: new THREE.Color(),
      to: new THREE.Color(),
      rotation: new THREE.Euler(),
      spin: new THREE.Vector3(),
      life: 0,
      max: 1,
      size: 0,
      gravity: 0,
      stretch: 1,
      grow: 0,
      drag: 0,
      alpha: 1,
      seed: 0,
    }));
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the color buffer before the first shot (and shader compilation).
    mesh.setColorAt(0, new THREE.Color());
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    if (kind === 'glow' || kind === 'smoke') {
      this.fx = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
      this.fx.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('fx', this.fx);
    }
  }

  spawn(x: number, y: number, z: number, o: Spawn): Particle | undefined {
    if (this.active >= this.particles.length) return;
    const p = this.particles[this.active++]!;
    p.position.set(x, y, z);
    p.velocity.set(o.vx ?? 0, o.vy ?? 0, o.vz ?? 0);
    p.color.copy(o.color);
    p.to.copy(o.to ?? o.color);
    p.size = o.size;
    p.life = p.max = o.life;
    p.gravity = o.gravity ?? 0;
    p.stretch = o.stretch ?? 1;
    p.grow = o.grow ?? 0;
    p.drag = o.drag ?? 0;
    p.alpha = o.alpha ?? 1;
    p.seed = Math.random();
    return p;
  }

  step(dt: number): void {
    for (let i = 0; i < this.active;) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles[i] = this.particles[--this.active]!;
        this.particles[this.active] = p;
        continue;
      }
      if (p.drag) p.velocity.multiplyScalar(Math.exp(-p.drag * dt));
      p.velocity.y -= dt * p.gravity;
      p.position.addScaledVector(p.velocity, dt);
      // Falling sparks and chunks skip off the roof, losing energy each bounce.
      const floor = this.kind === 'debris' ? p.size * 0.2 : 0.02;
      if (
        p.gravity > 0 &&
        p.position.y < floor &&
        p.velocity.y < 0 &&
        Math.abs(p.position.x) < ARENA_HALF &&
        Math.abs(p.position.z) < ARENA_HALF
      ) {
        p.position.y = floor;
        p.velocity.y *= -0.38;
        p.velocity.x *= 0.7;
        p.velocity.z *= 0.7;
        p.spin.multiplyScalar(0.6);
      }
      this.write(i, p, p.life / p.max, dt);
      i++;
    }
    this.mesh.count = this.active;
    if (!this.active) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    if (this.fx) this.fx.needsUpdate = true;
  }

  private write(i: number, p: Particle, fade: number, dt: number): void {
    const t = this.transform,
      c = this.color.copy(p.color).lerp(p.to, 1 - fade);
    if (this.kind === 'spark') {
      // Thin streaks stretched along velocity, cooling from white-hot to their base color.
      const s = p.size * Math.sqrt(fade);
      t.position.copy(p.position);
      const long = p.stretch * Math.max(1, p.velocity.length() / 4);
      const thin = p.stretch > 1 ? 0.6 : 1;
      t.scale.set(s * thin, s * thin, s * long);
      if (p.velocity.lengthSq() > 0.001) t.lookAt(this.look.copy(p.position).add(p.velocity));
      t.updateMatrix();
      this.mesh.setMatrixAt(i, t.matrix);
      c.lerp(C.white, Math.max(0, fade - 0.8) * 1.5).multiplyScalar(fade);
    } else if (this.kind === 'debris') {
      p.rotation.x += p.spin.x * dt;
      p.rotation.y += p.spin.y * dt;
      p.rotation.z += p.spin.z * dt;
      t.position.copy(p.position);
      t.rotation.copy(p.rotation);
      t.scale.setScalar(p.size * Math.min(1, fade * 5));
      t.updateMatrix();
      this.mesh.setMatrixAt(i, t.matrix);
      // Chunks torn off by the hit glow orange for their first moments.
      if (fade > 0.75) c.lerp(C.blastLight, (fade - 0.75) * 4);
    } else {
      const s = p.size * (1 + (1 - fade) * p.grow);
      this.mesh.setMatrixAt(
        i,
        this.matrix.makeScale(s, s, s).setPosition(p.position.x, p.position.y, p.position.z),
      );
      if (this.kind === 'glow') c.multiplyScalar(fade * fade);
      // Smoke fades in quickly and out slowly.
      this.fx!.setXY(i, p.alpha * fade * Math.min(1, (1 - fade) * 8), p.seed);
    }
    this.mesh.setColorAt(i, c);
  }
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Fixed GPU resources: firing only updates transforms, instance colors and two pooled lights. */
export class WeaponEffects {
  readonly group = new THREE.Group();
  private spark = new Pool(
    new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      MAX_SPARKS,
    ),
    'spark',
  );
  readonly sparks = this.spark.mesh;
  private glow = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_GLOWS,
    ),
    'glow',
  );
  private smoke = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: SMOKE_FRAG,
        transparent: true,
        depthWrite: false,
      }),
      MAX_SMOKE,
    ),
    'smoke',
  );
  private debris = new Pool(
    new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.3, 0.65),
      new THREE.MeshStandardMaterial({ metalness: 0.75, roughness: 0.4 }),
      MAX_DEBRIS,
    ),
    'debris',
  );
  private pools = [this.smoke, this.debris, this.spark, this.glow];
  // Kept in the scene at zero intensity so a flash never changes the light count.
  private lights = Array.from({ length: LIGHTS }, () => ({
    light: new THREE.PointLight('#ffffff', 0, 12, 2),
    life: 0,
    max: 1,
    peak: 0,
  }));
  private projectiles = new Map<number, THREE.Mesh>();
  private meshPools: Record<ProjectileWeapon, THREE.Mesh[]> = {
    cannon: [],
    scattergun: [],
    railgun: [],
  };
  private ids = new Set<number>();
  private trailClock = 0;
  private trailTick = 0;
  private flameSmoke = 0;

  constructor(private scene: THREE.Scene) {
    this.smoke.mesh.renderOrder = 1;
    this.glow.mesh.renderOrder = 3;
    this.sparks.renderOrder = 2;
    for (const pool of this.pools) this.group.add(pool.mesh);
    for (const l of this.lights) this.group.add(l.light);
    scene.add(this.group);
    for (const weapon of Object.keys(this.meshPools) as ProjectileWeapon[]) {
      const rail = weapon === 'railgun',
        pellet = weapon === 'scattergun';
      const geometry = rail
        ? new THREE.BoxGeometry(0.12, 0.12, 1.9)
        : new THREE.SphereGeometry(pellet ? 0.085 : 0.16, 6, 6);
      const material = new THREE.MeshBasicMaterial({
        color: rail ? '#b8fbff' : pellet ? '#ffc27a' : '#fff0b0',
      });
      // Four pilots, including two overlapping cannon volleys at maximum range.
      const capacity = 4 * PROJECTILE_RULES[weapon].angles.length * (weapon === 'cannon' ? 2 : 1);
      for (let i = 0; i < capacity; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.userData.weapon = weapon;
        scene.add(mesh);
        this.meshPools[weapon].push(mesh);
      }
    }
  }

  burst(x: number, z: number, big: boolean, y = 0.8): void {
    for (let i = 0; i < (big ? 22 : 9); i++)
      this.spark.spawn(x, y, z, {
        vx: rand(-4.5, 4.5),
        vy: rand(0, 6),
        vz: rand(-4.5, 4.5),
        color: i % 2 ? C.gold : C.ember,
        size: big ? 0.11 : 0.06,
        life: 0.3 + Math.random() * (big ? 0.8 : 0.4),
        gravity: 10,
        stretch: 3,
      });
  }

  /** Hot metal chunks with tumbling spin; they bounce on the roof and shrink away. */
  private chunks(
    x: number,
    y: number,
    z: number,
    count: number,
    force: number,
    size: [number, number] = [0.1, 0.24],
    yaw?: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = yaw === undefined ? Math.random() * Math.PI * 2 : yaw + (Math.random() - 0.5);
      const speed = force * rand(0.4, 1);
      this.debris
        .spawn(x, y, z, {
          vx: Math.sin(angle) * speed,
          vy: 3 + Math.random() * force * 0.8,
          vz: Math.cos(angle) * speed,
          color: i % 3 ? C.steel : C.darkSteel,
          size: rand(...size),
          life: rand(1.2, 2),
          gravity: 18,
        })
        ?.spin.set(rand(-15, 15), rand(-15, 15), rand(-15, 15));
    }
  }

  /** Glowing embers that arc, bounce and burn out. */
  private embers(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    color: THREE.Color,
  ) {
    for (let i = 0; i < count; i++)
      this.glow.spawn(x, y, z, {
        vx: rand(-0.5, 0.5) * speed,
        vy: Math.random() * speed * 0.8,
        vz: rand(-0.5, 0.5) * speed,
        color,
        size: rand(0.14, 0.24),
        life: rand(0.5, 1.2),
        gravity: 9,
        drag: 0.6,
      });
  }

  /** Flat ring of sparks; `yaw` tilts it upright to face the firing direction. */
  private ring(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    speed: number,
    yaw?: number,
  ): void {
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const a = Math.cos(angle) * speed,
        b = Math.sin(angle) * speed;
      this.spark.spawn(x, y, z, {
        vx: yaw === undefined ? a : a * Math.cos(yaw),
        vy: yaw === undefined ? 0 : b,
        vz: yaw === undefined ? b : -a * Math.sin(yaw),
        color,
        size: 0.075,
        life: 0.32,
      });
    }
  }

  /** Dust thrown outward along the roof. */
  private dustRing(x: number, z: number, count: number, speed: number, size: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      this.smoke.spawn(x, 0.25, z, {
        vx: Math.cos(angle) * speed,
        vy: 0.4,
        vz: Math.sin(angle) * speed,
        color: C.dust,
        size,
        life: rand(0.9, 1.3),
        grow: 3,
        drag: 2.5,
        alpha: 0.5,
      });
    }
  }

  private flashLight(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    peak: number,
    life: number,
  ) {
    const slot = this.lights.reduce((a, b) => (a.life / a.max < b.life / b.max ? a : b));
    slot.light.position.set(x, y, z);
    slot.light.color.copy(color);
    slot.peak = peak;
    slot.life = slot.max = life;
  }

  /** Muzzle flash at the barrel tip (world position). */
  shot(x: number, y: number, z: number, yaw: number, weapon: TopWeapon): void {
    const rail = weapon === 'railgun',
      scatter = weapon === 'scattergun';
    const spread = scatter ? 1.2 : 0.45;
    const sin = Math.sin(yaw),
      cos = Math.cos(yaw);
    for (let i = 0; i < (rail ? 12 : 18); i++) {
      const angle = yaw + (Math.random() - 0.5) * spread;
      const speed = rand(4, 14);
      this.spark.spawn(x, y, z, {
        vx: Math.sin(angle) * speed,
        vy: rand(-1.5, 1.5),
        vz: Math.cos(angle) * speed,
        color: rail ? C.rail : i % 3 ? C.orange : C.cream,
        size: rail ? 0.065 : 0.12,
        life: rand(0.1, 0.26),
        stretch: 3,
      });
    }
    this.ring(x, y, z, rail ? C.railRing : C.amber, 2.5, yaw);
    // Flash petals: a hot core with smaller lobes pushed out along the barrel.
    this.glow.spawn(x, y, z, {
      color: rail ? C.railCore : C.flash,
      size: scatter ? 2.4 : 1.8,
      life: 0.09,
      grow: 0.5,
    });
    for (let i = 1; i <= 3; i++)
      this.glow.spawn(x + sin * i * 0.35, y, z + cos * i * 0.35, {
        color: rail ? C.railGlow : C.petal,
        size: (scatter ? 1.3 : 1.1) - i * 0.22,
        life: 0.06 + i * 0.01,
      });
    if (rail)
      // A lingering ionized beam along the bolt's first stretch of flight.
      for (let i = 1; i <= 28; i++)
        this.glow.spawn(x + sin * i * 0.3, y, z + cos * i * 0.3, {
          color: C.railBeam,
          size: 0.55,
          life: 0.12 + i * 0.008,
          grow: 1.2,
        });
    for (let i = 0; i < (rail ? 3 : scatter ? 7 : 5); i++) {
      const angle = yaw + (Math.random() - 0.5) * (scatter ? 1.4 : 0.7);
      const speed = rand(1.5, 4.5);
      this.smoke.spawn(x, y, z, {
        vx: Math.sin(angle) * speed,
        vy: rand(0.5, 1.1),
        vz: Math.cos(angle) * speed,
        color: rail ? C.railSmoke : C.gunSmoke,
        size: rand(0.35, 0.55),
        life: rand(0.8, 1.4),
        grow: 3,
        drag: 2.5,
        alpha: rail ? 0.25 : 0.45,
      });
    }
    this.flashLight(x, y, z, rail ? C.railLight : C.muzzleLight, rail ? 45 : 60, 0.09);
  }

  /** `y` is the struck body's center height; smaller chassis are hit lower. `weapon` tints projectile hits. */
  impact(x: number, z: number, big: boolean, y = 1, weapon?: TopWeapon): void {
    const rail = weapon === 'railgun';
    this.ring(x, 0.12, z, big ? C.blast : rail ? C.railCore : C.hitRing, big ? 13 : 6);
    this.burst(x, z, big, y - 0.2);
    this.embers(x, y - 0.2, z, big ? 14 : 4, big ? 12 : 7, rail ? C.railEmber : C.hitEmber);
    if (big) {
      this.explosion(x, y, z);
      return;
    }
    this.glow.spawn(x, y - 0.1, z, {
      color: rail ? C.railGlow : C.hitGlow,
      size: 1.6,
      life: 0.14,
      grow: 0.8,
    });
    for (let i = 0; i < (weapon === 'cannon' ? 3 : 1); i++)
      this.smoke.spawn(x, y - 0.3, z, {
        vx: rand(-1, 1),
        vy: rand(0.6, 1.4),
        vz: rand(-1, 1),
        color: C.haze,
        size: 0.45,
        life: 0.9,
        grow: 3,
        drag: 2.5,
        alpha: 0.4,
      });
    if (weapon === 'cannon' || rail) this.chunks(x, y - 0.2, z, 3, 5);
    this.flashLight(x, y, z, rail ? C.railLight : C.hitLight, 40, 0.09);
  }

  /** Fireball, rising soot column, ground shockwave and a spray of heavy debris. */
  private explosion(x: number, y: number, z: number): void {
    // One white-hot flash, then a body of yellow and orange balls that sink to deep red.
    this.glow.spawn(x, y, z, { color: C.fireWhite, size: 3.2, life: 0.15, grow: 1 });
    const fire = [C.fireYellow, C.fireOrange, C.fireOrange];
    for (let i = 0; i < 9; i++) {
      const angle = Math.random() * Math.PI * 2,
        out = rand(0, 1.8);
      this.glow.spawn(x, y, z, {
        vx: Math.cos(angle) * out,
        vy: rand(0.5, 2),
        vz: Math.sin(angle) * out,
        color: fire[i % 3]!,
        to: C.fireRed,
        size: rand(1.5, 2.5),
        life: rand(0.35, 0.6),
        grow: 2.5,
        gravity: -3,
        drag: 1.5,
      });
    }
    // First wave: a dark cloud punched outward.
    for (let i = 0; i < 9; i++) {
      const angle = Math.random() * Math.PI * 2,
        speed = rand(2, 5);
      this.smoke.spawn(x, y - 0.3, z, {
        vx: Math.cos(angle) * speed,
        vy: rand(0.6, 2.6),
        vz: Math.sin(angle) * speed,
        color: C.soot,
        size: 0.9,
        life: rand(1.6, 2.6),
        grow: 3,
        drag: 2.5,
        alpha: 0.7,
      });
    }
    // Second wave: a soot column that keeps rising after the fireball burns out.
    for (let i = 0; i < 8; i++)
      this.smoke.spawn(x + rand(-0.8, 0.8), y + rand(0.8, 1.8), z + rand(-0.8, 0.8), {
        vx: rand(-0.4, 0.4),
        vy: rand(2, 3),
        vz: rand(-0.4, 0.4),
        color: C.sootDark,
        size: rand(0.9, 1.3),
        life: rand(2, 3),
        grow: 3.5,
        drag: 0.5,
        alpha: 0.6,
      });
    this.dustRing(x, z, 16, 14, 0.7);
    this.ring(x, 0.1, z, C.fireYellow, 20);
    this.chunks(x, y - 0.2, z, 16, 11, [0.18, 0.3]);
    this.flashLight(x, y + 0.5, z, C.blastLight, 160, 0.35);
  }

  /** Flamethrower contact: scorch embers and a curl of smoke off the target. */
  scorch(x: number, y: number, z: number): void {
    this.embers(x, y, z, 3, 5, C.fireOrange);
    this.smoke.spawn(x, y + 0.2, z, {
      vy: 1.2,
      color: C.scorch,
      size: 0.5,
      life: 1.1,
      grow: 3,
      drag: 2.5,
      alpha: 0.4,
    });
  }

  /** Thin smoke wisp curling off a hot barrel; `steam` is the thicker overheat vent. */
  heatWisp(x: number, y: number, z: number, steam = false): void {
    for (let i = 0; i < (steam ? 2 : 1); i++)
      this.smoke.spawn(x, y, z, {
        vx: rand(-0.15, 0.15),
        vy: steam ? 1.6 : 0.9,
        vz: rand(-0.15, 0.15),
        color: steam ? C.steam : C.wisp,
        size: steam ? 0.35 : 0.14,
        life: steam ? 1.1 : 0.9,
        grow: 2.5,
        drag: 1,
        alpha: steam ? 0.6 : 0.3,
      });
  }

  /** `y` is the attachment's contact height. */
  melee(x: number, z: number, yaw: number, weapon: FrontWeapon, y = 0.95): void {
    const grinding = weapon === 'saw' || weapon === 'drill' || weapon === 'wedge';
    const heavy = weapon === 'hammer';
    const color = weapon === 'hook' ? C.hook : weapon === 'flipper' ? C.flip : C.melee;
    // A compact white contact star reads before the longer directional sparks.
    this.spark.spawn(x, y, z, { color: C.star, size: grinding ? 0.18 : 0.36, life: 0.075 });
    const direction = yaw + (weapon === 'sweeper' ? Math.PI / 2 : weapon === 'hook' ? Math.PI : 0);
    for (let i = 0; i < (grinding ? 8 : heavy ? 26 : 18); i++) {
      const angle = direction + (Math.random() - 0.5) * (grinding ? 1.9 : 1.1);
      const speed = 3 + Math.random() * (heavy ? 11 : 7);
      this.spark.spawn(x, y - 0.1, z, {
        vx: Math.sin(angle) * speed,
        vy: weapon === 'flipper' ? rand(6, 11) : Math.random() * (heavy ? 7 : 3),
        vz: Math.cos(angle) * speed,
        color,
        size: grinding ? 0.045 : 0.075,
        life: rand(0.16, 0.41),
        gravity: 12,
        stretch: grinding ? 4 : 6,
      });
    }
    if (heavy || weapon === 'ram') this.ring(x, 0.12, z, color, heavy ? 10 : 7);
    this.glow.spawn(x, y, z, {
      color: grinding ? C.grind : color,
      size: grinding ? 0.9 : heavy ? 2.6 : 1.8,
      life: 0.1,
    });
    if (grinding) {
      this.embers(x, y, z, 2, 6, C.grindEmber);
      return;
    }
    this.embers(x, y, z, heavy ? 8 : 4, heavy ? 10 : 7, C.meleeEmber);
    if (heavy || weapon === 'ram')
      this.chunks(x, y, z, heavy ? 6 : 3, heavy ? 7 : 5, undefined, direction);
    if (heavy) this.dustRing(x, z, 8, 5, 0.5);
    this.flashLight(x, y, z, heavy ? C.hammerLight : color, heavy ? 70 : 35, 0.1);
  }

  /** Sparse afterimages mark the attachment's actual swept path, including misses. */
  meleeTrail(x: number, y: number, z: number, weapon: FrontWeapon): void {
    const hook = weapon === 'hook';
    this.spark.spawn(x, y, z, { vy: 0.15, color: hook ? C.hook : C.trail, size: 0.1, life: 0.12 });
    this.glow.spawn(x, y, z, { color: hook ? C.hookGlow : C.trailGlow, size: 0.8, life: 0.14 });
  }

  /** Flame stream from the nozzle tip (world position). */
  flame(x: number, y: number, z: number, yaw: number, dt: number): void {
    const sin = Math.sin(yaw),
      cos = Math.cos(yaw);
    // A hot bulb at the nozzle, refreshed every frame whatever the frame rate.
    this.glow.spawn(x + sin * 0.3, y, z + cos * 0.3, {
      color: C.fireOrange,
      size: 1.2,
      life: Math.max(1e-3, dt * 1.5),
    });
    // Expected emission rate is independent of the display refresh rate.
    const count = Math.floor(dt * 75) + (Math.random() < (dt * 75) % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const angle = yaw + (Math.random() - 0.5) * 0.35;
      this.spark.spawn(x, y, z, {
        vx: Math.sin(angle) * 8,
        vy: rand(0.5, 1.5),
        vz: Math.cos(angle) * 8,
        color: i % 2 ? C.flameA : C.flameB,
        size: 0.09,
        life: rand(0.35, 0.55),
        gravity: -1,
        stretch: 2,
      });
      // Billowing fireballs: yellow at the nozzle, reddening as they slow and swell.
      const speed = rand(8, 11);
      this.glow.spawn(x, y, z, {
        vx: Math.sin(angle) * speed,
        vy: 0.2,
        vz: Math.cos(angle) * speed,
        color: i % 3 ? C.fireOrange : C.fireYellow,
        to: C.fireRed,
        size: 0.6,
        life: rand(0.4, 0.55),
        grow: 4,
        drag: 1.6,
        gravity: -2.5,
      });
    }
    this.flameSmoke += dt * 9;
    for (; this.flameSmoke >= 1; this.flameSmoke--) {
      const angle = yaw + (Math.random() - 0.5) * 0.4;
      this.smoke.spawn(x + Math.sin(angle) * 1.5, y + 0.3, z + Math.cos(angle) * 1.5, {
        vx: Math.sin(angle) * 6,
        vy: 1.4,
        vz: Math.cos(angle) * 6,
        color: C.scorch,
        size: 0.5,
        life: 1.3,
        grow: 4,
        drag: 1.4,
        alpha: 0.4,
      });
    }
  }

  /** `height` gives a new projectile's flight height from its owner, fixed for its lifetime. */
  sync(projectiles: readonly Projectile[], height: (ownerId: string) => number = () => 1.35): void {
    this.ids.clear();
    for (const projectile of projectiles) this.ids.add(projectile.id);
    for (const [id, mesh] of this.projectiles) {
      if (this.ids.has(id)) continue;
      mesh.visible = false;
      this.meshPools[mesh.userData.weapon as ProjectileWeapon].push(mesh);
      this.projectiles.delete(id);
    }
    for (const projectile of projectiles) {
      let mesh = this.projectiles.get(projectile.id);
      if (!mesh) {
        mesh = this.meshPools[projectile.weapon].pop();
        if (!mesh) continue;
        this.projectiles.set(projectile.id, mesh);
        mesh.position.y = height(projectile.ownerId);
      }
      mesh.visible = true;
      mesh.position.set(projectile.x, mesh.position.y, projectile.z);
      mesh.rotation.y = projectile.yaw;
    }
  }

  clear(): void {
    this.sync([]);
    for (const pool of this.pools) pool.active = pool.mesh.count = 0;
    for (const l of this.lights) l.life = l.light.intensity = 0;
    this.trailClock = this.flameSmoke = 0;
  }

  step(dt: number): void {
    this.trailClock += dt;
    if (this.trailClock >= 1 / 60) {
      this.trailClock %= 1 / 60;
      this.trailTick++;
      for (const mesh of this.projectiles.values()) {
        const weapon = mesh.userData.weapon as ProjectileWeapon;
        const rail = weapon === 'railgun';
        const length = rail ? 2.4 : 0.65;
        const sin = Math.sin(mesh.rotation.y),
          cos = Math.cos(mesh.rotation.y);
        const { x, y, z } = mesh.position;
        for (let i = 0; i < (rail ? 5 : 1); i++) {
          const offset = (i / 5) * length;
          this.spark.spawn(x - sin * offset, y, z - cos * offset, {
            vx: -sin * 0.3,
            vz: -cos * 0.3,
            color: rail ? C.railTrail : C.tracer,
            size: rail ? 0.075 : 0.055,
            life: rail ? 0.22 : 0.13,
            stretch: rail ? 4 : 2,
          });
        }
        if (weapon === 'cannon' && this.trailTick % 3 === 0)
          this.smoke.spawn(x, y, z, {
            vy: 0.3,
            color: C.contrail,
            size: 0.22,
            life: 0.6,
            grow: 2.5,
            drag: 1,
            alpha: 0.35,
          });
      }
    }
    for (const pool of this.pools) pool.step(dt);
    // Glowing heads spawn after stepping so each lives through the next frame at any frame rate.
    for (const mesh of this.projectiles.values()) {
      const weapon = mesh.userData.weapon as ProjectileWeapon;
      const { x, y, z } = mesh.position;
      this.glow.spawn(x, y, z, {
        color: weapon === 'railgun' ? C.railGlow : C.boltGlow,
        size: weapon === 'railgun' ? 1.2 : weapon === 'cannon' ? 0.95 : 0.5,
        life: Math.max(1e-3, dt * 1.5),
      });
    }
    for (const l of this.lights) {
      l.life = Math.max(0, l.life - dt);
      const k = l.life / l.max;
      l.light.intensity = l.peak * k * k;
    }
  }
}
