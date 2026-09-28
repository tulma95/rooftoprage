// Pure sample generators for the procedural audio: modal metal, metallic impulse responses,
// debris grains and the engine models. No Web Audio here, so everything is unit-testable.

/** Small deterministic PRNG, so every variant is reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export type Material = 'plate' | 'bar' | 'sheet';
/** Pitch of mode 1 in every rendered modal buffer; voices resample it to the pitch they need. */
export const MODAL_BASE = 400;

export interface Mode {
  ratio: number;
  /** Decay time constant, seconds. */
  decay: number;
  gain: number;
  /** -1..1 */
  pan: number;
}

/**
 * Mode set of a struck metal body. Plates and sheets use the (m, n) modes of a rectangular plate,
 * which are dense and inharmonic; bars use free-free beam modes, sparse and long.
 */
export function modes(material: Material, seed: number): Mode[] {
  const r = rng(seed);
  const out: Mode[] = [];
  if (material === 'bar') {
    // Free-free beam: (2k+1)^2 / 9, plus a few torsional modes in between.
    for (let k = 1; k <= 9; k++) {
      const ratio = ((2 * k + 1) ** 2 / 9) * (1 + (r() - 0.5) * 0.02);
      out.push({ ratio, decay: 2.4 / ratio ** 0.45, gain: 1 / k ** 0.6, pan: r() * 1.4 - 0.7 });
    }
    for (let k = 0; k < 5; k++)
      out.push({ ratio: 1.8 + r() * 9, decay: 0.5, gain: 0.25 * r(), pan: r() * 2 - 1 });
  } else {
    const aspect = material === 'plate' ? 1.37 + r() * 0.2 : 2.13 + r() * 0.3;
    const ratios: number[] = [];
    for (let m = 1; m <= 7; m++)
      for (let n = 1; n <= 7; n++)
        ratios.push((m * m + n * n * aspect * aspect) / (1 + aspect * aspect));
    ratios.sort((a, b) => a - b);
    const count = material === 'plate' ? 28 : 34,
      life = material === 'plate' ? 1.1 : 0.45;
    for (const [k, base] of ratios.slice(0, count).entries()) {
      const ratio = base * (1 + (r() - 0.5) * 0.03);
      const mode = {
        ratio,
        decay: life / (1 + 0.35 * (ratio - 1)) ** 0.6,
        gain: (0.4 + 0.6 * r()) / (1 + k) ** 0.35,
        pan: r() * 1.6 - 0.8,
      };
      out.push(mode);
      // Thin sheets beat: every mode has a slightly split twin.
      if (material === 'sheet')
        out.push({ ...mode, ratio: ratio * 1.004, gain: mode.gain * 0.7, pan: -mode.pan });
    }
  }
  return out;
}

/** Sums decaying sinusoids into stereo buffers (rotation recurrence, no per-sample trig). */
export function renderModes(
  rate: number,
  set: Mode[],
  base: number,
  seconds: number,
  seed = 1,
  strike = 0.3,
): [Float32Array, Float32Array] {
  const n = Math.floor(rate * seconds),
    L = new Float32Array(n),
    R = new Float32Array(n),
    r = rng(seed);
  for (const m of set) {
    const f = base * m.ratio;
    if (f > rate * 0.45) continue;
    const w = (2 * Math.PI * f) / rate,
      c = Math.cos(w),
      s = Math.sin(w),
      d = Math.exp(-1 / (m.decay * rate)),
      gl = m.gain * Math.cos(((m.pan + 1) * Math.PI) / 4),
      gr = m.gain * Math.sin(((m.pan + 1) * Math.PI) / 4);
    const phase = r() * Math.PI * 2;
    let x = Math.cos(phase),
      y = Math.sin(phase),
      a = 1;
    for (let i = 0; i < n && a > 1e-4; i++) {
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      L[i]! += y * a * gl;
      R[i]! += y * a * gr;
      a *= d;
    }
  }
  // The strike itself: a 3ms click of bright noise.
  const len = Math.floor(rate * 0.003);
  for (let i = 0; i < len; i++) {
    const e = (1 - i / len) * strike;
    L[i]! += (r() * 2 - 1) * e;
    R[i]! += (r() * 2 - 1) * e;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  for (let i = 0; i < n; i++) {
    L[i]! /= peak || 1;
    R[i]! /= peak || 1;
  }
  return [L, R];
}

/** Scales stereo channels to unit total energy, so a send level alone sets the wet level. */
export function unitEnergy(chs: Float32Array[]) {
  let sum = 0;
  for (const ch of chs) for (const x of ch) sum += x * x;
  const k = 1 / Math.sqrt(sum / chs.length || 1);
  for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i]! *= k;
  return chs;
}

/**
 * Short metallic impulse response: 320 plate modes scattered log-uniformly over 250Hz-10kHz with
 * short, frequency-dependent decays, over a diffuse onset. Dense enough that no single mode can
 * resonate with a tonal input (a sparse modal IR normalized to unit energy rings +20dB peaks).
 */
export function metalIR(rate: number, seed = 7): Float32Array[] {
  const r = rng(seed),
    set: Mode[] = [];
  for (let k = 0; k < 320; k++) {
    const ratio = 250 * 40 ** r();
    set.push({
      ratio,
      decay: 0.015 + 0.09 * r() * (1500 / (ratio + 1500)),
      gain: 0.5 + r(),
      pan: r() * 2 - 1,
    });
  }
  const [L, R] = renderModes(rate, set, 1, 0.45, seed, 0);
  for (let i = 0; i < rate * 0.2; i++) {
    const e = Math.exp(-i / (rate * 0.035));
    L[i]! += (r() * 2 - 1) * e * 0.35;
    R[i]! += (r() * 2 - 1) * e * 0.35;
  }
  return unitEnergy([L, R]);
}

/** A barrel or breech: a near-harmonic tube resonance, short. */
export function tubeIR(rate: number, seed = 11): Float32Array[] {
  const r = rng(seed);
  const set: Mode[] = [];
  for (let k = 1; k <= 26; k++)
    set.push({
      ratio: k * (1 + 0.0035 * k * k) * (1 + (r() - 0.5) * 0.01),
      decay: 0.09 / k ** 0.3,
      gain: 1 / k ** 0.8,
      pan: r() * 1.2 - 0.6,
    });
  return unitEnergy(renderModes(rate, set, 170, 0.3, seed, 0.5));
}

/** Debris grain bank: discrete chips of metal and concrete, silence between, with their onsets. */
export function rubble(rate: number, seed = 3) {
  const r = rng(seed),
    data = new Float32Array(Math.floor(rate * 3)),
    grains: [number, number][] = [];
  let at = 0;
  while (at < data.length - rate * 0.12) {
    const len = Math.floor(rate * (0.02 + r() * 0.07)),
      metal = r() < 0.5;
    const ms = Array.from({ length: metal ? 3 : 2 }, () => ({
      w: (2 * Math.PI * (metal ? 1500 + r() * 5000 : 400 + r() * 2200)) / rate,
      p: r() * 6.28,
    }));
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const e = Math.exp((-i / len) * (metal ? 4 : 7));
      lp += 0.5 * (r() * 2 - 1 - lp);
      let v = lp * (metal ? 0.4 : 1);
      for (const m of ms) v += Math.sin(m.w * i + m.p) * (metal ? 0.5 : 0.3);
      data[at + i] = v * e * Math.min(1, i / 8);
    }
    grains.push([at / rate, len / rate]);
    at += len + Math.floor(rate * 0.005);
  }
  let peak = 0;
  for (const x of data) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < data.length; i++) data[i]! /= peak;
  return { data, grains };
}

/**
 * Harmonic stack of a piston engine as Fourier coefficients over one 4-stroke cycle
 * (fundamental = rpm / 120). Firing-order harmonics (multiples of `cylinders`) dominate; the
 * rest are cylinder-to-cylinder imbalance, weighted by `rough`. Random phases keep the stack
 * from summing into a buzzy pulse train.
 */
export function engineStack(cylinders: number, rough: number, count = 192, seed = 5) {
  const r = rng(seed),
    real = new Float32Array(count + 1),
    imag = new Float32Array(count + 1);
  // Nothing below the half-order: sub-firing partials only add intermodulation mud.
  for (let k = Math.max(1, cylinders / 2); k <= count; k++) {
    const order = k / cylinders,
      firing = k % cylinders === 0,
      half = !firing && k % (cylinders / 2) === 0;
    const a =
      (firing ? 1 : half ? 0.45 * rough + 0.1 : rough * 0.3 * r()) / Math.max(0.5, order) ** 0.85;
    const phase = r() * Math.PI * 2;
    real[k] = a * Math.cos(phase);
    imag[k] = a * Math.sin(phase);
  }
  return { real, imag };
}

/** Top of each gear as a fraction of the chassis top speed (boost can exceed 1). */
export const GEARS = [0.26, 0.5, 0.78, 1.08, 1.6];

/** Automatic gearbox: gear index and normalized RPM (0 idle .. 1 redline) for a speed. */
export function gearbox(gear: number, speed: number) {
  let g = Math.max(0, Math.min(GEARS.length - 1, gear));
  if (g < GEARS.length - 1 && speed / GEARS[g]! > 0.93) g++;
  else if (g > 0 && speed / GEARS[g - 1]! < 0.62) g--;
  const low = g ? GEARS[g - 1]! * 0.62 : 0;
  // A fresh gear drops back to ~55% RPM; the band maps onto 0.4..1 after first gear.
  const rpm = g
    ? 0.4 + (0.6 * (speed - low)) / (GEARS[g]! * 0.93 - low)
    : speed / (GEARS[0]! * 0.93);
  return { gear: g, rpm: Math.max(0, Math.min(1.08, rpm)) };
}
