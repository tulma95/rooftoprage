/**
 * One shared AudioContext and mix for music and SFX, so both sit under a single limiter and
 * big SFX can duck the music directly:
 *
 *   music ─ EQ ─ music comp (pre-limit) ─ level ─ duck ──────────────┐
 *   bed (engines, loops) ─ 24dB/oct low cut ─ duck ─┐                 │
 *   sfx ────────────────────────────────────────────┴─ sfx level ────┼─ limiter ─ ceiling ─ out
 *   wide send ─ Haas delays (L 9ms / R 16ms, >300Hz) ─────────────────┤
 *   reverb send ─ rooftop IR (decorrelated L/R) ─ low cut ────────────┤
 *   metal send ─ plate IR ─┐   tube send ─ barrel IR ─ low cut ───────┘
 *
 * The music is compressed on its own bus and sits well under the SFX, so the master limiter
 * only catches the biggest booms instead of squashing everything. The context only runs while
 * something wants it (music enabled, a room with SFX on, or a moment after a UI blip) and the
 * page is visible, so a muted menu stays suspended and costs nothing.
 */
import {
  metalIR,
  modes,
  renderModes,
  rubble,
  tubeIR,
  type Material,
  MODAL_BASE,
} from './audio-dsp.js';

export type Mood = 'menu' | 'combat' | 'tension';

export interface Mix {
  ctx: AudioContext;
  /** SFX input. */
  sfx: GainNode;
  /** Engines and held weapon loops: low-cut and ducked under every weapon transient. */
  bed: GainNode;
  /** Music input, before the music bus EQ and compressor. */
  music: GainNode;
  /** Send into the rooftop reverb. */
  reverb: GainNode;
  /** Haas width send (mid/high only, bass stays mono). */
  wide: GainNode;
  /** Send through a short metallic plate IR. */
  metal: GainNode;
  /** Send through a short barrel/breech tube IR. */
  tube: GainNode;
  /** 2s of white noise, looped by every noise layer. */
  noise: AudioBuffer;
  /** Sparse crackle impulses: fire, sparks, electrical arcs. */
  crackle: AudioBuffer;
  /** Debris grains and their [offset, length] in seconds. */
  rubble: { buffer: AudioBuffer; grains: [number, number][] };
  /** Supersonic N-wave: a 2ms pressure spike and its rarefaction. */
  nwave: AudioBuffer;
  /** Warm tanh drive curve. */
  crunch: Float32Array<ArrayBuffer>;
}

let mix: Mix | null = null,
  duckGain: GainNode,
  bedDuck: GainNode,
  wantMusic = false,
  wantSfx = false,
  wantUi = false,
  uiTimer: ReturnType<typeof setTimeout> | undefined;
/** Combat state the soundtrack follows; set by the SFX layer, read by the music scheduler. */
export let mood: Mood = 'menu';
export function setMood(next: Mood) {
  mood = next;
}

export const tanhCurve = (drive: number, size = 2048) => {
  const curve = new Float32Array(size);
  const norm = Math.tanh(drive);
  for (let i = 0; i < size; i++) curve[i] = Math.tanh(((i / (size - 1)) * 2 - 1) * drive) / norm;
  return curve;
};

/**
 * Chromium's DynamicsCompressor adds automatic make-up gain of 0.6 x the gain reduction it
 * would apply at 0 dBFS; this gain cancels it so a compressor only ever turns things down.
 */
const makeupCancel = (threshold: number, ratio: number) =>
  10 ** ((-0.6 * -threshold * (1 - 1 / ratio)) / 20);

function compressor(
  ctx: BaseAudioContext,
  threshold: number,
  ratio: number,
  knee: number,
  attack: number,
  release: number,
) {
  const c = ctx.createDynamicsCompressor(),
    trim = ctx.createGain();
  c.threshold.value = threshold;
  c.ratio.value = ratio;
  c.knee.value = knee;
  c.attack.value = attack;
  c.release.value = release;
  trim.gain.value = makeupCancel(threshold, ratio);
  c.connect(trim);
  return { input: c, output: trim };
}

function stereoBuffer(ctx: BaseAudioContext, chs: Float32Array[]) {
  const b = ctx.createBuffer(chs.length, chs[0]!.length, ctx.sampleRate);
  chs.forEach((ch, i) => b.getChannelData(i).set(ch));
  return b;
}

/**
 * Stereo outdoor slap: building reflections, then a darkening diffuse tail. Each ear gets its
 * own noise, pre-delay and reflection times, so the wet signal is fully decorrelated.
 */
function rooftopImpulse(ctx: BaseAudioContext) {
  const rate = ctx.sampleRate,
    length = Math.floor(rate * 1.8),
    ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch),
      pre = Math.floor(rate * (0.012 + ch * 0.007));
    let lp = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / rate;
      const a = 1 - Math.exp((-2 * Math.PI * (9000 * Math.exp(-t * 2.2) + 500)) / rate);
      lp += a * (Math.random() * 2 - 1 - lp);
      data[i] = lp * Math.exp(-t * 3.6) * Math.min(1, t / 0.012) * 0.55;
    }
    for (const [delay, gain] of [
      [0.047 + ch * 0.013, 0.5],
      [0.113 - ch * 0.021, 0.32],
      [0.19 + ch * 0.029, 0.2],
      [0.31 - ch * 0.037, 0.12],
    ] as const) {
      const at = Math.floor(delay * rate);
      for (let j = 0; j < 40; j++) data[at + j]! += (Math.random() * 2 - 1) * gain * (1 - j / 40);
    }
    const energy = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0));
    for (let i = 0; i < length; i++) data[i]! /= energy;
  }
  return ir;
}

function build(): Mix {
  const ctx = new AudioContext({ latencyHint: 'interactive' }),
    rate = ctx.sampleRate;
  // Master: a brickwall-ish limiter a hair under full scale, then a soft ceiling for overshoot.
  const master = ctx.createGain();
  const limiter = compressor(ctx, -4, 20, 0, 0.002, 0.12);
  const clip = ctx.createWaveShaper();
  const ceiling = new Float32Array(4096);
  for (let i = 0; i < ceiling.length; i++) {
    const x = (i / (ceiling.length - 1)) * 4 - 2,
      m = Math.abs(x);
    ceiling[i] = Math.sign(x) * (m < 0.6 ? m : 0.6 + 0.16 * Math.tanh((m - 0.6) / 0.16));
  }
  clip.curve = ceiling;
  clip.oversample = '4x';
  master.connect(limiter.input);
  // The oversampled ceiling still leaves ~1.7dB of inter-sample overshoot; this trim keeps
  // true peak under -1 dBTP.
  const out = ctx.createGain();
  out.gain.value = 0.9;
  limiter.output.connect(clip).connect(out).connect(ctx.destination);

  // Music bus: sub cut, a dip in the mud, then its own compressor so the score is
  // pre-limited and sits a fixed distance under the SFX.
  const music = ctx.createGain();
  const eq = [
    ['highpass', 32, 0.7, 0],
    ['lowshelf', 110, 0.7, -6],
    ['peaking', 300, 0.9, -2.5],
    ['peaking', 2800, 0.8, 4.5],
  ] as const;
  let node: AudioNode = music;
  for (const [type, f, q, gain] of eq) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = gain;
    node = node.connect(b);
  }
  const musicComp = compressor(ctx, -20, 3, 8, 0.015, 0.25);
  const musicLevel = ctx.createGain();
  musicLevel.gain.value = 0.45;
  duckGain = ctx.createGain();
  node.connect(musicComp.input);
  musicComp.output.connect(musicLevel).connect(duckGain).connect(master);

  const sfx = ctx.createGain();
  sfx.gain.value = 1;
  sfx.connect(master);
  // Bed: engines and held loops. Two stacked high-passes (24dB/oct) keep their idle rumble out
  // of the kick/impact region; the duck drops them under every weapon transient.
  const bed = ctx.createGain(),
    bedHp1 = ctx.createBiquadFilter(),
    bedHp2 = ctx.createBiquadFilter();
  bedDuck = ctx.createGain();
  for (const hp of [bedHp1, bedHp2]) {
    hp.type = 'highpass';
    hp.frequency.value = 75;
    hp.Q.value = 0.6;
  }
  // Level: the bed sits far under the one-shots.
  bed.gain.value = 0.2;
  bed.connect(bedHp1).connect(bedHp2).connect(bedDuck).connect(sfx);

  const reverb = ctx.createGain(),
    convolver = ctx.createConvolver(),
    lowCut = ctx.createBiquadFilter(),
    wet = ctx.createGain();
  convolver.normalize = false;
  convolver.buffer = rooftopImpulse(ctx);
  lowCut.type = 'highpass';
  lowCut.frequency.value = 220;
  wet.gain.value = 0.5;
  reverb.connect(convolver).connect(lowCut).connect(wet).connect(master);

  // Haas width: mono sum delayed differently per ear, mids and highs only.
  const wide = ctx.createGain(),
    wideHp = ctx.createBiquadFilter(),
    merger = ctx.createChannelMerger(2);
  wideHp.type = 'highpass';
  wideHp.frequency.value = 300;
  wide.channelCount = 1;
  wide.channelCountMode = 'explicit';
  wide.connect(wideHp);
  for (const [ch, ms] of [
    [0, 9],
    [1, 16],
  ] as const) {
    const d = ctx.createDelay(0.05);
    d.delayTime.value = ms / 1000;
    wideHp.connect(d).connect(merger, 0, ch);
  }
  merger.connect(master);

  const convolve = (chs: Float32Array[], hp: number, level: number) => {
    const send = ctx.createGain(),
      c = ctx.createConvolver(),
      f = ctx.createBiquadFilter(),
      g = ctx.createGain();
    c.normalize = false;
    c.buffer = stereoBuffer(ctx, chs);
    f.type = 'highpass';
    f.frequency.value = hp;
    g.gain.value = level;
    send.connect(c).connect(f).connect(g).connect(master);
    return send;
  };
  const metal = convolve(metalIR(rate), 200, 0.25);
  const tube = convolve(tubeIR(rate), 120, 0.3);

  const noise = ctx.createBuffer(1, rate * 2, rate);
  const n = noise.getChannelData(0);
  for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
  const crackle = ctx.createBuffer(1, rate * 2, rate);
  const c = crackle.getChannelData(0);
  for (let i = 0; i < c.length; i++) {
    if (Math.random() < 0.0009) {
      const size = 0.2 + Math.random() ** 3 * 0.8,
        len = 20 + Math.floor(Math.random() * 180);
      for (let j = 0; j < len && i + j < c.length; j++)
        c[i + j]! += (Math.random() * 2 - 1) * size * Math.exp((-j / len) * 5);
    }
  }
  const bank = rubble(rate);
  const nwave = ctx.createBuffer(1, Math.floor(rate * 0.004), rate);
  const nw = nwave.getChannelData(0),
    span = Math.floor(rate * 0.0022);
  for (let i = 0; i < nw.length; i++)
    nw[i] = i < span ? 1 - (2 * i) / span : i < span + 12 ? -1 + (i - span) / 12 : 0;
  return {
    ctx,
    sfx,
    bed,
    music,
    reverb,
    wide,
    metal,
    tube,
    noise,
    crackle,
    rubble: { buffer: stereoBuffer(ctx, [bank.data]), grains: bank.grains },
    nwave,
    crunch: tanhCurve(3, 1024),
  };
}

const modalCache = new Map<string, AudioBuffer>();
/** A struck-metal modal buffer (mode 1 at MODAL_BASE Hz), rendered once per material/variant. */
export function modal(material: Material, variant: number): AudioBuffer {
  const m = audioMix(),
    key = `${material}:${variant}`;
  let b = modalCache.get(key);
  if (!b) {
    const seconds = material === 'bar' ? 2.2 : material === 'plate' ? 1.6 : 0.9;
    b = stereoBuffer(
      m.ctx,
      renderModes(
        m.ctx.sampleRate,
        modes(material, 97 + variant * 31),
        MODAL_BASE,
        seconds,
        variant + 1,
      ),
    );
    modalCache.set(key, b);
  }
  return b;
}

function refresh() {
  if (!mix) return;
  const hidden = typeof document !== 'undefined' && document.hidden;
  if ((wantMusic || wantSfx || wantUi) && !hidden) {
    if (mix.ctx.state === 'suspended') void mix.ctx.resume().catch(() => {});
  } else if (mix.ctx.state === 'running') void mix.ctx.suspend().catch(() => {});
}

/** The shared mix, created on first use (always after a user gesture). */
export function audioMix(): Mix {
  if (!mix) {
    mix = build();
    // Render the modal banks (~14ms each) in small slices now, not on the first hit in a fight.
    (['plate', 'bar', 'sheet'] as const).forEach((material, m) =>
      [0, 1, 2].forEach((v) => setTimeout(() => modal(material, v), 300 + (m * 3 + v) * 80)),
    );
  }
  return mix;
}

/**
 * The mix for a UI blip: wakes an existing context for a moment (the blip happens inside a
 * user gesture, so resume is allowed) and lets it sleep again afterwards. Never creates one:
 * a menu with music muted must not open audio at all.
 */
export function uiMix(): Mix | null {
  if (!mix || (typeof document !== 'undefined' && document.hidden)) return null;
  wantUi = true;
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    wantUi = false;
    refresh();
  }, 700);
  refresh();
  return mix;
}

/** Declares whether music or SFX currently need the context running. */
export function want(kind: 'music' | 'sfx', on: boolean) {
  if (kind === 'music') wantMusic = on;
  else wantSfx = on;
  refresh();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);

/**
 * Sidechain duck under a weapon transient: the music drops by `depth` (0..1, up to -20dB) and
 * the engine/loop bed drops harder, both recovering after `hold`.
 */
export function duckMusic(depth: number, hold = 0.12) {
  if (!mix || depth <= 0) return;
  const t = mix.ctx.currentTime;
  for (const [g, d] of [
    [duckGain.gain, Math.min(0.9, depth)],
    [bedDuck.gain, Math.min(0.95, depth * 1.4)],
  ] as const) {
    const floor = Math.min(g.value, 1 - d);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(floor, t, 0.006);
    g.setTargetAtTime(1, t + hold, 0.28);
  }
}
