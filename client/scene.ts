import { City } from './city.js';
import { Finale, finalElimination } from './finale.js';
import { ArenaHazards } from './hazards.js';
import { driveTerrain } from '../shared/hazards.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { glowPool, hazard, contactShadow, DECAL_NUMBERS, decals, tread } from './robot-textures.js';
import { WeaponEffects } from './weapon-effects.js';
import { WowEffects } from './wow-effects.js';
import { createPost, createSky, installHeightFog, type Post, SUN_DIRECTION } from './post.js';
import { pbr } from './assets.js';
import {
  ARENA_HALF,
  chassisScale,
  EMPTY_INPUT,
  TICK_SECONDS,
  type Chassis,
  WEAPONS,
  type FrontWeapon,
  type TopWeapon,
  type RoomState,
  type Input,
  type PlayerState,
} from '../shared/game.js';

const COMBAT_PHASES: readonly string[] = ['loading', 'countdown', 'combat', 'results'];

interface Robot {
  chassis: Chassis;
  group: THREE.Group;
  suspension: THREE.Group;
  wheels: THREE.Mesh[];
  wheelRadius: number;
  saw?: THREE.Group;
  hammer?: THREE.Group;
  drill?: THREE.Group;
  sweeper?: THREE.Group;
  flipper?: THREE.Group;
  hook?: THREE.Group;
  barrel: THREE.Group;
  muzzle: THREE.Object3D;
  burn: THREE.Group;
  /** Flamethrower stream on; the stream itself is pooled particles. */
  firing: boolean;
  front: FrontWeapon;
  top: TopWeapon;
  speed: number;
  impact: number;
  impactAge: number;
  paint: THREE.MeshStandardMaterial;
  meleeHold: number;
  meleeConnected: boolean;
  lastFrontCooldown: number;
  contactCooldown: number;
  /** Throttles flame-damage scorch effects separately from grinding contact. */
  scorchCooldown: number;
  /** Remaining time of the short slam into the contact pose, and the pose it started from. */
  slam: number;
  slamFrom: number;
  flash: number;
  kick: THREE.Vector2;
  trailClock: number;
  /** Barrel heat from sustained fire, 0..1; drives the barrel glow and smoke wisps. */
  heat: number;
  /** Heat-glowing barrel material; the railgun's energy coils. */
  hot: THREE.MeshStandardMaterial;
  /** Spinner spin-up, 0..1. */
  spin: number;
  /** Motion-blur shells on spinning attachments, faded in with spin. */
  blur: THREE.MeshBasicMaterial[];
  /** Turret charge lines: brighten as the top weapon's cooldown comes back to ready. */
  charge: THREE.MeshStandardMaterial;
}
const backOut = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const FOV = 48;
const SLAM = 0.04;
/** Barrel heat added per shot; the flamethrower reports its heat from the server. */
const SHOT_HEAT: Record<TopWeapon, number> = {
  cannon: 0.3,
  scattergun: 0.26,
  railgun: 0.45,
  flamethrower: 0,
};
/** A swinging attachment's animated channel and its pose at contact. */
function attachmentPose(
  r: Robot,
): [THREE.Euler | THREE.Vector3, 'x' | 'y' | 'z', number] | undefined {
  if (r.hammer) return [r.hammer.rotation, 'x', 0.45];
  if (r.sweeper) return [r.sweeper.rotation, 'y', 0.85];
  if (r.flipper) return [r.flipper.rotation, 'x', -1.12];
  if (r.hook) return [r.hook.position, 'z', 2.17];
}
/**
 * Object-space wear shared by robot metals and paint. `wear` is a per-vertex bevel mask baked by
 * box() (1 on rounded edges, 0 on flat faces); value noise in object space breaks it into chips,
 * so nothing stretches on long faces and there is no directional grain.
 */
const WEAR_GLSL = `
varying float vWear;
varying vec3 vObj;
float wearHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float wearNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(wearHash(i), wearHash(i + vec3(1, 0, 0)), f.x),
        mix(wearHash(i + vec3(0, 1, 0)), wearHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(wearHash(i + vec3(0, 0, 1)), wearHash(i + vec3(1, 0, 1)), f.x),
        mix(wearHash(i + vec3(0, 1, 1)), wearHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}`;
/**
 * Scanned CC0 detail (client/assets.ts), sampled triplanar in object space so boxes, extrusions and
 * merged parts never stretch. `paint` surfaces use the painted-plate scan as luminance/roughness/normal
 * detail under the material colour; `steel` surfaces use the raw-steel scan. Chips always reveal the
 * steel scan (bare metal with rust pits) and are fringed with rust.
 */
const TRI_GLSL = `
uniform sampler2D tBaseDiff, tBaseArm, tBaseNor, tSteelDiff, tSteelArm;
varying vec3 vNM0, vNM1, vNM2;
vec4 tri(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
// Whiteout-blended triplanar normal map (object space), after Ben Golus.
vec3 triNormal(sampler2D t, vec3 p, vec3 n, vec3 w, float s) {
  vec3 a = texture2D(t, p.zy).xyz * 2.0 - 1.0, b = texture2D(t, p.xz).xyz * 2.0 - 1.0,
    c = texture2D(t, p.xy).xyz * 2.0 - 1.0;
  a.xy *= s; b.xy *= s; c.xy *= s;
  a = vec3(a.xy + n.zy, abs(a.z) * n.x);
  b = vec3(b.xy + n.xz, abs(b.z) * n.y);
  c = vec3(c.xy + n.xy, abs(c.z) * n.z);
  return normalize(a.zyx * w.x + b.xzy * w.y + c.xyz * w.z);
}`;
type WearBase = 'paint' | 'steel';
/** Chipped edges reveal bare steel (tinted by `bare`); `amount` scales how much gets chipped. */
function worn(
  material: THREE.MeshStandardMaterial,
  key: string,
  bare: string,
  amount: number,
  // GLSL run after direct lighting. The chase camera looks toward the low sun, so the sun's
  // mirror glint on glossy parts is cut to keep them from blooming white.
  damp = 'reflectedLight.directSpecular *= 0.4;',
  // Metallic flake sparkle in the base coat (paint only).
  flake = false,
  base: WearBase = 'paint',
  // Rust patches on the surface itself (steel base only), 0..1.
  rust = 0,
): void {
  const set = base === 'paint' ? 'paint' : 'steel';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tBaseDiff: { value: pbr(set, 'diff') },
      tBaseArm: { value: pbr(set, 'arm') },
      tBaseNor: { value: pbr(set, 'nor') },
      tSteelDiff: { value: pbr('steel', 'diff') },
      tSteelArm: { value: pbr('steel', 'arm') },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float wear;\nvarying float vWear;\nvarying vec3 vObj;\nvarying vec3 vObjN;\nvarying vec3 vNM0, vNM1, vNM2;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWear = wear;\nvObj = position;\nvObjN = normal;\nvNM0 = normalMatrix[0]; vNM1 = normalMatrix[1]; vNM2 = normalMatrix[2];',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${WEAR_GLSL}\n${TRI_GLSL}\nvarying vec3 vObjN;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        vec3 objN = normalize(vObjN);
        vec3 triW = pow(abs(objN), vec3(4.0));
        triW /= dot(triW, vec3(1.0));
        // ~1.4 units per tile on the base scan; the chip scan tiles tighter and is offset.
        vec3 triP = vObj * 0.7 + 0.37;
        vec3 chipP = vObj * 1.1 + 0.71;
        vec3 bDiff = tri(tBaseDiff, triP, triW).rgb;
        vec3 bArm = tri(tBaseArm, triP, triW).rgb;
        vec3 sDiff = tri(tSteelDiff, chipP, triW).rgb;
        vec3 sArm = tri(tSteelArm, chipP, triW).rgb;
        float bLum = dot(bDiff, vec3(0.2126, 0.7152, 0.0722));
        ${
          base === 'paint'
            ? `// Scanned plate: mottled coat, rubbed patches, seams; roughness from the scan.
        diffuseColor.rgb *= clamp(bLum / 0.043, 0.45, 1.8) * mix(1.0, bArm.r, 0.8);
        // Sun-faded and resprayed panels: broad tonal drift so big faces are never one flat colour.
        diffuseColor.rgb *= 0.82 + 0.36 * wearNoise(vObj * 1.3 + 3.0);
        roughnessFactor *= clamp(bArm.g / 0.285, 0.55, 1.7);`
            : `// Brushed/scratched grain from the scan's roughness; albedo only lightly modulated.
        diffuseColor.rgb *= mix(0.8, 1.15, bArm.g) * mix(1.0, clamp(bLum / 0.072, 0.7, 1.3), 0.3);
        roughnessFactor = mix(roughnessFactor, roughnessFactor * bArm.g / 0.7, 0.8);
        // Patchy corrosion where the scan is rusty and a low-frequency blotch agrees.
        float rustSpot = (1.0 - bArm.b) * smoothstep(0.62, 0.82, wearNoise(vObj * 2.3)) * ${rust.toFixed(2)};
        diffuseColor.rgb = mix(diffuseColor.rgb, bDiff * 1.3, rustSpot);
        metalnessFactor = mix(metalnessFactor, 0.1, rustSpot);
        roughnessFactor = mix(roughnessFactor, 0.85, rustSpot);`
        }
        // Chips: bevel mask broken up by noise and the steel scan's bare-metal pattern.
        float wearN = wearNoise(vObj * 11.0) * 0.35 + wearNoise(vObj * 29.0) * 0.15 + sArm.b * 0.7;
        float wearV = vWear * (0.3 + wearN) * ${amount.toFixed(2)};
        float chip = smoothstep(0.8, 0.84, wearV);
        // Scuffed-through patches on flat panels too (knocks, scrapes), sparse and clustered.
        chip = max(chip, smoothstep(0.8, 0.92, sArm.b) * smoothstep(0.6, 0.75, wearNoise(vObj * 3.5 + 7.0)) * min(1.0, ${amount.toFixed(2)}));
        float fringe = smoothstep(0.6, 0.84, wearV) * (1.0 - chip);
        // Rubbed-thin paint lightens along every bevel crest (edge highlight), rust creeps under it.
        diffuseColor.rgb *= 1.0 + 0.45 * smoothstep(0.5, 1.0, vWear) * (1.0 - chip) * (1.0 - fringe);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.055, 0.025), fringe * 0.55);
        roughnessFactor *= 0.85 + 0.3 * wearNoise(vObj * 3.0);
        // Road grime: low parts are dirtier and duller; blotchy so it does not read as a gradient.
        float grime = smoothstep(0.75, 0.2, vObj.y) * (0.5 + 0.5 * wearNoise(vObj * 2.0)) * (1.0 - chip);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.075, 0.06), grime * 0.45);
        roughnessFactor = mix(roughnessFactor, 0.9, grime * 0.6);
        roughnessFactor = mix(roughnessFactor, 0.8, fringe * 0.5);
        float bareMetal = smoothstep(0.08, 0.4, sArm.b);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(sDiff * 1.4, ${bare} * (0.75 + 2.5 * dot(sDiff, vec3(0.33))), bareMetal), chip);
        metalnessFactor = mix(metalnessFactor, mix(0.2, 1.0, bareMetal), chip);
        roughnessFactor = mix(roughnessFactor, mix(0.8, 0.35, bareMetal), chip);
        // Dust settles on up-facing panels (rougher, paler); vertical sides stay glossier.
        float up = objN.y;
        float dust = smoothstep(0.6, 0.95, up) * (0.35 + 0.65 * wearNoise(vObj * 6.0)) * (1.0 - chip);
        roughnessFactor = mix(roughnessFactor * mix(0.7, 1.0, abs(up)), 0.85, dust * 0.55);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.5, 0.43), dust * 0.1);
        roughnessFactor = clamp(roughnessFactor, 0.06, 1.0);
        ${
          flake
            ? `// Flake cells fade out once they shrink below ~1 px, so at game distance the
        // coat reads as a smooth sheen instead of aliasing into glitter.
        vec3 flakeUv = vObj * 160.0;
        vec3 flakeW = fwidth(flakeUv);
        float flakeFade = 1.0 - smoothstep(0.25, 0.7, max(flakeW.x, max(flakeW.y, flakeW.z)));
        float flakeN = wearHash(floor(flakeUv));
        roughnessFactor *= 1.0 - step(0.9, flakeN) * 0.3 * flakeFade * (1.0 - chip);`
            : ''
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mat3(vNM0, vNM1, vNM2) * triNormal(tBaseNor, triP, objN, triW, ${base === 'paint' ? '1.2' : '1.0'}));
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        ${damp}`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          // Coat is patchy: dull where the scan is rough, dusty or grimy, gone where chipped.
          material.clearcoat *= (1.0 - chip) * (1.0 - grime * 0.8) * mix(0.35, 1.0, smoothstep(0.45, 0.15, bArm.g));
          material.clearcoatRoughness = min(1.0, material.clearcoatRoughness + bArm.g * 0.3 + dust * 0.3);
        #endif`,
      );
  };
  material.customProgramCacheKey = () => key;
}
const steel = new THREE.MeshStandardMaterial({ color: '#7a8286', roughness: 0.46, metalness: 0.9 });
const dark = new THREE.MeshStandardMaterial({ color: '#262c2f', roughness: 0.5, metalness: 0.7 });
const silver = new THREE.MeshStandardMaterial({ color: '#c4cacc', roughness: 0.32, metalness: 1 });
/** Dark painted gunmetal for lower hulls and armour: the second tone against the player colour. */
const gunmetal = new THREE.MeshStandardMaterial({
  color: '#343a40',
  roughness: 0.4,
  metalness: 0.55,
});
worn(gunmetal, 'worn-gunmetal', 'vec3(0.6, 0.6, 0.62)', 1);
worn(steel, 'worn-steel', 'vec3(0.66, 0.66, 0.68)', 1, undefined, false, 'steel', 0.45);
worn(dark, 'worn-dark', 'vec3(0.55, 0.55, 0.57)', 0.9);
worn(silver, 'worn-silver', 'vec3(0.8, 0.8, 0.82)', 0, undefined, false, 'steel');
const rubber = new THREE.MeshStandardMaterial({
  color: '#1a1c1c',
  roughness: 1,
  bumpMap: tread,
  bumpScale: 3,
  // Scanned rubber grain breaks the uniform matte (G = roughness); tiled finer than the tread.
  roughnessMap: pbr('rubber', 'arm', 4, 2),
});
const glass = new THREE.MeshPhysicalMaterial({
  color: '#0c1418',
  roughness: 0.05,
  metalness: 0.2,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
});
const stripe = new THREE.MeshStandardMaterial({
  color: '#d4cebd',
  roughness: 0.55,
  metalness: 0.1,
});
worn(stripe, 'worn-stripe', 'vec3(0.6, 0.6, 0.62)', 0);
const hazardPaint = new THREE.MeshStandardMaterial({
  map: hazard,
  roughness: 0.5,
  metalness: 0.3,
});
/** Sprayed stencils; alpha-tested so they need no sorting. */
const decal = new THREE.MeshStandardMaterial({
  map: decals,
  color: '#ebe6d8',
  roughness: 0.7,
  alphaTest: 0.5,
  polygonOffset: true,
  polygonOffsetFactor: -2,
});
const tail = new THREE.MeshStandardMaterial({
  color: '#ff2a18',
  emissive: '#ff1a0b',
  emissiveIntensity: 3,
});
/** Amber status LEDs and light bars. */
const amber = new THREE.MeshStandardMaterial({
  color: '#1a0f04',
  emissive: '#ffa21f',
  emissiveIntensity: 1.6,
});
/** Heat glow deep in exhaust tips. */
const ember = new THREE.MeshStandardMaterial({
  color: '#120602',
  emissive: '#ff4a12',
  emissiveIntensity: 1.8,
});
/** Shared by every robot; removeRobot must not dispose these. */
const robotShared: THREE.Material[] = [
  amber,
  ember,
  gunmetal,
  steel,
  dark,
  silver,
  rubber,
  glass,
  stripe,
  hazardPaint,
  decal,
  tail,
];
const ROUND_MIN = 0.045;
function box(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
): THREE.Mesh {
  // Chunky parts get generous chamfers so every edge catches a highlight; thin plates stay crisp.
  const min = Math.min(w, h, d);
  let geometry: THREE.BufferGeometry;
  if (min >= ROUND_MIN && Math.max(w, h, d) <= 4) {
    geometry = new RoundedBoxGeometry(w, h, d, 3, Math.min(0.09, min * 0.3));
    // Bevel mask for worn(): 0 where the normal is axis-aligned (flat faces), 1 on the rounds.
    const n = geometry.attributes.normal!,
      wear = new Float32Array(n.count);
    for (let i = 0; i < n.count; i++)
      wear[i] = Math.min(
        1,
        (1 - Math.max(Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i)))) * 4,
      );
    geometry.setAttribute('wear', new THREE.BufferAttribute(wear, 1));
  } else geometry = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function cylinder(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  r: number,
  len: number,
  material: THREE.Material,
  axis: 'x' | 'z' | 'y' = 'y',
  segments = 16,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segments), material);
  m.position.set(x, y, z);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  parent.add(m);
  return m;
}
/**
 * Side-profile body panel: `profile` is [z, y] points (forward, up) extruded across `width` on x
 * with a rounded bevel, so hulls read as sculpted shells rather than stacked cuboids.
 */
function sculpt(
  parent: THREE.Object3D,
  profile: number[][],
  width: number,
  material: THREE.Material,
  x = 0,
  bevel = 0.04,
): THREE.Mesh {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(0.01, width - 2 * bevel);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 16,
  });
  // Shape x becomes forward z; the extrusion spans x, centred on `x`.
  geometry.rotateY(-Math.PI / 2).translate(x + depth / 2, 0, 0);
  // Bevel mask for worn(): the rounded side edges have a partial x component in their normal.
  const n = geometry.attributes.normal!,
    wear = new Float32Array(n.count);
  for (let i = 0; i < n.count; i++)
    wear[i] = Math.min(1, (1 - Math.abs(2 * Math.abs(n.getX(i)) - 1)) * 2);
  geometry.setAttribute('wear', new THREE.BufferAttribute(wear, 1));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
/**
 * Turned part: `profile` is [radius, along] points revolved around the y axis, or around z when
 * `axis` is 'z' (barrels, tanks), placed at (x, y) on that axis.
 */
function turned(
  parent: THREE.Object3D,
  profile: number[][],
  material: THREE.Material,
  axis: 'y' | 'z',
  x = 0,
  y = 0,
): THREE.Mesh {
  const geometry = new THREE.LatheGeometry(
    profile.map(([r, t]) => new THREE.Vector2(r, t)),
    24,
  );
  if (axis === 'z') geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, 0);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
/** Chamfered wheel-arch flare over a wheel centred at (zc, yc), between radii r0 and r1. */
function arch(
  parent: THREE.Object3D,
  x: number,
  zc: number,
  yc: number,
  r0: number,
  r1: number,
  width: number,
  material: THREE.Material,
): THREE.Mesh {
  const points: number[][] = [];
  for (let i = 0; i <= 12; i++) {
    const a = 0.22 + ((Math.PI - 0.44) * i) / 12;
    points.push([zc + Math.cos(a) * r1, yc + Math.sin(a) * r1]);
  }
  for (let i = 12; i >= 0; i--) {
    const a = 0.22 + ((Math.PI - 0.44) * i) / 12;
    points.push([zc + Math.cos(a) * r0, yc + Math.sin(a) * r0]);
  }
  return sculpt(parent, points, width, material, x, 0.025);
}
type RimStyle = 'utility' | 'dish' | 'beadlock' | 'military';
/** Tyre with a rounded sidewall, a per-chassis rim, and tread lugs when knobby; all spin together. */
function wheel(
  parent: THREE.Object3D,
  x: number,
  z: number,
  r: number,
  w: number,
  knobby: boolean,
  style: RimStyle,
): THREE.Mesh {
  // Tyre profile turned on a lathe around local y (the axle): bead, rounded shoulders, tread.
  const c = Math.min(w * 0.3, r * 0.2),
    h = w / 2,
    profile = [new THREE.Vector2(r * 0.6, -h)];
  for (let i = 0; i <= 4; i++) {
    const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
    profile.push(new THREE.Vector2(r - c + Math.cos(a) * c, -h + c + Math.sin(a) * c));
  }
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    profile.push(new THREE.Vector2(r - c + Math.cos(a) * c, h - c + Math.sin(a) * c));
  }
  profile.push(new THREE.Vector2(r * 0.6, h));
  const body = new THREE.LatheGeometry(profile, 36);
  // Tread texture: chevrons (v 0.14..1) across the crown, sidewall band (v 0..0.12) elsewhere.
  const pos = body.attributes.position!,
    uv = body.attributes.uv!;
  for (let i = 0; i < pos.count; i++) {
    const radius = Math.hypot(pos.getX(i), pos.getZ(i));
    uv.setY(i, radius > r - c * 0.5 ? 0.14 + (pos.getY(i) / w + 0.5) * 0.86 : (radius / r) * 0.12);
  }
  const tire: THREE.Mesh = new THREE.Mesh(body, rubber);
  tire.position.set(x, r, z);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  parent.add(tire);
  const face = -Math.sign(x) * (w / 2 + 0.01); // Tire local +y points to world -x.
  const rim: THREE.BufferGeometry[] = [],
    trim: THREE.BufferGeometry[] = [];
  const ring = (radius: number, tube: number, at: number) =>
    new THREE.TorusGeometry(radius, tube, 6, 28).rotateX(Math.PI / 2).translate(0, at, 0);
  const spokes = (
    n: number,
    width: number,
    depth: number,
    from: number,
    to: number,
    at: number,
  ) => {
    for (let i = 0; i < n; i++)
      trim.push(
        new THREE.BoxGeometry(r * width, depth, r * (to - from))
          .translate(0, at, r * (from + to) * 0.5)
          .rotateY((i * Math.PI * 2) / n),
      );
  };
  const studs = (n: number, radius: number, size: number, target = trim) => {
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n;
      target.push(
        new THREE.CylinderGeometry(size, size, w + 0.1, 6).translate(
          Math.sin(a) * radius,
          0,
          Math.cos(a) * radius,
        ),
      );
    }
  };
  let rimMaterial: THREE.Material = steel,
    trimMaterial: THREE.Material = silver;
  if (style === 'dish') {
    // Deep dish: polished lip well proud of a dark recessed face with ten thin spokes.
    rimMaterial = dark;
    rim.push(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 0.7, 28));
    trim.push(
      ring(r * 0.63, r * 0.06, face * 0.98),
      new THREE.CylinderGeometry(r * 0.14, r * 0.16, w + 0.06, 12),
    );
    spokes(10, 0.06, 0.03, 0.12, 0.6, face * 0.72);
  } else if (style === 'beadlock') {
    // Off-road beadlock: bolted outer ring over an eight-spoke steel wheel.
    rim.push(
      new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 0.9, 28),
      ring(r * 0.6, r * 0.075, face * 0.98),
    );
    trim.push(new THREE.CylinderGeometry(r * 0.2, r * 0.22, w + 0.1, 12));
    spokes(8, 0.1, 0.05, 0.18, 0.56, face * 0.95);
    studs(14, r * 0.6, 0.018);
  } else if (style === 'military') {
    // Pressed-steel military wheel: flat disc, raised hub, lug nuts and stamped ribs.
    rimMaterial = dark;
    rim.push(
      new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 0.94, 28),
      ring(r * 0.62, r * 0.045, face * 0.98),
      new THREE.CylinderGeometry(r * 0.3, r * 0.34, w + 0.08, 16),
    );
    trimMaterial = steel;
    trim.push(new THREE.CylinderGeometry(r * 0.12, r * 0.12, w + 0.14, 8));
    studs(8, r * 0.22, 0.02);
    spokes(6, 0.08, 0.04, 0.36, 0.58, face * 0.95);
  } else {
    // Utility: six-spoke steel wheel with a bolt circle.
    rim.push(
      new THREE.CylinderGeometry(r * 0.64, r * 0.64, w * 0.9, 24),
      ring(r * 0.62, r * 0.05, face * 0.98),
    );
    trim.push(new THREE.CylinderGeometry(r * 0.18, r * 0.2, w + 0.1, 12));
    spokes(6, 0.12, 0.04, 0.12, 0.6, face);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI * 2) / 6 + 0.52;
      trim.push(
        new THREE.CylinderGeometry(0.022, 0.022, w + 0.1, 6).translate(
          Math.sin(a) * r * 0.26,
          0,
          Math.cos(a) * r * 0.26,
        ),
      );
    }
  }
  const lugs: THREE.BufferGeometry[] = [];
  if (knobby)
    for (let i = 0; i < 16; i++)
      for (const side of [-1, 1])
        lugs.push(
          new RoundedBoxGeometry(0.15, w * 0.4, 0.1, 1, 0.025)
            .translate(side * 0.03, side * w * 0.22, r - 0.01)
            .rotateY(((i + (side > 0 ? 0.5 : 0)) * Math.PI) / 8),
        );
  if (lugs.length) {
    // Lugs join the tire itself: one rubber draw call per wheel.
    const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
    const merged = mergeGeometries([flat(tire.geometry), ...lugs.map(flat)]);
    tire.geometry.dispose();
    tire.geometry = merged;
  }
  for (const [geometries, material] of [
    [rim, rimMaterial],
    [trim, trimMaterial],
  ] as const) {
    tire.add(new THREE.Mesh(mergeGeometries(geometries), material));
    for (const g of geometries) g.dispose();
  }
  return tire;
}
/** One draw call for many static [x, y, z, w, h, d] boxes that never cast visible shadows. */
function instancedBoxes(parent: THREE.Object3D, material: THREE.Material, boxes: number[][]): void {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, boxes.length);
  const matrix = new THREE.Matrix4();
  boxes.forEach(([x, y, z, w, h, d], i) =>
    mesh.setMatrixAt(i, matrix.makeScale(w!, h!, d!).setPosition(x!, y!, z!)),
  );
  mesh.receiveShadow = true;
  parent.add(mesh);
}
/** Bake a group's static mesh children into one mesh per material to cut draw calls. */
function mergeStatic(parent: THREE.Object3D, keep: THREE.Object3D[] = []): void {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...parent.children]) {
    if (!(child instanceof THREE.Mesh) || keep.includes(child)) continue;
    child.updateMatrix();
    const geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    // Every merged part needs the bevel-wear attribute; non-box parts are unworn.
    if (!geometry.attributes.wear)
      geometry.setAttribute(
        'wear',
        new THREE.BufferAttribute(new Float32Array(geometry.attributes.position!.count), 1),
      );
    geometry.applyMatrix4(child.matrix);
    child.geometry.dispose();
    parent.remove(child);
    const material = child.material as THREE.Material;
    byMaterial.set(material, [...(byMaterial.get(material) ?? []), geometry]);
  }
  for (const [material, geometries] of byMaterial) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    for (const g of geometries) g.dispose();
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
  }
}
function robot(
  front: FrontWeapon,
  top: TopWeapon,
  color: string,
  chassis: Chassis = 'mule',
): Robot {
  const group = new THREE.Group(),
    suspension = new THREE.Group(),
    runningGear = new THREE.Group(),
    // Clean paint under a satin clearcoat; worn() chips the bevels to bare steel.
    paint = new THREE.MeshPhysicalMaterial({
      color,
      // Glossy clearcoat so top faces mirror the dusk sky; the low sun's direct glint is
      // damped in worn() so the chase camera (sun ahead) does not bloom the robot white.
      metalness: 0.3,
      roughness: 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      // Hit flash: a tinted shimmer in the robot's own colour, kept below bloom white-out.
      emissive: new THREE.Color(color).lerp(new THREE.Color('#fff0bb'), 0.35),
      emissiveIntensity: 0,
    }),
    lamp = new THREE.MeshStandardMaterial({
      color: '#fff4d6',
      emissive: '#ffd98a',
      emissiveIntensity: 1.5,
    }),
    charge = new THREE.MeshStandardMaterial({
      color: '#000000',
      emissive: color,
      emissiveIntensity: 1,
    }),
    // Player-coloured light strips and underglow; bright enough to bloom.
    glow = new THREE.MeshStandardMaterial({
      color: '#000000',
      emissive: color,
      emissiveIntensity: 1.7,
    });
  const wheels: THREE.Mesh[] = [];
  let wheelRadius = 0.46,
    turretY = 1.17,
    footprint = [2.3, 2.7]; // Contact-shadow width and length.
  const axles = (
    r: number,
    w: number,
    x: number,
    zs: number[],
    knobby: boolean,
    style: RimStyle,
  ) => {
    wheelRadius = r;
    for (const side of [-1, 1])
      for (const z of zs) wheels.push(wheel(runningGear, side * x, z, r, w, knobby, style));
  };
  // Small dressing; all of it merges into the per-material meshes below.
  const bolts = (y: number, points: number[][], axis: 'x' | 'y' | 'z' = 'y') => {
    for (const [a, b] of points) {
      const [x, py, z] = axis === 'y' ? [a!, y, b!] : axis === 'x' ? [y, a!, b!] : [a!, b!, y];
      cylinder(group, x, py, z, 0.03, 0.035, silver, axis, 6);
    }
  };
  /** Bolted collar that hides the seam where a cylinder meets a panel. */
  const flange = (
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    r: number,
    axis: 'x' | 'y' | 'z',
  ) => {
    cylinder(parent, x, y, z, r * 1.35, 0.05, steel, axis, 16);
    cylinder(parent, x, y, z, r * 1.12, 0.08, dark, axis, 16);
  };
  const exhaust = (x: number, y: number, z: number) => {
    cylinder(group, x, y, z, 0.07, 0.34, dark, 'z', 10);
    cylinder(group, x, y, z - 0.17, 0.085, 0.07, silver, 'z', 12);
    cylinder(group, x, y, z - 0.19, 0.05, 0.02, ember, 'z', 10);
    flange(group, x, y, z + 0.1, 0.07, 'z');
  };
  /** Hazard chevrons on a thin plate, repeated along its length so stripes keep their width. */
  const hazardStrip = (
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ) => {
    const m = box(parent, x, y, z, w, h, d, hazardPaint);
    const [, short, long] = [w, h, d].sort((a, b) => a - b);
    const repeat = Math.max(1, Math.round(long! / short! / 2)),
      uv = m.geometry.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * repeat);
    return m;
  };
  const row = (from: number, to: number, n: number, other: number) =>
    Array.from({ length: n }, (_, i) => [other, from + ((to - from) * i) / (n - 1)]);
  worn(
    paint,
    'worn-paint',
    'vec3(0.66, 0.66, 0.68)',
    1,
    `reflectedLight.directSpecular *= 0.35;
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect *= 0.12;
    #endif`,
    true,
  );
  // Richer, deeper base coat than the raw UI colour so light tones read as candy, not cream.
  const tone = paint.color.getHSL({ h: 0, s: 0, l: 0 });
  // Warm yellows lean toward amber-orange.
  const hue = tone.h > 0.06 && tone.h < 0.16 ? tone.h - 0.025 : tone.h;
  paint.color.setHSL(hue, Math.min(1, tone.s * 1.2 + 0.1), tone.l * 0.82);
  // Race number picked from the paint colour so each robot keeps a stable number.
  const number = [...color].reduce((a, c) => a + c.charCodeAt(0), 0) % DECAL_NUMBERS;
  /**
   * Stencil from the decal atlas (2 x 4 cells of 2:1) on a thin plate facing along `axis`;
   * `size` is the plate's width, its height is half that.
   */
  const stencil = (
    x: number,
    y: number,
    z: number,
    size: number,
    cell: number,
    axis: 'x' | 'y' | 'z',
    parent: THREE.Object3D = group,
  ) => {
    const t = 0.004,
      [w, h, d] =
        axis === 'x'
          ? [t, size / 2, size]
          : axis === 'y'
            ? [size, t, size / 2]
            : [size, size / 2, t];
    const m = box(parent, x, y, z, w, h, d, decal),
      uv = m.geometry.attributes.uv!;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, ((cell % 2) + uv.getX(i)) / 2, 1 - (Math.floor(cell / 2) + 1 - uv.getY(i)) / 4);
    return m;
  };
  /** Ribbed hose along a smooth path through `points`. */
  const hose = (
    points: number[][],
    r = 0.035,
    material: THREE.Material = rubber,
    parent: THREE.Object3D = group,
  ) => {
    const path = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    const m = new THREE.Mesh(new THREE.TubeGeometry(path, 24, r, 8, false), material);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  /** Hydraulic ram from `a` to `b`: dark barrel, polished rod, collar, hoses feeding its base. */
  const piston = (a: number[], b: number[], r = 0.055) => {
    const from = new THREE.Vector3(...a),
      to = new THREE.Vector3(...b),
      dir = to.clone().sub(from),
      len = dir.length(),
      turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const part = (t0: number, t1: number, radius: number, material: THREE.Material) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, len * (t1 - t0), 12),
        material,
      );
      m.position.copy(from).addScaledVector(dir, len * (t0 + t1) * 0.5);
      m.quaternion.copy(turn);
      m.castShadow = true;
      group.add(m);
    };
    part(0, 0.58, r, dark);
    part(0.54, 0.6, r * 1.25, silver);
    part(0.58, 1, r * 0.45, silver);
    part(-0.05, 0.05, r * 1.35, steel);
    part(0.95, 1.03, r * 0.9, steel);
  };
  /** Whip antenna with a glowing tip. */
  const antenna = (x: number, y: number, z: number, len: number) => {
    cylinder(group, x, y + 0.04, z, 0.05, 0.08, dark, 'y', 10);
    cylinder(group, x, y + len / 2, z, 0.012, len, dark, 'y', 5);
    box(group, x, y + len, z, 0.045, 0.045, 0.045, glow);
  };
  /** Bolted-on armour plate with corner bolts on its outer face (normal along x). */
  const sidePlate = (x: number, y: number, z: number, h: number, d: number, material = steel) => {
    const plate = box(group, x, y, z, 0.05, h, d, material);
    for (const dy of [-h / 2 + 0.06, h / 2 - 0.06])
      for (const dz of [-d / 2 + 0.07, d / 2 - 0.07])
        cylinder(group, x + Math.sign(x) * 0.03, y + dy, z + dz, 0.028, 0.03, silver, 'x', 6);
    return plate;
  };
  group.add(runningGear);
  // Each chassis is its own vehicle, but keeps the turret seat (y ~1.12, z -0.13) and front mounts.
  if (chassis === 'mule') {
    // Utility pickup: chamfered chassis rail, one sculpted cab-and-hood shell, open bed.
    axles(0.46, 0.36, 1, [-0.78, 0.78], false, 'utility');
    sculpt(
      group,
      [
        [-1.25, 0.5],
        [-1.18, 0.44],
        [1.16, 0.44],
        [1.27, 0.56],
        [1.22, 0.78],
        [-1.24, 0.78],
      ],
      1.6,
      gunmetal,
    );
    // Raked nose, hood crease, windshield rake and a cab that tapers into the bed.
    sculpt(
      group,
      [
        [-0.55, 0.76],
        [1.18, 0.76],
        [1.25, 0.84],
        [1.22, 0.96],
        [1.02, 1.04],
        [0.36, 1.06],
        [0.2, 1.12],
        [-0.44, 1.12],
        [-0.55, 1.02],
      ],
      1.66,
      paint,
    );
    // Twin racing stripes over hood and cab roof, readable from the chase camera.
    for (const x of [-0.56, 0.56]) {
      box(group, x, 1.057, 0.69, 0.2, 0.006, 0.64, stripe);
      box(group, x, 1.123, -0.12, 0.2, 0.006, 0.6, stripe);
      box(group, x, 0.95, -1.232, 0.2, 0.3, 0.006, stripe);
    }
    for (const x of [-0.835, 0.835]) {
      box(group, x, 1.0, -0.12, 0.02, 0.15, 0.56, glass);
      box(group, x * 1.08, 1.02, 0.3, 0.14, 0.1, 0.05, dark);
      box(group, x * 0.94, 0.95, -0.85, 0.08, 0.3, 0.7, gunmetal);
      box(group, x * 0.86, 0.9, 1.245, 0.24, 0.08, 0.03, lamp);
      box(group, x * 0.88, 0.95, -1.22, 0.1, 0.18, 0.03, tail);
      // Chamfered fender flares over each wheel.
      for (const z of [-0.78, 0.78]) arch(group, x * 1.2, z, 0.46, 0.52, 0.6, 0.42, gunmetal);
    }
    // Windshield on the rake between hood and roof.
    const screen = box(group, 0, 1.09, 0.28, 1.5, 0.14, 0.012, glass);
    screen.rotation.x = -1.21;
    // Rubber bed mat, flat spare tyre strapped down between the crates.
    box(group, 0, 0.82, -0.85, 1.62, 0.06, 0.7, rubber);
    cylinder(group, 0, 0.92, -0.86, 0.26, 0.14, rubber, 'y', 24);
    cylinder(group, 0, 0.925, -0.86, 0.15, 0.15, steel, 'y', 16);
    cylinder(group, 0, 0.93, -0.86, 0.05, 0.17, silver, 'y', 10);
    box(group, 0, 0.995, -0.86, 0.62, 0.02, 0.05, dark);
    box(group, 0, 0.95, -1.2, 1.62, 0.3, 0.06, paint);
    // Number plate, tow hitch and a cross-braced cage with an amber light bar.
    box(group, 0, 0.845, -1.236, 0.36, 0.12, 0.008, dark);
    stencil(0, 0.845, -1.2405, 0.24, number, 'z');
    box(group, 0, 0.5, -1.33, 0.1, 0.1, 0.24, steel);
    cylinder(group, 0, 0.57, -1.42, 0.045, 0.08, silver, 'y', 12);
    hose(
      [
        [-0.72, 1.1, -1.08],
        [0.7, 1.41, -1.05],
      ],
      0.024,
      dark,
    );
    box(group, 0, 1.49, -1.05, 1.0, 0.07, 0.09, dark);
    for (const x of [-0.4, -0.18, 0.18, 0.4]) box(group, x, 1.49, -1.097, 0.16, 0.04, 0.01, amber);
    box(group, 0, 0.86, 1.245, 1.0, 0.16, 0.03, dark);
    for (const z of [-1.22, 1.22]) box(group, 0, 0.62, z, 1.8, 0.14, 0.1, silver);
    box(group, 0.56, 0.97, -0.95, 0.3, 0.24, 0.22, steel);
    box(group, -0.56, 0.97, -0.95, 0.3, 0.24, 0.2, dark);
    antenna(-0.72, 1.12, -0.4, 0.85);
    bolts(1.06, [...row(0.42, 0.98, 4, 0.76), ...row(0.42, 0.98, 4, -0.76)]);
    // Roll hoop over the bed, braced to the cab roof.
    hose(
      [
        [-0.74, 1.08, -1.08],
        [-0.7, 1.42, -1.05],
        [0.7, 1.42, -1.05],
        [0.74, 1.08, -1.08],
      ],
      0.035,
      dark,
    );
    for (const x of [-0.68, 0.68])
      hose(
        [
          [x, 1.42, -1.03],
          [x, 1.15, -0.5],
        ],
        0.028,
        dark,
      );
    // Hood scoop with slats, race number, tailgate sponsor.
    box(group, 0, 1.09, 0.82, 0.56, 0.07, 0.28, dark);
    for (const x of [-0.18, 0, 0.18]) box(group, x, 1.128, 0.82, 0.1, 0.012, 0.24, silver);
    stencil(0, 1.058, 0.5, 0.64, number, 'y');
    stencil(0, 1.0, -1.234, 0.5, 4, 'z');
    for (const x of [-1, 1]) stencil(x * 0.832, 0.86, -0.05, 0.3, 5, 'x');
    hazardStrip(group, 0, 0.62, -1.275, 1.5, 0.1, 0.012);
    exhaust(0.58, 0.45, -1.2);
    exhaust(0.4, 0.45, -1.2);
    for (const x of [-1, 1]) box(group, x * 0.805, 0.47, 0, 0.012, 0.035, 1.4, glow);
  } else if (chassis === 'dart') {
    // Low sports car: wedge body, teardrop canopy, flared arches, rear wing; turret sits lower.
    turretY = 0.98;
    footprint = [2.2, 2.6];
    axles(0.38, 0.42, 0.98, [-0.8, 0.82], false, 'dish');
    box(group, 0, 0.4, 0, 1.8, 0.16, 2.4, dark);
    sculpt(
      group,
      [
        [-1.22, 0.44],
        [1.2, 0.44],
        [1.34, 0.5],
        [1.28, 0.58],
        [0.7, 0.72],
        [-0.95, 0.76],
        [-1.22, 0.7],
      ],
      1.86,
      paint,
    );
    sculpt(
      group,
      [
        [0.5, 0.7],
        [0.1, 0.9],
        [-0.45, 0.93],
        [-0.9, 0.74],
      ],
      1.3,
      glass,
      0,
      0.06,
    );
    box(group, 0, 0.36, 1.2, 1.95, 0.04, 0.3, dark);
    box(group, 0, 1.0, -1.1, 1.9, 0.04, 0.34, paint);
    box(group, 0, 0.64, -1.235, 1.5, 0.06, 0.03, tail);
    for (const x of [-1, 1]) {
      box(group, x * 0.16, 0.654, 0.99, 0.14, 0.006, 0.56, stripe).rotation.x = 0.236;
      box(group, x * 0.16, 1.023, -1.1, 0.14, 0.006, 0.33, stripe);
      box(group, x * 0.95, 0.44, 0, 0.1, 0.12, 1.1, dark);
      box(group, x * 0.55, 0.85, -1.08, 0.06, 0.3, 0.12, dark);
      box(group, x * 0.95, 0.97, -1.1, 0.03, 0.18, 0.4, dark);
      box(group, x * 0.62, 0.62, 1.2, 0.34, 0.05, 0.06, lamp).rotation.x = 0.236;
      cylinder(group, x * 0.3, 0.45, -1.22, 0.07, 0.2, silver, 'z');
      for (const z of [-0.8, 0.82]) arch(group, x * 0.94, z, 0.38, 0.44, 0.51, 0.44, gunmetal);
      box(group, x * 1.002, 0.41, 0, 0.012, 0.03, 1.0, glow);
      box(group, x * 0.95, 0.745, -1.21, 0.2, 0.025, 0.012, glow);
    }
    hazardStrip(group, 0, 0.36, 1.353, 1.9, 0.035, 0.012);
    for (const x of [-1, 1]) {
      box(group, x * 0.935, 0.49, -0.1, 0.012, 0.09, 2.1, gunmetal);
      stencil(x * 0.943, 0.6, 0.1, 0.44, number, 'x');
      // Side intake with slats behind the door.
      box(group, x * 0.945, 0.61, -0.62, 0.02, 0.14, 0.34, dark);
      for (let i = 0; i < 3; i++)
        box(group, x * 0.955, 0.57 + i * 0.04, -0.62, 0.012, 0.012, 0.3, silver);
    }
    antenna(-0.62, 0.73, -0.75, 0.62);
  } else if (chassis === 'bruiser') {
    // Lifted off-roader: raked hood shell, big flared arches, snorkel and spare; turret rides high.
    turretY = 1.29;
    footprint = [2.5, 2.9];
    axles(0.56, 0.48, 1.02, [-0.82, 0.82], true, 'beadlock');
    box(group, 0, 0.82, 0, 1.5, 0.2, 2.3, dark);
    sculpt(
      group,
      [
        [-1.12, 0.88],
        [1.18, 0.88],
        [1.26, 0.98],
        [1.2, 1.12],
        [0.55, 1.22],
        [-1.02, 1.22],
        [-1.12, 1.12],
      ],
      1.72,
      paint,
    );
    box(group, 0, 0.8, 1.24, 1.95, 0.2, 0.16, steel);
    box(group, 0, 0.82, -1.2, 1.6, 0.16, 0.12, steel);
    cylinder(group, 0, 1.05, -1.3, 0.38, 0.22, rubber, 'z', 16);
    cylinder(group, 0, 1.05, -1.42, 0.2, 0.04, steel, 'z');
    cylinder(group, 0.82, 1.35, 0.45, 0.06, 0.7, dark);
    flange(group, 0.82, 1.24, 0.45, 0.06, 'y');
    box(group, 0.82, 1.71, 0.5, 0.14, 0.1, 0.18, dark);
    for (const x of [-1, 1]) {
      box(group, x * 0.865, 1.12, -0.1, 0.02, 0.14, 0.9, glass);
      box(group, x * 0.92, 0.66, 0, 0.2, 0.05, 0.45, silver);
      // Slim rectangular lamps in dark housings (round ones read as eyes over the winch).
      box(group, x * 0.6, 1.07, 1.24, 0.34, 0.1, 0.05, dark);
      box(group, x * 0.6, 1.07, 1.268, 0.28, 0.045, 0.012, lamp);
      box(group, x * 0.75, 1.02, -1.135, 0.12, 0.14, 0.03, tail);
      box(group, x * 1.02, 0.45, -1.42, 0.36, 0.4, 0.03, rubber);
      for (const z of [-0.82, 0.82]) arch(group, x * 0.95, z, 0.56, 0.62, 0.72, 0.42, dark);
      box(group, x * 0.752, 0.72, 0, 0.012, 0.035, 1.6, glow);
      // Gunmetal lower band along the body and a roof stripe.
      box(group, x * 0.866, 0.95, 0.05, 0.012, 0.12, 2.28, gunmetal);
      box(group, x * 0.52, 1.223, -0.24, 0.18, 0.006, 1.5, stripe);
    }
    hazardStrip(group, 0, 0.8, 1.323, 1.7, 0.12, 0.012);
    // Light bar on posts over the hood.
    box(group, 0, 1.28, 0.98, 1.25, 0.09, 0.14, dark);
    for (const x of [-0.55, 0.55]) box(group, x, 1.21, 0.98, 0.05, 0.1, 0.05, dark);
    for (const x of [-0.45, -0.15, 0.15, 0.45]) box(group, x, 1.28, 1.052, 0.2, 0.06, 0.012, lamp);
    exhaust(-0.55, 0.62, -1.26);
    // Winch on the bumper, snorkel hose, door numbers and a whip antenna.
    cylinder(group, 0, 0.97, 1.25, 0.09, 0.5, dark, 'x', 12);
    for (const x of [-0.27, 0.27]) box(group, x, 0.95, 1.25, 0.04, 0.16, 0.18, steel);
    hose([
      [0.82, 1.05, 0.45],
      [0.9, 0.98, 0.7],
      [0.88, 0.92, 1.0],
    ]);
    for (const x of [-1, 1]) stencil(x * 0.866, 0.97, -0.1, 0.38, number, 'x');
    antenna(-0.72, 1.22, -0.95, 0.9);
  } else {
    // Six-wheeled armored carrier: one hull shell with a steep glacis, chamfered track guards.
    footprint = [2.5, 3.0];
    axles(0.44, 0.42, 1.05, [-0.92, 0, 0.92], true, 'military');
    box(group, 0, 0.6, 0, 1.6, 0.3, 2.6, dark);
    sculpt(
      group,
      [
        [-1.25, 0.67],
        [0.92, 0.67],
        [1.34, 0.8],
        [1.36, 0.88],
        [1.06, 1.09],
        [-1.16, 1.09],
        [-1.27, 0.98],
      ],
      1.95,
      paint,
    );
    box(group, 0, 1.12, -0.3, 1.6, 0.06, 1.6, steel);
    cylinder(group, 0.55, 1.17, -0.9, 0.2, 0.06, steel);
    antenna(-0.8, 1.15, -1.0, 1.0);
    box(group, -0.45, 1.26, -0.95, 0.4, 0.22, 0.3, dark);
    stencil(0, 1.153, 0.3, 0.5, number, 'y');
    for (const x of [-1, 1]) {
      sculpt(
        group,
        [
          [-1.3, 0.9],
          [1.2, 0.9],
          [1.36, 1.0],
          [1.28, 1.1],
          [-1.26, 1.1],
          [-1.36, 1.0],
        ],
        0.14,
        gunmetal,
        x * 1.02,
        0.02,
      );
      box(group, x * 1.02, 1.103, 0, 0.1, 0.006, 2.5, stripe);
      box(group, x * 0.45, 1.035, 1.15, 0.3, 0.06, 0.02, glass).rotation.x = -0.96;
      box(group, x * 0.38, 0.88, -1.26, 0.7, 0.36, 0.03, steel);
      box(group, x * 0.1, 0.9, -1.285, 0.04, 0.12, 0.03, silver);
      box(group, x * 0.78, 0.98, 1.22, 0.16, 0.08, 0.04, lamp).rotation.x = -0.96;
      box(group, x * 0.85, 0.95, -1.26, 0.1, 0.1, 0.03, tail);
      for (let i = 0; i < 3; i++)
        cylinder(group, x * (0.62 + i * 0.1), 1.2, 0.75, 0.045, 0.22, dark, 'z').rotation.x =
          Math.PI / 2 - 0.5;
      box(group, x * 1.092, 0.93, 0, 0.012, 0.035, 2.3, glow);
      // Bolt-on track-guard armour.
      for (const z of [-0.82, 0, 0.82]) sidePlate(x * 1.12, 1.02, z, 0.15, 0.74);
      hazardStrip(group, x * 0.38, 0.75, -1.28, 0.7, 0.1, 0.012);
      stencil(x * 0.38, 0.95, -1.28, 0.5, x < 0 ? number : 5, 'z');
    }
    exhaust(-0.3, 1.24, -1.12);
    bolts(1.155, [...row(-1.0, 0.4, 5, 0.72), ...row(-1.0, 0.4, 5, -0.72)]);
  }
  let saw: THREE.Group | undefined, hammer: THREE.Group | undefined, drill: THREE.Group | undefined;
  let sweeper: THREE.Group | undefined,
    flipper: THREE.Group | undefined,
    hook: THREE.Group | undefined;
  if (front === 'ram') {
    // Raked plough blade with a hardened lip and three bolted ribs.
    sculpt(
      group,
      [
        [1.22, 0.24],
        [1.58, 0.18],
        [1.68, 0.26],
        [1.54, 0.74],
        [1.4, 0.78],
        [1.3, 0.66],
      ],
      2.13,
      paint,
      0,
      0.05,
    );
    box(group, 0, 0.22, 1.66, 2.17, 0.095, 0.12, silver);
    for (const x of [-0.7, 0, 0.7])
      sculpt(
        group,
        [
          [1.6, 0.22],
          [1.73, 0.27],
          [1.6, 0.76],
          [1.5, 0.74],
        ],
        0.1,
        dark,
        x,
        0.015,
      );
    hazardStrip(group, 0, 0.6, 1.598, 2.0, 0.12, 0.012).rotation.x = -0.28;
    for (const x of [-0.55, 0.55]) piston([x, 0.66, 0.92], [x, 0.54, 1.32]);
  } else if (front === 'wedge') {
    sculpt(
      group,
      [
        [1.05, 0.13],
        [2.05, 0.13],
        [1.05, 0.83],
      ],
      2.15,
      paint,
      0,
      0.04,
    );
    box(group, 0, 0.15, 2.04, 2.2, 0.1, 0.1, silver);
    hazardStrip(group, 0, 0.15, 2.096, 2.1, 0.07, 0.012);
    for (const x of [-0.65, 0, 0.65]) {
      const rib = box(group, x, 0.51, 1.56, 0.09, 0.065, 1.18, dark);
      rib.rotation.x = 0.61;
    }
    for (const x of [-0.42, 0.42]) piston([x, 0.9, 0.72], [x, 0.74, 1.18]);
  } else if (front === 'sweeper') {
    // Faceted steel hub (no dome or cap peeking under the glacis, which read as a mouth).
    cylinder(group, 0, 0.61, 1.2, 0.34, 0.45, steel, 'y', 8);
    sweeper = new THREE.Group();
    sweeper.position.set(0, 0.61, 1.2);
    group.add(sweeper);
    sculpt(
      sweeper,
      [
        [0, -0.12],
        [1.2, -0.1],
        [1.2, 0.1],
        [0, 0.12],
      ],
      0.22,
      steel,
      0,
      0.03,
    );
    sculpt(
      sweeper,
      [
        [1.16, -0.22],
        [1.52, -0.22],
        [1.62, -0.1],
        [1.62, 0.12],
        [1.5, 0.22],
        [1.2, 0.22],
        [1.14, 0.1],
      ],
      1.55,
      paint,
      0,
      0.05,
    );
    for (const x of [-0.68, 0.68]) box(sweeper, x, 0, 1.38, 0.22, 0.5, 0.5, silver);
    for (const x of [-0.36, 0, 0.36]) box(sweeper, x, 0.24, 1.38, 0.12, 0.04, 0.42, dark);
    sweeper.rotation.y = -0.85;
  } else if (front === 'flipper') {
    for (const x of [-0.66, 0.66]) {
      sculpt(
        group,
        [
          [0.85, 0.16],
          [1.2, 0.16],
          [1.3, 0.3],
          [1.3, 0.62],
          [1.18, 0.76],
          [0.9, 0.76],
        ],
        0.3,
        paint,
        x,
      );
      cylinder(group, x, 0.55, 1.22, 0.19, 0.38, silver, 'x');
      for (const side of [-1, 1]) flange(group, x + side * 0.16, 0.55, 1.22, 0.19, 'x');
    }
    flipper = new THREE.Group();
    flipper.position.set(0, 0.55, 1.22);
    group.add(flipper);
    box(flipper, 0, 0, 0.15, 1.7, 0.22, 0.3, steel);
    for (const x of [-0.63, 0.63]) {
      // Tapered lifting tine, thick at the hinge and knifed at the tip.
      sculpt(
        flipper,
        [
          [-0.05, -0.08],
          [0.05, 0.03],
          [1.2, -0.24],
          [1.42, -0.36],
          [1.36, -0.42],
          [0, -0.22],
        ],
        0.27,
        paint,
        x,
      );
      box(flipper, x, -0.34, 1.34, 0.29, 0.075, 0.24, silver);
    }
    cylinder(group, 0, 0.39, 1.25, 0.14, 0.6, dark, 'z');
    for (const x of [-0.3, 0.3]) piston([x, 0.82, 0.92], [x, 0.62, 1.3]);
  } else if (front === 'hook') {
    sculpt(
      group,
      [
        [0.9, 0.42],
        [1.35, 0.42],
        [1.45, 0.55],
        [1.45, 0.86],
        [1.3, 0.94],
        [0.95, 0.94],
        [0.9, 0.85],
      ],
      1.15,
      paint,
    );
    cylinder(group, 0, 0.74, 1.44, 0.27, 0.78, steel, 'x');
    for (const x of [-0.43, 0.43]) cylinder(group, x, 0.74, 1.44, 0.32, 0.09, silver, 'x');
    hook = new THREE.Group();
    hook.position.set(0, 0.56, 1.45);
    group.add(hook);
    box(hook, 0, 0, 0.45, 0.13, 0.13, 0.95, steel);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0.85),
      new THREE.Vector3(0, 0, 1.23),
      new THREE.Vector3(0.22, 0, 1.44),
      new THREE.Vector3(0.52, 0, 1.27),
      new THREE.Vector3(0.43, 0, 1.04),
    ]);
    const claw = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.115, 6, false), silver);
    claw.castShadow = true;
    hook.add(claw);
    box(hook, 0, 0, 0.73, 0.22, 0.23, 0.22, paint);
    for (const x of [-0.64, 0.64]) piston([x, 0.72, 0.9], [x, 0.72, 1.42], 0.05);
  } else if (front === 'saw') {
    for (const x of [-0.47, 0.47])
      sculpt(
        group,
        [
          [0.92, 0.54],
          [1.62, 0.56],
          [1.72, 0.62],
          [1.62, 0.68],
          [0.92, 0.72],
        ],
        0.16,
        steel,
        x,
        0.03,
      );
    saw = new THREE.Group();
    saw.position.set(0, 0.59, 1.65);
    group.add(saw);
    cylinder(saw, 0, 0, 0, 0.63, 0.1, silver, 'y', 20);
    for (let i = 0; i < 12; i++) {
      const tooth = box(
        saw,
        Math.sin((i * Math.PI) / 6) * 0.61,
        0,
        Math.cos((i * Math.PI) / 6) * 0.61,
        0.18,
        0.12,
        0.22,
        silver,
      );
      tooth.rotation.y = (i * Math.PI) / 6 + 0.4;
    }
    turned(
      saw,
      [
        [0, 0.02],
        [0.2, 0.02],
        [0.2, 0.09],
        [0.14, 0.14],
        [0, 0.15],
      ],
      paint,
      'y',
    );
    for (const x of [-0.3, 0.3]) piston([x, 0.86, 0.98], [x * 0.7, 0.76, 1.45], 0.05);
  } else if (front === 'hammer') {
    for (const x of [-0.52, 0.52]) {
      sculpt(
        group,
        [
          [0.7, 0.66],
          [1.06, 0.66],
          [1.06, 1.2],
          [0.98, 1.45],
          [0.78, 1.45],
          [0.7, 1.2],
        ],
        0.2,
        paint,
        x,
        0.03,
      );
      cylinder(group, x, 1.38, 0.88, 0.2, 0.24, silver, 'x');
      for (const side of [-1, 1]) flange(group, x + side * 0.11, 1.38, 0.88, 0.2, 'x');
    }
    hammer = new THREE.Group();
    hammer.position.set(0, 1.38, 0.88);
    group.add(hammer);
    for (const x of [-0.35, 0.35]) box(hammer, x, 0, 0.62, 0.15, 0.19, 1.35, steel);
    sculpt(
      hammer,
      [
        [1.02, -0.27],
        [1.6, -0.27],
        [1.6, 0.22],
        [1.5, 0.3],
        [1.12, 0.3],
        [1.02, 0.2],
      ],
      1.14,
      paint,
      0,
      0.05,
    );
    box(hammer, 0, -0.33, 1.31, 1.22, 0.13, 0.64, silver);
    for (const x of [-0.39, 0, 0.39]) box(hammer, x, 0.025, 1.608, 0.1, 0.45, 0.04, dark);
    hazardStrip(hammer, 0, 0.306, 1.31, 1.0, 0.012, 0.3);
    for (const x of [-0.68, 0.68]) piston([x, 0.95, 0.45], [x, 1.32, 0.84]);
    hammer.rotation.x = -1;
  } else if (front === 'drill') {
    sculpt(
      group,
      [
        [1.03, 0.41],
        [1.45, 0.41],
        [1.51, 0.5],
        [1.51, 0.84],
        [1.42, 0.93],
        [1.1, 0.93],
        [1.03, 0.82],
      ],
      1.08,
      paint,
    );
    cylinder(group, 0, 0.67, 1.55, 0.36, 0.25, dark, 'z');
    flange(group, 0, 0.67, 1.5, 0.33, 'z');
    for (const x of [-0.46, 0.46]) piston([x, 0.98, 0.95], [x * 0.75, 0.8, 1.42], 0.05);
    drill = new THREE.Group();
    drill.position.set(0, 0.67, 1.57);
    group.add(drill);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.18, 16), steel);
    core.rotation.x = Math.PI / 2;
    core.position.z = 0.57;
    core.castShadow = true;
    drill.add(core);
    // Tapered spiral flight gives the auger a recognizable silhouette as it spins.
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120,
        angle = t * Math.PI * 7,
        radius = 0.44 * (1 - t) + 0.025;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, t * 1.17));
    }
    const flight = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 120, 0.055, 5, false),
      silver,
    );
    flight.castShadow = true;
    drill.add(flight);
  }
  const hot = new THREE.MeshStandardMaterial(
    top === 'railgun'
      ? {
          color: '#65e5ed',
          emissive: '#20cadd',
          emissiveIntensity: 2,
          metalness: 0.4,
          roughness: 0.3,
        }
      : {
          color: '#6a7072',
          roughness: 0.45,
          metalness: 0.95,
          emissive: '#ff4a14',
          emissiveIntensity: 0,
        },
  );
  const barrel = new THREE.Group();
  barrel.position.set(0, turretY, -0.13);
  group.add(barrel);
  // Turret ring: turned race with a chamfered lip, glowing seam and bolt circle.
  turned(
    barrel,
    [
      [0, -0.08],
      [0.43, -0.08],
      [0.46, -0.03],
      [0.44, 0.05],
      [0.37, 0.09],
      [0, 0.09],
    ],
    dark,
    'y',
  );
  cylinder(barrel, 0, -0.02, 0, 0.465, 0.03, glow, 'y', 24);
  // Charge ring on the turret race, and a single-lens sensor pod with rear status LEDs.
  turned(
    barrel,
    [
      [0.4, 0.09],
      [0.42, 0.095],
      [0.42, 0.11],
      [0.4, 0.11],
    ],
    charge,
    'y',
  );
  const [sx, sy, sz] = (
    {
      cannon: [-0.2, 0.48, -0.16],
      flamethrower: [0, 0.53, -0.24],
      scattergun: [0.25, 0.51, -0.12],
      railgun: [-0.18, 0.46, -0.2],
    } as const
  )[top];
  box(barrel, sx, sy, sz, 0.12, 0.12, 0.12, dark);
  cylinder(barrel, sx, sy, sz + 0.065, 0.035, 0.02, charge, 'z', 12);
  for (let i = 0; i < 3; i++)
    box(barrel, sx - 0.03 + i * 0.03, sy + 0.02, sz - 0.063, 0.018, 0.018, 0.01, amber);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    cylinder(barrel, Math.sin(a) * 0.37, 0.085, Math.cos(a) * 0.37, 0.028, 0.03, silver, 'y', 6);
  }
  if (top === 'cannon') {
    // Sloped mantlet, turned barrel with a slotted muzzle brake, side ammo bin.
    sculpt(
      barrel,
      [
        [-0.29, 0.06],
        [0.26, 0.06],
        [0.4, 0.16],
        [0.34, 0.36],
        [-0.1, 0.42],
        [-0.3, 0.36],
      ],
      0.7,
      paint,
      0,
      0.05,
    );
    turned(
      barrel,
      [
        [0, 0.36],
        [0.15, 0.36],
        [0.13, 0.5],
        [0.12, 1.1],
        [0, 1.1],
      ],
      hot,
      'z',
      0,
      0.22,
    );
    turned(
      barrel,
      [
        [0.1, 1.08],
        [0.19, 1.1],
        [0.2, 1.28],
        [0.17, 1.33],
        [0.09, 1.33],
        [0.09, 1.16],
      ],
      silver,
      'z',
      0,
      0.22,
    );
    for (const x of [-0.19, 0.19]) box(barrel, x, 0.22, 1.2, 0.03, 0.07, 0.13, dark);
    flange(barrel, 0, 0.22, 0.39, 0.14, 'z');
    sculpt(
      barrel,
      [
        [-0.25, 0.06],
        [0.2, 0.06],
        [0.24, 0.2],
        [0.16, 0.34],
        [-0.25, 0.34],
      ],
      0.18,
      steel,
      0.39,
      0.03,
    );
  } else if (top === 'flamethrower') {
    // Transverse fuel tank in a strapped cradle behind the nozzle (twin rear-facing tanks
    // read as a pair of eyes from the chase camera), with hoses feeding the nozzle.
    cylinder(barrel, 0, 0.25, -0.24, 0.22, 0.86, paint, 'x', 24);
    for (const x of [-0.45, 0.45]) {
      turned(
        barrel,
        [
          [0.2, 0],
          [0.16, 0.05],
          [0.08, 0.08],
          [0, 0.085],
        ],
        dark,
        'y',
        0,
        0,
      )
        .geometry.rotateZ((-Math.sign(x) * Math.PI) / 2)
        .translate(x, 0.25, -0.24);
      hose(
        [
          [x * 0.8, 0.3, -0.1],
          [x * 0.6, 0.3, 0.12],
          [x * 0.3, 0.2, 0.3],
        ],
        0.035,
        rubber,
        barrel,
      );
    }
    for (const x of [-0.22, 0.22]) cylinder(barrel, x, 0.25, -0.24, 0.228, 0.05, dark, 'x', 24);
    box(barrel, 0, 0.05, -0.24, 0.7, 0.08, 0.36, dark);
    turned(
      barrel,
      [
        [0, 0.13],
        [0.22, 0.13],
        [0.2, 0.3],
        [0.15, 0.75],
        [0.14, 0.96],
        [0, 0.96],
      ],
      hot,
      'z',
      0,
      0.18,
    );
    turned(
      barrel,
      [
        [0.13, 0.92],
        [0.26, 0.95],
        [0.29, 1.05],
        [0.24, 1.08],
        [0.15, 1.08],
        [0.15, 1.0],
      ],
      silver,
      'z',
      0,
      0.18,
    );
    flange(barrel, 0, 0.18, 0.16, 0.22, 'z');
    for (const x of [-0.15, 0.15]) cylinder(barrel, x, 0.18, 1.08, 0.08, 0.04, dark, 'z');
  } else if (top === 'scattergun') {
    sculpt(
      barrel,
      [
        [-0.26, 0.03],
        [0.3, 0.03],
        [0.36, 0.12],
        [0.36, 0.4],
        [0.2, 0.45],
        [-0.2, 0.45],
        [-0.3, 0.36],
      ],
      0.91,
      paint,
      0,
      0.05,
    );
    box(barrel, 0, 0.23, 0.59, 0.83, 0.43, 0.13, silver);
    for (const [x, y] of [
      [-0.23, 0.12],
      [0, 0.12],
      [0.23, 0.12],
      [-0.12, 0.34],
      [0.12, 0.34],
    ]) {
      // Turned barrel with a reinforced muzzle ring and a hollow bore.
      turned(
        barrel,
        [
          [0, 0.4],
          [0.1, 0.4],
          [0.1, 0.94],
          [0.12, 0.96],
          [0.12, 1.0],
          [0.075, 1.0],
          [0.075, 0.9],
        ],
        hot,
        'z',
        x!,
        y!,
      );
      cylinder(barrel, x!, y!, 0.91, 0.076, 0.01, dark, 'z');
    }
    for (const x of [-0.54, 0.54]) {
      box(barrel, x, 0.22, -0.02, 0.2, 0.36, 0.48, dark);
      for (let i = 0; i < 3; i++)
        cylinder(barrel, x, 0.4, -0.17 + i * 0.14, 0.05, 0.16, silver, 'x');
    }
  } else if (top === 'railgun') {
    sculpt(
      barrel,
      [
        [-0.39, 0.05],
        [0.12, 0.05],
        [0.21, 0.14],
        [0.21, 0.36],
        [0, 0.4],
        [-0.32, 0.4],
        [-0.4, 0.3],
      ],
      0.71,
      paint,
      0,
      0.05,
    );
    box(barrel, 0, 0.14, 0.64, 0.49, 0.13, 1.6, dark);
    for (const x of [-0.24, 0.24]) {
      // Knife-tipped rails.
      sculpt(
        barrel,
        [
          [-0.1, 0.2],
          [1.5, 0.2],
          [1.58, 0.31],
          [1.5, 0.42],
          [-0.1, 0.42],
        ],
        0.14,
        silver,
        x,
        0.025,
      );
      box(barrel, x * 0.72, 0.3, 0.75, 0.045, 0.09, 1.48, hot);
    }
    // Accelerator coils wrapped round both rails.
    for (let i = 0; i < 4; i++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 24), hot);
      coil.position.set(0, 0.31, 0.18 + i * 0.27);
      coil.scale.set(1, 0.55, 1);
      barrel.add(coil);
    }
    turned(
      barrel,
      [
        [0, -0.58],
        [0.2, -0.57],
        [0.23, -0.52],
        [0.23, -0.42],
        [0.2, -0.38],
        [0, -0.38],
      ],
      hot,
      'z',
      0,
      0.26,
    );
  }
  // Barrel tip, so flashes and flames follow each chassis' turret height, scale and recoil.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(
    0,
    top === 'railgun' ? 0.3 : 0.2,
    { cannon: 1.33, flamethrower: 1.08, scattergun: 1.0, railgun: 1.52 }[top],
  );
  barrel.add(muzzle);
  // Anchor for burning-robot flames; the particles are emitted by WeaponEffects.burning.
  const burn = new THREE.Group();
  burn.visible = false;
  burn.position.set(0, 0.95, -0.2);
  group.add(burn);
  // Suspension moves the body only; tires, hubs, and tracks stay on the roof.
  for (const child of [...group.children]) if (child !== runningGear) suspension.add(child);
  group.add(suspension);
  mergeStatic(suspension);
  mergeStatic(runningGear, wheels);
  for (const part of [saw, hammer, drill, sweeper, flipper, hook, barrel])
    if (part) mergeStatic(part);
  // Underglow pooled on the floor beneath the hull; additive, so it never darkens the ground.
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color,
      map: glowPool,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pool.position.y = 0.025;
  pool.renderOrder = 1;
  runningGear.add(pool);
  // Soft contact shadow that pins the chassis to the floor; the rect in the texture spans ~60%.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(footprint[0]! / 0.6, footprint[1]! / 0.68).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: '#000000',
      alphaMap: contactShadow,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  shadow.position.y = 0.015;
  runningGear.add(shadow);
  // Added after merging so the blur shells keep their own fading materials and cast no shadow.
  const blur: THREE.MeshBasicMaterial[] = [];
  const shell = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    color: string,
    max: number,
    additive = false,
  ) => {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    material.userData.max = max;
    blur.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  };
  if (saw) {
    shell(saw, new THREE.CylinderGeometry(0.74, 0.74, 0.13, 40), '#c3ccca', 0.6);
    shell(
      saw,
      new THREE.RingGeometry(0.5, 0.8, 48).rotateX(-Math.PI / 2),
      '#ff9c45',
      0.9,
      true,
    ).position.y = 0.07;
  }
  if (drill)
    shell(
      drill,
      new THREE.ConeGeometry(0.5, 1.2, 24).rotateX(Math.PI / 2).translate(0, 0, 0.57),
      '#b7c1bf',
      0.5,
    );
  group.scale.setScalar(chassisScale(chassis));
  return {
    suspension,
    chassis,
    group,
    burn,
    wheels,
    wheelRadius,
    saw,
    hammer,
    drill,
    sweeper,
    flipper,
    hook,
    barrel,
    muzzle,
    firing: false,
    front,
    top,
    speed: 0,
    impact: 0,
    impactAge: 0,
    paint,
    meleeHold: 0,
    meleeConnected: false,
    lastFrontCooldown: 0,
    contactCooldown: 0,
    scorchCooldown: 0,
    slam: 0,
    slamFrom: 0,
    flash: 0,
    kick: new THREE.Vector2(),
    trailClock: 0,
    heat: 0,
    hot,
    charge,
    spin: 0,
    blur,
  };
}

export class GameScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 650);
  private renderer: THREE.WebGLRenderer;
  private robots = new Map<string, Robot>();
  private previewRobot: Robot;
  private state: RoomState | null = null;
  private localId = '';
  private spectatorId = '';
  private input: Input = { forward: 0, turn: 0, front: false, top: false };
  private lastSnapshot = 0;
  private priorState: RoomState | null = null;
  private timer = new THREE.Timer();
  private shakeEnabled = true;
  private shake = 0;
  /** Client-only freeze-frame: effects nearly pause for a few frames after heavy hits. */
  private hitStop = 0;
  /** Hit-stop waits for the attacker's slam to land. */
  private hitStopDelay = 0;
  /** 0.1 during hit-stop, else 1; scales robot interpolation, animation and effects. */
  private timeScale = 1;
  /** Momentary zoom-in on heavy hits, 0..1. */
  private punch = 0;
  private city = new City();
  private hazards = new ArenaHazards();
  private effects: WeaponEffects;
  private wow: WowEffects;
  private finale: Finale;
  private seenEvents = new Set<number>();
  private target = new THREE.Vector3();
  private aim: THREE.Vector3 | null = null;
  // Scratch objects reused every frame to avoid garbage-collection hitches.
  private aimPoint = new THREE.Vector3();
  private muzzlePoint = new THREE.Vector3();
  private projected = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private size = new THREE.Vector2();
  private predicted = {} as PlayerState;
  private post: Post;
  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA happens in the composer's HDR target instead of the default framebuffer.
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    installHeightFog();
    createSky(this.renderer, this.scene);
    this.scene.fog = new THREE.FogExp2('#7a6470', 0.0022);
    this.scene.add(new THREE.HemisphereLight('#aab4dc', '#9a7452', 0.85));
    const sun = new THREE.DirectionalLight('#ffc485', 2.5);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(70);
    sun.castShadow = true;
    // Frustum hugs the arena as seen from the sun (the roof foreshortens to ~±20 vertically),
    // so a 4096 map gives ~1.5 cm texels and shadows stay attached at the wheels.
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, {
      left: -ARENA_HALF - 3,
      right: ARENA_HALF + 3,
      top: 22,
      bottom: -22,
      near: 30,
      far: 110,
    });
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.012;
    sun.shadow.radius = 1.5;
    // Sky fill never lets a cast shadow go fully black (hemisphere/env alone read as ink).
    sun.shadow.intensity = 0.82;
    sun.shadow.blurSamples = 12;
    this.scene.add(sun);
    // Cool cyan kicker from opposite the sun (no shadows) rims robot silhouettes off the warm floor.
    const rim = new THREE.DirectionalLight('#7cc8ff', 2.2);
    rim.position.set(-SUN_DIRECTION.x, 0.2, -SUN_DIRECTION.z).multiplyScalar(50);
    this.scene.add(rim);
    this.post = createPost(this.renderer, this.scene, this.camera);
    this.effects = new WeaponEffects(this.scene);
    this.wow = new WowEffects(this.scene);
    this.finale = new Finale(this.scene);
    this.buildArena();
    this.scene.add(this.city.group);
    this.scene.add(this.hazards.group);
    this.previewRobot = robot('ram', 'cannon', '#e6aa3c');
    this.scene.add(this.previewRobot.group);
    this.camera.position.set(7, 5, 8);
    this.target.set(0, 0.6, 0);
    // Compile pooled effect shaders at startup so the first shot does not stall combat.
    this.renderer.compile(this.scene, this.camera);
    this.timer.connect(document);
    this.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }
  private buildArena(): void {
    const H = ARENA_HALF,
      M = H * 2,
      N = 2048,
      aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Seeded so every client paints the same rooftop.
    let seed = 1337;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647,
      span = (a: number, b: number) => a + (b - a) * rnd(),
      canvas = (px: number) => {
        const c = document.createElement('canvas');
        c.width = c.height = px;
        return [c, c.getContext('2d')!] as const;
      };
    // Color (2048) and roughness (1024) share one metre-space drawing: canvas y is world z.
    const [colorCanvas, col] = canvas(N),
      [roughCanvas, rough] = canvas(N / 2),
      [paintCanvas, paint] = canvas(N);
    for (const [ctx, px] of [
      [col, N],
      [rough, N / 2],
      [paint, N],
    ] as const)
      ctx.setTransform(px / M, 0, 0, px / M, (px / M) * H, (px / M) * H);
    const blob = (
      ctx: CanvasRenderingContext2D,
      x: number,
      z: number,
      r: number,
      rgb: string,
      a: number,
    ) => {
      const grad = ctx.createRadialGradient(x, z, 0, x, z, r);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, z - r, r * 2, r * 2);
    };

    // Weathered concrete: per-slab tone, broad mottling, runoff grime toward the edge.
    col.fillStyle = '#5f5a53';
    col.fillRect(-H, -H, M, M);
    rough.fillStyle = '#cfcfcf';
    rough.fillRect(-H, -H, M, M);
    for (let x = -H; x < H; x += 4)
      for (let z = -H; z < H; z += 4) {
        const v = rnd();
        col.fillStyle =
          v < 0.5 ? `rgba(40,36,30,${v * 0.34})` : `rgba(200,195,185,${(v - 0.5) * 0.26})`;
        col.fillRect(x, z, 4, 4);
      }
    for (let i = 0; i < 520; i++)
      blob(
        col,
        span(-H, H),
        span(-H, H),
        span(0.6, 5),
        rnd() < 0.6 ? '38,33,28' : '185,178,165',
        span(0.05, 0.17),
      );
    // Low-frequency grime and sun-bleached zones that ignore the slab grid.
    for (let i = 0; i < 46; i++)
      blob(
        col,
        span(-H, H),
        span(-H, H),
        span(4, 13),
        rnd() < 0.55 ? '34,29,24' : '196,186,168',
        span(0.1, 0.24),
      );
    // Roughness breakup: dusty (matte, lighter) and damp (glossy, darker) patches.
    for (let i = 0; i < 70; i++) {
      const x = span(-H, H),
        z = span(-H, H),
        r = span(1.5, 6);
      if (rnd() < 0.5) {
        blob(rough, x, z, r, '255,255,255', 0.35);
        blob(col, x, z, r, '205,196,180', 0.1);
      } else {
        blob(rough, x, z, r, '50,50,50', span(0.35, 0.6));
        blob(col, x, z, r * 0.9, '30,26,22', 0.16);
      }
    }
    // Repairs: a few recast slabs (paler, matte) and tar-patched slabs (dark, semi-gloss).
    for (let i = 0; i < 12; i++) {
      const x = -H + 4 * Math.floor(span(0, 14)),
        z = -H + 4 * Math.floor(span(0, 14)),
        tar = i % 3 === 0;
      col.fillStyle = tar ? 'rgba(52,47,42,0.6)' : 'rgba(170,163,148,0.32)';
      col.fillRect(x + 0.05, z + 0.05, 3.9, 3.9);
      rough.fillStyle = tar ? 'rgba(120,120,120,0.7)' : 'rgba(255,255,255,0.5)';
      rough.fillRect(x + 0.05, z + 0.05, 3.9, 3.9);
    }
    // Standing water: dark, near-mirror puddles that pick up the dusk sky.
    for (let i = 0; i < 9; i++) {
      const x = span(-H + 4, H - 4),
        z = span(-H + 4, H - 4),
        r = span(1.2, 2.8);
      if (Math.hypot(x, z) < 7) continue;
      for (let k = 0; k < 6; k++) {
        const ox = x + span(-r, r) * 0.7,
          oz = z + span(-r, r) * 0.5,
          rr = r * span(0.5, 0.9);
        blob(col, ox, oz, rr, '28,24,22', 0.35);
        blob(rough, ox, oz, rr * 1.1, '8,8,8', 0.95);
      }
    }
    // Dried puddle tide marks.
    for (let i = 0; i < 14; i++) {
      const x = span(-H + 3, H - 3),
        z = span(-H + 3, H - 3),
        r = span(1, 3);
      col.strokeStyle = 'rgba(40,34,28,0.22)';
      col.lineWidth = 0.05;
      col.beginPath();
      for (let a = 0; a <= 24; a++) {
        const t = (a / 24) * Math.PI * 2,
          rr = r * (0.8 + 0.2 * Math.sin(t * 3 + i) + 0.1 * Math.sin(t * 7 + i * 2));
        col.lineTo(x + Math.cos(t) * rr, z + Math.sin(t) * rr * 0.8);
      }
      col.stroke();
    }
    for (const flip of [0, 1, 2, 3]) {
      col.save();
      col.rotate((flip * Math.PI) / 2);
      const g = col.createLinearGradient(0, H, 0, H - 3.5);
      g.addColorStop(0, 'rgba(30,26,22,0.45)');
      g.addColorStop(1, 'rgba(30,26,22,0)');
      col.fillStyle = g;
      col.fillRect(-H, H - 3.5, M, 3.5);
      col.restore();
    }

    // Worn painted markings: hazard chevron band, centre ring and radial ticks.
    paint.fillStyle = '#e0a93a';
    paint.save();
    paint.beginPath();
    paint.rect(-H + 0.25, -H + 0.25, M - 0.5, M - 0.5);
    paint.rect(-H + 1.15, -H + 1.15, M - 2.3, M - 2.3);
    paint.clip('evenodd');
    paint.strokeStyle = '#e0a93a';
    paint.lineWidth = 0.42;
    for (let d = -M * 2; d < M * 2; d += 1.1) {
      paint.beginPath();
      paint.moveTo(d - M, -M);
      paint.lineTo(d + M, M);
      paint.stroke();
    }
    paint.restore();
    paint.strokeStyle = '#e0a93a';
    paint.lineWidth = 0.2;
    paint.beginPath();
    paint.arc(0, 0, 5.85, 0, Math.PI * 2);
    paint.stroke();
    for (const side of [-1, 1]) {
      paint.fillRect(side * 10 - 1.5, -0.07, 3, 0.14);
      paint.fillRect(-0.07, side * 10 - 1.5, 0.14, 3);
    }
    paint.fillStyle = '#d9d4c7';
    paint.font = 'bold 1.1px Arial, sans-serif';
    paint.textAlign = 'center';
    for (const [x, z, rot] of [
      [0, H - 2.2, 0],
      [0, -H + 2.2, Math.PI],
      [H - 2.2, 0, -Math.PI / 2],
      [-H + 2.2, 0, Math.PI / 2],
    ] as const) {
      paint.save();
      paint.translate(x, z);
      paint.rotate(rot);
      paint.fillText('KEEP CLEAR OF EDGE', 0, 0.4);
      paint.restore();
    }
    // Faded loading-bay outlines and a stencilled sector number.
    paint.strokeStyle = '#d6d0c2';
    paint.lineWidth = 0.14;
    for (const [x, z] of [
      [-H + 3, -H + 3],
      [H - 11, H - 9],
    ] as const) {
      paint.strokeRect(x, z, 8, 6);
      for (let d = 0; d < 14; d += 1.2) {
        paint.beginPath();
        paint.moveTo(x + Math.min(d, 8), z + Math.max(0, d - 8));
        paint.lineTo(x + Math.max(0, d - 6), z + Math.min(d, 6));
        paint.stroke();
      }
    }
    paint.fillStyle = '#d6d0c2';
    paint.font = 'bold 6px Arial, sans-serif';
    paint.fillText('07', -H + 7, H - 5);
    // Team spawn boxes on the spawn ring (radius 14, rotated 85°), numbered, in team colours.
    ['#e6aa3c', '#51bec9', '#cc6478', '#8cb961'].forEach((team, i) => {
      const a = (i * Math.PI) / 2 + (85 * Math.PI) / 180;
      paint.save();
      paint.translate(Math.sin(a) * 14, Math.cos(a) * 14);
      paint.rotate(-a);
      paint.strokeStyle = team;
      paint.lineWidth = 0.16;
      paint.strokeRect(-1.8, -1.8, 3.6, 3.6);
      paint.fillStyle = team;
      for (const [cx, cz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        paint.fillRect(cx * 1.8 - (cx > 0 ? 0.6 : 0), cz * 1.8 - (cz > 0 ? 0.16 : 0), 0.6, 0.16);
        paint.fillRect(cx * 1.8 - (cx > 0 ? 0.16 : 0), cz * 1.8 - (cz > 0 ? 0.6 : 0), 0.16, 0.6);
      }
      paint.font = 'bold 2.2px Arial, sans-serif';
      paint.textAlign = 'center';
      paint.textBaseline = 'middle';
      paint.globalAlpha = 0.7;
      paint.fillText(`0${i + 1}`, 0, 2.9);
      paint.globalAlpha = 1;
      paint.restore();
    });
    // Lane arrows pointing into the ring between the spawns.
    paint.fillStyle = '#d6d0c2';
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + (40 * Math.PI) / 180;
      for (const r of [9, 10.6]) {
        paint.save();
        paint.translate(Math.sin(a) * r, Math.cos(a) * r);
        paint.rotate(-a);
        paint.beginPath();
        paint.moveTo(-0.8, 0.5);
        paint.lineTo(0, -0.5);
        paint.lineTo(0.8, 0.5);
        paint.lineTo(0.8, 0.85);
        paint.lineTo(0, -0.15);
        paint.lineTo(-0.8, 0.85);
        paint.closePath();
        paint.fill();
        paint.restore();
      }
    }
    // Chip and scuff the paint before it is laid onto the concrete.
    paint.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9000; i++) {
      paint.fillStyle = `rgba(0,0,0,${span(0.3, 1)})`;
      const r = span(0.02, 0.09);
      paint.fillRect(span(-H, H), span(-H, H), r, r * span(0.5, 2));
    }
    for (let i = 0; i < 260; i++)
      blob(paint, span(-H, H), span(-H, H), span(0.4, 2.4), '0,0,0', span(0.2, 0.6));
    paint.globalCompositeOperation = 'source-over';
    col.setTransform(1, 0, 0, 1, 0, 0);
    col.globalAlpha = 0.82;
    col.drawImage(paintCanvas, 0, 0);
    col.globalAlpha = 1;
    // Paint is smoother than bare concrete.
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'source-in';
    paint.fillStyle = '#9a9a9a';
    paint.fillRect(0, 0, N, N);
    rough.setTransform(1, 0, 0, 1, 0, 0);
    rough.drawImage(paintCanvas, 0, 0, N / 2, N / 2);
    for (const [ctx, px] of [
      [col, N],
      [rough, N / 2],
    ] as const)
      ctx.setTransform(px / M, 0, 0, px / M, (px / M) * H, (px / M) * H);

    // Oil stains read as dark, glossy patches that catch the sky.
    for (let i = 0; i < 22; i++) {
      const x = span(-H + 2, H - 2),
        z = span(-H + 2, H - 2),
        r = span(0.5, 1.6);
      // Keep the hero spot clean so a stain never reads as a detached shadow.
      if (Math.hypot(x, z) < 8) continue;
      for (let k = 0; k < 5; k++) {
        const ox = x + span(-r, r) * 0.6,
          oz = z + span(-r, r) * 0.6,
          rr = r * span(0.4, 1);
        blob(col, ox, oz, rr, '24,20,15', span(0.2, 0.4));
        blob(rough, ox, oz, rr, '110,110,110', 0.5);
      }
    }
    // Tire skid arcs from previous bouts.
    col.lineCap = 'round';
    for (let i = 0; i < 34; i++) {
      let x = span(-H + 3, H - 3),
        z = span(-H + 3, H - 3),
        a = span(0, Math.PI * 2);
      const turn = span(-0.14, 0.14),
        steps = Math.floor(span(8, 26)),
        track = span(0.5, 0.9);
      for (let k = 0; k < steps; k++) {
        const nx = x + Math.cos(a) * 0.35,
          nz = z + Math.sin(a) * 0.35,
          px = -Math.sin(a) * track,
          pz = Math.cos(a) * track;
        col.strokeStyle = `rgba(18,16,14,${0.2 * Math.sin((Math.PI * (k + 0.5)) / steps)})`;
        col.lineWidth = 0.2;
        for (const s of [-1, 1]) {
          col.beginPath();
          col.moveTo(x + px * s * 0.5, z + pz * s * 0.5);
          col.lineTo(nx + px * s * 0.5, nz + pz * s * 0.5);
          col.stroke();
        }
        x = nx;
        z = nz;
        a += turn;
      }
    }
    // Recessed expansion joints: dark sealant with a lit far lip.
    for (let i = -H + 4; i < H; i += 4) {
      // Soft grime gathered along each seam, then a thin, low-contrast sealant line.
      for (const [w, a] of [
        [0.5, 0.08],
        [0.26, 0.1],
        [0.12, 0.13],
      ] as const) {
        col.fillStyle = `rgba(30,26,22,${a})`;
        col.fillRect(i - w / 2, -H, w, M);
        col.fillRect(-H, i - w / 2, M, w);
      }
      col.fillStyle = 'rgba(34,30,26,0.4)';
      col.fillRect(i - 0.025, -H, 0.05, M);
      col.fillRect(-H, i - 0.025, M, 0.05);
      col.fillStyle = 'rgba(210,200,185,0.1)';
      col.fillRect(i + 0.025, -H, 0.025, M);
      col.fillRect(-H, i + 0.025, M, 0.025);
    }
    // Hairline cracks wandering across a few slabs.
    col.strokeStyle = 'rgba(28,24,20,0.45)';
    col.lineWidth = 0.025;
    for (let i = 0; i < 40; i++) {
      let x = span(-H, H),
        z = span(-H, H),
        a = span(0, Math.PI * 2);
      col.beginPath();
      col.moveTo(x, z);
      for (let k = 0, n = Math.floor(span(4, 12)); k < n; k++) {
        a += span(-0.7, 0.7);
        x += Math.cos(a) * 0.3;
        z += Math.sin(a) * 0.3;
        col.lineTo(x, z);
      }
      col.stroke();
    }
    // Flush roof furniture (all painted into the maps, zero height): skylights, a hatch plate,
    // drain grates, painted cable trays, scorch clusters and a big centre wordmark.
    const [glowCanvas, glow] = canvas(512);
    glow.fillStyle = '#000';
    glow.fillRect(0, 0, 512, 512);
    glow.setTransform(512 / M, 0, 0, 512 / M, (512 / M) * H, (512 / M) * H);
    for (const [x, z, w, d] of [
      [-19, -15, 4.4, 2.4],
      [15, 17, 4.4, 2.4],
      [-6, 19, 2.4, 4.4],
    ] as const) {
      col.fillStyle = '#3b3f41';
      col.fillRect(x - 0.15, z - 0.15, w + 0.3, d + 0.3);
      col.fillStyle = '#1d2a33';
      col.fillRect(x, z, w, d);
      rough.fillStyle = '#1a1a1a';
      rough.fillRect(x, z, w, d);
      const g = glow.createLinearGradient(x, z, x + w, z + d);
      g.addColorStop(0, '#ffcf8a');
      g.addColorStop(1, '#b8853f');
      glow.fillStyle = g;
      glow.fillRect(x, z, w, d);
      // Mullions.
      for (const c of [col, glow]) {
        c.fillStyle = c === col ? '#4a4e50' : '#000';
        for (let i = 1; i < 4; i++)
          if (w > d) c.fillRect(x + (w * i) / 4 - 0.04, z, 0.08, d);
          else c.fillRect(x, z + (d * i) / 4 - 0.04, w, 0.08);
        c.fillRect(x, z + d / 2 - 0.04, w, 0.08);
      }
    }
    // Roof hatch: chequer-plate steel with bolts.
    const hx = 19,
      hz = -9;
    col.fillStyle = '#5d6063';
    col.fillRect(hx, hz, 1.8, 1.8);
    rough.fillStyle = '#707070';
    rough.fillRect(hx, hz, 1.8, 1.8);
    col.fillStyle = 'rgba(200,205,210,0.35)';
    for (let i = 0.1; i < 1.8; i += 0.12)
      for (let k = 0.1; k < 1.8; k += 0.12)
        col.fillRect(hx + i + ((k * 8) % 2 < 1 ? 0 : 0.06), hz + k, 0.07, 0.025);
    col.fillStyle = '#2c2d2e';
    for (const [bx, bz] of [
      [0.08, 0.08],
      [1.66, 0.08],
      [0.08, 1.66],
      [1.66, 1.66],
    ] as const)
      col.fillRect(hx + bx, hz + bz, 0.06, 0.06);
    col.strokeStyle = 'rgba(20,20,20,0.8)';
    col.lineWidth = 0.05;
    col.strokeRect(hx, hz, 1.8, 1.8);
    // Drain grates at slab corners, with a rust bloom around them.
    for (const [x, z] of [
      [-12, -20],
      [12, 20],
      [-20, 8],
      [20, -20],
      [8, -12],
      [-12, 24],
    ] as const) {
      blob(col, x, z, 1.2, '70,45,25', 0.35);
      col.fillStyle = '#1e1f20';
      col.fillRect(x - 0.35, z - 0.35, 0.7, 0.7);
      col.fillStyle = '#6b6e70';
      for (let i = 0; i < 6; i++) col.fillRect(x - 0.32, z - 0.32 + i * 0.12, 0.64, 0.05);
      rough.fillStyle = '#5a5a5a';
      rough.fillRect(x - 0.35, z - 0.35, 0.7, 0.7);
    }
    // Painted cable trays running in from the edge.
    for (const path of [
      [
        [-H, 10],
        [-14, 10],
        [-14, 22],
      ],
      [
        [H, -3],
        [22, -3],
        [22, -16],
      ],
    ]) {
      for (const [w, c] of [
        [0.5, 'rgba(40,40,42,0.75)'],
        [0.06, 'rgba(210,160,50,0.6)'],
      ] as const) {
        col.strokeStyle = c;
        col.lineWidth = w;
        col.lineJoin = 'miter';
        col.beginPath();
        path.forEach(([x, z], i) => (i ? col.lineTo(x!, z!) : col.moveTo(x!, z!)));
        col.stroke();
      }
    }
    // Scorch clusters from previous bouts.
    for (let i = 0; i < 9; i++) {
      const x = span(-H + 4, H - 4),
        z = span(-H + 4, H - 4);
      if (Math.hypot(x, z) < 7) continue;
      blob(col, x, z, span(1.2, 2.2), '12,10,9', 0.55);
      for (let k = 0; k < 10; k++) {
        const a = span(0, Math.PI * 2),
          r = span(0.8, 2.6);
        col.strokeStyle = 'rgba(15,12,10,0.3)';
        col.lineWidth = span(0.05, 0.18);
        col.beginPath();
        col.moveTo(x, z);
        col.lineTo(x + Math.cos(a) * r, z + Math.sin(a) * r);
        col.stroke();
      }
    }
    // Faded centre wordmark inside the ring.
    col.save();
    col.globalAlpha = 0.16;
    col.fillStyle = '#e8e0cc';
    col.font = 'italic 900 5.2px Arial, sans-serif';
    col.textAlign = 'center';
    col.textBaseline = 'middle';
    col.fillText('R/', 0, 0.2);
    col.restore();

    // Scattered debris: dark bolts/nuts and glittering shattered glass (glossy in the roughness map).
    for (let c = 0; c < 26; c++) {
      const cx = span(-H + 2, H - 2),
        cz = span(-H + 2, H - 2);
      for (let k = 0; k < 14; k++) {
        const x = cx + span(-1.2, 1.2),
          z = cz + span(-1.2, 1.2),
          glass = rnd() < 0.5,
          sz = span(0.03, glass ? 0.09 : 0.06);
        col.fillStyle = glass ? 'rgba(215,230,235,0.8)' : 'rgba(25,24,22,0.9)';
        col.beginPath();
        col.moveTo(x, z - sz);
        col.lineTo(x + sz, z + sz * span(0.2, 1));
        col.lineTo(x - sz * span(0.3, 1), z + sz);
        col.fill();
        rough.fillStyle = glass ? '#080808' : '#606060';
        rough.fillRect(x - sz, z - sz, sz * 2, sz * 2);
      }
    }

    // Fine aggregate grain.
    col.setTransform(1, 0, 0, 1, 0, 0);
    const img = col.getImageData(0, 0, N, N),
      px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const n = (rnd() - 0.5) * 22;
      px[i]! += n;
      px[i + 1]! += n;
      px[i + 2]! += n * 0.9;
    }
    col.putImageData(img, 0, 0);

    // Tiled 8 m bump detail with joint grooves on the 4 m grid.
    const [bumpCanvas, bump] = canvas(1024);
    bump.fillStyle = '#808080';
    bump.fillRect(0, 0, 1024, 1024);
    const bimg = bump.getImageData(0, 0, 1024, 1024),
      b = bimg.data;
    for (let i = 0; i < b.length; i += 4) b[i] = b[i + 1] = b[i + 2] = 128 + (rnd() - 0.5) * 40;
    bump.putImageData(bimg, 0, 0);
    for (let i = 0; i < 1400; i++) {
      bump.fillStyle = rnd() < 0.7 ? 'rgba(40,40,40,0.7)' : 'rgba(200,200,200,0.5)';
      bump.beginPath();
      bump.arc(span(0, 1024), span(0, 1024), span(0.8, 3), 0, Math.PI * 2);
      bump.fill();
    }
    bump.fillStyle = '#202020';
    for (const p of [0, 512, 1024]) {
      bump.fillRect(p - 4, 0, 8, 1024);
      bump.fillRect(0, p - 4, 1024, 8);
    }

    const texture = (c: HTMLCanvasElement, repeat: number, srgb = false) => {
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const roof = new THREE.Mesh(
      new THREE.PlaneGeometry(M, M),
      new THREE.MeshStandardMaterial({
        map: texture(colorCanvas, 1, true),
        roughnessMap: texture(roughCanvas, 1),
        bumpMap: texture(bumpCanvas, M / 8),
        bumpScale: 0.6,
        roughness: 1,
        metalness: 0,
        emissiveMap: texture(glowCanvas, 1, true),
        emissive: '#ffffff',
        emissiveIntensity: 0.9,
      }),
    );
    // World-space macro noise breaks the slab repetition, and wet patches drop roughness so the
    // roof picks up sky and floodlight reflections.
    // Floodlight lens positions (the pylon ring built below, R = H + 1.1, heads at y 6.2).
    const lampGlsl = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
    ]
      .map(([x, z]) => `vec3(${(x! * (H + 1.1)).toFixed(2)}, 6.2, ${(z! * (H + 1.1)).toFixed(2)})`)
      .join(', ');
    roof.material.onBeforeCompile = (shader) => {
      // Scanned CC0 concrete (Poly Haven concrete_floor_worn_001) as world-space detail.
      shader.uniforms.tConc = { value: pbr('floor', 'diff') };
      shader.uniforms.tConcNor = { value: pbr('floor', 'nor') };
      shader.uniforms.tConcArm = { value: pbr('floor', 'arm') };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vMacro;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvMacro = (modelMatrix * vec4(transformed, 1.0)).xz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vMacro;
          uniform sampler2D tConc, tConcNor, tConcArm;
          const vec3 LAMPS[8] = vec3[8](${lampGlsl});
          float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float mNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mHash(i), mHash(i + vec2(1, 0)), f.x), mix(mHash(i + vec2(0, 1)), mHash(i + 1.0), f.x), f.y);
          }
          float mFbm(vec2 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 4; i++) { v += a * mNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
            return v;
          }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          // Macro zones (tens of metres), per-slab tint/value and damp -> standing-water zones,
          // all in world space so nothing lines up with the 8 m bump tile.
          float macro = smoothstep(0.22, 0.78, mFbm(vMacro * 0.045));
          // Two scanned-concrete samples (3 m and rotated 4.7 m tiles) cross-faded by noise hide
          // the repeat; each is divided by its own mean (top mip) so it adds detail, not tone.
          vec2 cA = vMacro / 3.0, cB = mat2(0.8, -0.6, 0.6, 0.8) * vMacro / 4.7 + 0.37;
          float cW = smoothstep(0.35, 0.65, mNoise(vMacro * 0.18));
          vec3 concDetail = mix(texture2D(tConc, cA).rgb / max(textureLod(tConc, cA, 12.0).rgb, 0.02),
                                texture2D(tConc, cB).rgb / max(textureLod(tConc, cB, 12.0).rgb, 0.02), cW);
          vec3 concArm = mix(texture2D(tConcArm, cA).rgb / max(textureLod(tConcArm, cA, 12.0).rgb, 0.02),
                             texture2D(tConcArm, cB).rgb / max(textureLod(tConcArm, cB, 12.0).rgb, 0.02), cW);
          diffuseColor.rgb *= clamp(mix(vec3(1.0), concDetail * concArm.r, 0.85), 0.3, 1.8);
          vec2 slab = floor(vMacro / 4.0);
          float sh = mHash(slab), sv = mHash(slab + 7.3);
          diffuseColor.rgb *= mix(vec3(0.92, 0.95, 1.02), vec3(1.07, 1.0, 0.9), sh) * mix(0.86, 1.1, sv) * mix(0.62, 1.3, macro);
          float wetN = mFbm(vMacro * 0.075 + 5.3) + (mNoise(vMacro * 0.9) - 0.5) * 0.06;
          float wet = smoothstep(0.55, 0.61, wetN);
          float damp = smoothstep(0.45, 0.56, wetN);
          diffuseColor.rgb *= (1.0 - damp * 0.22) * (1.0 - wet * 0.45);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor *= mix(0.8, 1.15, mFbm(vMacro * 0.3)) * (1.0 - damp * 0.35) * clamp(concArm.g, 0.6, 1.4);
          roughnessFactor = mix(roughnessFactor, 0.12, wet);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          // Standing water fills the concrete texture: flatten the bump under wet patches.
          `#include <normal_fragment_maps>
          {
            vec3 nA = texture2D(tConcNor, cA).xyz * 2.0 - 1.0;
            vec3 nB = texture2D(tConcNor, cB).xyz * 2.0 - 1.0;
            nB.xy = mat2(0.8, 0.6, -0.6, 0.8) * nB.xy; // undo the sample rotation
            vec2 t = mix(nA.xy, nB.xy, cW);
            // Sample uv is world (x, z): tangent-space xy is a world (x, z) slope, added to the bump normal.
            normal = normalize(normal + (viewMatrix * vec4(t.x, 0.0, t.y, 0.0)).xyz * 0.9);
          }
          normal = normalize(mix(normal, nonPerturbedNormal, wet * 0.85));`,
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
          #if defined( RE_IndirectSpecular )
          radiance *= 1.0 - damp * 0.2;
          #endif`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          // Floodlight heads are not in the env map: reflect them analytically in standing water,
          // stretched vertically like real wet-asphalt glints.
          {
            vec3 wp = vec3(vMacro.x, 0.0, vMacro.y);
            vec3 rv = reflect(normalize(wp - cameraPosition), vec3(0.0, 1.0, 0.0));
            vec3 glint = vec3(0.0);
            for (int i = 0; i < 8; i++) {
              vec3 l = normalize(LAMPS[i] - wp);
              vec3 e = rv - l;
              glint += exp(-(e.x * e.x + e.z * e.z) * 6000.0 - e.y * e.y * 25.0) * vec3(1.2, 1.0, 0.75);
            }
            reflectedLight.indirectSpecular += glint * (wet * 0.9 + damp * 0.15);
          }`,
        );
    };
    roof.rotation.x = -Math.PI / 2;
    roof.receiveShadow = true;
    this.scene.add(roof);
    // The slab must not cast: its top sits just under the roof plane and would shadow it.
    box(
      this.scene,
      0,
      -0.41,
      0,
      M,
      0.8,
      M,
      new THREE.MeshStandardMaterial({ color: '#57534c', roughness: 0.95 }),
    ).castShadow = false;

    // Galvanised flashing just outside the open edge (5 cm proud) with amber warning lamps.
    const flashing = new THREE.MeshStandardMaterial({
        color: '#8a8d8c',
        roughness: 0.42,
        metalness: 0.85,
      }),
      lamp = new THREE.MeshStandardMaterial({
        color: '#2a1a0c',
        emissive: '#ff7a1a',
        emissiveIntensity: 5,
      }),
      trims: number[][] = [],
      lamps: number[][] = [];
    for (const s of [-1, 1]) {
      trims.push([s * (H + 0.14), -0.4, 0, 0.28, 0.9, M + 0.56]);
      trims.push([0, -0.4, s * (H + 0.14), M + 0.56, 0.9, 0.28]);
      for (let i = -H; i <= H; i += 4) {
        lamps.push([s * (H + 0.14), 0.08, i, 0.14, 0.07, 0.3]);
        lamps.push([i, 0.08, s * (H + 0.14), 0.3, 0.07, 0.14]);
      }
    }
    instancedBoxes(this.scene, flashing, trims);
    instancedBoxes(this.scene, lamp, lamps);

    // Hazard-painted cap on the flashing.
    const [stripeCanvas, stripe] = canvas(64);
    stripe.fillStyle = '#1b1b1b';
    stripe.fillRect(0, 0, 64, 64);
    stripe.fillStyle = '#d9a032';
    stripe.beginPath();
    stripe.moveTo(0, 64);
    stripe.lineTo(32, 0);
    stripe.lineTo(64, 0);
    stripe.lineTo(32, 64);
    stripe.fill();
    for (let i = 0; i < 4; i++) {
      const map = texture(stripeCanvas, 1, true);
      map.repeat.set((M + 0.56) / 0.6, 1);
      const cap = new THREE.Mesh(
        new THREE.PlaneGeometry(M + 0.56, 0.24).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.3 }),
      );
      cap.rotation.y = (i * Math.PI) / 2;
      cap.position
        .set(0, 0.051, 0)
        .add(
          new THREE.Vector3(0, 0, H + 0.14).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            cap.rotation.y,
          ),
        );
      cap.receiveShadow = true;
      this.scene.add(cap);
    }

    // Floodlight pylons just beyond the open edge: masts rise from the building face below the
    // roof, lamp heads aim into the arena and throw faint additive light cones. Cable runs link them.
    const mast = new THREE.MeshStandardMaterial({
        color: '#34383b',
        roughness: 0.55,
        metalness: 0.8,
      }),
      lens = new THREE.MeshStandardMaterial({
        color: '#fff4dc',
        emissive: '#fff0d0',
        emissiveIntensity: 6,
      }),
      [coneCanvas, cone] = canvas(64);
    const cg = cone.createLinearGradient(0, 0, 0, 64);
    // Canvas top maps to the cone apex: bright at the lamp, fading out toward the arena.
    cg.addColorStop(0, 'rgba(255,255,255,1)');
    cg.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    cone.fillStyle = cg;
    cone.fillRect(0, 0, 64, 64);
    const beam = new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(coneCanvas),
        color: new THREE.Color('#ffd9a0').multiplyScalar(0.12),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      beamGeometry = new THREE.ConeGeometry(3, 11, 24, 1, true).translate(0, -5.5, 0),
      masts: number[][] = [],
      cables: number[][] = [],
      R = H + 1.1;
    for (const [px, pz] of [
      [-R, -R],
      [0, -R],
      [R, -R],
      [R, 0],
      [R, R],
      [0, R],
      [-R, R],
      [-R, 0],
    ] as const) {
      masts.push([px, -1.5, pz, 0.32, 15, 0.32]);
      masts.push([px, 6, pz, 0.12, 0.12, 0.12]);
      const head = new THREE.Group();
      head.position.set(px, 6.2, pz);
      head.lookAt(0, 0, 0);
      box(head, 0, 0, -0.1, 1.5, 0.75, 0.55, mast).castShadow = false;
      box(head, 0, 0, 0.19, 1.3, 0.55, 0.04, lens).castShadow = false;
      const ray = new THREE.Mesh(beamGeometry, beam);
      ray.rotation.x = -Math.PI / 2;
      ray.position.z = 0.2;
      head.add(ray);
      this.scene.add(head);
    }
    for (const s of [-1, 1]) {
      cables.push([s * (H + 0.45), -0.55, 0, 0.12, 0.12, M + 2]);
      cables.push([0, -0.55, s * (H + 0.45), M + 2, 0.12, 0.12]);
    }
    const masted = new THREE.InstancedMesh(new THREE.BoxGeometry(), mast, masts.length);
    masts.forEach(([x, y, z, w, h, d], i) =>
      masted.setMatrixAt(i, new THREE.Matrix4().makeScale(w!, h!, d!).setPosition(x!, y!, z!)),
    );
    this.scene.add(masted);
    instancedBoxes(
      this.scene,
      new THREE.MeshStandardMaterial({ color: '#1c1d1e', roughness: 0.7 }),
      cables,
    );
  }

  preview(front: FrontWeapon, top: TopWeapon, chassis: Chassis = 'mule'): void {
    if (
      this.previewRobot.front === front &&
      this.previewRobot.top === top &&
      this.previewRobot.chassis === chassis
    )
      return;
    this.removeRobot(this.previewRobot);
    this.previewRobot = robot(front, top, '#e6aa3c', chassis);
    this.scene.add(this.previewRobot.group);
  }
  update(state: RoomState | null, localId: string, input: Input, spectatorId?: string): void {
    if (state !== this.priorState) {
      const finishingEvent = finalElimination(this.priorState, state);
      if (finishingEvent && !matchMedia('(prefers-reduced-motion: reduce)').matches)
        this.finale.start(
          finishingEvent,
          state!.players.find((p) => p.id === finishingEvent.playerId)?.yaw ?? 0,
        );
      if (!state || state.phase !== 'results') this.finale.stop();
      if (state?.code !== this.priorState?.code || state?.round !== this.priorState?.round) {
        this.seenEvents.clear();
        this.effects.clear();
        this.wow.clear();
        this.shake = this.hitStop = this.hitStopDelay = this.punch = 0;
      }
      if (
        state &&
        (state.round !== this.priorState?.round ||
          (state.phase === 'loading' && this.priorState?.phase !== 'loading'))
      )
        for (const p of state.players) {
          const r = this.robots.get(p.id);
          if (r) {
            r.meleeHold = r.contactCooldown = r.flash = r.trailClock = r.impact = 0;
            r.heat = r.spin = r.scorchCooldown = r.slam = 0;
            r.meleeConnected = false;
            r.lastFrontCooldown = 0;
            r.kick.set(0, 0);
            r.paint.emissiveIntensity = 0;
            r.group.position.set(p.x, 0, p.z);
            r.group.rotation.y = p.yaw;
          }
        }
      this.lastSnapshot = performance.now();
      this.priorState = state;
    }
    this.state = state;
    this.localId = localId;
    this.input = { ...input };
    this.spectatorId = spectatorId ?? '';
  }
  get cinematicActive(): boolean {
    return this.finale.active;
  }
  skipCinematic(): void {
    this.finale.stop();
  }
  setCameraShake(enabled: boolean): void {
    this.shakeEnabled = enabled;
  }
  aimScreen(): { x: number; y: number } | null {
    if (!this.aim) return null;
    const p = this.projected.copy(this.aim).project(this.camera);
    if (p.z > 1) return null;
    return {
      x: (p.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-0.5 * p.y + 0.5) * this.canvas.clientHeight,
    };
  }
  private removeRobot(r: Robot): void {
    this.scene.remove(r.group);
    const materials = new Set<THREE.Material>();
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    });
    for (const m of materials) if (!robotShared.includes(m)) m.dispose();
  }
  private animateRobot(r: Robot, p: PlayerState | undefined, time: number, realDt: number): void {
    const dt = realDt * this.timeScale;
    // Robot metals and clearcoat get the dusk environment at full strength (an explicit envMap
    // uses envMapIntensity instead of the scene's dimmer global value), so bevels flash.
    const env = this.scene.environment;
    if (env && r.paint.envMap !== env)
      for (const [m, intensity] of [
        [r.paint, 0.95],
        [r.hot, 0.7],
        [steel, 0.8],
        [gunmetal, 0.8],
        [silver, 0.9],
        [dark, 0.6],
        [glass, 1],
      ] as const) {
        if (m.envMap === env) continue;
        m.envMap = env;
        m.envMapIntensity = intensity;
        m.needsUpdate = true;
      }
    const lift = Math.min(1, (p?.lifted ?? 0) / 0.15);
    r.group.rotation.x += (-lift * 0.16 - r.group.rotation.x) * (1 - Math.exp(-dt * 16));
    r.group.rotation.z = 0;
    r.contactCooldown = Math.max(0, r.contactCooldown - dt);
    r.scorchCooldown = Math.max(0, r.scorchCooldown - dt);
    r.flash = Math.max(0, r.flash - dt);
    r.paint.emissiveIntensity = (r.flash / 0.09) * 0.6;
    r.kick.multiplyScalar(Math.exp(-dt * 18));
    r.impactAge += dt;
    r.impact *= Math.exp(-dt * 8);
    r.suspension.rotation.x = Math.sin(r.impactAge * 32) * r.impact * 0.04;
    r.suspension.rotation.z = Math.sin(r.impactAge * 25) * r.impact * 0.025;
    r.suspension.position.y = -Math.abs(Math.sin(r.impactAge * 32)) * r.impact * 0.02;
    r.suspension.rotation.x += r.kick.x;
    r.suspension.rotation.z += r.kick.y;
    if ((p?.boostRemaining ?? 0) > 0) {
      r.suspension.rotation.x += 0.045;
      r.suspension.position.y -= 0.035;
    }
    for (const w of r.wheels) w.rotation.x += (realDt * r.speed) / r.wheelRadius;
    // Spinners wind up over ~0.4 s and coast down; blur shells hide the teeth at speed.
    const spinning = !!p?.frontActive && (!!r.saw || !!r.drill);
    r.spin += ((spinning ? 1 : 0) - r.spin) * (1 - Math.exp(-dt * (spinning ? 5 : 1.5)));
    for (const m of r.blur) m.opacity = (m.userData.max as number) * r.spin * r.spin;
    if ((p?.frontCooldown ?? 0) > r.lastFrontCooldown + 0.05) r.meleeConnected = false;
    r.lastFrontCooldown = p?.frontCooldown ?? 0;
    const pose = attachmentPose(r);
    if (r.slam > 0 && pose) {
      // The slam plays in real time so it lands before the hit-stop begins.
      r.slam = Math.max(0, r.slam - realDt);
      const k = (1 - r.slam / SLAM) ** 2;
      pose[0][pose[1]] = r.slamFrom + (pose[2] - r.slamFrom) * k;
    } else if (r.meleeHold > 0) r.meleeHold = Math.max(0, r.meleeHold - dt);
    else this.animateMelee(r, p, dt);
    r.burn.visible = !!p?.burning;
    if (r.burn.visible && p?.alive) {
      const at = r.burn.getWorldPosition(this.muzzlePoint);
      this.effects.burning(at.x, at.y, at.z, dt);
    }
    r.firing = !!p?.topActive && r.top === 'flamethrower';
    if (r.firing && p?.alive) {
      const tip = r.muzzle.getWorldPosition(this.muzzlePoint);
      this.effects.flame(tip.x, tip.y, tip.z, r.group.rotation.y, dt);
    }
    const cooldown = WEAPONS[r.top].cooldown,
      elapsed = cooldown - (p?.topCooldown ?? 0) + this.snapshotAge();
    // Sharp kick, then a damped spring that overshoots slightly forward before settling.
    const settle = elapsed - 0.025;
    const recoil =
      cooldown > 0 && p && p.topCooldown > 0
        ? settle < 0
          ? elapsed / 0.025
          : Math.exp(-settle * 11) * Math.cos(settle * 20)
        : 0;
    const heavy = r.top === 'cannon' ? 1 : r.top === 'scattergun' ? 0.72 : 0.42;
    r.barrel.position.z = -0.13 - recoil * 0.42 * heavy;
    r.barrel.rotation.x = -recoil * 0.14 * heavy;
    r.barrel.position.x = r.firing ? Math.sin(time * 83) * 0.012 : 0;
    // Gun heat builds per shot and bleeds off over ~8 s; the flamethrower's is authoritative.
    if (r.top === 'flamethrower') r.heat = p?.heat ?? 0;
    else r.heat = Math.min(1, Math.max(0, r.heat - dt * 0.12));
    if (r.top === 'railgun') {
      // Coils dim after a shot, recharge, then pulse when ready.
      const ready = p && p.topCooldown > 0 ? 1 - p.topCooldown / cooldown : 1;
      r.hot.emissiveIntensity =
        0.4 + 1.6 * ready * ready + (ready >= 1 ? Math.sin(time * 6) * 0.35 : 0) + r.heat * 2;
    } else r.hot.emissiveIntensity = Math.max(0, (r.heat - 0.35) / 0.65) ** 1.5 * 4; // Sustained fire only.
    // Turret charge lines: dim right after firing, brighten to a soft pulse once ready again.
    const charged = p && cooldown > 0 && p.topCooldown > 0 ? 1 - p.topCooldown / cooldown : 1;
    r.charge.emissiveIntensity =
      0.25 + 1.35 * charged * charged + (charged >= 1 ? Math.sin(time * 4) * 0.2 : 0);
    // An overheated flamethrower vents steam until it cools.
    const vent = !!p?.overheated;
    if (p?.alive && (vent || r.heat > 0.45) && Math.random() < dt * (vent ? 14 : r.heat * 10)) {
      const tip = r.muzzle.getWorldPosition(this.muzzlePoint);
      this.effects.heatWisp(tip.x, tip.y, tip.z, vent);
    }
  }
  private snapshotAge(): number {
    return Math.min(Math.max(0, (performance.now() - this.lastSnapshot) / 1000), TICK_SECONDS);
  }
  private animateMelee(r: Robot, p: PlayerState | undefined, dt: number): void {
    if (!p || p.frontCooldown <= 0) r.meleeConnected = false;
    if (r.saw) r.saw.rotation.y += dt * (3 + 36 * r.spin);
    if (r.drill) r.drill.rotation.z += dt * (2.2 + 30 * r.spin);
    // Advance between server ticks so quick swings still move every frame.
    const snapshotAge = this.snapshotAge();
    if (r.sweeper || r.flipper || r.hook) {
      const elapsed = WEAPONS[r.front].cooldown - (p?.frontCooldown ?? 0) + snapshotAge;
      // A brief pull-back, then a snap that overshoots its contact pose.
      const strike = r.meleeConnected
        ? 1
        : elapsed < 0.04
          ? -0.18 * (elapsed / 0.04)
          : -0.18 + 1.18 * backOut(Math.min(1, (elapsed - 0.04) / 0.1));
      const recovery = Math.min(1, Math.max(0, (elapsed - 0.2) / 0.42));
      const action =
        p && p.frontCooldown > 0 ? strike * (1 - recovery * recovery * (3 - 2 * recovery)) : 0;
      if (r.sweeper) r.sweeper.rotation.y = -0.85 + action * 1.7;
      if (r.flipper) r.flipper.rotation.x = -action * 1.12;
      if (r.hook) r.hook.position.z = 1.45 + action * 0.72;
    }
    if (r.hammer) {
      const elapsed = WEAPONS.hammer.cooldown - (p?.frontCooldown ?? 0) + snapshotAge;
      // Anticipation: rear back 0.06 s, slam in 0.1 s, then a ringing bounce when it misses.
      const slam = Math.min(1, Math.max(0, (elapsed - 0.06) / 0.1));
      const ring = elapsed - 0.16;
      const up = Math.min(1, Math.max(0, (elapsed - 0.26) / 1.1));
      const pose = r.meleeConnected
        ? 0.55
        : elapsed < 0.06
          ? -1 - 0.4 * Math.sin((elapsed / 0.06) * (Math.PI / 2))
          : -1.4 +
            1.95 * slam ** 3 +
            (ring > 0 ? Math.sin(ring * 40) * Math.exp(-ring * 18) * 0.12 : 0);
      r.hammer.rotation.x = p && p.frontCooldown > 0 ? pose - 1.55 * up * up * (3 - 2 * up) : -1;
    }
    const attachment = r.hammer ?? r.sweeper ?? r.flipper ?? r.hook;
    const elapsed = WEAPONS[r.front].cooldown - (p?.frontCooldown ?? 0);
    r.trailClock += dt;
    if (attachment && p?.alive && p.frontCooldown > 0 && elapsed < 0.24 && r.trailClock >= 1 / 60) {
      r.trailClock %= 1 / 60;
      const tip = attachment.localToWorld(this.goal.set(0, 0, r.hook ? 0 : r.sweeper ? 1.4 : 1.3));
      this.effects.meleeTrail(tip.x, tip.y, tip.z, r.front);
    }
  }

  private frame(timestamp?: number): void {
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), 0.05),
      time = this.timer.getElapsed();
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (!width || !height) return;
    const size = this.renderer.getSize(this.size);
    // Re-check the ratio too, so moving to a monitor with a different DPI stays sharp.
    const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
    if (size.x !== width || size.y !== height || this.renderer.getPixelRatio() !== pixelRatio) {
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(width, height, false);
      this.post.setSize(width, height, pixelRatio);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const combat = !!this.state && COMBAT_PHASES.includes(this.state.phase);
    this.previewRobot.group.visible = !combat;
    this.aim = null;
    this.city.update(time);
    this.hazards.update(this.state, combat, time);
    if (combat && this.state) {
      if (this.camera.view?.enabled) this.camera.clearViewOffset();
      const state = this.state;
      for (const p of state.players) {
        let r = this.robots.get(p.id);
        if (r && (r.front !== p.front || r.top !== p.top || r.chassis !== p.chassis)) {
          this.removeRobot(r);
          this.robots.delete(p.id);
          r = undefined;
        }
        if (!r) {
          r = robot(p.front, p.top, p.color, p.chassis);
          r.group.position.set(p.x, 0, p.z);
          r.group.rotation.y = p.yaw;
          this.robots.set(p.id, r);
          this.scene.add(r.group);
        }
        r.group.visible = p.alive;
        const predicted = Object.assign(this.predicted, p);
        const snapshotAge = Math.min((performance.now() - this.lastSnapshot) / 1000, 0.085);
        if (state.phase === 'combat' && p.alive) {
          driveTerrain(
            predicted,
            p.id === this.localId ? { ...this.input, boost: false } : EMPTY_INPUT,
            snapshotAge,
          );
        }
        const smooth = 1 - Math.exp(-dt * 17);
        const oldX = r.group.position.x,
          oldZ = r.group.position.z;
        r.group.position.lerp(this.goal.set(predicted.x, 0, predicted.z), smooth);
        r.group.rotation.y +=
          Math.atan2(
            Math.sin(predicted.yaw - r.group.rotation.y),
            Math.cos(predicted.yaw - r.group.rotation.y),
          ) * smooth;
        r.speed =
          dt > 0
            ? ((r.group.position.x - oldX) * Math.sin(r.group.rotation.y) +
                (r.group.position.z - oldZ) * Math.cos(r.group.rotation.y)) /
              dt
            : 0;
        this.animateRobot(r, p, time, dt);
      }
      for (const [id, r] of this.robots)
        if (!state.players.some((p) => p.id === id)) {
          this.removeRobot(r);
          this.robots.delete(id);
        }
      const watched =
        state.players.find((p) => p.id === (this.spectatorId || this.localId) && p.alive) ??
        state.players.find((p) => p.alive);
      const r = watched ? this.robots.get(watched.id) : undefined;
      if (r && !this.finale.active) {
        const yaw = r.group.rotation.y,
          pos = r.group.position;
        const edge = Math.max(Math.abs(pos.x), Math.abs(pos.z));
        const outward =
          (pos.x * Math.sin(yaw) + pos.z * Math.cos(yaw)) / Math.max(1, Math.hypot(pos.x, pos.z));
        const vertigo =
          Math.max(0, Math.min(1, (edge - ARENA_HALF + 8) / 7)) * Math.max(0, outward);
        this.camera.position.lerp(
          this.goal.set(
            pos.x - Math.sin(yaw) * (9 - vertigo * 3),
            6.4 + vertigo * 4,
            pos.z - Math.cos(yaw) * (9 - vertigo * 3),
          ),
          1 - Math.exp(-dt * this.timeScale * 6),
        );
        this.target.lerp(
          this.goal.set(
            pos.x + Math.sin(yaw) * (3 + vertigo * 5),
            0.6 - vertigo * 9,
            pos.z + Math.cos(yaw) * (3 + vertigo * 5),
          ),
          1 - Math.exp(-dt * this.timeScale * 10),
        );
        if (watched?.id === this.localId)
          this.aim = this.aimPoint.set(
            pos.x + Math.sin(yaw) * 12,
            1.36,
            pos.z + Math.cos(yaw) * 12,
          );
      }
      for (const event of state.events)
        if (!this.seenEvents.has(event.id)) {
          this.seenEvents.add(event.id);
          const victim = this.robots.get(event.playerId);
          const attacker = event.attackerId ? this.robots.get(event.attackerId) : undefined;
          if (event.type === 'hit' && event.melee && victim && attacker) {
            const grinding = ['saw', 'drill', 'wedge'].includes(event.melee);
            if (grinding && victim.contactCooldown > 0) continue;
            victim.contactCooldown = grinding ? 0.09 : 0;
            victim.flash = grinding ? 0.035 : 0.09;
            const yaw = attacker.group.rotation.y;
            const relative = yaw - victim.group.rotation.y;
            const strength = grinding ? 0.035 : event.melee === 'hammer' ? 0.19 : 0.12;
            const direction = event.melee === 'hook' ? -1 : 1;
            victim.kick.set(
              Math.cos(relative) * strength * direction,
              -Math.sin(relative) * strength * direction,
            );
            if (event.melee === 'sweeper')
              victim.kick.set(Math.sin(relative) * strength, Math.cos(relative) * strength);
            if (event.melee === 'flipper') victim.kick.x = -0.2;
            victim.impact = Math.min(1.5, victim.impact + strength * 5);
            victim.impactAge = 0;
            // Hold only the attachment at its contact pose; driving and the server keep running.
            // Contact often arrives on the swing's first tick: slam in over 40 ms, then hold.
            if (!grinding) {
              attacker.meleeConnected = true;
              attacker.meleeHold = event.melee === 'hammer' ? 0.065 : 0.04;
              attacker.kick.x = -strength * 0.45;
              const pose = attachmentPose(attacker);
              if (pose) {
                attacker.slamFrom = pose[0][pose[1]];
                attacker.slam = SLAM;
              }
            }
            const a = attacker.group.position,
              b = victim.group.position;
            // Contact sits on the victim's scaled hull, at the attacker's scaled attachment height.
            const reach =
              (0.85 * victim.group.scale.x) / Math.max(0.001, Math.hypot(b.x - a.x, b.z - a.z));
            const cx = b.x - (b.x - a.x) * reach,
              cz = b.z - (b.z - a.z) * reach,
              cy = 0.95 * attacker.group.scale.x;
            this.effects.melee(cx, cz, yaw, event.melee, cy);
            this.wow.melee(cx, cz, event.melee, cy);
            if (watched && !grinding) {
              const proximity = Math.max(
                0,
                1 - Math.hypot(event.x - watched.x, event.z - watched.z) / 18,
              );
              this.shake = Math.min(0.24, this.shake + proximity * strength);
              if (event.melee === 'hammer') {
                this.hitStop = Math.max(this.hitStop, 0.06 * proximity);
                this.hitStopDelay = SLAM;
                this.punch = Math.min(1, this.punch + proximity);
              }
            }
            continue;
          }
          // Flame damage arrives every tick: throttle it to scorch embers without flares.
          if (
            event.type === 'hit' &&
            attacker?.top === 'flamethrower' &&
            event.reason !== 'collision' &&
            victim
          ) {
            if (victim.scorchCooldown > 0) continue;
            victim.scorchCooldown = 0.12;
            victim.flash = 0.035;
            this.effects.scorch(event.x, victim.group.scale.x, event.z);
            continue;
          }
          if (victim && (event.type === 'hit' || event.type === 'shot')) {
            victim.impact = Math.min(1.5, victim.impact + (event.type === 'hit' ? 0.9 : 0.35));
            victim.impactAge = 0;
          }
          const big = event.type === 'elimination' || event.type === 'explosion';
          const railHit = event.type === 'hit' && attacker?.top === 'railgun';
          if (event.type !== 'shot' && watched) {
            const proximity = Math.max(
              0,
              1 - Math.hypot(event.x - watched.x, event.z - watched.z) / 20,
            );
            this.shake = Math.min(0.24, this.shake + proximity * (big ? 0.24 : 0.16));
            if (big || railHit) {
              this.hitStop = Math.max(this.hitStop, (big ? 0.09 : 0.05) * proximity);
              this.punch = Math.min(1, this.punch + proximity * (big ? 1 : 0.6));
            }
          }
          if (event.type === 'shot' && victim) {
            const tip = victim.muzzle.getWorldPosition(this.muzzlePoint);
            this.effects.shot(tip.x, tip.y, tip.z, victim.group.rotation.y, victim.top);
            const kick = SHOT_HEAT[victim.top];
            victim.heat = Math.min(1, victim.heat + kick);
            // Firing jolts your own camera a little.
            if (watched?.id === event.playerId)
              this.shake = Math.min(0.24, this.shake + kick * 0.2);
          } else {
            const y = victim?.group.scale.x ?? 1;
            this.effects.impact(
              event.x,
              event.z,
              big,
              y,
              event.type === 'hit' && event.reason !== 'collision' ? attacker?.top : undefined,
            );
            this.wow.impact(event.x, event.z, event.type, y);
          }
        }
      if (this.seenEvents.size > 2000) this.seenEvents = new Set(state.events.map((e) => e.id));
      // The results snapshot freezes shots mid-flight; hide them rather than leave glowing orbs hanging.
      this.effects.sync(
        state.phase === 'results' ? [] : state.projectiles,
        (id) => this.robots.get(id)?.muzzle.getWorldPosition(this.muzzlePoint).y ?? 1.35,
      );
    } else {
      // Free the finished match's robots instead of keeping them on the GPU in menus.
      for (const r of this.robots.values()) this.removeRobot(r);
      this.robots.clear();
      this.effects.clear();
      this.wow.clear();
      this.previewRobot.group.rotation.y = -0.65 + Math.sin(time * 0.22) * 0.16;
      // Shift the preview into the right quarter, keeping long attachments clear of the garage cards.
      this.camera.setViewOffset(width, height, -width * 0.3, 0, width, height);
      // Each menu screen has its own hero framing [orbit angle, radius, height, look-at height];
      // a slow orbit keeps it alive and the lerp dollies between screens.
      const poses: Record<string, readonly [number, number, number, number]> = {
          name: [0.95, 10, 1.7, 2.1],
          home: [0.73, 9.6, 2.3, 1.25],
          garage: [0.35, 6.8, 2.6, 0.7],
          play: [1.15, 9, 3.4, 1],
          lobby: [0.2, 8.4, 1.5, 1.4],
        },
        [angle, radius, camY, lookY] = poses[
          document.querySelector('.shell')?.classList[1] ?? ''
        ] ?? [1.3, 12, 4, 1.2],
        orbit = angle + Math.sin(time * 0.07) * 0.18,
        reach = radius + Math.sin(time * 0.11) * 0.4;
      this.camera.position.lerp(
        this.goal.set(
          Math.sin(orbit) * reach,
          camY + Math.sin(time * 0.09) * 0.15,
          Math.cos(orbit) * reach,
        ),
        0.04,
      );
      this.target.lerp(this.goal.set(0, lookY, 0), 0.04);
      this.animateRobot(this.previewRobot, undefined, time, dt);
    }
    this.finale.step(
      dt,
      this.robots.get(this.finale.victimId ?? '')?.group,
      this.camera,
      this.target,
    );
    if (this.finale.active) this.aim = null;
    this.effects.step(dt * this.timeScale);
    this.wow.step(dt * this.timeScale);
    if (this.hitStopDelay > 0) this.hitStopDelay = Math.max(0, this.hitStopDelay - dt);
    else this.hitStop = Math.max(0, this.hitStop - dt);
    this.timeScale = this.hitStop > 0 && this.hitStopDelay === 0 ? 0.1 : 1;
    this.shake *= Math.exp(-dt * 13);
    this.punch *= Math.exp(-dt * 9);
    const fov = FOV * (1 - (combat && this.shakeEnabled ? this.punch * 0.05 : 0));
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(this.target);
    // Offset only the rendered view, avoiding drift in the follow-camera position.
    if (combat && this.shakeEnabled) {
      this.camera.rotateX(Math.sin(time * 73) * this.shake * 0.035);
      this.camera.rotateZ(Math.sin(time * 91) * this.shake * 0.025);
    }
    this.post.dof += ((combat ? 0 : 1) - this.post.dof) * 0.1;
    this.post.render();
  }
}
