import * as THREE from 'three';

/** Deterministic PRNG so the skyline is identical on every load. */
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One facade tile covers BAYS x FLOORS windows; world size of a bay/floor is set in city.ts. */
export const BAYS = 16;
export const FLOORS = 16;
const CELL = 64;
const SIZE = BAYS * CELL;

export type FacadeKind = 'glass' | 'concrete' | 'brick' | 'office';
export interface FacadeMaps {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  /** G = roughness, B = metalness (three's roughnessMap/metalnessMap channels). */
  surface: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const surf = (rough: number, metal: number) =>
  `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

const LIT = ['#ffd49a', '#ffc27a', '#ffe2b8', '#eef2ff', '#dfe6f2', '#ffb070'];

/** Interior light with a brighter ceiling edge, so lit panes read as rooms rather than flat decals. */
function litPane(
  e: CanvasRenderingContext2D,
  r: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  palette: string[],
): void {
  const color = palette[Math.floor(r() * palette.length)]!;
  // Skewed toward dim so only a few rooms reach bloom brightness.
  e.globalAlpha = 0.12 + r() ** 2 * 0.88;
  e.fillStyle = color;
  e.fillRect(x, y, w, h);
  const g = e.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  e.fillStyle = g;
  e.fillRect(x, y, w, h);
  // Occasional blinds or a silhouette cut into the light.
  if (r() < 0.3) {
    e.fillStyle = '#000';
    e.globalAlpha = 0.6;
    e.fillRect(x, y, w, h * (0.2 + r() * 0.5));
  } else if (r() < 0.3) {
    // Venetian blinds: slatted light.
    e.fillStyle = '#000';
    e.globalAlpha = 0.5;
    for (let sy = y; sy < y + h; sy += 4) e.fillRect(x, sy, w, 2);
  }
  e.globalAlpha = 1;
}

function grime(c: CanvasRenderingContext2D, r: Rng, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = r() * SIZE,
      y = r() * SIZE,
      h = 20 + r() * 160;
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, `rgba(20,16,12,${alpha * r()})`);
    g.addColorStop(1, 'rgba(20,16,12,0)');
    c.fillStyle = g;
    c.fillRect(x, y, 2 + r() * 6, h);
  }
  for (let i = 0; i < count * 30; i++) {
    c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
    c.fillRect(r() * SIZE, r() * SIZE, 2, 2);
  }
}

export function facadeMaps(kind: FacadeKind, seed: number): FacadeMaps {
  const r = mulberry32(seed);
  const [mc, m] = canvas(SIZE, SIZE);
  const [ec, e] = canvas(SIZE, SIZE);
  const [sc, s] = canvas(SIZE, SIZE);
  e.fillStyle = '#000';
  e.fillRect(0, 0, SIZE, SIZE);
  // Canvas y grows downward, texture v grows upward; floors are symmetric so this is harmless.
  if (kind === 'glass') {
    s.fillStyle = surf(0.45, 0.6);
    s.fillRect(0, 0, SIZE, SIZE);
    m.fillStyle = '#20262c';
    m.fillRect(0, 0, SIZE, SIZE);
    for (let f = 0; f < FLOORS; f++) {
      const occupied = r() < 0.22,
        tone = r() < 0.4 ? LIT.slice(3, 5) : LIT.slice(0, 3);
      for (let b = 0; b < BAYS; b++) {
        const x = b * CELL + 2,
          y = f * CELL + 2,
          w = CELL - 4,
          h = CELL - 14;
        // Per-panel coating drift: mostly blue-grey, some greener or bronzer units.
        const shade = 160 + r() * 35,
          hue = r();
        const [cr, cg, cb] =
          hue < 0.12 ? [0.84, 0.84, 0.82] : hue < 0.3 ? [0.74, 0.88, 0.9] : [0.72, 0.84, 0.96];
        m.fillStyle = `rgb(${shade * cr},${shade * cg},${shade * cb})`;
        m.fillRect(x, y, w, h);
        s.fillStyle = surf(0.05 + r() * 0.07, 0.9);
        s.fillRect(x, y, w, h);
        if (occupied ? r() < 0.6 : r() < 0.03) litPane(e, r, x, y, w, h, tone);
      }
      // Shadow-box spandrel glass hides the slab edge: same skin, darker and a touch rougher.
      m.fillStyle = '#3a4450';
      m.fillRect(0, f * CELL + CELL - 12, SIZE, 10);
      s.fillStyle = surf(0.22, 0.85);
      s.fillRect(0, f * CELL + CELL - 12, SIZE, 10);
    }
    // Thin mullions: a fine grid, not a window pattern, so the tower reads as one reflective skin.
    m.fillStyle = '#6d747a';
    for (let b = 0; b <= BAYS; b++) m.fillRect(b * CELL - 1, 0, 3, SIZE);
    for (let f = 0; f <= FLOORS; f++) m.fillRect(0, f * CELL - 2, SIZE, 3);
  } else if (kind === 'office') {
    // Ribbon-window office slab: whole floors lit cool white, others dark or half-occupied.
    m.fillStyle = '#6a6d70';
    m.fillRect(0, 0, SIZE, SIZE);
    s.fillStyle = surf(0.8, 0.1);
    s.fillRect(0, 0, SIZE, SIZE);
    grime(m, r, 80, 0.35);
    for (let f = 0; f < FLOORS; f++) {
      const y = f * CELL + 12,
        h = CELL - 26;
      m.fillStyle = `rgb(${38 + r() * 14},${50 + r() * 14},${62 + r() * 16})`;
      m.fillRect(0, y, SIZE, h);
      s.fillStyle = surf(0.06 + r() * 0.1, 0.8);
      s.fillRect(0, y, SIZE, h);
      const mode = r();
      for (let x = 0; x < SIZE; x += CELL / 2) {
        const lit = mode < 0.3 ? r() < 0.92 : mode < 0.5 ? r() < 0.35 : r() < 0.02;
        if (lit) litPane(e, r, x + 2, y, CELL / 2 - 4, h, mode < 0.3 ? LIT.slice(3, 5) : LIT);
      }
      m.fillStyle = '#9aa0a4';
      for (let x = 0; x < SIZE; x += CELL / 2) m.fillRect(x - 1, y, 2, h);
      m.fillStyle = 'rgba(0,0,0,0.5)';
      m.fillRect(0, y, SIZE, 4);
    }
  } else {
    const brick = kind === 'brick';
    m.fillStyle = brick ? '#7a4535' : '#a39a8c';
    m.fillRect(0, 0, SIZE, SIZE);
    s.fillStyle = surf(0.92, 0);
    s.fillRect(0, 0, SIZE, SIZE);
    if (brick)
      for (let y = 0; y < SIZE; y += 5) {
        for (let x = (y / 5) % 2 ? -6 : 0; x < SIZE; x += 13) {
          const v = 0.8 + r() * 0.35;
          m.fillStyle = `rgb(${122 * v},${66 * v},${50 * v})`;
          m.fillRect(x, y, 12, 4);
        }
      }
    else
      for (let f = 0; f < FLOORS; f++) {
        // Precast panel joints.
        m.fillStyle = 'rgba(60,54,46,0.5)';
        m.fillRect(0, f * CELL + CELL - 4, SIZE, 2);
        for (let b = 0; b < BAYS; b += 2) m.fillRect(b * CELL, f * CELL, 2, CELL);
      }
    grime(m, r, brick ? 60 : 140, brick ? 0.35 : 0.5);
    const warm = LIT.slice(0, 3).concat(['#ff9a6a', '#ffb070', '#9ec0ff', '#ffd49a']);
    // Column patterns stay consistent vertically, like real facades: punched, wide, paired, blank.
    const columns = Array.from({ length: BAYS }, () => {
      const v = r();
      return brick
        ? v < 0.7
          ? 'punched'
          : v < 0.9
            ? 'pair'
            : 'blank'
        : v < 0.4
          ? 'punched'
          : v < 0.7
            ? 'wide'
            : v < 0.88
              ? 'pair'
              : 'blank';
    });
    for (let f = 0; f < FLOORS; f++) {
      // Per-storey weathering and occupancy so the grid never reads as one repeated tile.
      m.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,240,220'},${r() * 0.08})`;
      m.fillRect(0, f * CELL, SIZE, CELL);
      const occupancy = (brick ? 0.26 : 0.2) * (r() < 0.3 ? 0.15 : 1 + r());
      for (let b = 0; b < BAYS; b++) {
        const col = columns[b]!;
        if (col === 'blank') continue;
        const panes: [number, number, number, number][] =
          col === 'pair'
            ? [
                [b * CELL + 8, f * CELL + 12, 20, 38],
                [b * CELL + 36, f * CELL + 12, 20, 38],
              ]
            : col === 'wide'
              ? [[b * CELL + 5, f * CELL + 18, CELL - 10, 28]]
              : brick
                ? [[b * CELL + 16, f * CELL + 12, CELL - 32, 38]]
                : [[b * CELL + 9, f * CELL + 14, CELL - 18, 38]];
        for (const [x, y, w, h] of panes) {
          m.fillStyle = brick ? '#d8cdb8' : '#8d8578';
          m.fillRect(x - 3, y - 3, w + 6, h + 6);
          if (brick) m.fillRect(x - 5, y + h + 2, w + 10, 5);
          m.fillStyle = `rgb(${30 + r() * 25},${40 + r() * 25},${52 + r() * 25})`;
          m.fillRect(x, y, w, h);
          // Recess shadow from the reveal above and beside the glass.
          m.fillStyle = 'rgba(0,0,0,0.55)';
          m.fillRect(x, y, w, 6);
          m.fillRect(x, y, 4, h);
          s.fillStyle = surf(0.08 + r() * 0.12, 0.4);
          s.fillRect(x, y, w, h);
          if (r() < occupancy) litPane(e, r, x, y, w, h, warm);
        }
      }
    }
  }
  return {
    map: texture(mc, true),
    emissive: texture(ec, true),
    surface: texture(sc, false),
    normal: normalFrom(
      sc,
      kind === 'glass' ? 3 : 5,
      kind === 'glass' ? mulberry32(seed + 1) : undefined,
    ),
  };
}

/** Tangent-space normal map using roughness as height: glossy glass sits recessed in the wall. */
function normalFrom(src: HTMLCanvasElement, strength: number, tilt?: Rng): THREE.CanvasTexture {
  // Curtain-wall panes are never coplanar: a random slope per cell breaks reflections panel by panel.
  const tilts = Array.from({ length: BAYS * FLOORS }, () =>
    tilt ? [(tilt() - 0.5) * 0.06, (tilt() - 0.5) * 0.06] : [0, 0],
  );
  const b = canvas(SIZE, SIZE)[1];
  b.filter = 'blur(1.5px)';
  b.drawImage(src, 0, 0);
  const data = b.getImageData(0, 0, SIZE, SIZE).data;
  const [nc, n] = canvas(SIZE, SIZE);
  const out = n.createImageData(SIZE, SIZE);
  const h = (x: number, y: number) =>
    data[(((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4 + 1]! / 255;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const t = tilts[Math.floor(y / CELL) * BAYS + Math.floor(x / CELL)]!;
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength + t[0]!,
        dy = (h(x, y - 1) - h(x, y + 1)) * strength + t[1]!;
      const len = Math.hypot(dx, dy, 1),
        i = (y * SIZE + x) * 4;
      out.data[i] = (-dx / len / 2 + 0.5) * 255;
      out.data[i + 1] = (-dy / len / 2 + 0.5) * 255;
      out.data[i + 2] = (1 / len / 2 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  n.putImageData(out, 0, 0);
  return texture(nc, false);
}

/** Gravel/membrane roof with tar seams. */
export function roofMap(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed);
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#6a6863';
  x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 70 + r() * 70;
    x.fillStyle = `rgb(${v},${v * 0.97},${v * 0.92})`;
    x.fillRect(r() * 512, r() * 512, 2, 2);
  }
  // Membrane seams on a straight grid.
  x.fillStyle = 'rgba(30,28,26,0.55)';
  for (let i = 0; i < 512; i += 128) {
    x.fillRect(i, 0, 3, 512);
    x.fillRect(0, i + 64, 512, 2);
  }
  return texture(c, true);
}

/** White soft round falloff for light pools and glows. */
export function glowMap(): THREE.CanvasTexture {
  const [c, x] = canvas(128, 128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Lumpy cumulus band, flat-bottomed, white so each sprite can be tinted by the sun. */
export function cloudMap(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed);
  const [c, x] = canvas(512, 256);
  for (let i = 0; i < 70; i++) {
    const px = 60 + r() * 392,
      edge = 1 - Math.abs(px - 256) / 220,
      py = 170 - r() * 90 * edge,
      rad = 20 + r() * 50 * edge;
    const g = x.createRadialGradient(px, py, 0, px, py, rad);
    const shade = Math.round(200 + (170 - py) * 0.6);
    g.addColorStop(0, `rgba(${shade},${shade},${shade},0.35)`);
    g.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
    x.fillStyle = g;
    x.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  // Soften the flat base.
  x.globalCompositeOperation = 'destination-out';
  const fade = x.createLinearGradient(0, 150, 0, 230);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  x.fillStyle = fade;
  x.fillRect(0, 150, 512, 106);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Endless-city silhouette strip; returns [silhouette, lights] sharing one layout. */
export function horizonMaps(seed: number): [THREE.CanvasTexture, THREE.CanvasTexture] {
  const r = mulberry32(seed);
  const W = 2048,
    H = 256;
  const [sc, s] = canvas(W, H);
  const [lc, l] = canvas(W, H);
  // Darker at the rooftops, fog-bright at the base so it dissolves into the haze.
  const g = s.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#a8a8b8');
  g.addColorStop(0.3, '#e4e4ea');
  g.addColorStop(0.45, '#ffffff');
  s.fillStyle = g;
  const base = H * 0.3;
  for (let x = 0; x < W;) {
    const w = 6 + r() * 22,
      cluster = 0.5 + 0.5 * Math.sin((x / W) * Math.PI * 6 + 1.3),
      h = Math.min(60, 4 + r() * 22 + cluster * cluster * r() * 44);
    s.fillRect(x, base - h, w, H);
    if (r() < 0.25) s.fillRect(x + w * 0.3, base - h - h * 0.2, w * 0.4, h * 0.2);
    if (r() < 0.12) s.fillRect(x + w * 0.5, base - h * 1.45, 1, h * 0.45);
    for (let i = 0; i < h * w * 0.03; i++) {
      l.fillStyle = LIT[Math.floor(r() * LIT.length)]!;
      l.globalAlpha = 0.3 + r() * 0.7;
      l.fillRect(Math.floor(x + 1 + r() * (w - 2)), Math.floor(base - h + 2 + r() * h), 1, 1);
    }
    x += w + (r() < 0.2 ? r() * 8 : 0);
  }
  s.fillRect(0, base, W, H);
  const make = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return [make(sc), make(lc)];
}

const SIGNS: [string, string][] = [
  ['HOTEL', '#ff3d7f'],
  ['RAMEN', '#35e6ff'],
  ['BAR 24', '#ffb02e'],
  ['ROBO FIX', '#7dff5a'],
  ['SCRAP', '#ff5a3d'],
  ['ARCADE', '#b36bff'],
];
export const SIGN_COUNT = SIGNS.length;

/** Neon sign atlas: 2 columns x 3 rows, each cell a 3:1 dark panel with glowing tube lettering. */
export function signAtlas(): THREE.CanvasTexture {
  const [c, x] = canvas(1024, 512);
  const cw = 512,
    ch = 512 / 3;
  SIGNS.forEach(([text, color], i) => {
    const ox = (i % 2) * cw,
      oy = Math.floor(i / 2) * ch;
    x.fillStyle = '#0d0a10';
    x.fillRect(ox, oy, cw, ch);
    x.strokeStyle = color;
    x.lineWidth = 5;
    x.shadowColor = color;
    x.shadowBlur = 18;
    x.strokeRect(ox + 12, oy + 12, cw - 24, ch - 24);
    x.font = `900 ${ch * 0.52}px Arial Black, Impact, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineWidth = 7;
    x.strokeText(text, ox + cw / 2, oy + ch / 2 + 4, cw - 70);
    x.shadowBlur = 0;
    x.fillStyle = '#fff';
    x.lineWidth = 2.5;
    x.strokeStyle = '#fff';
    x.strokeText(text, ox + cw / 2, oy + ch / 2 + 4, cw - 70);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Three stacked 16:9 frames of a rooftop video ad; the city cycles texture offset between them. */
export function screenAtlas(): THREE.CanvasTexture {
  const [c, x] = canvas(512, 864);
  const frames: [string, string, string, string][] = [
    ['ROOFTOP', 'RAGE', '#ff3d7f', '#2a0b3a'],
    ['SCRAP', 'BUILT', '#ffb02e', '#3a1606'],
    ['TONIGHT', 'LIVE', '#35e6ff', '#061e36'],
  ];
  frames.forEach(([a, b, color, bg], i) => {
    const oy = i * 288;
    const g = x.createLinearGradient(0, oy, 512, oy + 288);
    g.addColorStop(0, bg);
    g.addColorStop(1, '#050507');
    x.fillStyle = g;
    x.fillRect(0, oy, 512, 288);
    x.fillStyle = color;
    x.globalAlpha = 0.35;
    for (let k = 0; k < 6; k++) x.fillRect(0, oy + 30 + k * 44, 512, 8);
    x.globalAlpha = 1;
    x.textAlign = 'center';
    x.font = '900 86px Arial Black, Impact, sans-serif';
    x.shadowColor = color;
    x.shadowBlur = 24;
    x.fillStyle = '#fff';
    x.fillText(a, 256, oy + 125, 470);
    x.fillStyle = color;
    x.fillText(b, 256, oy + 225, 470);
    x.shadowBlur = 0;
  });
  // LED scanlines.
  x.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < 864; y += 3) x.fillRect(0, y, 512, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
