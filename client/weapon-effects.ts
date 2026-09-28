import * as THREE from 'three';
import { NOISE, NOISE3 } from './glsl.js';
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
  MAX_SMOKE = 220,
  MAX_FIRE = 192,
  MAX_DEBRIS = 64,
  MAX_FLASHES = 32,
  MAX_DECALS = 48,
  MAX_FIREBALL = 48,
  MAX_SOOT = 96,
  LIGHTS = 3;

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
  brass: '#c9a04a',
  railDim: '#1d4f8a',
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
  soot: '#45403b',
  char: '#2b2725',
  charHot: '#3a2a22',
  sootDark: '#35312e',
  dust: '#8c8378',
  haze: '#77716a',
  scorch: '#4a433d',
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
  float halo = pow(max(0.0, 1.0 - d), 2.2);
  gl_FragColor = vec4(vColor * (halo * 1.1 + exp(-d * d * 18.0) * 2.0), 1.0);
}`;
const SMOKE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vFx;
varying vec3 vColor;
${NOISE}
void main() {
  vec2 q = vUv - 0.5;
  float n = fbm(vUv * 3.0 + vFx.y * 17.0);
  float a = (1.0 - smoothstep(0.1, 1.0, length(q) * 2.0 + (n - 0.5) * 0.8)) * vFx.x;
  if (a < 0.01) discard;
  // Fake volume: billows lit from above, self-shadowed underneath.
  // Warm bounce underneath, cool sky on top; never denser than 0.35.
  float up = clamp(0.45 + q.y * 1.2 + (n - 0.5) * 0.9, 0.0, 1.0);
  vec3 col = vColor * mix(0.6, 1.2, up) * mix(vec3(1.15, 0.95, 0.8), vec3(0.9, 0.95, 1.08), up);
#ifdef DENSE
  // Heavy soot: dark, nearly opaque billows for explosion columns.
  // Lingers: opacity follows sqrt(life) instead of fading linearly.
  gl_FragColor = vec4(col * 0.55, min(a / max(sqrt(vFx.x), 0.01) * 0.9, 0.8));
#else
  gl_FragColor = vec4(col, min(a * 0.6, 0.35));
#endif
}`;
// Fireball: HDR black-body core that cools into occluding soot. Premultiplied alpha lets the
// same sprite add light early in life and darken the scene late in life.
// Fireball: a slice through evolving 3D noise (age is the third axis) shaded as a sphere of
// burning gas, so each sprite reads as a volume. The same black-body ramp as the slick fires,
// clamped below white; premultiplied alpha lets it glow early and occlude as soot late.
const FIRE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vFx;
varying vec3 vColor;
${NOISE3}
void main() {
  float age = 1.0 - vFx.x;
  vec2 q = (vUv - 0.5) * 2.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float depth = sqrt(1.0 - r2);
  vec3 w = vec3(q * 1.6, age * 1.8 + vFx.y * 17.0) + vec3(0.0, -age * 1.2, 0.0);
  w += (vec3(noise3(w * 0.7 + 2.3), noise3(w * 0.7 + 5.9), 0.0) - 0.5) * 1.3;
  float n = fbm3(w);
  float density = clamp(depth * 1.3 + (n - 0.5) * 1.6 - age * 0.5, 0.0, 1.0);
#ifdef FIREBALL
  // Explosion fireball: the silhouette erodes as it ages, it cools fast from yellow through
  // deep red, and what is left is an opaque, sooty black billow.
  float mask = smoothstep(0.18 + age * 0.3, 0.45 + age * 0.3, density + (n - 0.5) * 0.5);
  if (mask < 0.01) discard;
  // Cooler toward the rim and top, so each ball has a hot heart and a dark, sooty skin.
  float temp = clamp(density * (1.0 - age * 1.35) * 1.6 + (n - 0.5) * 0.6 - (1.0 - depth) * 0.35 - q.y * 0.15, 0.0, 1.0);
  vec3 c = mix(vec3(0.28, 0.02, 0.003), vColor * vec3(1.0, 0.7, 0.45), smoothstep(0.12, 0.6, temp));
  c = mix(c, vec3(1.6, 0.78, 0.2), smoothstep(0.78, 1.0, temp));
  vec3 glow = c * smoothstep(0.02, 0.3, temp) * mask * 0.8;
  float soot = smoothstep(0.25, 0.65, age + (1.0 - depth) * 0.2 + q.y * 0.15) * (1.0 - smoothstep(0.85, 1.0, age)) * mask * 0.9;
  // Soot is lit from above by the sky and from below by the dying fire.
  vec3 sootCol = mix(vec3(0.07, 0.035, 0.02), vec3(0.075, 0.07, 0.07), clamp(q.y * 0.8 + 0.5, 0.0, 1.0));
  gl_FragColor = vec4(min(glow, vec3(1.6)) + sootCol * soot, max(soot, mask * 0.55));
#else
  float mask = smoothstep(0.05, 0.5, density);
  if (mask < 0.01) discard;
  float temp = clamp(density * (1.0 - age * 1.2) * 1.4 + (n - 0.5) * 0.4, 0.0, 1.0);
  vec3 c = mix(vec3(0.45, 0.05, 0.01), vColor * 1.3, smoothstep(0.1, 0.55, temp));
  c = mix(c, vec3(1.5, 0.95, 0.35), smoothstep(0.65, 0.95, temp));
  vec3 glow = c * smoothstep(0.02, 0.35, temp) * mask * 0.7;
  float soot = smoothstep(0.35, 0.85, age) * (1.0 - smoothstep(0.8, 1.0, age)) * mask * 0.35;
  // Partly "over" even while hot, so stacked fireballs saturate to orange instead of white.
  gl_FragColor = vec4(min(glow, vec3(1.6)) + vec3(0.06, 0.055, 0.05) * soot, max(soot, mask * 0.4));
#endif
}`;

// Muzzle flash card: a hot core with 4-7 ragged petals whose count, sharpness and twist come
// from the per-instance seed, so consecutive shots never repeat the same shape.
const FLASH_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vFx;
varying vec3 vColor;
${NOISE}
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0, a = atan(q.y, q.x);
  float petals = floor(4.0 + vFx.y * 3.99);
  float lobe = pow(abs(cos(a * petals * 0.5 + vFx.y * 11.0)), 2.0 + vFx.y * 10.0);
  float reach = mix(0.22, 1.0, lobe) * (0.75 + 0.35 * noise(vec2(a * 3.0, vFx.y * 40.0)));
  float m = 1.0 - smoothstep(reach * 0.45, reach, r);
  float core = exp(-r * r * 18.0);
  gl_FragColor = vec4(min(vColor * (m * 1.3 + core * 2.2), vec3(3.0)) * vFx.x, 1.0);
}`;
// Flat impact decal: noisy scorch with radial blast streaks; normal blending darkens the roof.
const DECAL_VERT = /* glsl */ `
attribute vec2 fx;
varying vec2 vUv;
varying vec2 vFx;
varying float vHeat;
void main() {
  vUv = uv;
  vFx = fx;
  vHeat = instanceColor.r;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const DECAL_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vFx;
varying float vHeat;
${NOISE}
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float n = fbm(vUv * 4.0 + vFx.y * 13.0);
  float blot = 1.0 - smoothstep(0.25, 0.95, r + (n - 0.5) * 0.7);
  float rays = pow(abs(sin(atan(q.y, q.x) * 7.0 + vFx.y * 20.0)), 10.0) * smoothstep(0.2, 0.6, r) * (1.0 - smoothstep(0.7, 1.0, r));
  float a = clamp(blot * (0.8 + 0.3 * n) + rays * 0.4, 0.0, 0.92) * vFx.x;
  if (a < 0.01) discard;
  // Fresh blast scorch: glowing ember cracks that cool over the first couple of seconds.
  float cracks = smoothstep(0.55, 0.75, fbm(vUv * 11.0 + vFx.y * 7.0)) * (1.0 - smoothstep(0.2, 0.7, r));
  vec3 ember = vec3(2.2, 0.55, 0.08) * cracks * vHeat * vHeat + vec3(0.6, 0.12, 0.02) * vHeat * blot * (1.0 - r);
  float fa = max(a, min(1.0, cracks * vHeat));
  gl_FragColor = vec4(vec3(0.03, 0.027, 0.024) * (0.7 + 0.6 * n) + ember / fa, fa);
}`;
// Tracer ribbon: crossed quads trailing each projectile; white-hot centre line, tapered tail.
const TRACER_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRACER_FRAG = /* glsl */ `
uniform vec3 color;
varying vec2 vUv;
void main() {
  float along = vUv.y;
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0 / mix(0.25, 1.0, along);
  if (across <= 0.0) discard;
  float body = pow(across, 1.6) * pow(along, 1.4);
  float core = pow(across, 6.0) * pow(along, 0.7);
  gl_FragColor = vec4(min(color * body + vec3(2.6, 2.3, 1.9) * core, vec3(3.5)), 1.0);
}`;

type Kind = 'spark' | 'glow' | 'smoke' | 'fire' | 'flash' | 'decal' | 'debris';
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
    if (kind !== 'spark' && kind !== 'debris') {
      this.fx = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
      this.fx.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('fx', this.fx);
    }
  }

  spawn(x: number, y: number, z: number, o: Spawn): Particle | undefined {
    let p: Particle;
    if (this.active < this.particles.length) p = this.particles[this.active++]!;
    else if (this.kind === 'decal')
      // Decals are long-lived: the oldest mark gives way to the newest.
      p = this.particles.reduce((a, b) => (a.life < b.life ? a : b));
    else return;
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
      // HDR: white-hot sparks exceed 1.0 so the bloom pass picks them up.
      c.lerp(C.white, Math.max(0, fade - 0.8) * 1.5).multiplyScalar(fade * 2.4);
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
    } else if (this.kind === 'decal') {
      this.mesh.setMatrixAt(
        i,
        this.matrix
          .makeRotationY(p.seed * 6.283)
          .scale(this.look.set(p.size, 1, p.size))
          .setPosition(p.position.x, 0.02, p.position.z),
      );
      this.fx!.setXY(i, p.alpha * Math.min(1, fade * 4), p.seed);
      // Big scorches glow for the first ~15% of their life (red channel = heat).
      c.setRGB(p.size > 2 ? Math.max(0, (fade - 0.85) / 0.15) : 0, 0, 0);
    } else {
      const s = p.size * (1 + (1 - fade) * p.grow);
      this.mesh.setMatrixAt(
        i,
        this.matrix.makeScale(s, s, s).setPosition(p.position.x, p.position.y, p.position.z),
      );
      if (this.kind === 'glow') c.multiplyScalar(fade * fade);
      // Fire reads its remaining life; smoke fades in quickly and out slowly.
      if (this.kind === 'fire' || this.kind === 'flash') this.fx!.setXY(i, fade, p.seed);
      else this.fx!.setXY(i, p.alpha * fade * Math.min(1, (1 - fade) * 8), p.seed);
    }
    this.mesh.setColorAt(i, c);
  }
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** A flat ribbon plus a copy rolled 90 degrees about its length, so it reads from any angle. */
function mergeCrossed(flat: THREE.BufferGeometry): THREE.BufferGeometry {
  const upright = flat.clone().rotateZ(Math.PI / 2);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'uv'] as const) {
    const a = flat.getAttribute(name).array as Float32Array,
      b = upright.getAttribute(name).array as Float32Array;
    const merged = new Float32Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    out.setAttribute(name, new THREE.BufferAttribute(merged, name === 'uv' ? 2 : 3));
  }
  const ia = flat.getIndex()!.array,
    count = flat.getAttribute('position').count;
  out.setIndex([...ia, ...Array.from(ia, (v) => v + count)]);
  return out;
}

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
  private fire = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: FIRE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
      MAX_FIRE,
    ),
    'fire',
  );
  // Explosion-only variants: eroding fireballs that turn to soot, and a dense soot column.
  private fireball = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: FIRE_FRAG,
        defines: { FIREBALL: 1 },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
      MAX_FIREBALL,
    ),
    'fire',
  );
  private soot = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: SMOKE_FRAG,
        defines: { DENSE: 1 },
        transparent: true,
        depthWrite: false,
      }),
      MAX_SOOT,
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
  private flash = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT,
        fragmentShader: FLASH_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_FLASHES,
    ),
    'flash',
  );
  private decal = new Pool(
    new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT,
        fragmentShader: DECAL_FRAG,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
      MAX_DECALS,
    ),
    'decal',
  );
  private pools = [
    this.decal,
    this.soot,
    this.smoke,
    this.fireball,
    this.debris,
    this.fire,
    this.spark,
    this.glow,
    this.flash,
  ];
  // Kept in the scene at zero intensity so a flash never changes the light count.
  private lights = Array.from({ length: LIGHTS }, () => ({
    light: new THREE.PointLight('#ffffff', 0, 14, 2),
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
  private flameLight?: (typeof this.lights)[number];

  constructor(private scene: THREE.Scene) {
    this.smoke.mesh.renderOrder = 1;
    this.soot.mesh.renderOrder = 1;
    this.fireball.mesh.renderOrder = 2;
    this.fire.mesh.renderOrder = 2;
    this.glow.mesh.renderOrder = 3;
    this.sparks.renderOrder = 2;
    this.flash.mesh.renderOrder = 4;
    for (const pool of this.pools) this.group.add(pool.mesh);
    for (const l of this.lights) this.group.add(l.light);
    scene.add(this.group);
    for (const weapon of Object.keys(this.meshPools) as ProjectileWeapon[]) {
      const rail = weapon === 'railgun',
        pellet = weapon === 'scattergun';
      const geometry = rail
        ? new THREE.BoxGeometry(0.12, 0.12, 1.9)
        : new THREE.SphereGeometry(pellet ? 0.1 : 0.16, 6, 6);
      // HDR core (x3) so the head blooms; the tracer ribbon trails behind it.
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rail ? '#b8fbff' : pellet ? '#ffc27a' : '#fff0b0').multiplyScalar(3),
      });
      const [length, width] = rail ? [6, 0.34] : pellet ? [2.4, 0.3] : [3.2, 0.44];
      // Lies flat along -z behind the head, uv.y running from 0 at the tail to 1 at the head.
      const ribbon = new THREE.PlaneGeometry(width, length).rotateX(Math.PI / 2);
      const crossed = mergeCrossed(ribbon.translate(0, 0, -length / 2));
      const tracerMaterial = new THREE.ShaderMaterial({
        vertexShader: TRACER_VERT,
        fragmentShader: TRACER_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          color: {
            value: new THREE.Color(rail ? C.railBeam : pellet ? C.tracer : C.orange).multiplyScalar(
              rail ? 1.6 : 2.2,
            ),
          },
        },
      });
      // Four pilots, including two overlapping cannon volleys at maximum range.
      const capacity = 4 * PROJECTILE_RULES[weapon].angles.length * (weapon === 'cannon' ? 2 : 1);
      for (let i = 0; i < capacity; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        const trail = new THREE.Mesh(crossed, tracerMaterial);
        trail.frustumCulled = false;
        mesh.add(trail);
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
    charred = false,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = yaw === undefined ? Math.random() * Math.PI * 2 : yaw + (Math.random() - 0.5);
      const speed = force * rand(0.4, 1);
      this.debris
        .spawn(x, y, z, {
          vx: Math.sin(angle) * speed,
          vy: 3 + Math.random() * force * 0.8,
          vz: Math.cos(angle) * speed,
          color: charred ? (i % 2 ? C.char : C.charHot) : i % 3 ? C.steel : C.darkSteel,
          size: rand(...size),
          life: charred ? rand(2, 3) : rand(1.2, 2),
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
    // Jittered angles and speeds: a burst of grit, not a drawn circle.
    for (let i = 0; i < 24; i++) {
      const angle = ((i + Math.random()) / 24) * Math.PI * 2,
        v = speed * rand(0.45, 1);
      const a = Math.cos(angle) * v,
        b = Math.sin(angle) * v;
      this.spark.spawn(x, y, z, {
        vx: yaw === undefined ? a : a * Math.cos(yaw),
        vy: yaw === undefined ? 0 : b,
        vz: yaw === undefined ? b : -a * Math.sin(yaw),
        color,
        size: 0.06,
        life: rand(0.15, 0.28),
      });
    }
  }

  /** Dust thrown outward along the roof. */
  private dustRing(
    x: number,
    z: number,
    count: number,
    speed: number,
    size: number,
    alpha = 0.5,
  ): void {
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
        alpha,
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
    distance = 14,
    reuse?: (typeof this.lights)[number],
  ) {
    const slot =
      reuse && reuse.life > 0
        ? reuse
        : this.lights.reduce((a, b) => (a.life / a.max < b.life / b.max ? a : b));
    slot.light.position.set(x, y, z);
    slot.light.color.copy(color);
    slot.light.distance = distance;
    slot.peak = peak;
    slot.life = slot.max = life;
    return slot;
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
    // Muzzle flash: randomly shaped petal cards (a big bloom at the muzzle, smaller ones
    // pushed out along the barrel) around a small hot core.
    this.glow.spawn(x, y, z, { color: rail ? C.railCore : C.flash, size: 0.8, life: 0.06 });
    for (let i = 0; i < 3; i++)
      this.flash.spawn(x + sin * (0.15 + i * 0.4), y, z + cos * (0.15 + i * 0.4), {
        color: rail ? C.railGlow : i ? C.petal : C.flash,
        size: (scatter ? 1.7 : 1.35) * (1 - i * 0.28) * rand(0.85, 1.15),
        life: rand(0.05, 0.08),
        grow: 0.4,
      });
    if (!rail)
      // Forward flash cone: glows shrinking along the barrel axis read from any camera angle.
      for (let i = 0; i < 6; i++) {
        const k = i / 5,
          reach = 0.2 + k * (scatter ? 1.6 : 1.3);
        this.glow.spawn(x + sin * reach, y, z + cos * reach, {
          color: i < 2 ? C.flash : C.petal,
          size: (scatter ? 1 : 0.8) * (1 - k * 0.65),
          life: 0.06,
        });
      }
    if (!rail)
      // A hot casing ejected to the right, tumbling onto the roof.
      this.debris
        .spawn(x - sin * 0.6 + cos * 0.2, y + 0.1, z - cos * 0.6 - sin * 0.2, {
          vx: cos * rand(2, 3.5) - sin,
          vy: rand(2.5, 4),
          vz: -sin * rand(2, 3.5) - cos,
          color: C.brass,
          size: scatter ? 0.07 : 0.1,
          life: rand(1.4, 2),
          gravity: 14,
        })
        ?.spin.set(rand(-20, 20), rand(-20, 20), rand(-20, 20));
    if (rail) {
      // Ionized beam lingers and cools from cyan to deep blue...
      for (let i = 1; i <= 28; i++)
        this.glow.spawn(x + sin * i * 0.3, y, z + cos * i * 0.3, {
          color: C.railBeam,
          to: C.railDim,
          size: 0.4,
          life: 0.35 + i * 0.012,
          grow: 1.6,
        });
      // ...wrapped in a helical energy spiral that unwinds outward.
      const rx = cos,
        rz = -sin;
      for (let i = 0; i < 64; i++) {
        const t = i * 0.14,
          a = t * 4.2,
          c = Math.cos(a),
          sn = Math.sin(a);
        this.glow.spawn(x + sin * t + rx * c * 0.22, y + sn * 0.22, z + cos * t + rz * c * 0.22, {
          vx: rx * c * 0.8,
          vy: sn * 0.8,
          vz: rz * c * 0.8,
          color: C.railGlow,
          to: C.railDim,
          size: 0.2,
          life: 0.25 + t * 0.04,
          grow: 0.8,
        });
      }
    }
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
    this.flashLight(x, y, z, rail ? C.railLight : C.muzzleLight, rail ? 30 : 40, 0.08);
  }

  /** `y` is the struck body's center height; smaller chassis are hit lower. `weapon` tints projectile hits. */
  impact(x: number, z: number, big: boolean, y = 1, weapon?: TopWeapon): void {
    const rail = weapon === 'railgun';
    // A scorch or bullet mark on the roof that fades out over several seconds.
    if (!big)
      this.decal.spawn(x + rand(-0.3, 0.3), 0, z + rand(-0.3, 0.3), {
        color: C.scorch,
        size: rail ? 1 : rand(0.6, 0.9),
        life: 7,
        alpha: 0.85,
      });
    this.ring(x, 0.12, z, big ? C.blast : rail ? C.railCore : C.hitRing, big ? 9 : 5);
    this.burst(x, z, big, y - 0.2);
    this.embers(x, y - 0.2, z, big ? 14 : 4, big ? 12 : 7, rail ? C.railEmber : C.hitEmber);
    if (big) {
      this.explosion(x, y, z);
      return;
    }
    this.glow.spawn(x, y - 0.1, z, {
      color: rail ? C.railGlow : C.hitGlow,
      size: 1,
      life: 0.1,
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
    this.flashLight(x, y, z, rail ? C.railLight : C.hitLight, 25, 0.1);
  }

  /**
   * Timed blast: a small white-hot flash (~70 ms), an eroding fireball cooling orange to red
   * to black soot, a dark soot column lingering ~3 s, dark shards and burning embers on
   * ballistic arcs, a dust shockwave along the roof, a glowing scorch and a floor light pulse.
   */
  private explosion(x: number, y: number, z: number): void {
    this.glow.spawn(x, y, z, { color: C.fireWhite, size: 0.55, life: 0.07, grow: 1.5 });
    const fire = [C.fireYellow, C.fireOrange, C.fireOrange, C.blast];
    for (let i = 0; i < 11; i++) {
      const angle = Math.random() * Math.PI * 2,
        out = rand(2, 6),
        up = i < 4 ? rand(0.5, 1.4) : rand(0, 0.6);
      this.fireball.spawn(x + rand(-0.3, 0.3), y * 0.6 + up * 0.5, z + rand(-0.3, 0.3), {
        vx: Math.cos(angle) * out,
        vy: rand(1, 3) + up * 2,
        vz: Math.sin(angle) * out,
        color: fire[i % 4]!,
        size: rand(0.8, 1.4),
        life: rand(0.9, 1.5),
        grow: 2.2,
        gravity: -2.5,
        drag: 3.5,
      });
    }
    // Soot column: billows released at rising heights keep climbing after the fire dies.
    for (let i = 0; i < 16; i++) {
      const h = (i / 16) * 2.2;
      this.soot.spawn(x + rand(-0.7, 0.7), y + h * 0.6, z + rand(-0.7, 0.7), {
        vx: rand(-0.5, 0.5) + 0.35,
        vy: rand(0.7, 1.4) + h * 0.3,
        vz: rand(-0.5, 0.5),
        color: C.sootDark,
        size: rand(1.0, 1.6),
        life: rand(2.4, 3.4),
        grow: 2.2,
        drag: 0.3,
        alpha: 0.85,
      });
    }
    // Low dust skirt shoved outward along the roof.
    this.dustRing(x, z, 18, 13, 0.5, 0.35);
    this.ring(x, 0.1, z, C.fireYellow, 12);
    this.chunks(x, y * 0.6, z, 22, 12, [0.12, 0.3], undefined, true);
    // Burning embers arcing out and skipping across the roof.
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2,
        speed = rand(5, 11);
      this.spark.spawn(x, y * 0.7, z, {
        vx: Math.cos(angle) * speed,
        vy: rand(4, 9),
        vz: Math.sin(angle) * speed,
        color: i % 2 ? C.fireOrange : C.ember,
        size: 0.09,
        life: rand(0.9, 1.5),
        gravity: 14,
        stretch: 2,
      });
    }
    this.decal.spawn(x, 0, z, { color: C.scorch, size: rand(4.2, 5), life: 14, alpha: 1 });
    this.flashLight(x, 1.1, z, C.blastLight, 90, 0.7, 16);
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

  /** A burning robot: licking fireballs and a soot trail from its hull, emitted at a fixed rate. */
  burning(x: number, y: number, z: number, dt: number): void {
    const count = (rate: number) => Math.floor(dt * rate + Math.random());
    for (let i = count(40); i > 0; i--)
      this.fire.spawn(x + rand(-0.3, 0.3), y + rand(0, 0.2), z + rand(-0.3, 0.3), {
        vx: rand(-0.3, 0.3),
        vy: rand(1.4, 2.4),
        vz: rand(-0.3, 0.3),
        color: i % 3 ? C.fireOrange : C.fireYellow,
        to: C.fireRed,
        size: rand(0.5, 0.85),
        life: rand(0.4, 0.65),
        grow: 1.4,
        drag: 1,
      });
    for (let i = count(6); i > 0; i--)
      this.smoke.spawn(x, y + 0.8, z, {
        vx: rand(-0.2, 0.2),
        vy: rand(1.2, 1.8),
        vz: rand(-0.2, 0.2),
        color: C.scorch,
        size: 0.5,
        life: 1.4,
        grow: 3.5,
        drag: 0.8,
        alpha: 0.5,
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
      size: grinding ? 0.6 : heavy ? 1.5 : 1.1,
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
    this.flashLight(x, y, z, heavy ? C.hammerLight : color, heavy ? 35 : 18, 0.1);
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
    const count = (rate: number) => Math.floor(dt * rate + Math.random());
    // White-hot nozzle bulb, refreshed every frame whatever the frame rate.
    this.glow.spawn(x + sin * 0.15, y, z + cos * 0.15, {
      color: C.fireWhite,
      size: 0.55,
      life: Math.max(1e-3, dt * 1.5),
    });
    // One pooled light rides along the stream near the floor so the roof flickers under it.
    // ponytail: one light shared by all flamethrowers; give each its own if 2+ fire at once.
    const reach = rand(1.8, 3);
    this.flameLight = this.flashLight(
      x + sin * reach,
      0.45,
      z + cos * reach,
      C.fireOrange,
      32 + Math.random() * 22,
      0.12,
      9,
      this.flameLight,
    );
    // Hot core: fast, short-lived additive streak along the first metre or so.
    for (let i = count(45); i > 0; i--) {
      const angle = yaw + (Math.random() - 0.5) * 0.08,
        speed = rand(11, 14);
      this.glow.spawn(x, y, z, {
        vx: Math.sin(angle) * speed,
        vz: Math.cos(angle) * speed,
        color: i % 2 ? C.fireYellow : C.fireWhite,
        size: rand(0.3, 0.45),
        life: rand(0.08, 0.13),
      });
    }
    // Stream body: a pressurised jet, pencil-thin at the nozzle, that billows out and reddens
    // as drag slows it (small sprites that grow sixfold).
    for (let i = count(130); i > 0; i--) {
      const angle = yaw + (Math.random() - 0.5) * 0.12,
        speed = rand(14, 17),
        side = rand(-0.8, 0.8);
      this.fire.spawn(x, y, z, {
        vx: Math.sin(angle) * speed + cos * side,
        vy: rand(-0.3, 0.5),
        vz: Math.cos(angle) * speed - sin * side,
        color: i % 3 ? C.fireOrange : C.fireYellow,
        to: C.fireRed,
        size: rand(0.14, 0.22),
        life: rand(0.36, 0.48),
        grow: 5.5,
        drag: 2.6,
        gravity: -2,
      });
    }
    // Curling fireball front: slow, fat billows that roll up off the tip and redden.
    for (let i = count(14); i > 0; i--) {
      const tip = rand(3.3, 4.3),
        off = rand(-0.4, 0.4);
      this.fire.spawn(x + sin * tip + cos * off, y + rand(-0.1, 0.3), z + cos * tip - sin * off, {
        vx: sin * rand(1, 2.5),
        vy: rand(1.2, 2.2),
        vz: cos * rand(1, 2.5),
        color: i % 2 ? C.fireOrange : C.fireYellow,
        to: C.fireRed,
        size: rand(0.6, 0.9),
        life: rand(0.45, 0.65),
        grow: 1.8,
        drag: 2,
        gravity: -1.5,
      });
    }
    // Burning napalm droplets rain out of the stream and skip on the roof.
    for (let i = count(16); i > 0; i--) {
      const at = rand(1, 3.6);
      this.glow.spawn(x + sin * at, y, z + cos * at, {
        vx: sin * rand(3, 6),
        vy: rand(-0.5, 1),
        vz: cos * rand(3, 6),
        color: i % 2 ? C.fireOrange : C.ember,
        size: rand(0.14, 0.22),
        life: rand(0.5, 0.8),
        gravity: 9,
        drag: 0.8,
      });
    }
    // Floor splash: where the jet comes down, low licks of fire spray up off the roof.
    for (let i = count(26); i > 0; i--) {
      const tip = rand(3.6, 4.6),
        off = rand(-0.6, 0.6);
      this.fire.spawn(x + sin * tip + cos * off, 0.15, z + cos * tip - sin * off, {
        vx: sin * rand(0.5, 2) + cos * off * 2,
        vy: rand(1.2, 2.4),
        vz: cos * rand(0.5, 2) - sin * off * 2,
        color: i % 2 ? C.fireOrange : C.fireYellow,
        to: C.fireRed,
        size: rand(0.3, 0.45),
        life: rand(0.3, 0.45),
        grow: 1.6,
        drag: 1.5,
      });
    }
    for (let i = count(20); i > 0; i--) {
      const angle = yaw + (Math.random() - 0.5) * 0.3;
      this.spark.spawn(x, y, z, {
        vx: Math.sin(angle) * 11,
        vy: rand(0.5, 1.5),
        vz: Math.cos(angle) * 11,
        color: i % 2 ? C.flameA : C.flameB,
        size: 0.06,
        life: rand(0.3, 0.45),
        gravity: -1,
        stretch: 2,
      });
    }
    // Smoke peels off the tip of the stream.
    this.flameSmoke += dt * 10;
    for (; this.flameSmoke >= 1; this.flameSmoke--) {
      const angle = yaw + (Math.random() - 0.5) * 0.4,
        tip = rand(3.8, 4.8);
      this.smoke.spawn(x + Math.sin(angle) * tip, y + 0.4, z + Math.cos(angle) * tip, {
        vx: Math.sin(angle) * 2,
        vy: 1.6,
        vz: Math.cos(angle) * 2,
        color: C.scorch,
        size: 0.35,
        life: 1,
        grow: 2.5,
        drag: 1.4,
        alpha: 0.25,
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
      // Spent rounds fizzle out in a few sparks instead of vanishing.
      if (mesh.userData.weapon !== 'railgun')
        for (let i = 0; i < 3; i++)
          this.spark.spawn(mesh.position.x, mesh.position.y, mesh.position.z, {
            vx: rand(-2, 2) + Math.sin(mesh.rotation.y) * 4,
            vy: rand(0, 2.5),
            vz: rand(-2, 2) + Math.cos(mesh.rotation.y) * 4,
            color: C.gold,
            size: 0.06,
            life: rand(0.2, 0.4),
            gravity: 10,
            stretch: 3,
          });
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
        size: weapon === 'railgun' ? 1.2 : weapon === 'cannon' ? 0.95 : 0.7,
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
