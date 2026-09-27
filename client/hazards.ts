import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { COOLING_POOLS, OIL_SLICKS, makeHazards } from '../shared/hazards.js';
import type { RoomState } from '../shared/game.js';

// Liquid surfaces: noise-perturbed normals, sky fresnel and a sharp sun glint.
const SURFACE_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const SURFACE_FRAG = /* glsl */ `
uniform float time, radius, burn, oil;
uniform vec3 shallow, deep, sky, horizon;
varying vec3 vWorld;
varying vec2 vLocal;
${NOISE}
float height(vec2 p) {
  float t = time * mix(1.0, 0.18, oil);
  float s = mix(0.55, 0.35, oil);
  return fbm(p * s + vec2(t * 0.6, t * 0.4)) + fbm(p * s * 1.7 - vec2(t * 0.5, -t * 0.7)) * 0.5;
}
void main() {
  float r = length(vLocal) / radius;
  // Oil spreads with a ragged, seamless edge; pools keep their round basin.
  vec2 dir = normalize(vLocal + 1e-4);
  float edge = 1.0 - oil * 0.09 * fbm(dir * 2.5 + radius);
  float alpha = 1.0 - smoothstep(edge - 0.04, edge, r);
  if (alpha <= 0.0) discard;
  vec2 p = vWorld.xz;
  float e = 0.06, h = height(p);
  float strength = mix(0.12, 0.06, oil);
  vec3 n = normalize(vec3((h - height(p + vec2(e, 0))) * strength / e, 1.0, (h - height(p + vec2(0, e))) * strength / e));
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 l = normalize(vec3(-16.0, 35.0, 12.0));
  float fresnel = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 rd = reflect(-v, n);
  vec3 reflection = mix(horizon, sky, smoothstep(0.0, 0.6, rd.y));
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), mix(260.0, 500.0, oil)) * mix(1.6, 2.2, oil);
  vec3 base = mix(deep, shallow, smoothstep(0.35, 1.0, r));
  // Water: shifting caustic light on the basin floor.
  float caustic = pow(1.0 - abs(noise(p * 2.2 + time * 0.4) - noise(p * 2.2 - time * 0.33)), 8.0);
  base += shallow * caustic * 0.2 * (1.0 - oil);
  // Oil: thin-film rainbow patches that drift slowly.
  float film = fbm(p * 0.7 + time * 0.03) * 3.0 + dot(n, v) * 1.5;
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (film + vec3(0.0, 0.33, 0.67)));
  float patches = smoothstep(0.5, 0.75, fbm(p * 0.5 - time * 0.02));
  base += irid * patches * 0.06 * oil * (1.0 - burn);
  vec3 col = mix(base, reflection, fresnel * mix(0.85, 0.6, oil)) + spec;
  // Burning oil glows from below the flames.
  float glow = 0.35 + 0.65 * fbm(p * 1.4 - vec2(0.0, time * 1.3));
  col = mix(col, col * 0.4, burn) + vec3(1.0, 0.3, 0.04) * burn * glow * glow * (1.1 - r) * 1.1;
  gl_FragColor = vec4(col, alpha * mix(0.92, 1.0, oil));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Cylindrical billboards: each quad turns to face the camera but stays upright.
const BILLBOARD_VERT = /* glsl */ `
attribute vec3 center;
attribute vec2 size;
attribute float seed;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = seed;
  vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  vec3 local = center + right * (uv.x - 0.5) * size.x + vec3(0.0, uv.y * size.y, 0.0);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
}`;
const FLAME_FRAG = /* glsl */ `
uniform float time, intensity;
varying vec2 vUv;
varying float vSeed;
${NOISE}
void main() {
  vec2 uv = vUv;
  float t = time * (1.0 + vSeed * 0.3);
  uv.x += (fbm(vec2(uv.y * 2.5 - t * 1.8, vSeed * 9.0)) - 0.5) * 0.45 * uv.y;
  float width = max(0.04, 1.0 - pow(uv.y, 1.3));
  float body = 1.0 - abs(uv.x - 0.5) * 2.0 / width;
  float n = fbm(vec2(uv.x * 3.0 + vSeed * 7.0, uv.y * 3.5 - t * 3.2));
  float heat = clamp(body * 1.2 - uv.y * 1.15 + (n - 0.5) * 1.4, 0.0, 1.0);
  heat *= smoothstep(0.0, 0.12, vUv.y) * intensity;
  vec3 col = mix(vec3(0.35, 0.03, 0.0), vec3(0.95, 0.22, 0.02), smoothstep(0.0, 0.4, heat));
  col = mix(col, vec3(1.0, 0.55, 0.12), smoothstep(0.4, 0.8, heat));
  col = mix(col, vec3(1.0, 0.85, 0.55), smoothstep(0.8, 1.0, heat));
  float alpha = smoothstep(0.05, 0.5, heat) * 0.8;
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(col * 1.2, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SMOKE_FRAG = /* glsl */ `
uniform float time, intensity;
varying vec2 vUv;
varying float vSeed;
${NOISE}
void main() {
  vec2 uv = vUv;
  float n = fbm(vec2(uv.x * 2.2 + vSeed * 5.0, uv.y * 2.0 - time * 0.55));
  float spread = mix(0.18, 0.48, uv.y);
  float body = 1.0 - smoothstep(spread * 0.5, spread, abs(uv.x - 0.5 + (n - 0.5) * 0.35));
  float alpha = body * smoothstep(0.3, 0.65, n) * smoothstep(0.0, 0.25, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y));
  alpha *= 0.85 * intensity;
  if (alpha <= 0.0) discard;
  vec3 col = mix(vec3(0.3, 0.12, 0.04), vec3(0.06, 0.055, 0.05), smoothstep(0.0, 0.35, uv.y));
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const EMBER_VERT = /* glsl */ `
uniform float time, radius;
attribute float seed;
varying float vLife;
void main() {
  float life = fract(seed * 13.7 + time * (0.35 + fract(seed * 7.1) * 0.3));
  vLife = life;
  vec3 p = position * radius * 0.8;
  p.y = life * 5.0;
  p.x += sin(time * 2.0 + seed * 40.0) * 0.4 * life;
  p.z += cos(time * 1.7 + seed * 23.0) * 0.4 * life;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_PointSize = (1.0 - life) * 90.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const EMBER_FRAG = /* glsl */ `
uniform float intensity;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(0.1, 0.5, d)) * (1.0 - vLife) * intensity;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * 2.0, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Fire {
  group: THREE.Group;
  intensity: { value: number };
  burn: { value: number };
  light: THREE.PointLight;
}

/** One draw call of upright billboards spread over an area. */
function billboards(
  count: number,
  radius: number,
  make: (i: number, a: number, r: number) => [number, number, number, number, number],
): THREE.BufferGeometry {
  const quad = [0, 0, 1, 0, 1, 1, 0, 1];
  const uv: number[] = [],
    center: number[] = [],
    size: number[] = [],
    seed: number[] = [],
    index: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996,
      r = Math.sqrt((i + 0.5) / count) * radius;
    const [x, y, z, w, h] = make(i, a, r);
    for (let k = 0; k < 4; k++) {
      uv.push(quad[k * 2]!, quad[k * 2 + 1]!);
      center.push(x, y, z);
      size.push(w, h);
      seed.push(i / count + Math.sin(i * 12.9) * 0.1);
    }
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  // Positions are rebuilt in the vertex shader; this only feeds three's bookkeeping.
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(count * 12).fill(0), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('center', new THREE.Float32BufferAttribute(center, 3));
  g.setAttribute('size', new THREE.Float32BufferAttribute(size, 2));
  g.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1));
  g.setIndex(index);
  return g;
}

export class ArenaHazards {
  readonly group = new THREE.Group();
  private tanks: THREE.Group[] = [];
  private fires: Fire[] = [];
  private time = { value: 0 };
  constructor() {
    const metal = new THREE.MeshStandardMaterial({
      color: '#592421',
      metalness: 0.65,
      roughness: 0.5,
    });
    const band = new THREE.MeshStandardMaterial({
      color: '#efbd46',
      metalness: 0.45,
      roughness: 0.6,
    });
    for (const tank of makeHazards().tanks) {
      const g = new THREE.Group();
      g.position.set(tank.x, 0, tank.z);
      for (const [y, r, h, mat] of [
        [1, 0.9, 2, metal],
        [0.3, 0.94, 0.15, band],
        [1.6, 0.94, 0.15, band],
        [2.08, 0.23, 0.16, band],
      ] as const) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mat);
        m.position.y = y;
        m.castShadow = true;
        g.add(m);
      }
      const label = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 0.035), band);
      label.position.set(0, 1, 0.91);
      label.rotation.z = Math.PI / 4;
      g.add(label);
      this.tanks.push(g);
      this.group.add(g);
    }
    const curb = new THREE.MeshStandardMaterial({
      color: '#8d9695',
      metalness: 0.6,
      roughness: 0.35,
    });
    for (const [areas, oil] of [
      [OIL_SLICKS, true],
      [COOLING_POOLS, false],
    ] as const)
      for (const area of areas) {
        const burn = { value: 0 };
        const surface = new THREE.Mesh(
          new THREE.CircleGeometry(area.radius, 64),
          new THREE.ShaderMaterial({
            vertexShader: SURFACE_VERT,
            fragmentShader: SURFACE_FRAG,
            transparent: true,
            depthWrite: false,
            uniforms: {
              time: this.time,
              radius: { value: area.radius },
              burn,
              oil: { value: oil ? 1 : 0 },
              shallow: { value: new THREE.Color(oil ? '#16121a' : '#34c2c8') },
              deep: { value: new THREE.Color(oil ? '#050407' : '#0a4a58') },
              sky: { value: new THREE.Color(oil ? '#1c2a33' : '#3d6378') },
              horizon: { value: new THREE.Color(oil ? '#6f8288' : '#b9d6d6') },
            },
          }),
        );
        surface.rotation.x = -Math.PI / 2;
        surface.position.set(area.x, 0.035, area.z);
        this.group.add(surface);
        if (!oil) {
          const lip = new THREE.Mesh(new THREE.TorusGeometry(area.radius, 0.08, 8, 64), curb);
          lip.rotation.x = -Math.PI / 2;
          lip.position.set(area.x, 0.04, area.z);
          lip.receiveShadow = true;
          this.group.add(lip);
          continue;
        }
        const intensity = { value: 0 };
        const fire = new THREE.Group();
        fire.position.set(area.x, 0, area.z);
        const shader = (fragmentShader: string, blending: THREE.Blending) =>
          new THREE.ShaderMaterial({
            vertexShader: BILLBOARD_VERT,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            blending,
            uniforms: { time: this.time, intensity },
          });
        const smoke = new THREE.Mesh(
          billboards(6, area.radius * 0.6, (i, a, r) => [
            Math.sin(a) * r,
            1.2,
            Math.cos(a) * r,
            3.2,
            6 + (i % 3),
          ]),
          shader(SMOKE_FRAG, THREE.NormalBlending),
        );
        // Tall flames gather in the middle where the fuel is deepest.
        const flames = new THREE.Mesh(
          billboards(18, area.radius * 0.85, (i, a, r) => {
            const k = 1 - r / area.radius;
            return [
              Math.sin(a) * r,
              0,
              Math.cos(a) * r,
              1.2 + k * 0.9,
              1.3 + k * 2.2 + (i % 3) * 0.3,
            ];
          }),
          shader(FLAME_FRAG, THREE.AdditiveBlending),
        );
        const emberSeeds = Array.from({ length: 40 }, (_, i) => i / 40);
        const emberGeometry = new THREE.BufferGeometry();
        emberGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            emberSeeds.flatMap((s) => {
              const a = s * 97.3,
                r = Math.sqrt(s);
              return [Math.sin(a) * r, 0, Math.cos(a) * r];
            }),
            3,
          ),
        );
        emberGeometry.setAttribute('seed', new THREE.Float32BufferAttribute(emberSeeds, 1));
        const embers = new THREE.Points(
          emberGeometry,
          new THREE.ShaderMaterial({
            vertexShader: EMBER_VERT,
            fragmentShader: EMBER_FRAG,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: { time: this.time, intensity, radius: { value: area.radius } },
          }),
        );
        smoke.renderOrder = 1;
        flames.renderOrder = 2;
        for (const m of [smoke, flames, embers]) m.frustumCulled = false;
        // Kept in the scene at zero intensity so ignition never changes the light count.
        const light = new THREE.PointLight('#ff7a2a', 0, area.radius * 4, 2);
        light.position.y = 1.4;
        fire.add(smoke, flames, embers, light);
        this.fires.push({ group: fire, intensity, burn, light });
        this.group.add(fire);
      }
  }
  update(state: RoomState | null, combat: boolean, time: number): void {
    this.group.visible = combat;
    this.time.value = time;
    this.tanks.forEach((tank, i) => {
      tank.visible = (state?.tanks?.[i]?.hp ?? 0) > 0;
    });
    this.fires.forEach((fire, i) => {
      // Ease in on ignition and die down over the final second.
      const target = Math.min(1, state?.oil?.[i]?.burning ?? 0);
      const k = fire.intensity.value;
      fire.intensity.value = k + (target - k) * (target > k ? 0.15 : 0.05);
      fire.burn.value = fire.intensity.value;
      const flicker = 0.75 + 0.15 * Math.sin(time * 13 + i) + 0.1 * Math.sin(time * 29.3 + i * 2);
      fire.light.intensity = fire.intensity.value * 30 * flicker;
      for (const child of fire.group.children)
        if (!(child instanceof THREE.Light)) child.visible = fire.intensity.value > 0.01;
    });
  }
}
