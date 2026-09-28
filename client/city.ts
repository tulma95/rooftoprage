import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BAYS,
  FLOORS,
  type FacadeKind,
  SIGN_COUNT,
  cloudMap,
  facadeMaps,
  glowMap,
  horizonMaps,
  mulberry32,
  roofMap,
  screenAtlas,
  signAtlas,
} from './city-textures.js';
import { SUN_DIRECTION as SUN } from './post.js';
import { pbr } from './assets.js';

const STREET_Y = -130;
const BLOCK = 72;
const RINGS = 5;
const BAY = 3.2;
const FLOOR = 3.6;
const LOT = 50;
const CITY_EDGE = (RINGS + 0.5) * BLOCK;
const UP = new THREE.Vector3(0, 1, 0);
/** Downtown clusters shape the skyline; amplitude scales tower height. */
const DOWNTOWNS: [number, number, number][] = [
  [-240, -250, 1],
  [270, -160, 0.8],
  [-170, 250, 0.75],
  [290, 290, 0.6],
];

/** Accumulates triangles into one merged, vertex-coloured draw call. */
class Batch {
  private p: number[] = [];
  private n: number[] = [];
  private uv: number[] = [];
  private c: number[] = [];
  private v = new THREE.Vector3();
  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: THREE.Color): void {
    this.p.push(p.x, p.y, p.z);
    this.n.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.c.push(c.r, c.g, c.b);
  }
  /** Upright quad from a bottom-left origin; uv = [a, b, c, d] for bl, br, tr, tl. */
  face(
    o: THREE.Vector3,
    right: THREE.Vector3,
    w: number,
    h: number,
    uv: number[],
    c: THREE.Color,
    cTop = c,
    taper = 0,
  ): void {
    const n = new THREE.Vector3().crossVectors(right, UP);
    const a = o.clone(),
      b = o.clone().addScaledVector(right, w),
      cc = o
        .clone()
        .addScaledVector(right, w - taper)
        .addScaledVector(n, -taper)
        .addScaledVector(UP, h),
      d = o.clone().addScaledVector(right, taper).addScaledVector(n, -taper).addScaledVector(UP, h);
    const q = [a, b, cc, d];
    for (const i of [0, 1, 2, 0, 2, 3])
      this.vertex(q[i]!, n, uv[i * 2]!, uv[i * 2 + 1]!, i < 2 ? c : cTop);
  }
  top(x0: number, z0: number, x1: number, z1: number, y: number, s: number, c: THREE.Color): void {
    const q = [
      [x0, z1],
      [x1, z1],
      [x1, z0],
      [x0, z0],
    ];
    for (const i of [0, 1, 2, 0, 2, 3])
      this.vertex(this.v.set(q[i]![0]!, y, q[i]![1]!), UP, q[i]![0]! * s, q[i]![1]! * s, c);
  }
  geometry(g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color): void {
    const src = g.index ? g.toNonIndexed() : g;
    const pos = src.getAttribute('position'),
      nor = src.getAttribute('normal'),
      uv = src.getAttribute('uv');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const p = new THREE.Vector3(),
      n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.vertex(p, n, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, c);
    }
  }
  mesh(material: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

interface Tier {
  x: number;
  z: number;
  w: number;
  d: number;
  y0: number;
  y1: number;
}

const snap = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);
const box = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const cone = new THREE.ConeGeometry(1, 1, 12);
const needle = new THREE.ConeGeometry(1, 1, 10);
/** Unit box whose top slopes from full height at +x down to the base at -x. */
const wedge = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0 && p.getX(i) < 0) p.setY(i, -0.5);
  g.computeVertexNormals();
  return g;
})();
/** Half cylinder with its axis along z: a barrel vault sitting on y = 0. */
const vault = new THREE.CylinderGeometry(1, 1, 1, 18, 1, false, 0, Math.PI)
  .rotateX(Math.PI / 2)
  .rotateZ(Math.PI / 2);
const CRANE_BLOCK = [-3, -1] as const;
const SCREEN_BLOCK = [-3, -2] as const;
const RAIL_Z = -3.5 * BLOCK;
// Runs down a street canyon below the ring-2 roofline, so from the arena it reads as a street structure,
// not a beam across the sky.
const RAIL_Y = -80;
const CROWNS = ['deco', 'slant', 'helipad', 'masts', 'led', 'curved', 'needle'] as const;
const matrix = new THREE.Matrix4();
const place = (x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0) =>
  matrix.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(UP, ry),
    new THREE.Vector3(sx, sy, sz),
  );

/**
 * Blends the scanned concrete_wall PBR set into a procedural facade's wall pixels (rough areas of its
 * surface map; glass panes stay procedural). Scan tiles every ~4.5 x 5.4 m of the 16x16-cell facade
 * tile, off the window grid so repeats don't line up; a second, much larger sample adds stains.
 */
function scanned(
  material: THREE.MeshStandardMaterial,
  strength: number,
): THREE.MeshStandardMaterial {
  const uniforms = {
    scanDiff: { value: pbr('facade', 'diff') },
    scanNor: { value: pbr('facade', 'nor') },
    scanArm: { value: pbr('facade', 'arm') },
    scanStrength: { value: strength },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D scanDiff, scanNor, scanArm;
uniform float scanStrength;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec2 scanUv = vMapUv * vec2(11.3, 10.7);
float wallMask = scanStrength * smoothstep(0.55, 0.8, texture2D(roughnessMap, vRoughnessMapUv).g);
vec3 scanArmS = texture2D(scanArm, scanUv).rgb;
// Divide by the scan's mean so it adds grain and stains, not its own brown tone.
float scanLum = dot(texture2D(scanDiff, scanUv).rgb, vec3(0.3, 0.59, 0.11)) / 0.235;
float stain = dot(texture2D(scanDiff, vMapUv * vec2(1.37, 1.21) + 0.31).rgb, vec3(0.3, 0.59, 0.11)) / 0.235;
diffuseColor.rgb *= mix(1.0, clamp(scanLum, 0.3, 1.8) * mix(0.75, 1.15, clamp(stain * 0.5, 0.0, 1.0)) * mix(1.0, scanArmS.r, 0.6), wallMask);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, scanArmS.g, wallMask);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
mapN.xy *= normalScale;
mapN.xy += (texture2D(scanNor, scanUv).xy * 2.0 - 1.0) * wallMask * 1.3;
normal = normalize(tbn * mapN);`,
      );
  };
  return material;
}

/** Batched dusk skyline, streets and fixed-size moving traffic, independent of the simulation. */
export class City {
  readonly group = new THREE.Group();
  private rng = mulberry32(1337);
  private facades = new Map<FacadeKind, Batch>([
    ['glass', new Batch()],
    ['concrete', new Batch()],
    ['brick', new Batch()],
    ['office', new Batch()],
  ]);
  private roofs = new Batch();
  private props = new Batch();
  private glow = new Batch();
  private signs = new Batch();
  private beacons: THREE.Vector3[] = [];
  private signed = new Set<string>();
  /** One fire escape per brick building, consumed by the first face that takes it. */
  private escape = false;
  private towerIndex = 0;
  private propMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0.35,
  });
  /** Highest roof per block, so landmarks can sit on top. */
  private blockTop = new Map<string, number>();
  private crane = new THREE.Group();
  private train = new THREE.Group();
  private screen!: THREE.CanvasTexture;
  private lamps: THREE.Vector3[] = [];
  private cars: THREE.InstancedMesh;
  private headlights: THREE.InstancedMesh;
  private taillights: THREE.InstancedMesh;
  private traffic: { axis: boolean; line: number; dir: number; speed: number; phase: number }[] =
    [];
  private beaconMesh!: THREE.InstancedMesh;
  private beaconMaterial = new THREE.MeshBasicMaterial({ color: '#ff2a1a' });
  private glassMaterial!: THREE.MeshStandardMaterial;
  private horizon: THREE.MeshBasicMaterial[] = [];
  private clouds: THREE.Sprite[] = [];
  private aircraft = new THREE.Group();
  private strobe = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  private fogColor = new THREE.Color();

  constructor() {
    this.buildBlocks();
    this.buildLandmarks();
    this.buildStreets();
    this.buildMeshes();
    this.buildHorizon();
    this.buildHaze();
    this.buildClouds();
    this.buildAircraft();
    const TRAFFIC = 480;
    const carGeometry = mergeGeometries([
      box.clone().scale(1.9, 0.75, 4.4).translate(0, 0.55, 0),
      box.clone().scale(1.7, 0.6, 2.2).translate(0, 1.2, -0.3),
    ]);
    const lamp = (z: number, y: number) =>
      mergeGeometries([
        box.clone().scale(0.45, 0.22, 0.1).translate(-0.62, y, z),
        box.clone().scale(0.45, 0.22, 0.1).translate(0.62, y, z),
      ]);
    this.cars = new THREE.InstancedMesh(
      carGeometry,
      new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.35 }),
      TRAFFIC,
    );
    this.headlights = new THREE.InstancedMesh(
      lamp(2.21, 0.7),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.4, 4.2) }),
      TRAFFIC,
    );
    this.taillights = new THREE.InstancedMesh(
      lamp(-2.21, 0.75),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.25, 0.15) }),
      TRAFFIC,
    );
    const paints = ['#1b1d21', '#e6e4dc', '#8a8f94', '#6e1a1a', '#1d3552', '#c9a23a', '#2f4a3a'];
    const r = this.rng;
    for (let i = 0; i < TRAFFIC; i++) {
      this.traffic.push({
        axis: r() < 0.5,
        line: 2 + Math.floor(r() * (RINGS * 2 - 2)),
        dir: r() < 0.5 ? 1 : -1,
        speed: 7 + r() * 9,
        phase: r() * 1000,
      });
      this.cars.setColorAt(i, new THREE.Color(paints[Math.floor(r() * paints.length)]!));
    }
    for (const m of [this.cars, this.headlights, this.taillights]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.update(0);
  }

  private skyline(x: number, z: number): number {
    let f = 0;
    for (const [cx, cz, a] of DOWNTOWNS)
      f = Math.max(f, a * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * 130 ** 2)));
    return f;
  }

  private buildBlocks(): void {
    const r = this.rng;
    // Arena tower: its roof slab is drawn by the scene at y = 0.
    this.building(0, 0, 54.4, 54.4, 129.2, 'concrete', 0, true);
    this.props.geometry(box, place(0, STREET_Y + 0.15, 0, 62, 0.3, 62), new THREE.Color('#8d8a84'));
    // Neighbours sit just below the roof edge so the skyline and sky stay open from the arena.
    for (let bx = -RINGS; bx <= RINGS; bx++)
      for (let bz = -RINGS; bz <= RINGS; bz++) {
        if (!bx && !bz) continue;
        if (bx === CRANE_BLOCK[0] && bz === CRANE_BLOCK[1]) continue;
        const cx = bx * BLOCK,
          cz = bz * BLOCK,
          ring = Math.max(Math.abs(bx), Math.abs(bz)),
          f = this.skyline(cx, cz);
        this.props.geometry(
          box,
          place(cx, STREET_Y + 0.15, cz, LOT + 2, 0.3, LOT + 2),
          new THREE.Color('#8d8a84'),
        );
        if (ring === 1) {
          {
            const split = Math.abs(bx) ? 'x' : 'z';
            for (const s of [-1, 1]) {
              const v = r();
              const kind = v < 0.4 ? 'brick' : v < 0.7 ? 'concrete' : 'office';
              this.building(
                cx + (split === 'z' ? s * 12.5 : 0),
                cz + (split === 'x' ? s * 12.5 : 0),
                split === 'z' ? 22 : 46,
                split === 'x' ? 22 : 46,
                92 + r() * 30,
                kind,
                ring,
              );
            }
          }
          continue;
        }
        if (r() < 0.25 + f * 0.6) {
          // Towers grow with distance so they frame the horizon instead of walling it off.
          const cap = ring === 2 ? 124 : ring === 3 ? 140 : ring === 4 ? 190 : 400;
          const h = Math.min(cap, 95 + f * 190 * (0.45 + r() * 0.55) + r() * 45);
          const kind =
            h > 170
              ? r() < 0.75
                ? 'glass'
                : 'office'
              : r() < 0.45
                ? 'glass'
                : r() < 0.5
                  ? 'office'
                  : 'concrete';
          // Archetypes: slender supertall, broad mid-rise, tapered, or classic setback tower.
          const arch = r();
          if (ring >= 4 && arch < 0.22)
            this.building(
              cx,
              cz,
              17 + r() * 12,
              17 + r() * 12,
              240 + r() * 110,
              r() < 0.7 ? 'glass' : 'office',
              ring,
              false,
              r() < 0.5 ? 0.1 : 0,
            );
          else if (arch < 0.45)
            this.building(
              cx,
              cz,
              46 + r() * 4,
              42 + r() * 8,
              Math.min(h, 85 + r() * 50),
              kind,
              ring,
            );
          else if (arch < 0.62 && h > 150)
            this.building(cx, cz, 38 + r() * 8, 38 + r() * 8, h, kind, ring, false, 0.14);
          else this.building(cx, cz, 34 + r() * 14, 34 + r() * 14, h, kind, ring);
        } else {
          const quads = r() < 0.6;
          for (let i = 0; i < (quads ? 4 : 2); i++) {
            const sx = quads ? (i % 2 ? 1 : -1) : i ? 1 : -1,
              sz = quads ? (i < 2 ? 1 : -1) : 0;
            const h = 22 + r() * 70 + f * 60;
            const v = r();
            const kind =
              h < 60 && v < 0.6 ? 'brick' : v < 0.25 ? 'glass' : v < 0.55 ? 'office' : 'concrete';
            this.building(
              cx + sx * 12.5,
              cz + sz * 12.5,
              22 + r() * 2,
              quads ? 22 + r() * 2 : 44 + r() * 4,
              h,
              kind,
              ring,
            );
          }
        }
      }
  }

  private building(
    x: number,
    z: number,
    w: number,
    d: number,
    height: number,
    kind: FacadeKind,
    ring: number,
    arena = false,
    taperRatio = 0,
  ): void {
    const r = this.rng;
    w = snap(w, BAY);
    d = snap(d, BAY);
    const h = arena ? height : snap(height, FLOOR);
    const top = STREET_Y + h;
    const key = `${Math.round(x / BLOCK)},${Math.round(z / BLOCK)}`;
    this.blockTop.set(key, Math.max(this.blockTop.get(key) ?? -Infinity, top));
    const tiers: Tier[] = [];
    if (!arena && !taperRatio && h > 120 && r() < 0.7) {
      const steps = h > 190 && r() < 0.6 ? 3 : 2;
      let y = STREET_Y,
        tw = w,
        td = d;
      for (let s = 0; s < steps; s++) {
        const y1 =
          s === steps - 1
            ? top
            : STREET_Y + snap(h * (steps === 3 ? [0.55, 0.82][s]! : 0.68), FLOOR);
        tiers.push({ x, z, w: tw, d: td, y0: y, y1 });
        y = y1;
        tw = snap(tw * (0.68 + r() * 0.14), BAY);
        td = snap(td * (0.68 + r() * 0.14), BAY);
      }
    } else tiers.push({ x, z, w, d, y0: STREET_Y, y1: top });

    const tints: Record<FacadeKind, string[]> = {
      glass: ['#ffffff', '#cfe0ff', '#ffe0c0', '#cfe8dc', '#b8c4d8'],
      concrete: ['#ffffff', '#efe3d2', '#d6d6d6', '#c8beb0', '#e6d2bf'],
      brick: ['#ffffff', '#e0bca8', '#b89080', '#d8b89a'],
      office: ['#ffffff', '#d8dce2', '#e8dccb', '#c4c9d0'],
    };
    const tint = new THREE.Color(tints[kind][Math.floor(r() * tints[kind].length)]!);
    // Near blocks sit darker (and vary in value) so their silhouettes read against the bright horizon.
    // Position hash, not this.rng, so the layout stays identical.
    const hv = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    if (!arena)
      tint.multiplyScalar(ring <= 2 ? 0.4 + hv * 0.3 : ring === 3 ? 0.6 + hv * 0.25 : 0.85);
    const uOff = Math.floor(r() * BAYS) / BAYS,
      vOff = Math.floor(r() * FLOORS) / FLOORS;
    // Distant buildings vary window scale/spacing; some offices turn their ribbons into vertical strips.
    const far = ring >= 3 && !arena;
    const us = (far ? 0.65 + r() * 0.8 : 1) / (BAYS * BAY),
      vs = (far ? 0.75 + r() * 0.6 : 1) / (FLOORS * FLOOR);
    const rotate = far && kind === 'office' && r() < 0.5;
    const taper = Math.min(w, d) * taperRatio;
    const facade = this.facades.get(kind)!;
    // Street canyons fall into shadow; upper floors catch the low sun.
    const grade = (y: number) => 0.38 + 0.62 * THREE.MathUtils.smoothstep(y - STREET_Y, 0, 115);
    const roofTint = new THREE.Color().setHSL(0.08, 0.05, 0.55 + r() * 0.25);
    const coping = new THREE.Color('#d4d0c6');
    this.escape = kind === 'brick' && ring <= 3;
    const capTint = kind === 'brick' ? new THREE.Color('#9b8a78') : new THREE.Color('#a8a49c');
    for (const t of tiers) {
      const x0 = t.x - t.w / 2,
        x1 = t.x + t.w / 2,
        z0 = t.z - t.d / 2,
        z1 = t.z + t.d / 2;
      const faces: [THREE.Vector3, THREE.Vector3, number][] = [
        [new THREE.Vector3(x0, t.y0, z1), new THREE.Vector3(1, 0, 0), t.w],
        [new THREE.Vector3(x1, t.y0, z0), new THREE.Vector3(-1, 0, 0), t.w],
        [new THREE.Vector3(x1, t.y0, z1), new THREE.Vector3(0, 0, -1), t.d],
        [new THREE.Vector3(x0, t.y0, z0), new THREE.Vector3(0, 0, 1), t.d],
      ];
      const v0 = (t.y0 - STREET_Y) * vs + vOff,
        v1 = (t.y1 - STREET_Y) * vs + vOff;
      faces.forEach(([o, right, len], i) => {
        const u0 = uOff + i * 0.25,
          u1 = u0 + len * us;
        facade.face(
          o,
          right,
          len,
          t.y1 - t.y0,
          rotate ? [v0, u0, v0, u1, v1, u1, v1, u0] : [u0, v0, u1, v0, u1, v1, u0, v1],
          tint.clone().multiplyScalar(grade(t.y0)),
          tint.clone().multiplyScalar(grade(t.y1)),
          taper,
        );
        if (ring <= 2 && !taper) this.facadeDetail(o, right, len, t, kind, ring);
      });
      if (arena) continue;
      // A tapered tower's roof is the shrunken top of its sloped walls.
      const rt = { ...t, w: t.w - 2 * taper, d: t.d - 2 * taper };
      const rx0 = rt.x - rt.w / 2,
        rx1 = rt.x + rt.w / 2,
        rz0 = rt.z - rt.d / 2,
        rz1 = rt.z + rt.d / 2;
      this.roofs.top(rx0, rz0, rx1, rz1, t.y1, 0.05, roofTint);
      // Outset parapet cornice casts a crisp shadow line at every roof edge.
      const ph = 1.3;
      for (const [px, pz, sw, sd] of [
        [rt.x, rz0 + 0.1, rt.w + 1, 0.9],
        [rt.x, rz1 - 0.1, rt.w + 1, 0.9],
        [rx0 + 0.1, rt.z, 0.9, rt.d + 1],
        [rx1 - 0.1, rt.z, 0.9, rt.d + 1],
      ] as const) {
        this.props.geometry(box, place(px, t.y1 + ph / 2, pz, sw, ph, sd), capTint);
        // Light metal coping on top of the parapet: a crisp roofline trim.
        this.props.geometry(box, place(px, t.y1 + ph + 0.08, pz, sw + 0.2, 0.16, sd + 0.2), coping);
      }
    }
    if (arena) return;
    const top0 = tiers[tiers.length - 1]!;
    const last = { ...top0, w: top0.w - 2 * taper, d: top0.d - 2 * taper };
    this.crown(last, kind, ring, h, x, z);
  }

  /** Recognisable depth cues: a construction site with a tower crane, a rooftop video screen, a skyway. */
  private buildLandmarks(): void {
    const r = this.rng;
    const concrete = new THREE.Color('#9a958c'),
      yellow = new THREE.Color('#d39a1c'),
      steel = new THREE.Color('#34373b');
    // Construction site: finished lower floors, bare concrete frame above.
    const [bx, bz] = CRANE_BLOCK;
    const cx = bx * BLOCK,
      cz = bz * BLOCK,
      done = 18 * FLOOR,
      frame = 7;
    this.props.geometry(
      box,
      place(cx, STREET_Y + 0.15, cz, LOT + 2, 0.3, LOT + 2),
      new THREE.Color('#8d8a84'),
    );
    this.building(cx, cz, 38, 38, done, 'concrete', 3);
    const base = STREET_Y + snap(done, FLOOR);
    for (let f = 1; f <= frame; f++) {
      const y = base + f * FLOOR;
      if (f < frame) this.props.geometry(box, place(cx, y, cz, 38, 0.45, 38), concrete);
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          if (f <= frame - (Math.abs(i) + Math.abs(j) > 2 ? 2 : 0))
            this.props.geometry(
              box,
              place(cx + i * 9, y - FLOOR / 2, cz + j * 9, 0.8, FLOOR, 0.8),
              concrete,
            );
    }
    // Lattice tower-crane mast from the street.
    const mx = cx + 26,
      mz = cz + 26,
      // Jib stays below the arena roofline: from menu cams a jib against the sky reads as a stray beam.
      mastTop = base + frame * FLOOR + 14;
    const mh = mastTop - STREET_Y;
    for (const [ox, oz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const)
      this.props.geometry(box, place(mx + ox, STREET_Y + mh / 2, mz + oz, 0.25, mh, 0.25), yellow);
    for (let y = STREET_Y + 2; y < mastTop; y += 2.5)
      for (const ry of [0, Math.PI / 2])
        this.props.geometry(box, place(mx, y, mz, 2.2, 0.15, 2.2, ry + 0.05), yellow);
    // Rotating jib, counter-jib, cab and counterweight in their own mesh.
    const jib = new Batch();
    const jl = 62;
    for (const [oy, oz] of [
      [0, -0.9],
      [0, 0.9],
      [1.8, 0],
    ] as const)
      jib.geometry(box, place(jl / 2 - 10, oy, oz, jl + 16, 0.25, 0.25), yellow);
    for (let a = -12; a < jl; a += 2.4) jib.geometry(box, place(a, 0.9, 0, 0.15, 1.9, 1.8), yellow);
    jib.geometry(box, place(-10, -0.4, 0, 5, 3, 3.2), new THREE.Color('#5a5650'));
    jib.geometry(box, place(1.5, -1.8, 1.8, 2.4, 2.4, 2), new THREE.Color('#e0e0d8'));
    jib.geometry(box, place(0, 5, 0, 0.3, 8, 0.3), yellow);
    const trolley = jl * (0.4 + r() * 0.4);
    jib.geometry(box, place(trolley, -12, 0, 0.06, 24, 0.06), steel);
    jib.geometry(box, place(trolley, -24.5, 0, 2.2, 1.2, 2.2), steel);
    this.crane.add(jib.mesh(this.propMaterial));
    for (const p of [
      [0, 9.2, 0],
      [jl + 6, 0.5, 0],
      [-12, 1.5, 0],
    ] as const) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), this.beaconMaterial);
      light.position.set(p[0], p[1], p[2]);
      this.crane.add(light);
    }
    this.crane.position.set(mx, mastTop + 0.5, mz);
    this.group.add(this.crane);

    // Rooftop video screen facing the arena.
    const [sx, sz] = SCREEN_BLOCK;
    const top = this.blockTop.get(`${sx},${sz}`) ?? STREET_Y + 100;
    const ry = Math.atan2(-sx, -sz);
    const w = 34,
      h = 19;
    const px = sx * BLOCK,
      pz = sz * BLOCK,
      y = top + 12;
    const out = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry)),
      side = new THREE.Vector3(out.z, 0, -out.x);
    this.props.geometry(box, place(px, y + h / 2, pz, w + 1.2, h + 1.2, 0.8, ry), steel);
    for (const s of [-0.4, 0, 0.4]) {
      const leg = new THREE.Vector3(px, 0, pz)
        .addScaledVector(side, s * w)
        .addScaledVector(out, -1.5);
      this.props.geometry(
        box,
        place(leg.x, top + (y + 2 - top) / 2, leg.z, 0.5, y + 2 - top, 0.5, ry),
        steel,
      );
    }
    this.screen = screenAtlas();
    this.screen.repeat.set(1, 1 / 3);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: this.screen, color: new THREE.Color(2, 2, 2) }),
    );
    panel.position.copy(new THREE.Vector3(px, y + h / 2, pz).addScaledVector(out, 0.45));
    panel.rotation.y = ry;
    this.group.add(panel);

    // Elevated skyway along one avenue, with a lit train.
    const span = CITY_EDGE * 2;
    this.props.geometry(
      box,
      place(0, RAIL_Y - 0.8, RAIL_Z, span, 1.6, 7),
      new THREE.Color('#5c5a58'),
    );
    for (const s of [-1, 1])
      this.props.geometry(box, place(0, RAIL_Y + 0.4, RAIL_Z + s * 3.3, span, 0.8, 0.3), steel);
    for (let x = -CITY_EDGE + 18; x < CITY_EDGE; x += BLOCK / 2) {
      const ph = RAIL_Y - 1.6 - STREET_Y;
      this.props.geometry(
        box,
        place(x, STREET_Y + ph / 2, RAIL_Z, 2.2, ph, 2.2),
        new THREE.Color('#6d6a66'),
      );
      this.props.geometry(
        box,
        place(x, RAIL_Y - 2.2, RAIL_Z, 1.4, 1.2, 8),
        new THREE.Color('#6d6a66'),
      );
    }
    const body = new Batch(),
      lit = new Batch();
    for (let c = 0; c < 6; c++) {
      const x = -c * 15;
      body.geometry(box, place(x, 1.9, 0, 14.4, 3.4, 3), new THREE.Color('#c8ccd0'));
      for (const s of [-1, 1])
        lit.geometry(box, place(x, 2.3, s * 1.52, 12.6, 1.1, 0.05), new THREE.Color(2.6, 2.1, 1.5));
    }
    lit.geometry(box, place(7.25, 1.2, 0, 0.1, 0.5, 2.2), new THREE.Color(8, 7.5, 6));
    lit.geometry(box, place(-5 * 15 - 7.25, 1.2, 0, 0.1, 0.5, 2.2), new THREE.Color(6, 0.3, 0.2));
    this.train.add(
      body.mesh(this.propMaterial),
      lit.mesh(new THREE.MeshBasicMaterial({ vertexColors: true })),
    );
    this.train.position.set(0, RAIL_Y, RAIL_Z);
    this.group.add(this.train);
  }

  /** Each tall tower gets the next crown in the rotation so no two neighbours share a top. */
  private landmarkCrown(t: Tier, r: () => number): void {
    const y = t.y1,
      metal = new THREE.Color('#7d8286'),
      dark = new THREE.Color('#3d4046'),
      stone = new THREE.Color('#cbbfa9');
    const hot = [
      new THREE.Color(3.2, 2.2, 1.2),
      new THREE.Color(1.1, 2.4, 3.6),
      new THREE.Color(3.2, 1, 2.4),
      new THREE.Color(1.4, 3.2, 2),
    ];
    const band = (yy: number, w: number, d: number, c: THREE.Color) =>
      this.glow.geometry(box, place(t.x, yy, t.z, w + 0.25, 0.35, d + 0.25), c);
    const mast = (x: number, z: number, base: number, mh: number, thick = 0.35) => {
      this.props.geometry(cylinder, place(x, base + mh / 2, z, thick, mh, thick), metal);
      this.beacons.push(new THREE.Vector3(x, base + mh + 0.4, z));
    };
    const style = CROWNS[this.towerIndex++ % CROWNS.length]!;
    switch (style) {
      case 'deco': {
        // Stepped art-deco ziggurat with lit setback edges and a needle.
        let ty = y,
          k = 1;
        for (const [f, sh] of [
          [0.8, 6],
          [0.6, 5],
          [0.42, 4],
          [0.26, 6],
        ] as const) {
          this.props.geometry(box, place(t.x, ty + sh / 2, t.z, t.w * f, sh, t.d * f), stone);
          band(ty + sh - 0.2, t.w * f, t.d * f, new THREE.Color(3, 2.3, 1.3).multiplyScalar(k));
          ty += sh;
          k *= 0.85;
        }
        mast(t.x, t.z, ty, 12 + r() * 10, 0.25);
        break;
      }
      case 'slant': {
        // Slanted glass roof rising across the tower.
        const rise = Math.min(t.w, t.d) * (0.45 + r() * 0.3);
        this.props.geometry(
          wedge,
          place(t.x, y + rise / 2, t.z, t.w, rise, t.d, r() < 0.5 ? 0 : Math.PI / 2),
          new THREE.Color('#415062'),
        );
        this.beacons.push(new THREE.Vector3(t.x + t.w / 2, y + rise + 0.4, t.z));
        break;
      }
      case 'helipad': {
        this.props.geometry(box, place(t.x, y + 2, t.z, t.w * 0.7, 4, t.d * 0.7), dark);
        const pr = Math.min(t.w, t.d) * 0.38;
        this.props.geometry(
          cylinder,
          place(t.x, y + 4.3, t.z, pr, 0.6, pr),
          new THREE.Color('#2c2e31'),
        );
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          this.glow.geometry(
            box,
            place(t.x + Math.cos(a) * pr, y + 4.7, t.z + Math.sin(a) * pr, 0.5, 0.25, 0.5),
            new THREE.Color(1, 3.4, 1.2),
          );
        }
        // Maintenance derrick crane on the roof edge.
        const cx = t.x - t.w * 0.4,
          cz = t.z - t.d * 0.4;
        const yellow = new THREE.Color('#c7911c');
        this.props.geometry(box, place(cx, y + 7, cz, 0.8, 14, 0.8), yellow);
        this.props.geometry(box, place(cx + 5, y + 13.5, cz, 11, 0.6, 0.6, 0.4), yellow);
        this.beacons.push(new THREE.Vector3(cx, y + 14.6, cz));
        break;
      }
      case 'masts': {
        this.props.geometry(box, place(t.x, y + 3, t.z, t.w * 0.5, 6, t.d * 0.5), dark);
        for (let i = 0; i < 4; i++)
          mast(
            t.x + (r() - 0.5) * t.w * 0.4,
            t.z + (r() - 0.5) * t.d * 0.4,
            y + 6,
            10 + r() * 34,
            0.2 + r() * 0.3,
          );
        break;
      }
      case 'led': {
        // Flat top wrapped in LED crown bands, with light strips running down the corners.
        const c = hot[Math.floor(r() * hot.length)]!;
        for (let i = 0; i < 4; i++)
          band(y - 0.5 - i * 2.4, t.w, t.d, c.clone().multiplyScalar(1 - i * 0.18));
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const)
          this.glow.geometry(
            box,
            place(
              t.x + (sx * (t.w + 0.2)) / 2,
              y - 20,
              t.z + (sz * (t.d + 0.2)) / 2,
              0.35,
              40,
              0.35,
            ),
            c.clone().multiplyScalar(0.6),
          );
        mast(t.x, t.z, y, 8);
        break;
      }
      case 'curved': {
        // Barrel-vaulted metal roof.
        const rise = Math.min(t.w, t.d) * 0.35;
        this.props.geometry(
          vault,
          place(t.x, y, t.z, t.w / 2, rise, t.d, r() < 0.5 ? 0 : Math.PI / 2),
          metal,
        );
        this.beacons.push(new THREE.Vector3(t.x, y + rise + 0.4, t.z));
        break;
      }
      default: {
        // Needle: thin round spire on a drum.
        this.props.geometry(cylinder, place(t.x, y + 3, t.z, t.w * 0.3, 6, t.w * 0.3), stone);
        band(y + 5.8, t.w * 0.6, t.w * 0.6, hot[0]!);
        const nh = 30 + r() * 25;
        this.props.geometry(needle, place(t.x, y + 6 + nh / 2, t.z, 1.4, nh, 1.4), metal);
        this.beacons.push(new THREE.Vector3(t.x, y + 6 + nh + 0.3, t.z));
      }
    }
  }

  /** Real geometry relief for nearby facades: glass fins, concrete ledges, lit shopfronts. */
  private facadeDetail(
    o: THREE.Vector3,
    right: THREE.Vector3,
    len: number,
    t: Tier,
    kind: FacadeKind,
    ring: number,
  ): void {
    const r = this.rng;
    const out = new THREE.Vector3().crossVectors(right, UP);
    const ry = Math.atan2(out.x, out.z);
    const h = t.y1 - t.y0;
    const at = (along: number, y: number, depth: number) =>
      o.clone().addScaledVector(right, along).addScaledVector(out, depth).setY(y);
    const slab = (
      along: number,
      y: number,
      depth: number,
      w: number,
      sh: number,
      sd: number,
      c: THREE.Color,
    ) => {
      const p = at(along, y, depth);
      this.props.geometry(box, place(p.x, p.y, p.z, w, sh, sd, ry), c);
    };
    const floor0 = t.y0 + FLOOR * (t.y0 === STREET_Y ? 2 : 0);
    if (kind === 'glass') {
      const fin = new THREE.Color('#353a40');
      for (let a = BAY * 2; a < len - 0.1; a += BAY * 2)
        slab(a, t.y0 + h / 2, 0.45, 0.3, h, 0.9, fin);
    } else if (kind === 'office') {
      // Protruding floor slabs at every storey, with deeper sunshades every fourth.
      const edge = new THREE.Color('#8f9398');
      for (let y = floor0, n = 0; y < t.y1 - 1; y += FLOOR, n++)
        slab(len / 2, y, n % 4 ? 0.35 : 0.8, len + 0.6, n % 4 ? 0.3 : 0.2, n % 4 ? 0.7 : 1.6, edge);
      for (let a = BAY * 4; a < len - 0.1; a += BAY * 4)
        slab(a, t.y0 + h / 2, 0.3, 0.5, h, 0.6, edge);
    } else if (kind === 'concrete') {
      const ledge = new THREE.Color('#9d978c');
      if (ring <= 2 && r() < 0.6) {
        // Stacked balconies on alternating floors with dark glass railings.
        const slabColor = new THREE.Color('#b3ada2'),
          rail = new THREE.Color('#3c4248');
        const start = Math.floor(r() * 3);
        for (let y = floor0, n = 0; y < t.y1 - FLOOR; y += FLOOR, n++) {
          if (n % 2) continue;
          for (let b = start; b * BAY + BAY * 1.5 < len; b += 3) {
            const a = (b + 1) * BAY;
            slab(a, y, 0.65, BAY * 1.7, 0.25, 1.3, slabColor);
            slab(a, y + 0.6, 1.28, BAY * 1.7, 1, 0.08, rail);
          }
        }
      } else
        for (let y = t.y0 + FLOOR * 6; y < t.y1 - 2; y += FLOOR * 6)
          slab(len / 2, y - 0.25, 0.2, len + 0.4, 0.4, 0.4, ledge);
    } else {
      // Brick: pilasters, belt courses and a cast-iron fire escape.
      const ledge = new THREE.Color('#b6a892');
      for (let y = t.y0 + FLOOR * 4; y < t.y1 - 2; y += FLOOR * 4)
        slab(len / 2, y - 0.25, 0.2, len + 0.4, 0.4, 0.4, ledge);
      const pier = new THREE.Color('#7e4a3a');
      for (let a = BAY * 4; a < len - 0.1; a += BAY * 4)
        slab(a, t.y0 + h / 2, 0.18, 0.8, h, 0.36, pier);
      if (this.escape && r() < 0.6) {
        this.escape = false;
        const iron = new THREE.Color('#2b2725');
        const a0 = (Math.floor(r() * Math.max(1, len / BAY - 3)) + 1) * BAY + BAY,
          span = BAY * 2;
        const tilt = Math.atan2(FLOOR, span * 0.75);
        for (let y = floor0, n = 0; y < t.y1 - FLOOR; y += FLOOR, n++) {
          slab(a0, y + 0.05, 0.8, span, 0.12, 1.5, iron);
          slab(a0, y + 0.5, 1.52, span, 0.9, 0.05, iron);
          const p = at(a0, y + FLOOR / 2, 1.1);
          matrix.compose(
            p,
            new THREE.Quaternion()
              .setFromAxisAngle(UP, ry)
              .multiply(
                new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(0, 0, 1),
                  n % 2 ? tilt : -tilt,
                ),
              ),
            new THREE.Vector3(Math.hypot(FLOOR, span * 0.75), 0.12, 0.5),
          );
          this.props.geometry(box, matrix, iron);
        }
        for (const side of [-1, 1])
          slab(
            a0 + side * span * 0.5,
            floor0 + (t.y1 - FLOOR - floor0) / 2,
            1.52,
            0.08,
            t.y1 - FLOOR - floor0,
            0.08,
            iron,
          );
      }
    }
    if (t.y0 === STREET_Y && r() < 0.7) {
      // Ground-floor shops and awnings glow at street level.
      const w = len * (0.5 + r() * 0.4);
      const p = at(len / 2, STREET_Y + 2.2, 0.12);
      const shop = new THREE.Color(
        ...(
          [
            [2.4, 1.6, 0.8],
            [1.2, 2, 2.4],
            [2.6, 1.2, 1.4],
          ] as const
        )[Math.floor(r() * 3)]!,
      );
      this.glow.geometry(box, place(p.x, p.y, p.z, w, 3, 0.1, ry), shop);
      const awn = at(len / 2, STREET_Y + 4.1, 1);
      this.props.geometry(
        box,
        place(awn.x, awn.y, awn.z, w, 0.25, 2, ry),
        new THREE.Color().setHSL(r(), 0.35, 0.25),
      );
    }
  }

  private crown(t: Tier, kind: FacadeKind, ring: number, h: number, bx: number, bz: number): void {
    const r = this.rng;
    const y = t.y1;
    const dark = new THREE.Color('#4a4d52'),
      metal = new THREE.Color('#7d8286');
    const rand = (span: number) => (r() - 0.5) * span;
    const tall = h > 150;
    if (tall) {
      this.landmarkCrown(t, r);
      return;
    }
    if (ring > 3) return;
    // Low roofs: HVAC, bulkheads, water tanks, vents; this is what players see past the edge.
    const inset = (s: number, room: number) => rand(Math.max(0, s - room));
    this.props.geometry(
      box,
      place(t.x + inset(t.w, 8), y + 1.8, t.z + inset(t.d, 8), 5, 3.6, 4),
      new THREE.Color('#8f8a80'),
    );
    for (let i = 0; i < 2 + r() * 5; i++) {
      const sw = 2 + r() * 3.5,
        sh = 1 + r() * 1.6,
        sd = 1.6 + r() * 3;
      this.props.geometry(
        box,
        place(t.x + inset(t.w, sw + 2), y + sh / 2, t.z + inset(t.d, sd + 2), sw, sh, sd),
        new THREE.Color().setHSL(0.55, 0.05, 0.28 + r() * 0.18),
      );
    }
    for (let i = 0; i < 3; i++)
      this.props.geometry(
        cylinder,
        place(t.x + inset(t.w, 3), y + 0.8, t.z + inset(t.d, 3), 0.35, 1.6, 0.35),
        metal,
      );
    if (ring <= 2) {
      // Louvred mechanical penthouse.
      const pw = Math.min(t.w * 0.4, 12),
        pd = Math.min(t.d * 0.35, 9);
      const px = t.x + inset(t.w, pw + 4),
        pz = t.z + inset(t.d, pd + 4);
      this.props.geometry(box, place(px, y + 2.4, pz, pw, 4.8, pd), new THREE.Color('#9a958c'));
      this.props.geometry(
        box,
        place(px, y + 2.6, pz, pw + 0.12, 2.2, pd + 0.12),
        new THREE.Color('#4d5156'),
      );
      this.props.geometry(
        box,
        place(px, y + 4.9, pz, pw + 0.5, 0.25, pd + 0.5),
        new THREE.Color('#c4bfb4'),
      );
    }
    if (kind !== 'glass' && r() < (ring <= 2 ? 0.7 : 0.5)) {
      const tx = t.x + inset(t.w, 8),
        tz = t.z + inset(t.d, 8);
      const wood = new THREE.Color('#6b4a33');
      for (const [lx, lz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        this.props.geometry(
          box,
          place(tx + lx * 1.5, y + 1.6, tz + lz * 1.5, 0.25, 3.2, 0.25),
          dark,
        );
      this.props.geometry(cylinder, place(tx, y + 5.2, tz, 2.3, 4, 2.3), wood);
      this.props.geometry(cone, place(tx, y + 7.9, tz, 2.5, 1.4, 2.5), new THREE.Color('#3b3634'));
    }
    if (r() < 0.25) {
      const mh = 6 + r() * 8;
      const ax = t.x + inset(t.w, 4),
        az = t.z + inset(t.d, 4);
      this.props.geometry(cylinder, place(ax, y + mh / 2, az, 0.12, mh, 0.12), metal);
      this.beacons.push(new THREE.Vector3(ax, y + mh + 0.3, az));
    }
    // Neon rooftop billboard facing the arena.
    const block = `${Math.round(bx / BLOCK)},${Math.round(bz / BLOCK)}`;
    if (ring <= 2 && !this.signed.has(block) && r() < 0.45) {
      this.signed.add(block);
      this.billboard(t, bx, bz);
    } else if (ring <= 2 && r() < 0.35) this.frame(t, bx, bz);
    else if (kind !== 'glass' && r() < 0.35) this.blade(t, bx, bz);
  }

  /** Unlit steel billboard: faded panel on a braced lattice, seen from behind or the side. */
  private frame(t: Tier, bx: number, bz: number): void {
    const r = this.rng;
    const [corner, right, len, out] = this.facing(t, bx, bz);
    const w = Math.min(len * 0.7, 16),
      h = w * 0.4;
    const mid = corner
      .clone()
      .addScaledVector(right, len / 2)
      .addScaledVector(out, -4 - r() * 6);
    const ry = Math.atan2(out.x, out.z);
    const steel = new THREE.Color('#3a3835');
    const y = t.y1 + 3;
    this.props.geometry(
      box,
      place(mid.x, y + h / 2, mid.z, w, h, 0.3, ry),
      new THREE.Color().setHSL(r(), 0.25, 0.35 + r() * 0.2),
    );
    for (let i = 0; i <= 4; i++) {
      const leg = mid
        .clone()
        .addScaledVector(right, (i / 4 - 0.5) * w * 0.9)
        .addScaledVector(out, -0.5);
      this.props.geometry(
        box,
        place(leg.x, t.y1 + (y + h - t.y1) / 2, leg.z, 0.25, y + h - t.y1, 0.25, ry),
        steel,
      );
    }
    for (const dy of [0.3, h * 0.5, h - 0.3]) {
      const rail = mid.clone().addScaledVector(out, -0.5);
      this.props.geometry(box, place(rail.x, y + dy, rail.z, w, 0.18, 0.18, ry), steel);
    }
    const walk = mid.clone().addScaledVector(out, 0.8);
    this.props.geometry(box, place(walk.x, y - 0.1, walk.z, w, 0.12, 1.2, ry), steel);
  }

  private signUv(i: number, rotated: boolean): number[] {
    const u0 = (i % 2) * 0.5,
      u1 = u0 + 0.5,
      vt = 1 - Math.floor(i / 2) / 3,
      vb = vt - 1 / 3;
    // bl, br, tr, tl; rotated runs the lettering top-to-bottom for vertical blades.
    return rotated ? [u1, vb, u1, vt, u0, vt, u0, vb] : [u0, vb, u1, vb, u1, vt, u0, vt];
  }

  /** Face of the tier that looks most toward the arena: origin corner, right vector, length. */
  private facing(
    t: Tier,
    bx: number,
    bz: number,
  ): [THREE.Vector3, THREE.Vector3, number, THREE.Vector3] {
    if (Math.abs(bx) >= Math.abs(bz)) {
      const s = bx > 0 ? -1 : 1;
      return [
        new THREE.Vector3(t.x + (s * t.w) / 2, 0, t.z + (s * t.d) / 2),
        new THREE.Vector3(0, 0, -s),
        t.d,
        new THREE.Vector3(s, 0, 0),
      ];
    }
    const s = bz > 0 ? -1 : 1;
    return [
      new THREE.Vector3(t.x - (s * t.w) / 2, 0, t.z + (s * t.d) / 2),
      new THREE.Vector3(s, 0, 0),
      t.w,
      new THREE.Vector3(0, 0, s),
    ];
  }

  private billboard(t: Tier, bx: number, bz: number): void {
    const [corner, right, len, out] = this.facing(t, bx, bz);
    const w = Math.min(len * 0.75, 20),
      h = w / 3;
    const o = corner
      .clone()
      .addScaledVector(right, (len - w) / 2)
      .addScaledVector(out, -3);
    o.y = t.y1 + 2.5;
    this.signs.face(
      o,
      right,
      w,
      h,
      this.signUv(Math.floor(this.rng() * SIGN_COUNT), false),
      new THREE.Color(1, 1, 1),
    );
    const mid = o
      .clone()
      .addScaledVector(right, w / 2)
      .addScaledVector(out, -0.3);
    const ry = Math.atan2(out.x, out.z);
    const frame = new THREE.Color('#2a2a2e');
    this.props.geometry(box, place(mid.x, o.y + h / 2, mid.z, w + 0.6, h + 0.6, 0.5, ry), frame);
    for (const s of [-0.35, 0.35]) {
      const leg = mid.clone().addScaledVector(right, s * w);
      this.props.geometry(box, place(leg.x, t.y1 + 1.25, leg.z, 0.4, 2.5, 0.4), frame);
    }
  }

  private blade(t: Tier, bx: number, bz: number): void {
    const [corner, right, len, out] = this.facing(t, bx, bz);
    const h = Math.min(18, (t.y1 - t.y0) * 0.3),
      w = h / 3;
    const along = len * (0.15 + this.rng() * 0.7);
    const base = corner.clone().addScaledVector(right, along);
    base.y = t.y1 - h - 4;
    const uv = this.signUv(Math.floor(this.rng() * SIGN_COUNT), true);
    // Two faces so it reads from both sides of the street.
    this.signs.face(
      base.clone().addScaledVector(out, 0.35),
      out,
      w,
      h,
      uv,
      new THREE.Color(1, 1, 1),
    );
    const back = base.clone().addScaledVector(out, w + 0.35);
    this.signs.face(back, out.clone().negate(), w, h, uv, new THREE.Color(1, 1, 1));
  }

  private buildStreets(): void {
    const r = this.rng;
    const lampColor = new THREE.Color(5, 3.1, 1.3),
      pole = new THREE.Color('#2b2d30');
    for (let k = -RINGS - 1; k <= RINGS; k++) {
      const line = (k + 0.5) * BLOCK;
      for (let b = -RINGS; b <= RINGS; b++)
        for (const o of [-17, 0, 17])
          for (const side of [-1, 1])
            for (const axis of [true, false]) {
              const along = b * BLOCK + o,
                lateral = line + side * 10.3;
              const x = axis ? lateral : along,
                z = axis ? along : lateral;
              if (Math.hypot(x, z) > 330 || r() < 0.08) continue;
              const hx = axis ? -side * 1.7 : 0,
                hz = axis ? 0 : -side * 1.7;
              this.props.geometry(box, place(x, STREET_Y + 3.5, z, 0.3, 7, 0.3), pole);
              this.props.geometry(
                box,
                place(
                  x + hx / 2,
                  STREET_Y + 7,
                  z + hz / 2,
                  axis ? 1.8 : 0.2,
                  0.2,
                  axis ? 0.2 : 1.8,
                ),
                pole,
              );
              this.glow.geometry(
                box,
                place(x + hx, STREET_Y + 6.85, z + hz, axis ? 1.2 : 0.55, 0.2, axis ? 0.55 : 1.2),
                lampColor,
              );
              this.lamps.push(new THREE.Vector3(x + hx * 1.6, STREET_Y + 0.09, z + hz * 1.6));
            }
    }
  }

  private buildMeshes(): void {
    const facadeMaterial = (kind: FacadeKind, seed: number) => {
      const maps = facadeMaps(kind, seed);
      return new THREE.MeshStandardMaterial({
        map: maps.map,
        emissiveMap: maps.emissive,
        emissive: '#ffffff',
        emissiveIntensity: kind === 'glass' ? 1.7 : 1.9,
        roughnessMap: maps.surface,
        normalMap: maps.normal,
        normalScale: new THREE.Vector2(1.4, 1.4),
        metalnessMap: maps.surface,
        roughness: 1,
        metalness: 1,
        vertexColors: true,
      });
    };
    this.glassMaterial = facadeMaterial('glass', 11);
    this.glassMaterial.normalScale.set(1, 1);
    this.group.add(
      this.facades.get('glass')!.mesh(this.glassMaterial),
      this.facades.get('concrete')!.mesh(scanned(facadeMaterial('concrete', 22), 1)),
      this.facades.get('brick')!.mesh(facadeMaterial('brick', 33)),
      this.facades.get('office')!.mesh(scanned(facadeMaterial('office', 44), 0.7)),
      this.roofs.mesh(
        new THREE.MeshStandardMaterial({ map: roofMap(5), vertexColors: true, roughness: 0.95 }),
      ),
      this.props.mesh(this.propMaterial),
      this.glow.mesh(new THREE.MeshBasicMaterial({ vertexColors: true })),
      this.signs.mesh(
        new THREE.MeshBasicMaterial({ map: signAtlas(), color: new THREE.Color(2.6, 2.6, 2.6) }),
      ),
    );
    // Asphalt ground far past the blocks so the street never ends at a visible edge.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.8, metalness: 0.15 }),
    );
    ground.position.y = STREET_Y;
    // Dashed centre lines.
    const dashes: THREE.Matrix4[] = [];
    for (let k = -RINGS - 1; k <= RINGS; k++)
      for (let n = -CITY_EDGE; n <= CITY_EDGE; n += 9)
        for (const axis of [true, false]) {
          const line = (k + 0.5) * BLOCK;
          const m = (((n - BLOCK / 2) % BLOCK) + BLOCK) % BLOCK;
          if (Math.min(m, BLOCK - m) < 12) continue;
          dashes.push(
            place(
              axis ? line : n,
              STREET_Y + 0.03,
              axis ? n : line,
              axis ? 0.25 : 3.5,
              0.02,
              axis ? 3.5 : 0.25,
            ).clone(),
          );
        }
    const lanes = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: '#b8b098', roughness: 0.7 }),
      dashes.length,
    );
    dashes.forEach((m, i) => lanes.setMatrixAt(i, m));
    // Sodium light pools under every lamp.
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glowMap(),
        color: new THREE.Color(1.6, 0.95, 0.45),
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      }),
      this.lamps.length,
    );
    this.lamps.forEach((p, i) => pools.setMatrixAt(i, place(p.x, p.y, p.z, 13, 1, 13)));
    this.beaconMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.75, 8, 6),
      this.beaconMaterial,
      this.beacons.length,
    );
    this.beacons.forEach((p, i) => this.beaconMesh.setMatrixAt(i, place(p.x, p.y, p.z, 1, 1, 1)));
    this.group.add(ground, lanes, pools, this.beaconMesh);
  }

  private buildHorizon(): void {
    // Two parallax rings of endless city beyond the modelled blocks, tinted to the haze each frame.
    const [silhouette, lights] = horizonMaps(99);
    // Far hazy -> mid -> near-dark silhouette layers, each a little darker and more lit.
    for (const [radius, repeat, offset, shade, glow] of [
      [610, 3, 0, 1, 0.3],
      [540, 4, 0.37, 0.84, 0.4],
      [470, 5, 0.71, 0.66, 0.55],
    ] as const) {
      const height = 200;
      const geometry = new THREE.CylinderGeometry(radius, radius, height, 96, 1, true);
      const s = silhouette.clone(),
        l = lights.clone();
      s.repeat.x = l.repeat.x = repeat;
      s.offset.x = l.offset.x = offset;
      const material = new THREE.MeshBasicMaterial({
        map: s,
        transparent: true,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      });
      const lit = new THREE.MeshBasicMaterial({
        map: l,
        transparent: true,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: glow,
      });
      material.userData.shade = shade;
      this.horizon.push(material);
      for (const m of [material, lit]) {
        const mesh = new THREE.Mesh(geometry, m);
        mesh.position.y = 70 - height / 2;
        mesh.renderOrder = radius > 600 ? -4 : radius > 500 ? -3 : -2;
        this.group.add(mesh);
      }
    }
  }

  /** Low-lying haze shells: the street canyons dissolve layer by layer with distance. */
  private buildHaze(): void {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 128;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0.8)');
    x.fillStyle = g;
    x.fillRect(0, 0, 1, 128);
    const map = new THREE.CanvasTexture(c);
    for (const [radius, height, opacity] of [
      [170, 70, 0.25],
      [290, 120, 0.32],
      [420, 170, 0.5],
    ] as const) {
      const material = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        opacity,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      });
      this.horizon.push(material);
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, height, 64, 1, true),
        material,
      );
      mesh.position.y = STREET_Y + height / 2;
      this.group.add(mesh);
    }
  }

  private buildClouds(): void {
    const r = this.rng;
    const maps = [cloudMap(3), cloudMap(8), cloudMap(21)];
    const lit = new THREE.Color('#ffc38e'),
      pink = new THREE.Color('#e89aa0'),
      shade = new THREE.Color('#9d93b8');
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + r() * 0.3,
        dist = 380 + r() * 180;
      const x = Math.sin(angle) * dist,
        z = Math.cos(angle) * dist;
      const toward = (Math.sin(angle) * SUN.x + Math.cos(angle) * SUN.z) / Math.hypot(SUN.x, SUN.z);
      const color = shade.clone().lerp(pink, THREE.MathUtils.clamp(toward + 0.6, 0, 1));
      if (toward > 0.3) color.lerp(lit, (toward - 0.3) * 1.4);
      const cloud = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: maps[i % 3]!,
          color: color.multiplyScalar(1.15),
          transparent: true,
          opacity: 0.55 + r() * 0.35,
          depthWrite: false,
          fog: false,
        }),
      );
      const w = 170 + r() * 150;
      cloud.scale.set(w, w * (0.28 + r() * 0.12), 1);
      cloud.position.set(x, 40 + r() * 110, z);
      cloud.userData.angle = angle;
      cloud.userData.dist = dist;
      cloud.renderOrder = -1;
      this.clouds.push(cloud);
      this.group.add(cloud);
    }
  }

  private buildAircraft(): void {
    const hull = new THREE.MeshStandardMaterial({
      color: '#b9c0c4',
      metalness: 0.6,
      roughness: 0.35,
    });
    for (const [sx, sy, sz, z] of [
      [0.9, 0.8, 6, 0],
      [7, 0.14, 1.3, 0.2],
      [2.4, 0.14, 0.7, -2.6],
      [0.12, 1.3, 0.9, -2.6],
    ] as const) {
      const part = new THREE.Mesh(box, hull);
      part.scale.set(sx, sy, sz);
      part.position.set(0, sy === 1.3 ? 0.7 : 0, z);
      this.aircraft.add(part);
    }
    const nav = (x: number, color: THREE.Color | THREE.MeshBasicMaterial) => {
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 6, 4),
        color instanceof THREE.Material ? color : new THREE.MeshBasicMaterial({ color }),
      );
      light.position.set(x, 0, 0.2);
      this.aircraft.add(light);
    };
    nav(3.5, new THREE.Color(0.4, 6, 0.8));
    nav(-3.5, new THREE.Color(6, 0.3, 0.2));
    nav(0, this.strobe);
    this.group.add(this.aircraft);
  }

  update(time: number): void {
    const edge = CITY_EDGE * 2;
    this.traffic.forEach((c, i) => {
      const line = (c.line - RINGS - 1 + 0.5) * BLOCK + c.dir * (i % 2 ? 6.3 : 2.6);
      const along = ((((c.phase + time * c.speed * c.dir) % edge) + edge) % edge) - CITY_EDGE;
      const yaw = c.axis ? (c.dir > 0 ? 0 : Math.PI) : (c.dir * Math.PI) / 2;
      matrix
        .makeRotationY(yaw)
        .setPosition(c.axis ? line : along, STREET_Y + 0.05, c.axis ? along : line);
      this.cars.setMatrixAt(i, matrix);
      this.headlights.setMatrixAt(i, matrix);
      this.taillights.setMatrixAt(i, matrix);
    });
    this.cars.instanceMatrix.needsUpdate = true;
    this.headlights.instanceMatrix.needsUpdate = true;
    this.taillights.instanceMatrix.needsUpdate = true;
    // Aviation beacons blink in unison, like a real skyline.
    const blink = time % 1.8 < 0.35 ? 7 : 0.25;
    this.beaconMaterial.color.setRGB(blink, blink * 0.06, blink * 0.03);
    this.strobe.color.setScalar(time % 1.2 < 0.08 ? 10 : 0);
    for (const cloud of this.clouds) {
      const a = (cloud.userData.angle as number) + time * 0.0025;
      const d = cloud.userData.dist as number;
      cloud.position.x = Math.sin(a) * d;
      cloud.position.z = Math.cos(a) * d;
    }
    this.crane.rotation.y = Math.sin(time * 0.05) * 1.2 + 0.6;
    this.screen.offset.y = (Math.floor(time / 4) % 3) / 3;
    const loop = CITY_EDGE * 2 + 100;
    this.train.position.x = ((time * 22) % loop) - loop / 2;
    const angle = time * 0.035;
    this.aircraft.position.set(
      Math.sin(angle) * 175,
      18 + Math.sin(angle * 2) * 8,
      Math.cos(angle) * 175,
    );
    this.aircraft.rotation.set(0, angle + Math.PI / 2, -0.16);
    // Match the far rings to whatever haze and environment the scene currently uses.
    const scene = this.group.parent as THREE.Scene | null;
    if (!scene) return;
    const fog = scene.fog as THREE.FogExp2 | THREE.Fog | null;
    if (fog) {
      this.fogColor.copy(fog.color);
      for (const m of this.horizon)
        m.color.copy(this.fogColor).multiplyScalar((m.userData.shade as number | undefined) ?? 1);
    }
    if (scene.environment && this.glassMaterial.envMap !== scene.environment) {
      this.glassMaterial.envMap = scene.environment as THREE.Texture;
      this.glassMaterial.envMapIntensity = 2;
      this.glassMaterial.needsUpdate = true;
    }
  }
}
