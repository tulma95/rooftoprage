import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FIRE_VOLUME_FRAG, FIRE_VOLUME_VERT, NOISE } from './glsl.js';
import { SUN_DIRECTION } from './post.js';
import { COOLING_POOLS, OIL_SLICKS, makeHazards } from '../shared/hazards.js';
import type { RoomState } from '../shared/game.js';

const FIRE_LIGHTS = 2;

const LQ_NOISE = NOISE.replace(/\b(hash|noise|fbm)\(/g, 'lq_$1(');

/**
 * Oil is a lit PBR surface (IBL reflections, fire lights, roughness response); the
 * shader patch only adds ripple normals, a soft irregular outline and roughness breakup.
 */
function oilMaterial(
  radius: number,
  seed: number,
  time: { value: number },
  burn: { value: number },
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: '#15100b',
    roughness: 0.06,
    metalness: 0,
    ior: 1.47,
    // Thin-film interference on oil, driven per-pixel below.
    iridescence: 1,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [150, 600],
    transparent: true,
    depthWrite: false,
  });
  material.customProgramCacheKey = () => 'oil';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      time,
      burn,
      radius: { value: radius },
      seed: { value: seed },
    });
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vWorldP;\nvarying vec2 vLocalP;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvLocalP = position.xy;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform float time, burn, radius, seed;
varying vec3 vWorldP;
varying vec2 vLocalP;
${LQ_NOISE}
float lqHeight(vec2 p) {
  return lq_fbm(p * 0.5 + time * 0.03) + lq_fbm(p * 1.6 - time * 0.02) * 0.4;
}
void main() {
  float lqR = length(vLocalP) / radius;
  vec2 lqDir = normalize(vLocalP + 1e-4);
  // Oil spreads in lobes (noise sampled around a circle, so it wraps seamlessly).
  float lqEdge = 1.0 - 0.32 * lq_fbm(lqDir * 1.4 + seed * 7.0) - 0.05 * lq_noise(vWorldP.xz * 3.0);
  float lqMask = 1.0 - smoothstep(lqEdge - 0.06, lqEdge, lqR); // crisp liquid edge, not a soft shadow-like falloff
  // Burning chars the concrete under and around the slick.
  float lqScorch = (1.0 - smoothstep(lqEdge - 0.1, lqEdge + 0.2 + 0.1 * lq_noise(vWorldP.xz * 2.0), lqR)) * burn;
  if (max(lqMask, lqScorch) <= 0.002) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  // Large, low-contrast depth/film variation only: no high-frequency tiling to alias.
  float lqLow = lq_fbm(vWorldP.xz * 0.3 + seed * 3.0);
  diffuseColor.rgb *= mix(0.7, 1.3, lqLow) * mix(1.0, 0.75, burn);
  diffuseColor.a *= lqMask * mix(0.55, 0.97, smoothstep(0.0, 0.6, lqMask));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.066, 0.058) * (0.6 + 0.8 * lqLow), burn * 0.6);
  diffuseColor.a = max(diffuseColor.a, lqScorch * (0.75 + 0.2 * lq_noise(vWorldP.xz * 5.0)));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(0.03, 0.14, lq_fbm(vWorldP.xz * 0.9 + 11.0));
  roughnessFactor = mix(roughnessFactor, 0.45, smoothstep(0.5, 1.0, lqR / lqEdge) * 0.6 + burn * 0.5);
  roughnessFactor = mix(roughnessFactor, 0.9, lqScorch * (1.0 - lqMask));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  {
    vec2 p = vWorldP.xz;
    float e = 0.05, h = lqHeight(p);
    float s = 0.035 / e;
    vec3 nW = normalize(vec3((h - lqHeight(p + vec2(e, 0.0))) * s, 1.0, (h - lqHeight(p + vec2(0.0, e))) * s));
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
  #ifdef USE_IRIDESCENCE
  // Film thickness drifts slowly; only part of the slick shows sheen.
  material.iridescence = smoothstep(0.35, 0.75, lq_fbm(vWorldP.xz * 0.35 - time * 0.01 + seed)) * 0.9 * (1.0 - burn);
  material.iridescenceThickness = mix(180.0, 560.0, lq_fbm(vWorldP.xz * 0.6 + time * 0.015));
  #endif`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
  #ifdef USE_ENVMAP
  // The dusk IBL is sky-blue overhead; liquids keep a darker, warmer reflection to stay grounded.
  radiance *= vec3(1.9, 1.65, 1.45); // low-Fresnel sky mirror boosted so the slick reads as liquid, not a shadow
  #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  // Burning oil: a molten ember bed under the flames (brightest at the heart, broken by
  // charred crust), fraying into sparse glowing cracks toward the rim.
  float lqFlick = 0.75 + 0.25 * sin(time * 9.0 + vWorldP.x * 3.0) * sin(time * 5.3 + vWorldP.z * 2.0);
  float lqCrust = lq_fbm(vWorldP.xz * 2.4 + vec2(0.0, -time * 0.5));
  float lqCrack = smoothstep(0.5, 0.72, lqCrust);
  float lqBed = 1.0 - smoothstep(0.15, 0.8, lqR / lqEdge);
  vec3 lqHot = vec3(2.4, 0.7, 0.1) * lqCrack * (0.35 + lqBed) + vec3(1.1, 0.25, 0.03) * lqBed * smoothstep(0.3, 0.6, lqCrust);
  totalEmissiveRadiance += lqHot * burn * lqMask * lqFlick;`,
      );
  };
  return material;
}

// Coolant shaft: the disc is the opening under a steel grate. Each pixel traces the view ray
// into a deep cylinder below the roof (interior mapping): sooty riveted walls fall off into
// darkness, the low sun rakes a warm band across the far wall, and coolant glows faintly at
// the bottom, tinting the lowest walls.
const SUMP_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const SUMP_FRAG = /* glsl */ `
uniform float time, radius;
uniform vec3 center, sun;
varying vec3 vWorld;
${NOISE}
const float LEVEL = 4.5;
vec3 coolant(vec2 p) {
  float veins = smoothstep(0.55, 0.9, fbm(p * 1.3 + vec2(time * 0.12, -time * 0.09)));
  return vec3(0.02, 0.13, 0.11) + vec3(0.05, 0.5, 0.42) * veins;
}
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  vec2 o = vWorld.xz - center.xz;
  float tFloor = LEVEL / max(-d.y, 1e-3);
  vec2 dd = d.xz;
  float a = dot(dd, dd), b = dot(o, dd), c = dot(o, o) - radius * radius;
  float tWall = (-b + sqrt(max(b * b - a * c, 0.0))) / max(a, 1e-5);
  vec3 col;
  float t;
  if (tFloor < tWall) {
    t = tFloor;
    vec2 q = o + dd * tFloor;
    col = coolant(q + center.xz) * (1.0 - smoothstep(0.6, 1.0, length(q) / radius) * 0.6);
  } else {
    t = tWall;
    vec3 w = vWorld + d * tWall;
    vec2 r = w.xz - center.xz;
    float depth = -w.y;
    float ang = atan(r.y, r.x);
    // Riveted plate rings, vertical stiffeners, soot streaks running down.
    float seams = smoothstep(0.03, 0.0, abs(fract(depth * 1.4) - 0.5) - 0.44);
    float ribs = smoothstep(0.85, 1.0, abs(sin(ang * 10.0)));
    float grime = fbm(vec2(ang * 4.0, depth * 0.8)) * fbm(vec2(ang * 18.0, depth * 3.0));
    float albedo = (0.1 + 0.12 * grime) * (1.0 - seams * 0.5) + ribs * 0.04;
    // Ambient sky light fades quickly with depth; the low sun lights only a band of the far wall.
    vec3 lightc = vec3(0.55, 0.5, 0.52) * exp(-depth * 1.6);
    vec2 s = normalize(sun.xz);
    vec2 nIn = -r / radius;
    float chord = -2.0 * dot(r, s);
    float lit = step(0.0, chord) * smoothstep(0.05, -0.05, depth - chord * sun.y / length(sun.xz));
    // Where the sun ray back to the opening crosses a grate bar, the band is shadowed.
    vec2 g = w.xz + sun.xz * (depth / sun.y) - center.xz + radius;
    float bars = smoothstep(0.02, 0.035, abs(fract((g.x - 0.2) / 0.3 + 0.5) - 0.5) * 0.3)
      * smoothstep(0.02, 0.035, abs(fract((g.y - 0.45) / 0.9 + 0.5) - 0.5) * 0.9);
    lightc += vec3(1.5, 0.95, 0.55) * lit * bars * max(dot(nIn, s), 0.0);
    // Cyan bounce from the coolant below.
    lightc += vec3(0.05, 0.5, 0.42) * exp(-(LEVEL - depth) * 1.3) * 0.5;
    col = albedo * lightc;
    // Bright worn lip where the wall meets the roof.
    col += vec3(0.5, 0.42, 0.34) * smoothstep(0.06, 0.0, depth);
  }
  // Vapour haze thickens with distance down the shaft.
  col = mix(col, vec3(0.01, 0.03, 0.03), 1.0 - exp(-t * 0.12));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const VAPOR_FRAG = /* glsl */ `
uniform float time, intensity;
varying vec2 vUv;
varying float vSeed, vLife;
${NOISE}
void main() {
  vec2 q = vUv - 0.5;
  float n = fbm(vUv * 2.4 + vSeed * 11.0 + vec2(0.0, -time * 0.2));
  float a = (1.0 - smoothstep(0.1, 1.0, length(q) * 2.0 + (n - 0.5) * 0.9));
  a *= smoothstep(0.0, 0.2, vLife) * (1.0 - smoothstep(0.4, 1.0, vLife)) * 0.09 * intensity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(0.45, 0.62, 0.58), vec3(0.72, 0.75, 0.73), vLife), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Heavy bar grating clipped to the shaft opening, plus a raised steel frame ring. */
function grateGeometry(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Bearing bars (tall, thin, 0.3 m pitch) and cross rods every metre, tops at y = 0.07.
  for (let u = -r + 0.2; u < r - 0.1; u += 0.3) {
    const half = Math.sqrt(r * r - u * u);
    parts.push(new THREE.BoxGeometry(0.05, 0.1, half * 2).translate(u, 0.02, 0));
  }
  for (let v = -r + 0.45; v < r - 0.2; v += 0.9) {
    const half = Math.sqrt(r * r - v * v);
    parts.push(new THREE.BoxGeometry(half * 2, 0.05, 0.05).translate(0, 0.045, v));
  }
  // Frame: an L-section ring sitting on the collar's inner edge.
  const frame = [
    [r - 0.12, -0.05],
    [r - 0.12, 0.08],
    [r + 0.08, 0.1],
    [r + 0.14, 0.0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  parts.push(new THREE.LatheGeometry(frame, 96));
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  merged.computeVertexNormals();
  return merged;
}

/** Yellow/black hazard band wrapped around a ring, with worn paint and grime. */
function hazardBand(): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1b1a';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#d9a91f';
  for (let x = -64; x < 256; x += 64) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 32, 64);
    g.lineTo(x + 64, 0);
    g.lineTo(x + 32, 0);
    g.fill();
  }
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '40,36,30' : '90,80,64'},${0.2 + rnd() * 0.5})`;
    g.fillRect(rnd() * 256, rnd() * 64, 1 + rnd() * 6, 1 + rnd() * 3);
  }
  // Steel lip on the inner edge and grime on the outer edge.
  g.fillStyle = '#34383a';
  g.fillRect(0, 0, 256, 10);
  const grime = g.createLinearGradient(0, 40, 0, 64);
  grime.addColorStop(0, 'rgba(20,18,16,0)');
  grime.addColorStop(1, 'rgba(20,18,16,0.6)');
  g.fillStyle = grime;
  g.fillRect(0, 40, 256, 24);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Smoke puffs rise, swell and drift downwind on a loop; lit orange from the fire beneath.
const SMOKE_VERT = /* glsl */ `
uniform float time;
uniform vec2 rise;
attribute vec3 center;
attribute vec2 size;
attribute float seed;
varying vec2 vUv;
varying float vSeed, vLife;
void main() {
  vUv = uv;
  vSeed = seed;
  float life = fract(time * (0.13 + seed * 0.05) + seed * 7.31);
  vLife = life;
  vec3 p = center * (1.0 - life * 0.5);
  p.y = rise.x + life * rise.y;
  p.x += life * life * rise.y * 0.33 + sin(time * 0.7 + seed * 20.0) * 0.3 * life;
  float s = size.x * mix(0.45, 1.8, sqrt(life));
  float a = seed * 6.28 + time * (seed - 0.5) * 0.4;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  mv.xy += mat2(cos(a), sin(a), -sin(a), cos(a)) * (uv - 0.5) * s;
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FRAG = /* glsl */ `
uniform float time, intensity;
varying vec2 vUv;
varying float vSeed, vLife;
${NOISE}
void main() {
  vec2 q = vUv - 0.5;
  float n = fbm(vUv * 2.6 + vSeed * 11.0 + vec2(0.0, -time * 0.15));
  float d = length(q) * 2.0 + (n - 0.5) * 0.7;
  float density = 1.0 - smoothstep(0.15, 1.0, d);
  float alpha = density * smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.4, 1.0, vLife)) * 0.35 * intensity;
  if (alpha < 0.004) discard;
  // Fake volume: warm fire-lit underside, cool sky-lit top; the glow fades as puffs climb.
  float up = clamp(0.5 + q.y * 1.4 + (n - 0.5) * 0.6, 0.0, 1.0);
  vec3 col = mix(vec3(0.05, 0.045, 0.042), vec3(0.2, 0.21, 0.24), up);
  col += vec3(0.8, 0.32, 0.08) * pow(1.0 - vLife, 2.5) * (1.0 - up) * 0.8;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const EMBER_VERT = /* glsl */ `
uniform float time, radius;
attribute float seed;
varying float vLife, vSeed;
void main() {
  float life = fract(seed * 13.7 + time * (0.3 + fract(seed * 7.1) * 0.35));
  vLife = life;
  vSeed = seed;
  vec3 p = position * radius * 0.8;
  p.y = 0.2 + life * 6.0;
  p.x += sin(time * 2.0 + seed * 40.0) * 0.6 * life + life * life * 1.5;
  p.z += cos(time * 1.7 + seed * 23.0) * 0.6 * life;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_PointSize = (1.0 - life * 0.7) * 55.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const EMBER_FRAG = /* glsl */ `
uniform float intensity, time;
varying float vLife, vSeed;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float twinkle = 0.6 + 0.4 * sin(time * 25.0 + vSeed * 90.0);
  float a = (1.0 - smoothstep(0.05, 0.5, d)) * (1.0 - vLife) * intensity * twinkle;
  if (a <= 0.004) discard;
  vec3 col = mix(vec3(5.0, 2.4, 0.7), vec3(2.0, 0.35, 0.05), vLife);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Fire {
  group: THREE.Group;
  intensity: { value: number };
  burn: { value: number };
  x: number;
  z: number;
  radius: number;
}

/** One draw call of billboards spread over an area. */
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

/** Weathered red fuel drum wrap: chipped paint, rust runs, grime and a flammable placard. */
function drumTextures(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } | undefined {
  if (typeof document === 'undefined') return;
  const W = 512,
    H = 256;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return [c, c.getContext('2d')!] as const;
  };
  const [cc, g] = make(),
    [rc, rg] = make();
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  // Colour: red paint with mottled fade. Roughness (green channel): satin paint.
  g.fillStyle = '#8e2a1b';
  g.fillRect(0, 0, W, H);
  rg.fillStyle = 'rgb(0,120,0)';
  rg.fillRect(0, 0, W, H);
  for (let i = 0; i < 500; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      r = 4 + rnd() * 20;
    g.fillStyle = `rgba(${rnd() < 0.5 ? '60,15,10' : '175,70,45'},${0.05 + rnd() * 0.08})`;
    g.beginPath();
    g.arc(x, y, r, 0, 7);
    g.fill();
  }
  // Grime rising from the base and a dusty top.
  const grime = g.createLinearGradient(0, 0, 0, H);
  grime.addColorStop(0, 'rgba(40,30,25,0.35)');
  grime.addColorStop(0.2, 'rgba(40,30,25,0)');
  grime.addColorStop(0.75, 'rgba(30,22,16,0)');
  grime.addColorStop(1, 'rgba(30,22,16,0.7)');
  g.fillStyle = grime;
  g.fillRect(0, 0, W, H);
  // Rust runs from the rolling hoops.
  for (let i = 0; i < 38; i++) {
    const x = rnd() * W,
      y0 = [0, H * 0.33, H * 0.66][i % 3]!,
      len = 15 + rnd() * 60,
      w = 1 + rnd() * 3;
    const run = g.createLinearGradient(0, y0, 0, y0 + len);
    run.addColorStop(0, 'rgba(95,45,20,0.8)');
    run.addColorStop(1, 'rgba(95,45,20,0)');
    g.fillStyle = run;
    g.fillRect(x, y0, w, len);
    rg.fillStyle = 'rgba(0,220,0,0.7)';
    rg.fillRect(x, y0, w, len * 0.6);
  }
  // Edge wear: chips and scuffs cluster on the rims and rolling hoops, exposing dull,
  // dark steel (moderate roughness, so it never mirrors the blue sky as bright dots).
  const wearRows = [0, H / 3, (H * 2) / 3, H];
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W,
      y = wearRows[i % 4]! + (rnd() - 0.5) * 18,
      w = 2 + rnd() * 10,
      h = 1 + rnd() * 3;
    g.fillStyle = 'rgba(70,34,20,0.85)';
    g.fillRect(x - 1, y - 1, w + 2, h + 2);
    const v = 62 + rnd() * 22;
    g.fillStyle = `rgb(${v},${v - 3},${v - 6})`;
    g.fillRect(x, y, w, h);
    rg.fillStyle = 'rgb(0,150,0)';
    rg.fillRect(x, y, w, h);
  }
  // Fine horizontal scuffs from being dragged and rolled.
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(${rnd() < 0.5 ? '40,20,14' : '150,90,70'},${0.15 + rnd() * 0.25})`;
    g.lineWidth = 0.6 + rnd();
    const x = rnd() * W,
      y = rnd() * H;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 8 + rnd() * 40, y + (rnd() - 0.5) * 3);
    g.stroke();
  }
  // Two flammable placards (the wrap goes all the way round).
  for (const cx of [W * 0.25, W * 0.75]) {
    g.save();
    g.translate(cx, H * 0.5);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#d8cfb8';
    g.fillRect(-34, -34, 68, 68);
    g.fillStyle = '#b8301c';
    g.fillRect(-29, -29, 58, 58);
    g.rotate(-Math.PI / 4);
    g.fillStyle = '#d8cfb8';
    g.beginPath();
    g.moveTo(0, -24);
    g.bezierCurveTo(12, -8, 14, 4, 0, 12);
    g.bezierCurveTo(-14, 4, -10, -8, 0, -24);
    g.fill();
    g.fillRect(-14, 16, 28, 3);
    g.restore();
    // Wear scratched through the placard.
    for (let i = 0; i < 12; i++) {
      g.fillStyle = 'rgba(70,25,15,0.6)';
      g.fillRect(cx - 40 + rnd() * 80, H * 0.5 - 40 + rnd() * 80, 1 + rnd() * 5, 1 + rnd() * 2);
    }
  }
  const map = new THREE.CanvasTexture(cc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return { map, rough: new THREE.CanvasTexture(rc) };
}

export class ArenaHazards {
  readonly group = new THREE.Group();
  private tanks: THREE.Group[] = [];
  private fires: Fire[] = [];
  private time = { value: 0 };
  // Shared by whichever slicks burn brightest; created once so ignition never recompiles shaders.
  private lights = Array.from(
    { length: FIRE_LIGHTS },
    () => new THREE.PointLight('#ff7a2a', 0, 14, 2),
  );
  constructor() {
    const tex = drumTextures();
    const paint = new THREE.MeshStandardMaterial({
      color: tex ? '#ffffff' : '#8e2a1b',
      map: tex?.map,
      roughnessMap: tex?.rough,
      metalness: 0.35,
      roughness: 1,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: '#6e2419',
      metalness: 0.5,
      roughness: 0.55,
    });
    const lid = new THREE.MeshStandardMaterial({
      color: '#4a1a12',
      metalness: 0.4,
      roughness: 0.7,
    });
    const cap = new THREE.MeshStandardMaterial({
      color: '#b5b1a6',
      metalness: 0.9,
      roughness: 0.35,
    });
    const body = new THREE.CylinderGeometry(0.88, 0.88, 1.96, 48, 1, true);
    // Swaged rolling hoops and rolled chimes: crisp ribs that catch highlights.
    const hoop = new THREE.TorusGeometry(0.885, 0.05, 8, 48).rotateX(Math.PI / 2);
    const top = new THREE.CylinderGeometry(0.86, 0.86, 0.04, 32);
    const chime = new THREE.TorusGeometry(0.87, 0.065, 8, 48).rotateX(Math.PI / 2);
    const bung = new THREE.CylinderGeometry(0.1, 0.1, 0.06, 12);
    for (const tank of makeHazards().tanks) {
      const g = new THREE.Group();
      g.position.set(tank.x, 0, tank.z);
      g.rotation.y = tank.x * 1.7 + tank.z;
      const parts: [THREE.BufferGeometry, THREE.Material, number, number?][] = [
        [body, paint, 1],
        [hoop, steel, 0.66],
        [hoop, steel, 1.33],
        [chime, steel, 1.98],
        [chime, steel, 0.03],
        [top, lid, 1.96],
        [bung, cap, 2.0, 0.45],
        [bung, cap, 2.0, -0.5],
      ];
      for (const [geometry, mat, y, x = 0] of parts) {
        const m = new THREE.Mesh(geometry, mat);
        m.position.set(x, y, x * 0.3);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      this.tanks.push(g);
      this.group.add(g);
    }
    // Coolant sumps: pit opening, hazard-striped steel collar and rising vapour.
    const band = hazardBand();
    const collar = new THREE.MeshStandardMaterial({
      color: band ? '#ffffff' : '#d9a91f',
      map: band,
      metalness: 0.55,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const grate = new THREE.MeshStandardMaterial({
      color: '#2c2e2e',
      metalness: 0.7,
      roughness: 0.62,
    });
    for (const pool of COOLING_POOLS) {
      const r = pool.radius;
      const ring = new THREE.RingGeometry(r, r + 0.45, 96, 1);
      // Polar UVs: u runs around the ring (16 chevron repeats), v runs outward.
      const pos = ring.attributes.position!,
        uv = ring.attributes.uv!;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i),
          y = pos.getY(i);
        uv.setXY(
          i,
          ((Math.atan2(y, x) / (Math.PI * 2) + 1) % 1) * 16,
          (Math.hypot(x, y) - r) / 0.45,
        );
      }
      const rim = new THREE.Mesh(ring, collar);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(pool.x, 0.012, pool.z);
      rim.receiveShadow = true;
      const pit = new THREE.Mesh(
        new THREE.CircleGeometry(r, 64),
        new THREE.ShaderMaterial({
          vertexShader: SUMP_VERT,
          fragmentShader: SUMP_FRAG,
          uniforms: {
            time: this.time,
            radius: { value: r },
            center: { value: new THREE.Vector3(pool.x, 0, pool.z) },
            sun: { value: SUN_DIRECTION },
          },
        }),
      );
      pit.rotation.x = -Math.PI / 2;
      pit.position.set(pool.x, 0.004, pool.z);
      const bars = new THREE.Mesh(grateGeometry(r), grate);
      bars.position.set(pool.x, 0, pool.z);
      bars.castShadow = bars.receiveShadow = true;
      this.group.add(bars);
      const vapor = new THREE.Mesh(
        billboards(10, r * 0.8, (_i, a, rr) => [Math.sin(a) * rr, 0, Math.cos(a) * rr, 2.2, 0]),
        new THREE.ShaderMaterial({
          vertexShader: SMOKE_VERT,
          fragmentShader: VAPOR_FRAG,
          transparent: true,
          depthWrite: false,
          uniforms: {
            time: this.time,
            intensity: { value: 1 },
            rise: { value: new THREE.Vector2(0.2, 2.4) },
          },
        }),
      );
      vapor.position.set(pool.x, 0, pool.z);
      vapor.frustumCulled = false;
      vapor.renderOrder = 1;
      this.group.add(pit, rim, vapor);
    }
    for (const area of OIL_SLICKS) {
      const burn = { value: 0 };
      const surface = new THREE.Mesh(
        new THREE.CircleGeometry(area.radius * 1.4, 64),
        oilMaterial(area.radius * 1.1, area.x * 0.37 + area.z, this.time, burn),
      );
      surface.receiveShadow = true;
      surface.rotation.x = -Math.PI / 2;
      surface.position.set(area.x, 0.035, area.z);
      this.group.add(surface);
      const intensity = { value: 0 };
      const fire = new THREE.Group();
      fire.position.set(area.x, 0, area.z);
      const shader = (vertexShader: string, fragmentShader: string, blending: THREE.Blending) =>
        new THREE.ShaderMaterial({
          vertexShader,
          fragmentShader,
          transparent: true,
          depthWrite: false,
          blending,
          uniforms: {
            time: this.time,
            intensity,
            radius: { value: area.radius },
            rise: { value: new THREE.Vector2(1, 7.5) },
          },
        });
      const smoke = new THREE.Mesh(
        billboards(26, area.radius * 0.7, (_i, a, r) => [
          Math.sin(a) * r,
          0,
          Math.cos(a) * r,
          4.2,
          0,
        ]),
        shader(SMOKE_VERT, SMOKE_FRAG, THREE.NormalBlending),
      );
      // One raymarched fire volume per slick: soft, turbulent, no card edges.
      const flames = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.ShaderMaterial({
          vertexShader: FIRE_VOLUME_VERT,
          fragmentShader: FIRE_VOLUME_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          uniforms: {
            time: this.time,
            intensity,
            seed: { value: area.x * 0.7 + area.z * 0.3 },
            height: { value: 4.4 },
          },
        }),
      );
      flames.scale.set(area.radius * 0.95, 2.2, area.radius * 0.95);
      flames.position.y = 2.2;
      const emberSeeds = Array.from({ length: 64 }, (_, i) => i / 64);
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
        shader(EMBER_VERT, EMBER_FRAG, THREE.AdditiveBlending),
      );
      // Flames draw over the smoke column behind them.
      smoke.renderOrder = 1;
      flames.renderOrder = 2;
      embers.renderOrder = 3;
      for (const m of [smoke, embers]) m.frustumCulled = false;
      fire.add(smoke, flames, embers);
      this.fires.push({ group: fire, intensity, burn, x: area.x, z: area.z, radius: area.radius });
      this.group.add(fire);
    }
    this.group.add(...this.lights);
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
      fire.group.visible = fire.intensity.value > 0.01;
    });
    // Brightest fires get the light pool; the rest rely on their emissive glow.
    const lit = [...this.fires].sort((a, b) => b.intensity.value - a.intensity.value);
    this.lights.forEach((light, i) => {
      const fire = lit[i];
      const k = fire && fire.intensity.value > 0.01 ? fire.intensity.value : 0;
      light.intensity = 0;
      if (!fire || !k) return;
      const s = i * 3.1 + fire.x;
      // Layered sines approximate turbulent flicker; the light also wanders so shadows breathe.
      const flicker =
        0.7 +
        0.15 * Math.sin(time * 11 + s) +
        0.1 * Math.sin(time * 23.7 + s * 2) +
        0.05 * Math.sin(time * 41 + s);
      light.intensity = k * 32 * flicker;
      light.distance = fire.radius * 5;
      light.color.setRGB(1, 0.42 + 0.08 * flicker, 0.12);
      light.position.set(
        fire.x + Math.sin(time * 3.1 + s) * 0.25,
        0.55 + 0.12 * Math.sin(time * 5.3 + s),
        fire.z + Math.cos(time * 2.7 + s) * 0.25,
      );
    });
  }
}
