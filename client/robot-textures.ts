import * as THREE from 'three';

/**
 * Procedural textures shared by every robot: stencils, tread, hazard stripes and floor falloffs.
 * Paint and metal wear are computed in object space by the material shaders, not textured.
 */
type Draw = (g: CanvasRenderingContext2D, s: number, rand: () => number) => void;

function canvas(size: number, draw: Draw, color = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  draw(c.getContext('2d')!, size, rand);
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const blobs = (
  g: CanvasRenderingContext2D,
  s: number,
  rand: () => number,
  n: number,
  rgb: string,
  alpha: number,
  bottomBias = 0,
) => {
  for (let i = 0; i < n; i++) {
    const x = rand() * s,
      y = s * (bottomBias ? 1 - rand() ** 2 * bottomBias : rand()),
      r = s * (0.03 + rand() * 0.12);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rgb},${alpha * rand()})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
};
/** Small chips hugging the face border, where a real panel gets knocked. */
const chips = (
  g: CanvasRenderingContext2D,
  s: number,
  rand: () => number,
  style: string,
  n: number,
) => {
  g.fillStyle = style;
  for (let i = 0; i < n; i++) {
    const along = rand() * s,
      depth = rand() ** 2 * s * 0.04,
      side = Math.floor(rand() * 4),
      w = 4 + rand() * 18,
      h = 2 + depth;
    // Ragged ellipses centred on the border read as chipped paint, not pixel blocks.
    const [x, y, rx, ry] =
      side === 0
        ? [along, 0, w, h]
        : side === 1
          ? [along, s, w, h]
          : side === 2
            ? [0, along, h, w]
            : [s, along, h, w];
    g.beginPath();
    g.ellipse(x, y, rx / 2, ry, rand() * 0.4 - 0.2, 0, Math.PI * 2);
    g.fill();
  }
};
const scratches = (
  g: CanvasRenderingContext2D,
  s: number,
  rand: () => number,
  style: string,
  n: number,
) => {
  g.strokeStyle = style;
  for (let i = 0; i < n; i++) {
    g.lineWidth = 0.5 + rand() * 1.2;
    const x = rand() * s,
      y = rand() * s,
      a = rand() * Math.PI,
      l = 8 + rand() * 50;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
};
/** Stencilled decals, 2 columns x 4 rows of 2:1 cells: numbers, sponsor marks, warnings. */
export const DECAL_NUMBERS = 4;
export const decals = canvas(
  512,
  (g, s, rand) => {
    const cw = s / 2,
      ch = s / 4;
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    /** Text shrunk to fit `max` px wide. */
    const fit = (text: string, x: number, y: number, px: number, max: number) => {
      g.font = `900 ${px}px Impact, "Arial Black", sans-serif`;
      const w = g.measureText(text).width;
      if (w > max) g.font = `900 ${(px * max) / w}px Impact, "Arial Black", sans-serif`;
      g.fillText(text, x, y);
    };
    const cell = (i: number, draw: (cx: number, cy: number) => void) =>
      draw((i % 2) * cw + cw / 2, Math.floor(i / 2) * ch + ch / 2);
    ['07', '13', '42', '88'].forEach((n, i) =>
      cell(i, (x, y) => {
        fit(n, x, y + 4, ch * 0.86, cw * 0.8);
        // Stencil bridges.
        g.clearRect(x - cw / 2, y - 3, cw, 6);
      }),
    );
    cell(4, (x, y) => {
      fit('RAGE//WRX', x, y - ch * 0.08, ch * 0.5, cw * 0.84);
      g.fillRect(x - cw * 0.42, y + ch * 0.24, cw * 0.84, 5);
      fit('CONTINUOUS COMBAT DIV.', x, y + ch * 0.38, ch * 0.13, cw * 0.84);
    });
    cell(5, (x, y) => {
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(x - cw * 0.44, y + ch * 0.36);
      g.lineTo(x - cw * 0.24, y - ch * 0.38);
      g.lineTo(x - cw * 0.04, y + ch * 0.36);
      g.closePath();
      g.stroke();
      g.font = `900 ${ch * 0.44}px Impact, sans-serif`;
      g.fillText('!', x - cw * 0.24, y + ch * 0.1);
      g.textAlign = 'left';
      fit('HIGH', x + cw * 0.02, y - ch * 0.17, ch * 0.3, cw * 0.44);
      fit('VOLTAGE', x + cw * 0.02, y + ch * 0.2, ch * 0.3, cw * 0.44);
      g.textAlign = 'center';
    });
    cell(6, (x, y) => {
      fit('NO STEP', x, y, ch * 0.42, cw * 0.74);
      g.lineWidth = 4;
      g.strokeRect(x - cw * 0.42, y - ch * 0.36, cw * 0.84, ch * 0.72);
    });
    cell(7, (x, y) => {
      for (let i = 0; i < 3; i++) {
        const ax = x - cw * 0.3 + i * cw * 0.22;
        g.beginPath();
        g.moveTo(ax, y - ch * 0.32);
        g.lineTo(ax + cw * 0.14, y);
        g.lineTo(ax, y + ch * 0.32);
        g.lineTo(ax + cw * 0.07, y + ch * 0.32);
        g.lineTo(ax + cw * 0.21, y);
        g.lineTo(ax + cw * 0.07, y - ch * 0.32);
        g.fill();
      }
    });
    // Dark keyline under every mark so light stencils stay legible on light paint at game distance.
    const fill = document.createElement('canvas');
    fill.width = fill.height = s;
    fill.getContext('2d')!.drawImage(g.canvas, 0, 0);
    const line = document.createElement('canvas');
    line.width = line.height = s;
    const lg = line.getContext('2d')!;
    lg.drawImage(fill, 0, 0);
    lg.globalCompositeOperation = 'source-in';
    lg.fillStyle = '#16130f';
    lg.fillRect(0, 0, s, s);
    g.clearRect(0, 0, s, s);
    for (let a = 0; a < 16; a++)
      g.drawImage(line, Math.cos(a * 0.3927) * 5, Math.sin(a * 0.3927) * 5);
    g.drawImage(fill, 0, 0);
    // Weathering: knock out flecks so decals look sprayed on and scuffed.
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 1400; i++) {
      g.globalAlpha = 0.3 + rand() * 0.7;
      g.beginPath();
      g.arc(rand() * s, rand() * s, 0.5 + rand() ** 3 * 5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  },
  true,
);
decals.wrapS = decals.wrapT = THREE.ClampToEdgeWrapping;

/**
 * Tire bump: chevron tread over v 0.14..1 of the torso; v 0..0.12 is the sidewall, which the
 * wheel builder remaps the cylinder caps onto.
 */
export const tread = canvas(512, (g, s) => {
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, s, s);
  const top = 0,
    bottom = s * 0.86; // Canvas y is flipped: v=1 at the top.
  g.strokeStyle = '#141414';
  g.lineWidth = 7;
  const n = 26,
    step = s / n;
  for (let i = -1; i <= n; i++) {
    const x = i * step;
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x + step * 0.55, (top + bottom) / 2);
    g.lineTo(x, bottom);
    g.stroke();
  }
  g.fillStyle = '#141414';
  g.fillRect(0, bottom * 0.5 - 3, s, 6);
  // Sidewall: concentric ribs plus lettering-like bumps near the rim.
  g.fillStyle = '#6a6a6a';
  g.fillRect(0, bottom, s, s - bottom);
  for (const f of [0.35, 0.55, 0.8]) {
    g.fillStyle = '#b0b0b0';
    g.fillRect(0, s - (s - bottom) * f - 2, s, 3);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = i % 5 === 0 ? '#6a6a6a' : '#c8c8c8';
    g.fillRect((i * s) / 40, s - (s - bottom) * 0.72, s / 60, 8);
  }
});

/** Worn yellow/black hazard chevrons. */
export const hazard = canvas(
  256,
  (g, s, rand) => {
    g.fillStyle = '#f2b51c';
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#141414';
    for (let i = -2; i < 4; i++) {
      g.beginPath();
      const x = i * s * 0.5;
      g.moveTo(x, s);
      g.lineTo(x + s * 0.25, s);
      g.lineTo(x + s * 0.25 + s, 0);
      g.lineTo(x + s, 0);
      g.fill();
    }
    blobs(g, s, rand, 20, '50,40,30', 0.4, 1);
    chips(g, s, rand, 'rgba(90,90,90,0.9)', 90);
    scratches(g, s, rand, 'rgba(200,200,190,0.5)', 30);
  },
  true,
);

/** Soft radial falloff for the underglow pool cast on the floor. */
export const glowPool = canvas(128, (g, s) => {
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
});
glowPool.wrapS = glowPool.wrapT = THREE.ClampToEdgeWrapping;

/** Soft rounded-rectangle falloff: the contact shadow that pins each chassis to the floor. */
export const contactShadow = canvas(128, (g, s) => {
  // Opaque black ground so the alpha map's green channel fades smoothly.
  g.fillStyle = '#000000';
  g.fillRect(0, 0, s, s);
  g.filter = 'blur(10px)';
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(s * 0.2, s * 0.16, s * 0.6, s * 0.68, s * 0.12);
  g.fill();
});
contactShadow.wrapS = contactShadow.wrapT = THREE.ClampToEdgeWrapping;
