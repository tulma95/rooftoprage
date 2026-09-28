import {
  CHASSIS,
  FRONT_RULES,
  PROJECTILE_RULES,
  TICK_SECONDS,
  WEAPONS,
  type Chassis,
  type Projectile,
  type GameEvent,
  type PlayerState,
  type RoomState,
} from '../shared/game.js';
import { engineStack, gearbox, MODAL_BASE, type Material } from './audio-dsp.js';
import {
  audioMix,
  duckMusic,
  modal,
  setMood,
  uiMix,
  want,
  type Mix,
  type Mood,
} from './audio-engine.js';

/** Stereo pan and gain for a sound at (x, z), heard from behind the listener's robot. */
export function spatial(listener: PlayerState | undefined, x: number, z: number) {
  if (!listener) return { pan: 0, gain: 0.8 };
  const dx = x - listener.x,
    dz = z - listener.z;
  // The follow camera looks along (sin yaw, cos yaw); screen-right is (-cos yaw, sin yaw).
  const side = -dx * Math.cos(listener.yaw) + dz * Math.sin(listener.yaw);
  const distance = Math.hypot(dx, dz);
  return {
    pan: Math.max(-0.85, Math.min(0.85, side / 14)),
    gain: distance > 60 ? 0 : 1 / (1 + distance / 12),
  };
}

/** Which soundtrack layer fits the fight: calm menus, full combat, or a tense endgame. */
export function moodFor(s: RoomState, listener: PlayerState | undefined): Mood {
  if (s.phase !== 'combat') return 'menu';
  const alive = s.players.filter((p) => p.alive).length;
  const hurt = !!listener?.alive && listener.hp / CHASSIS[listener.chassis].hp < 0.3;
  return hurt || (alive === 2 && s.players.length > 2) ? 'tension' : 'combat';
}

const MAX_VOICES = 28;
/** Absolute ceiling, which even important voices respect. */
const HARD_VOICES = 48;
const DRY = 0.25;
let mix: Mix | null = null,
  ctx: AudioContext,
  master: GainNode,
  post: GainNode,
  bus: BiquadFilterNode,
  /** SFX sends into the shared reverb, width and metal/tube IRs, scaled with the dry level. */
  sends: Record<'reverb' | 'wide' | 'metal' | 'tube', GainNode>,
  voices = 0;
const lastPlayed = new Map<string, number>();

/** The SFX half of the shared mix, wired on first use. */
function context() {
  if (!mix) {
    mix = audioMix();
    ctx = mix.ctx;
    master = ctx.createGain();
    master.gain.value = DRY;
    // A low-pass on the whole SFX mix, swept down after big booms so they muffle everything else.
    bus = ctx.createBiquadFilter();
    bus.frequency.value = 20000;
    master.connect(bus).connect(mix.sfx);
    // Booms and UI skip the bus they duck, so their own crack stays bright.
    post = ctx.createGain();
    post.gain.value = DRY;
    post.connect(mix.sfx);
    const m = mix;
    const scaled = (to: AudioNode, level: number) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(to);
      return g;
    };
    sends = {
      reverb: scaled(m.reverb, DRY * 3),
      wide: scaled(m.wide, DRY * 2),
      metal: scaled(m.metal, DRY),
      tube: scaled(m.tube, DRY),
    };
  }
  return ctx;
}

/** Random factor around 1 so repeated sounds never sound identical. */
const vary = (amount = 0.08) => 1 + (Math.random() * 2 - 1) * amount;
const spread = (width = 1) => (Math.random() * 2 - 1) * width;

interface Voice {
  ctx: AudioContext;
  t: number;
  out: AudioNode;
  dirty: AudioNode;
  metal: GainNode;
  tube: GainNode;
  mix: Mix;
}
type Where = { pan: number; gain: number };

/**
 * Opens a panned voice held for `duration`, or null when muted, too far, throttled, or over
 * the voice budget. Important voices (shots, booms) skip the soft cap, never the hard one.
 * `unducked` voices bypass the SFX duck and low-pass. Distance darkens the voice and pushes
 * more of it into the rooftop reverb; close voices also feed the Haas width send.
 */
function voice(
  key: string,
  gap: number,
  duration: number,
  volume: number,
  where: Where,
  important = false,
  unducked = false,
  wet = 0.3,
  width = 0.3,
): Voice | null {
  if (where.gain * volume < 0.02 || voices >= HARD_VOICES || (!important && voices >= MAX_VOICES))
    return null;
  const ctx = context(),
    t = ctx.currentTime;
  if (t - (lastPlayed.get(key) ?? -Infinity) < gap) return null;
  lastPlayed.set(key, t);
  if (lastPlayed.size > 256) lastPlayed.clear();
  const out = ctx.createGain(),
    air = ctx.createBiquadFilter(),
    panner = ctx.createStereoPanner(),
    shaper = ctx.createWaveShaper(),
    send = ctx.createGain(),
    wide = ctx.createGain(),
    metal = ctx.createGain(),
    tube = ctx.createGain();
  out.gain.value = where.gain * volume;
  air.frequency.value = 1400 + 18600 * where.gain ** 2;
  air.Q.value = 0.5;
  panner.pan.value = where.pan;
  shaper.curve = mix!.crunch;
  send.gain.value = wet * volume * (0.35 + 0.5 * (1 - where.gain)) * Math.min(1, where.gain * 3);
  wide.gain.value = width * volume * Math.min(1, where.gain * 1.5);
  metal.gain.value = tube.gain.value = where.gain * volume;
  shaper.connect(out);
  out
    .connect(air)
    .connect(panner)
    .connect(unducked ? post : master);
  panner.connect(send).connect(sends.reverb);
  panner.connect(wide).connect(sends.wide);
  metal.connect(sends.metal);
  tube.connect(sends.tube);
  voices++;
  setTimeout(
    () => {
      voices--;
      for (const n of [out, air, panner, shaper, send, wide, metal, tube]) n.disconnect();
    },
    (duration + 0.4) * 1000,
  );
  return { ctx, t, out, dirty: shaper, metal, tube, mix: mix! };
}

interface Layer {
  dirty?: boolean;
  delay?: number;
  attack?: number;
  pan?: number;
  /** Also feed this layer through a short metallic (plate) or barrel (tube) impulse response. */
  send?: 'metal' | 'tube';
  /** Send level into that IR. */
  sendLevel?: number;
}

function route(v: Voice, gain: GainNode, o: Layer) {
  const target = o.dirty ? v.dirty : v.out,
    nodes: AudioNode[] = [gain];
  if (o.send) {
    const s = v.ctx.createGain();
    s.gain.value = o.sendLevel ?? 1;
    gain.connect(s).connect(v[o.send]);
    nodes.push(s);
  }
  if (!o.pan) return (gain.connect(target), nodes);
  const p = v.ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, o.pan));
  gain.connect(p).connect(target);
  return [...nodes, p];
}

function tone(
  v: Voice,
  type: OscillatorType,
  from: number,
  to: number,
  duration: number,
  level: number,
  o: Layer = {},
) {
  const osc = v.ctx.createOscillator(),
    gain = v.ctx.createGain(),
    t = v.t + (o.delay ?? 0);
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + (o.attack ?? 0.003));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain);
  const nodes = route(v, gain, o);
  osc.start(t);
  osc.stop(t + duration + 0.02);
  osc.onended = () => [osc, ...nodes].forEach((n) => n.disconnect());
}

function noise(
  v: Voice,
  type: BiquadFilterType,
  from: number,
  to: number,
  duration: number,
  level: number,
  o: Layer & { q?: number; crackle?: boolean } = {},
) {
  const source = v.ctx.createBufferSource(),
    filter = v.ctx.createBiquadFilter(),
    gain = v.ctx.createGain(),
    t = v.t + (o.delay ?? 0);
  source.buffer = o.crackle ? v.mix.crackle : v.mix.noise;
  source.loop = true;
  filter.type = type;
  filter.Q.value = o.q ?? 1;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + (o.attack ?? 0.004));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  source.connect(filter).connect(gain);
  const nodes = route(v, gain, o);
  source.start(t, Math.random() * 1.9);
  source.stop(t + duration + 0.02);
  source.onended = () => [source, filter, ...nodes].forEach((n) => n.disconnect());
}

/** Plays a one-shot buffer (or a slice of one) as a layer. */
function sample(
  v: Voice,
  buffer: AudioBuffer,
  rate: number,
  level: number,
  o: Layer & { offset?: number; length?: number; choke?: number } = {},
) {
  const source = v.ctx.createBufferSource(),
    gain = v.ctx.createGain(),
    t = v.t + (o.delay ?? 0);
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.setValueAtTime(level, t);
  const length = o.length ?? buffer.duration / rate;
  if (o.choke !== undefined && o.choke < length)
    gain.gain.setTargetAtTime(0, t + o.choke * 0.5, o.choke * 0.2);
  source.connect(gain);
  const nodes = route(v, gain, o);
  const end = Math.min(length, (o.choke ?? length) * 1.6);
  if (o.offset !== undefined) source.start(t, o.offset, o.length);
  else source.start(t);
  source.stop(t + end + 0.02);
  source.onended = () => [source, ...nodes].forEach((n) => n.disconnect());
}

/** Transient: a sub-30ms broadband snap that makes a sound read as instant. */
function crack(v: Voice, level: number, bright = 5000, delay = 0) {
  noise(v, 'highpass', bright, bright * 0.6, 0.028, level, { attack: 0.0008, delay, q: 0.7 });
  noise(v, 'bandpass', bright * 0.4, bright * 0.25, 0.018, level * 0.7, {
    attack: 0.0005,
    delay,
    q: 1.2,
  });
}

/** Supersonic crack: an N-wave pressure spike plus a 7-16kHz sheen. */
function sonic(v: Voice, level: number, delay = 0) {
  sample(v, v.mix.nwave, 1, level * 0.5, { delay });
  noise(v, 'highpass', 11000, 7000, 0.022, level * 0.55, { attack: 0.0005, delay, q: 0.5 });
  noise(v, 'highpass', 9000, 6000, 0.02, level * 0.35, { attack: 0.0005, delay, pan: -0.6 });
  noise(v, 'highpass', 9500, 6500, 0.02, level * 0.35, {
    attack: 0.0005,
    delay: delay + 0.004,
    pan: 0.6,
  });
}

/** Body: a saturated pitch-dropping sine plus a clean sub an octave down. */
function thump(v: Voice, from: number, to: number, duration: number, level: number, delay = 0) {
  tone(v, 'sine', from, to, duration, level, { dirty: true, delay, attack: 0.002 });
  tone(v, 'sine', from / 2, Math.max(22, to / 2), duration * 1.2, level * 0.7, { delay });
}

/**
 * Struck metal by modal synthesis: a pre-rendered bank of 14-68 inharmonic, individually
 * decaying and panned modes (plate, bar or thin sheet), resampled to `base` Hz, choked after
 * `duration`, and partly fed through the metallic plate IR.
 */
function clang(
  v: Voice,
  base: number,
  duration: number,
  level: number,
  delay = 0,
  material: Material = 'plate',
  pan = 0,
) {
  const rate = Math.min(2.5, (base / MODAL_BASE) * vary(0.02));
  sample(v, modal(material, Math.floor(Math.random() * 3)), rate, level, {
    delay,
    choke: duration,
    pan,
    send: 'metal',
    sendLevel: 0.5,
  });
}

/**
 * Granular debris: `count` grains of metal and concrete chips from the rubble bank, each at
 * its own pitch, level and stereo position, landing over `over` seconds.
 */
function debris(
  v: Voice,
  count: number,
  over: number,
  level: number,
  pitch = 1,
  start = 0.08,
  width = 0.95,
) {
  const { buffer, grains } = v.mix.rubble;
  for (let i = 0; i < count; i++) {
    const at = start + over * Math.random() ** 1.6,
      fade = 1 - (at - start) / (over + 0.1),
      [offset, length] = grains[Math.floor(Math.random() * grains.length)]!,
      rate = pitch * vary(0.4);
    sample(v, buffer, rate, level * fade * (0.5 + Math.random() * 0.7), {
      delay: at,
      offset,
      length: length,
      pan: spread(width),
      dirty: Math.random() < 0.3,
    });
  }
  noise(v, 'bandpass', 3000 * pitch, 1500, over, level * 0.25, {
    q: 0.8,
    delay: start,
    crackle: true,
    attack: 0.05,
    pan: spread(0.5),
  });
}

function fire(weapon: PlayerState['top'], where: Where, id: string) {
  const r = vary();
  if (weapon === 'cannon') {
    const v = voice(`fire:${id}`, 0.05, 1.8, 1, where, true, false, 0.55, 0.5);
    if (!v) return;
    duckMusic(0.75 * where.gain, 0.2);
    // Supersonic crack and muzzle blast.
    sonic(v, 0.9);
    crack(v, 0.7, 4200 * r);
    // Muzzle-blast turbulence: a 7-12kHz hiss that sprays out to both sides.
    noise(v, 'highpass', 9000, 5000, 0.35, 0.6, { q: 0.6, pan: -0.8, attack: 0.002 });
    noise(v, 'highpass', 8500, 4800, 0.38, 0.6, { q: 0.6, pan: 0.8, attack: 0.002, delay: 0.005 });
    noise(v, 'highpass', 12000, 8000, 0.06, 0.8, { q: 0.5, attack: 0.001 });
    thump(v, 150 * r, 34, 0.6, 1.1);
    noise(v, 'lowpass', 2600, 120, 0.5, 1, { q: 0.6, dirty: true, send: 'tube', sendLevel: 0.6 });
    noise(v, 'bandpass', 900 * r, 220, 0.45, 0.45, { q: 0.7, pan: -0.75 });
    noise(v, 'bandpass', 800 * r, 200, 0.5, 0.45, { q: 0.7, pan: 0.75, delay: 0.006 });
    // Breech foley: latch unlocks, the block slides back, re-seats, and the casing bounces.
    clang(v, 900 * r, 0.18, 0.3, 0.13, 'bar', 0.2);
    noise(v, 'bandpass', 2600, 1400, 0.07, 0.3, { q: 2.5, delay: 0.17, send: 'metal' });
    clang(v, 520 * r, 0.3, 0.42, 0.34, 'plate', -0.15);
    noise(v, 'bandpass', 1800, 1000, 0.03, 0.5, { q: 3, delay: 0.34 });
    for (const [at, f, pan] of [
      [0.44, 3100, 0.55],
      [0.58, 2950, 0.7],
      [0.66, 3000, 0.75],
    ] as const) {
      tone(v, 'sine', f * r, f * r * 0.99, 0.12, 0.09, { delay: at, pan });
      tone(v, 'sine', f * 1.53 * r, f * 1.51 * r, 0.08, 0.05, { delay: at, pan });
    }
    // Tail: outdoor rumble rolling off the towers.
    noise(v, 'lowpass', 500, 90, 1.3, 0.35, { delay: 0.05, attack: 0.06, q: 0.5 });
  } else if (weapon === 'scattergun') {
    const v = voice(`fire:${id}`, 0.05, 1, 0.95, where, true, false, 0.45, 0.4);
    if (!v) return;
    duckMusic(0.55 * where.gain, 0.12);
    crack(v, 0.7, 4200 * r);
    thump(v, 210 * r, 60, 0.18, 0.75);
    // Two decorrelated blasts, hard left and right.
    noise(v, 'highpass', 3200, 1000, 0.13, 0.8, { q: 0.7, dirty: true, pan: -0.85 });
    noise(v, 'highpass', 2800, 900, 0.14, 0.8, { q: 0.7, dirty: true, pan: 0.85, delay: 0.004 });
    noise(v, 'bandpass', 1300 * r, 280, 0.3, 0.7, { q: 0.9, dirty: true });
    tone(v, 'sawtooth', 240 * r, 50, 0.16, 0.35, { dirty: true });
    // Nine pellets fanning out across the stereo field, each a crack and a short whizz.
    const order = [...Array(9).keys()].sort(() => Math.random() - 0.5);
    for (const [i, slot] of order.entries()) {
      const pan = -0.95 + (1.9 * slot) / 8,
        at = 0.012 + i * 0.011 * vary(0.3);
      noise(v, 'bandpass', 4200 * vary(0.3), 2200, 0.03, 0.3, { q: 5, delay: at, pan });
      tone(v, 'sine', 6200 * vary(0.2), 2600, 0.06, 0.04, { delay: at, pan });
    }
    // Pump action: rack back, slam forward, through the metal IR.
    clang(v, 700 * r, 0.12, 0.22, 0.34, 'sheet', 0.3);
    noise(v, 'bandpass', 1500, 900, 0.05, 0.35, { q: 3, delay: 0.34, send: 'metal' });
    clang(v, 480 * r, 0.16, 0.3, 0.47, 'plate', 0.3);
    noise(v, 'bandpass', 1100, 700, 0.05, 0.4, { q: 4, delay: 0.47 });
  } else if (weapon === 'railgun') {
    const v = voice(`fire:${id}`, 0.05, 1.5, 0.9, where, true, false, 0.6, 0.6);
    if (!v) return;
    duckMusic(0.65 * where.gain, 0.16);
    // A 70ms capacitor whine, split across the ears, snaps into a supersonic crack.
    tone(v, 'sine', 900 * r, 7000, 0.07, 0.16, { attack: 0.05, pan: -0.5 });
    tone(v, 'sine', 907 * r, 7100, 0.07, 0.16, { attack: 0.05, pan: 0.5 });
    tone(v, 'sawtooth', 450 * r, 3500, 0.07, 0.07, { attack: 0.05 });
    const s = 0.07;
    sonic(v, 0.8, s);
    crack(v, 0.9, 7000, s);
    tone(v, 'sawtooth', 3600 * r, 80, 0.5, 0.3, { dirty: true, delay: s });
    tone(v, 'sine', 5400 * r, 600, 0.3, 0.22, { delay: s });
    thump(v, 140, 40, 0.35, 0.75, s);
    // The rails ring like a struck bar, and arcs crawl across the stereo field.
    clang(v, 780 * r, 1, 0.16, s, 'bar');
    for (let i = 0; i < 3; i++)
      noise(v, 'bandpass', 4200 * vary(0.2), 2200, 0.35, 0.55, {
        q: 1.5,
        delay: s + 0.03 + i * 0.12,
        crackle: true,
        pan: spread(0.9),
      });
    tone(v, 'square', 110 * r, 100, 0.6, 0.06, { dirty: true, delay: s + 0.02 });
  }
}

interface Held {
  gain: GainNode;
  panner: StereoPannerNode;
  filter: BiquadFilterNode;
  bite?: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  /** Motor oscillators and their ratio to the motor pitch. */
  oscs: [OscillatorNode, number][];
  pitch: number;
  active: boolean;
  spinUntil: number;
  lastActive: number;
  seen: boolean;
}
/** One looping voice per held weapon, keyed `${playerId}:${weapon}`, faded in and out. */
const held = new Map<string, Held>();
/** Player id -> time until which its saw or drill is biting a target. */
const grinding = new Map<string, number>();

function loop(buffer: AudioBuffer, type: BiquadFilterType, f: number, q: number, level: number) {
  const source = ctx.createBufferSource(),
    filter = ctx.createBiquadFilter(),
    gain = ctx.createGain();
  source.buffer = buffer;
  source.loop = true;
  filter.type = type;
  filter.frequency.value = f;
  filter.Q.value = q;
  gain.gain.value = level;
  source.connect(filter).connect(gain);
  source.start(ctx.currentTime, Math.random() * 1.9);
  return { source, filter, gain };
}

function holdVoice(kind: 'flamethrower' | 'saw' | 'drill'): Held {
  context();
  const gain = ctx.createGain(),
    panner = ctx.createStereoPanner(),
    send = ctx.createGain();
  gain.gain.value = 0;
  send.gain.value = 0.25;
  gain.connect(panner).connect(mix!.bed);
  panner.connect(send).connect(sends.reverb);
  const nodes: AudioNode[] = [gain, panner, send],
    sources: AudioScheduledSourceNode[] = [];
  const add = (l: ReturnType<typeof loop>, pan = 0) => {
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      l.gain.connect(p).connect(gain);
      nodes.push(p);
    } else l.gain.connect(gain);
    nodes.push(l.source, l.filter, l.gain);
    sources.push(l.source);
    return l;
  };
  let main: ReturnType<typeof loop>, bite: GainNode | undefined;
  if (kind === 'flamethrower') {
    // Roar, low combustion body, pilot hiss and popping crackle, spread across the ears.
    main = add(loop(mix!.noise, 'lowpass', 900, 0.6, 1));
    add(loop(mix!.noise, 'bandpass', 220, 0.9, 0.9));
    add(loop(mix!.noise, 'highpass', 5000, 0.7, 0.12), -0.6);
    add(loop(mix!.crackle, 'highpass', 1200, 0.7, 1.2), 0.6);
    add(loop(mix!.crackle, 'highpass', 1500, 0.7, 1.2), -0.6);
  } else {
    main = add(
      loop(mix!.noise, 'bandpass', kind === 'saw' ? 4200 : 1300, kind === 'saw' ? 3 : 2, 0.6),
    );
    // Sparks and grit, opened only while the blade bites armor.
    const grit = add(loop(mix!.crackle, 'bandpass', kind === 'saw' ? 3500 : 2200, 1.2, 0), 0.4);
    bite = grit.gain;
  }
  const h: Held = {
    gain,
    panner,
    filter: main.filter,
    bite,
    nodes,
    sources,
    oscs: [],
    pitch: kind === 'saw' ? 820 : 95,
    active: false,
    spinUntil: 0,
    lastActive: ctx.currentTime,
    seen: true,
  };
  if (kind !== 'flamethrower') {
    const osc = ctx.createOscillator(),
      harmonic = ctx.createOscillator(),
      shaper = ctx.createWaveShaper(),
      oscGain = ctx.createGain();
    osc.type = kind === 'saw' ? 'sawtooth' : 'square';
    harmonic.type = 'triangle';
    // The second oscillator follows the motor at an inharmonic ratio: gear whine.
    h.oscs = [
      [osc, 1],
      [harmonic, kind === 'saw' ? 2.03 : 3.1],
    ];
    for (const [o, r] of h.oscs) o.frequency.value = h.pitch * 0.35 * r;
    shaper.curve = mix!.crunch;
    oscGain.gain.value = 0.45;
    osc.connect(shaper);
    harmonic.connect(shaper);
    shaper.connect(oscGain).connect(gain);
    osc.start();
    harmonic.start();
    nodes.push(osc, harmonic, shaper, oscGain);
    sources.push(osc, harmonic);
  }
  return h;
}

function release(
  key: string,
  h: { gain: GainNode; sources: AudioScheduledSourceNode[]; nodes: AudioNode[] },
) {
  const t = ctx.currentTime;
  h.gain.gain.cancelScheduledValues(t);
  h.gain.gain.setTargetAtTime(0, t, 0.04);
  for (const source of h.sources) source.stop(t + 0.3);
  h.sources[0]!.onended = () => h.nodes.forEach((n) => n.disconnect());
  held.delete(key);
  engines.delete(key);
}

function sustain(
  p: PlayerState,
  kind: 'flamethrower' | 'saw' | 'drill',
  on: boolean,
  where: Where,
) {
  const key = `${p.id}:${kind}`;
  let h = held.get(key);
  if (!h) {
    if (!on) return;
    h = holdVoice(kind);
    held.set(key, h);
  }
  h.seen = true;
  const t = ctx.currentTime;
  if (on) h.lastActive = t;
  else if (t - h.lastActive > 1) {
    // Idle for a while: free the loop; it is rebuilt on the next trigger.
    release(key, h);
    return;
  }
  const level = on ? where.gain * (kind === 'flamethrower' ? 0.6 : 0.36) : 0;
  // Fade to the new level, then to silence unless the next snapshot renews it: a stalled
  // connection can never leave a weapon roaring.
  h.gain.gain.cancelScheduledValues(t);
  h.gain.gain.setTargetAtTime(level, t, 0.03);
  h.gain.gain.setTargetAtTime(0, t + 0.3, 0.06);
  h.panner.pan.setTargetAtTime(where.pan, t, 0.03);
  if (kind === 'flamethrower') {
    // Flicker the roar so it breathes instead of droning.
    h.filter.frequency.setTargetAtTime(700 + Math.random() * 900, t, 0.05);
  } else {
    const biting = on && (grinding.get(p.id) ?? 0) > t;
    h.bite?.gain.setTargetAtTime(biting ? 1.6 : 0, t, 0.03);
    const jitter = vary(0.01);
    for (const [o, r] of h.oscs) {
      const f = o.frequency;
      if (on && !h.active) {
        // Spin-up: the motor climbs to speed over 0.4s.
        f.cancelScheduledValues(t);
        f.setValueAtTime(Math.max(f.value, h.pitch * 0.35 * r), t);
        f.linearRampToValueAtTime(h.pitch * r, t + 0.4);
      } else if (!on) f.setTargetAtTime(h.pitch * 0.35 * r, t, 0.12);
      // The whine bogs down while it bites into armor.
      else if (t >= h.spinUntil)
        f.setTargetAtTime(h.pitch * (biting ? 0.68 : 1) * jitter * r, t, biting ? 0.04 : 0.1);
    }
    if (on && !h.active) h.spinUntil = t + 0.4;
    else if (on && t >= h.spinUntil) {
      h.filter.frequency.setTargetAtTime(
        (kind === 'saw' ? 4200 : 1300) * (biting ? 0.7 : 1),
        t,
        0.05,
      );
    }
  }
  h.active = on;
}

/**
 * Per-chassis powerplant: cylinder count, idle and redline RPM, cylinder imbalance (how lumpy
 * the idle is), exhaust resonance, turbo whine and actuator (servo) whine.
 */
const ENGINE: Record<
  Chassis,
  {
    cylinders: number;
    idle: number;
    redline: number;
    rough: number;
    exhaust: number;
    turbo: number;
    servo: number;
    level: number;
  }
> = {
  dart: {
    cylinders: 4,
    idle: 1150,
    redline: 8400,
    rough: 0.3,
    exhaust: 1300,
    turbo: 5600,
    servo: 1500,
    level: 0.85,
  },
  mule: {
    cylinders: 6,
    idle: 850,
    redline: 6300,
    rough: 0.25,
    exhaust: 900,
    turbo: 4200,
    servo: 1050,
    level: 0.9,
  },
  bruiser: {
    cylinders: 8,
    idle: 680,
    redline: 5200,
    rough: 0.7,
    exhaust: 650,
    turbo: 3200,
    servo: 760,
    level: 1,
  },
  bulwark: {
    cylinders: 6,
    idle: 480,
    redline: 3100,
    rough: 0.55,
    exhaust: 430,
    turbo: 2300,
    servo: 520,
    level: 1.1,
  },
};
interface Engine {
  gain: GainNode;
  panner: StereoPannerNode;
  /** Harmonic stacks (centre, left, right), running at the 4-stroke cycle rate. */
  stacks: OscillatorNode[];
  drive: GainNode;
  load: BiquadFilterNode;
  turbo: OscillatorNode;
  turboGain: GainNode;
  servo: OscillatorNode;
  exhaust: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  seen: boolean;
  gear: number;
  lastSpeed: number;
  shiftUntil: number;
}
const engines = new Map<string, Engine>();
const stacks = new Map<Chassis, PeriodicWave>();

/**
 * A believable engine: three random-phase harmonic stacks from a firing-frequency model
 * (centre full-range; left and right detuned and high-passed, so the bass stays mono), a
 * jittered crank speed, exhaust noise pulsed by the firing waveform, drive and a load filter
 * that open with throttle, a spooling turbo whine and an actuator servo whine.
 */
function engineVoice(chassis: Chassis): Engine {
  const spec = ENGINE[chassis],
    nodes: AudioNode[] = [],
    sources: AudioScheduledSourceNode[] = [];
  const make = <T extends AudioNode>(n: T) => (nodes.push(n), n);
  const start = <T extends AudioScheduledSourceNode>(n: T) => (sources.push(n), n.start(), make(n));
  let wave = stacks.get(chassis);
  if (!wave) {
    const { real, imag } = engineStack(spec.cylinders, spec.rough);
    wave = ctx.createPeriodicWave(real, imag);
    stacks.set(chassis, wave);
  }
  const idle = spec.idle / 120;
  const sum = make(ctx.createGain()),
    drive = make(ctx.createGain()),
    shaper = make(ctx.createWaveShaper()),
    exhaustRes = make(ctx.createBiquadFilter()),
    load = make(ctx.createBiquadFilter()),
    gain = make(ctx.createGain()),
    panner = make(ctx.createStereoPanner());
  shaper.curve = mix!.crunch;
  exhaustRes.type = 'peaking';
  exhaustRes.frequency.value = spec.exhaust;
  exhaustRes.Q.value = 1.2;
  exhaustRes.gain.value = 7;
  load.type = 'lowpass';
  load.Q.value = 0.8;
  load.frequency.value = spec.exhaust * 1.5;
  drive.gain.value = 0.6;
  gain.gain.value = 0;
  sum.connect(drive).connect(shaper).connect(exhaustRes).connect(load).connect(gain);
  gain.connect(panner).connect(mix!.bed);

  // Crank-speed jitter: combustion is never perfectly even.
  const jitterSrc = start(ctx.createBufferSource()),
    jitterLp = make(ctx.createBiquadFilter()),
    jitter = make(ctx.createGain());
  jitterSrc.buffer = mix!.noise;
  jitterSrc.loop = true;
  jitterLp.type = 'lowpass';
  jitterLp.frequency.value = 7;
  jitter.gain.value = 60;
  jitterSrc.connect(jitterLp).connect(jitter);

  const stackOscs: OscillatorNode[] = [];
  for (const [detune, pan] of [
    [0, 0],
    [-9, -0.75],
    [8, 0.75],
  ] as const) {
    const o = start(ctx.createOscillator());
    o.setPeriodicWave(wave);
    o.frequency.value = idle;
    o.detune.value = detune;
    jitter.connect(o.detune);
    stackOscs.push(o);
    if (!pan) {
      o.connect(sum);
      continue;
    }
    const hp = make(ctx.createBiquadFilter()),
      p = make(ctx.createStereoPanner()),
      g = make(ctx.createGain());
    hp.type = 'highpass';
    hp.frequency.value = 220;
    p.pan.value = pan;
    g.gain.value = 0.55;
    o.connect(hp).connect(g).connect(p).connect(sum);
  }

  // Exhaust: noise through the tailpipe resonance, pulsed by the firing waveform.
  const exSrc = start(ctx.createBufferSource()),
    exBand = make(ctx.createBiquadFilter()),
    exhaust = make(ctx.createGain()),
    exAm = make(ctx.createGain());
  exSrc.buffer = mix!.noise;
  exSrc.loop = true;
  exBand.type = 'bandpass';
  exBand.frequency.value = spec.exhaust * 1.4;
  exBand.Q.value = 0.7;
  exhaust.gain.value = 0.15;
  exAm.gain.value = 0.25;
  stackOscs[0]!.connect(exAm).connect(exhaust.gain);
  exSrc.connect(exBand).connect(exhaust).connect(sum);

  // Turbo spools with load; the servo whine tracks the drivetrain.
  const turbo = start(ctx.createOscillator()),
    turboGain = make(ctx.createGain()),
    servo = start(ctx.createOscillator()),
    servoBand = make(ctx.createBiquadFilter()),
    servoGain = make(ctx.createGain());
  turbo.frequency.value = spec.turbo * 0.3;
  turboGain.gain.value = 0;
  turbo.connect(turboGain).connect(load);
  servo.type = 'triangle';
  servo.frequency.value = spec.servo * 0.5;
  servoBand.type = 'bandpass';
  servoBand.frequency.value = spec.servo * 1.5;
  servoBand.Q.value = 2;
  servoGain.gain.value = 0.035;
  servo.connect(servoBand).connect(servoGain).connect(gain);

  return {
    gain,
    panner,
    stacks: stackOscs,
    drive,
    load,
    turbo,
    turboGain,
    servo,
    exhaust,
    nodes,
    sources,
    seen: true,
    gear: 0,
    lastSpeed: 0,
    shiftUntil: 0,
  };
}

function drive(p: PlayerState, where: Where, speed: number, own: boolean, dt: number) {
  const key = `${p.id}:engine`;
  let e = engines.get(key);
  if (!e) {
    if (where.gain < 0.05) return;
    e = engineVoice(p.chassis);
    engines.set(key, e);
  }
  e.seen = true;
  const spec = ENGINE[p.chassis],
    t = ctx.currentTime,
    boosting = (p.boostRemaining ?? 0) > 0,
    s = Math.min(1.6, speed / CHASSIS[p.chassis].speed + (boosting ? 0.45 : 0));
  const box = gearbox(e.gear, s);
  const shifted = box.gear !== e.gear;
  if (shifted) e.shiftUntil = t + 0.09;
  e.gear = box.gear;
  // Throttle load: accelerating or boosting opens it up; cruising sits in the middle.
  const accel = dt > 0.01 ? (s - e.lastSpeed) / dt : 0;
  e.lastSpeed = s;
  const load =
    t < e.shiftUntil
      ? 0.05
      : Math.max(0, Math.min(1, 0.3 + accel * 1.5 + (boosting ? 0.6 : 0) + (s > 0.05 ? 0.15 : 0)));
  const rpm = spec.idle + (spec.redline - spec.idle) * box.rpm;
  const tc = shifted ? 0.04 : 0.09;
  for (const o of e.stacks) o.frequency.setTargetAtTime(rpm / 120, t, tc);
  e.drive.gain.setTargetAtTime(0.5 + 1.6 * load, t, 0.06);
  e.load.frequency.setTargetAtTime(spec.exhaust * (1.3 + 3 * load + 2.5 * box.rpm), t, 0.07);
  e.exhaust.gain.setTargetAtTime(0.1 + 0.25 * load, t, 0.08);
  e.turbo.frequency.setTargetAtTime(spec.turbo * (0.3 + 0.8 * box.rpm), t, 0.35);
  e.turboGain.gain.setTargetAtTime(0.03 * load * box.rpm, t, 0.3);
  e.servo.frequency.setTargetAtTime(spec.servo * (0.5 + s), t, 0.1);
  e.gain.gain.setTargetAtTime(
    where.gain * spec.level * (own ? 0.07 : 0.05) * (0.4 + 0.35 * box.rpm + 0.35 * load),
    t,
    0.06,
  );
  e.panner.pan.setTargetAtTime(where.pan, t, 0.05);
}

/** The swing of a one-shot front weapon, heard whether or not it connects. */
function swing(p: PlayerState, where: Where) {
  const v = voice(`swing:${p.id}`, 0.3, 0.6, 0.6, where, false, false, 0.2, 0.4);
  if (!v) return;
  const r = vary();
  if (p.front === 'ram') {
    // Hydraulic piston punch.
    noise(v, 'highpass', 4000, 1200, 0.2, 0.5, { q: 0.7, pan: -0.4 });
    noise(v, 'highpass', 3600, 1100, 0.2, 0.5, { q: 0.7, pan: 0.4, delay: 0.005 });
    tone(v, 'square', 70 * r, 40, 0.14, 0.5, { dirty: true });
    noise(v, 'bandpass', 900, 400, 0.08, 0.4, { q: 2, delay: 0.02, send: 'metal' });
  } else if (p.front === 'flipper') {
    // Pneumatic blast then a servo whine.
    noise(v, 'highpass', 5000, 2000, 0.3, 0.6, { q: 0.6, pan: spread(0.5) });
    noise(v, 'bandpass', 700, 300, 0.12, 0.6, { q: 1, dirty: true });
    tone(v, 'triangle', 180 * r, 520, 0.22, 0.35, { dirty: true });
  } else if (p.front === 'hook') {
    // Chain paying out, link by link across the stereo field.
    tone(v, 'sawtooth', 1600 * r, 260, 0.35, 0.2);
    for (let i = 0; i < 5; i++)
      noise(v, 'bandpass', 5000 * vary(0.2), 3000, 0.025, 0.3, {
        q: 6,
        delay: i * 0.05,
        pan: -0.6 + i * 0.3,
        send: 'metal',
      });
  } else {
    // Sweeper and hammer: a heavy whoosh with a pitched rotor edge, passing left to right.
    noise(v, 'bandpass', 250, p.front === 'hammer' ? 900 : 2200, 0.32, 0.8, {
      q: 1.4,
      attack: 0.08,
      pan: -0.5,
    });
    noise(v, 'bandpass', 300, p.front === 'hammer' ? 1000 : 2400, 0.3, 0.6, {
      q: 1.4,
      attack: 0.12,
      pan: 0.5,
    });
    noise(v, 'bandpass', 180, 500, 0.3, 0.5, { q: 0.8, attack: 0.1, dirty: true });
  }
}

/** How long each hit kind rings, so short grains free their voice quickly. */
const HIT_SECONDS: Record<string, number> = {
  hammer: 1.6,
  ram: 0.9,
  collision: 0.7,
  flipper: 0.9,
  sweeper: 0.6,
  hook: 0.6,
  saw: 0.15,
  drill: 0.15,
  wedge: 0.18,
  burn: 0.16,
  cannon: 1.3,
  scattergun: 0.6,
  railgun: 1.2,
};

function hit(e: GameEvent, s: RoomState, where: Where) {
  const attacker = s.players.find((p) => p.id === e.attackerId),
    victim = s.players.find((p) => p.id === e.playerId),
    // Heavier chassis ring lower.
    heavy = 1 / Math.sqrt(victim ? CHASSIS[victim.chassis].mass : 1),
    r = vary() * heavy;
  const kind =
    e.melee ??
    (e.reason === 'collision'
      ? 'collision'
      : attacker?.top === 'flamethrower' || (!attacker && victim?.burning)
        ? 'burn'
        : (attacker?.top ?? 'thud'));
  if ((kind === 'saw' || kind === 'drill') && e.attackerId)
    grinding.set(e.attackerId, context().currentTime + 0.15);
  const duration = HIT_SECONDS[kind] ?? 0.3;
  const v = voice(
    `hit:${e.playerId}:${kind}`,
    duration < 0.2 ? 0.12 : 0.03,
    duration,
    1,
    where,
    false,
    false,
    0.4,
    0.5,
  );
  if (!v) return;
  switch (kind) {
    case 'hammer':
      // A heavy plate struck dead centre: long ring, deep body, shrapnel.
      duckMusic(0.7 * where.gain, 0.2);
      crack(v, 0.9, 3500);
      thump(v, 120 * r, 32, 0.45, 1.1);
      clang(v, 150 * r, 1.4, 0.55, 0, 'plate');
      clang(v, 410 * r, 0.6, 0.25, 0.004, 'bar', 0.3);
      noise(v, 'lowpass', 3000, 200, 0.3, 0.8, { q: 0.8, dirty: true });
      debris(v, 8, 0.6, 0.5, 1.1);
      break;
    case 'ram':
    case 'collision':
      // Crumpling plate: a dirty mid band scraping downward and a creaking panel.
      duckMusic(0.45 * where.gain, 0.12);
      crack(v, 0.6, 2500);
      thump(v, 100 * r, 38, 0.3, 0.95);
      noise(v, 'bandpass', 1100 * r, 260, 0.3, 1, { q: 1.2, dirty: true, send: 'metal' });
      clang(v, 230 * r, 0.7, 0.35, 0, 'sheet', spread(0.4));
      tone(v, 'sawtooth', 420 * r, 300, 0.25, 0.06, { delay: 0.05, pan: spread(0.6) });
      if (kind === 'ram') debris(v, 4, 0.35, 0.35);
      break;
    case 'flipper':
      crack(v, 0.6, 3000);
      thump(v, 140 * r, 50, 0.28, 0.85);
      clang(v, 330 * r, 0.8, 0.35, 0, 'plate');
      noise(v, 'highpass', 3000, 900, 0.4, 0.35, { q: 0.5, pan: spread(0.6) });
      break;
    case 'sweeper':
    case 'hook':
      crack(v, 0.6, 4500);
      clang(v, 520 * r, 0.55, 0.35, 0, 'sheet', spread(0.5));
      noise(v, 'bandpass', 2200, 800, 0.14, 0.6, { q: 1.2, dirty: true });
      thump(v, 150, 60, 0.15, 0.4);
      break;
    case 'saw':
      noise(v, 'bandpass', 5500 * r, 3200, 0.14, 0.45, { q: 5, dirty: true, pan: spread(0.4) });
      tone(v, 'sawtooth', 1900 * r, 1500, 0.12, 0.15);
      noise(v, 'highpass', 6000, 4000, 0.12, 0.4, { crackle: true, pan: spread(0.7) });
      break;
    case 'drill':
      noise(v, 'bandpass', 2600 * r, 1800, 0.14, 0.45, { q: 3, dirty: true });
      tone(v, 'square', 160 * r, 120, 0.12, 0.2, { dirty: true });
      noise(v, 'bandpass', 3000, 2000, 0.12, 0.35, { crackle: true, pan: spread(0.7) });
      break;
    case 'wedge':
      noise(v, 'bandpass', 1500 * r, 700, 0.15, 0.35, { q: 4, dirty: true, send: 'metal' });
      tone(v, 'sine', 110, 60, 0.1, 0.3);
      break;
    case 'burn':
      noise(v, 'highpass', 4000 * r, 6000, 0.12, 0.3, { q: 0.7, pan: spread(0.5) });
      noise(v, 'bandpass', 1800, 900, 0.12, 0.35, { q: 1, delay: 0.02, crackle: true });
      break;
    case 'cannon':
      // Shell detonating on armor: blast, a thick plate ring and a spray of fragments.
      duckMusic(0.65 * where.gain, 0.2);
      crack(v, 1, 3200);
      thump(v, 130 * r, 34, 0.45, 1.05);
      clang(v, 200 * r, 1, 0.45, 0, 'plate');
      noise(v, 'lowpass', 4000, 250, 0.35, 0.8, { q: 0.7, dirty: true });
      noise(v, 'bandpass', 1400, 400, 0.3, 0.4, { q: 0.8, pan: -0.7 });
      noise(v, 'bandpass', 1200, 350, 0.3, 0.4, { q: 0.8, pan: 0.7, delay: 0.008 });
      debris(v, 10, 0.8, 0.5);
      break;
    case 'scattergun':
      // Pellets peppering a thin panel: a rattle of pings spread wide.
      for (let i = 0; i < 6; i++) {
        const pan = spread(0.9);
        crack(v, 0.35, 4500 * vary(0.3), i * 0.014 * vary(0.4));
        clang(v, 800 * vary(0.25), 0.25, 0.14, i * 0.014, 'sheet', pan);
      }
      thump(v, 150, 60, 0.12, 0.5);
      break;
    case 'railgun':
      // A slug punching straight through: a bright bar ring and a sizzle that crawls away.
      duckMusic(0.55 * where.gain, 0.15);
      sonic(v, 0.6);
      crack(v, 1, 6000);
      tone(v, 'sawtooth', 2600 * r, 300, 0.2, 0.25, { dirty: true });
      clang(v, 640 * r, 1.1, 0.35, 0, 'bar');
      thump(v, 120, 45, 0.3, 0.7);
      noise(v, 'bandpass', 4000, 2000, 0.6, 0.6, { q: 1.5, crackle: true, delay: 0.02, pan: -0.6 });
      noise(v, 'bandpass', 5000, 2500, 0.7, 0.5, { q: 1.5, crackle: true, delay: 0.1, pan: 0.6 });
      break;
    default:
      crack(v, 0.5, 3000);
      thump(v, 140 * r, 50, 0.22, 0.7);
      noise(v, 'bandpass', 1200, 400, 0.15, 0.5, { q: 1, dirty: true });
  }
}

function boom(where: Where, key: string, size: number) {
  const v = voice(key, 0.04, 2.8 * size, size * 1.45, where, true, true, 0.7, 0.45);
  if (!v) return;
  // Muffle the other SFX and duck the music, scaled by how close the blast is.
  const punch = Math.min(1, where.gain * size);
  duckMusic(0.9 * punch, 0.4);
  bus.frequency.cancelScheduledValues(v.t);
  bus.frequency.setTargetAtTime(20000 - 19200 * punch, v.t, 0.01);
  bus.frequency.setTargetAtTime(20000, v.t + 0.1, 0.35);
  master.gain.cancelScheduledValues(v.t);
  master.gain.setTargetAtTime(DRY * (1 - 0.35 * punch), v.t, 0.01);
  master.gain.setTargetAtTime(DRY, v.t + 0.1, 0.3);
  const r = vary(0.1);
  crack(v, 1.2, 3500 * r);
  sonic(v, 0.5);
  // Sub drop: the chest hit, kept mono.
  tone(v, 'sine', 90 * r, 22, 1.4 * size, 1.1, { dirty: true, attack: 0.002 });
  tone(v, 'sine', 48 * r, 24, 1.8 * size, 0.9, { attack: 0.004 });
  noise(v, 'lowpass', 6000, 90, 1.8 * size, 1.1, { q: 0.6, dirty: true });
  // Decorrelated blasts hard left and right.
  noise(v, 'bandpass', 2800, 500, 0.6, 0.7, { q: 0.8, pan: -0.9 });
  noise(v, 'bandpass', 2400, 450, 0.65, 0.7, { q: 0.8, pan: 0.9, delay: 0.007 });
  noise(v, 'highpass', 5000, 2500, 0.25, 0.4, { q: 0.6, pan: spread(0.4) });
  // Rolling rumble off the surrounding towers, and the structure groaning.
  noise(v, 'lowpass', 400, 80, 2.2 * size, 0.6, { q: 0.5, delay: 0.12, attack: 0.15 });
  clang(v, 95 * r, 1.6, 0.3, 0.05, 'plate', spread(0.3));
  // Stereo debris raining down around the listener.
  debris(v, 20, 1.6 * size, 0.6, 1, 0.12, 1);
}

/** Last seen per-player state, to catch recharge, overheat and boost edges and measure speed. */
const previous = new Map<
  string,
  {
    topCooldown: number;
    overheated: boolean;
    boost: number;
    x: number;
    z: number;
    t: number;
    speed: number;
  }
>();
/** Projectiles in flight last snapshot, to hear the ones that stop short on something. */
const flights = new Map<number, Projectile>();
let lastPhase = '',
  lastCount = 0;

function recharge(where: Where, id: string) {
  const v = voice(`charge:${id}`, 1, 0.6, 0.35, where);
  if (!v) return;
  tone(v, 'sine', 300, 2400, 0.45, 0.35, { attack: 0.3, pan: -0.3 });
  tone(v, 'triangle', 150, 1200, 0.45, 0.25, { dirty: true, attack: 0.3 });
  noise(v, 'bandpass', 3000, 9000, 0.45, 0.15, { q: 4, attack: 0.3, pan: 0.3 });
  tone(v, 'sine', 2400, 2400, 0.12, 0.2, { delay: 0.45 });
}

function overheat(where: Where, id: string) {
  const v = voice(`overheat:${id}`, 1, 1, 0.6, where, true);
  if (!v) return;
  noise(v, 'highpass', 6000, 2500, 0.8, 0.5, { q: 0.7, pan: spread(0.5) });
  for (let i = 0; i < 4; i++)
    noise(v, 'lowpass', 1200 * vary(0.3), 300, 0.06, 0.6, {
      dirty: true,
      delay: 0.08 + i * 0.11 * vary(0.3),
      pan: spread(0.6),
    });
  tone(v, 'square', 120, 60, 0.25, 0.2, { dirty: true });
  tone(v, 'sine', 1800, 1750, 0.5, 0.08, { delay: 0.1 });
}

function boost(where: Where, id: string) {
  const v = voice(`boost:${id}`, 0.5, 0.8, 0.8, where, true, false, 0.35, 0.5);
  if (!v) return;
  duckMusic(0.3 * where.gain, 0.2);
  crack(v, 0.5, 2500);
  thump(v, 90, 40, 0.25, 0.8);
  // Turbo whoosh sweeping up, wide.
  noise(v, 'bandpass', 400, 5000, 0.4, 0.7, { q: 1.5, attack: 0.03, pan: -0.7 });
  noise(v, 'bandpass', 500, 6000, 0.42, 0.7, { q: 1.5, attack: 0.03, pan: 0.7 });
  tone(v, 'sawtooth', 300, 1400, 0.3, 0.14, { dirty: true, attack: 0.02 });
  noise(v, 'highpass', 6000, 3000, 0.5, 0.3, { q: 0.7, delay: 0.08 });
}

function ricochet(q: Projectile, where: Where) {
  const v = voice(`ricochet:${q.id}`, 0, 0.45, 0.6, where, false, false, 0.45, 0.4);
  if (!v) return;
  const r = vary(0.15),
    pan = spread(0.5);
  crack(v, 0.4, 4000);
  clang(v, (q.weapon === 'scattergun' ? 900 : 450) * r, 0.3, 0.25, 0, 'sheet');
  // Whizz off: a falling doppler whistle that flies to one side.
  tone(v, 'sine', 3800 * r, 1400, 0.25, 0.1, { pan: pan > 0 ? 0.8 : -0.8 });
  noise(v, 'bandpass', 2500 * r, 900, 0.08, 0.4, { q: 1.5, dirty: true });
}

function eliminated(where: Where, id: string) {
  boom(where, `ko:${id}`, 1.1);
  const v = voice(`ko-whine:${id}`, 1, 1.6, 0.55, where, true, true, 0.6, 0.4);
  if (!v) return;
  // Power-down: servos and turbine winding to a stop while circuits arc out.
  tone(v, 'sawtooth', 700, 40, 1.4, 0.3, { dirty: true });
  tone(v, 'square', 350, 25, 1.2, 0.12, { dirty: true });
  noise(v, 'bandpass', 4500, 1800, 1.2, 0.5, { q: 1.5, crackle: true, delay: 0.1, pan: -0.7 });
  noise(v, 'bandpass', 3800, 1500, 1.1, 0.5, { q: 1.5, crackle: true, delay: 0.25, pan: 0.7 });
}

const centre = { pan: 0, gain: 1 };
function countdownTick(n: number) {
  const v = voice(`count:${n}`, 0.3, 0.8, 0.5, centre, true, true, 0.5, 0.4);
  if (!v) return;
  crack(v, 0.4, 3000);
  clang(v, 220, 0.6, 0.25, 0, 'bar');
  tone(v, 'square', 440, 440, 0.25, 0.1, { attack: 0.002 });
  tone(v, 'sine', 880, 880, 0.35, 0.15);
  thump(v, 110, 45, 0.2, 0.6);
}

function fightStinger() {
  const v = voice('fight', 2, 2.8, 0.85, centre, true, true, 0.8, 0.5);
  if (!v) return;
  duckMusic(0.8, 0.5);
  crack(v, 1.2, 3000);
  tone(v, 'sine', 80, 24, 1.6, 1.1, { dirty: true });
  tone(v, 'sine', 45, 26, 2, 0.9);
  noise(v, 'lowpass', 5000, 100, 1.5, 0.8, { q: 0.6, dirty: true });
  // A brassy D-minor power stab, wide, with a clanging anvil on top.
  for (const [f, pan] of [
    [73.4, 0],
    [110, -0.7],
    [146.8, 0.7],
    [220, -0.5],
    [293.7, 0.5],
  ] as const) {
    tone(v, 'sawtooth', f * 1.01, f, 1.2, 0.12, { dirty: true, pan, attack: 0.01 });
    tone(v, 'sawtooth', f * 0.995, f, 1.2, 0.1, { pan: -pan, attack: 0.01 });
  }
  clang(v, 180, 2, 0.4, 0, 'bar');
  noise(v, 'highpass', 5000, 3000, 2.2, 0.25, { q: 0.5, delay: 0.02, attack: 0.02, pan: -0.5 });
  noise(v, 'highpass', 5200, 3100, 2.2, 0.25, { q: 0.5, delay: 0.03, attack: 0.02, pan: 0.5 });
}

/** Leaves the fight: silences every loop and lets the context sleep if music is off too. */
function silence() {
  for (const [key, h] of held) release(key, h);
  for (const [key, e] of engines) release(key, e);
  previous.clear();
  flights.clear();
}

/** Stops every held weapon loop, e.g. on leaving a room or muting. */
export function stopCombatSounds() {
  if (mix) silence();
  lastPhase = '';
  setMood('menu');
  want('sfx', false);
}

/**
 * Plays everything audible in a fresh snapshot: new events plus held weapons and engines.
 * The listener is the watched robot; its absence yields centred, unattenuated sound.
 */
export function playCombatSounds(
  s: RoomState,
  events: GameEvent[],
  listener: PlayerState | undefined,
  enabled: boolean,
) {
  if (typeof AudioContext === 'undefined') return;
  setMood(moodFor(s, listener));
  if (!enabled) {
    if (mix) silence();
    want('sfx', false);
    return;
  }
  try {
    want('sfx', true);
    const now = context().currentTime;
    if (s.phase === 'countdown') {
      const n = Math.ceil(s.countdown);
      if (n !== lastCount && n > 0) countdownTick(n);
      lastCount = n;
    }
    if (s.phase === 'combat' && lastPhase === 'countdown') fightStinger();
    lastPhase = s.phase;
    for (const e of events) {
      const where = spatial(listener, e.x, e.z);
      if (e.type === 'shot') {
        const p = s.players.find((p) => p.id === e.playerId);
        if (p) fire(p.top, where, p.id);
      } else if (e.type === 'hit') hit(e, s, where);
      else if (e.type === 'explosion') boom(where, `boom:${e.playerId}`, 1.2);
      else if (e.type === 'elimination') eliminated(where, e.playerId);
    }
    if (s.phase !== 'combat') {
      silence();
      return;
    }
    for (const h of held.values()) h.seen = false;
    for (const e of engines.values()) e.seen = false;
    for (const p of s.players) {
      if (!p.alive) continue;
      const where = spatial(listener, p.x, p.z),
        was = previous.get(p.id);
      if (p.top === 'flamethrower') sustain(p, 'flamethrower', p.topActive, where);
      if (p.front === 'saw' || p.front === 'drill') sustain(p, p.front, p.frontActive, where);
      if (p.frontActive && !FRONT_RULES[p.front].continuous && WEAPONS[p.front].cooldown > 0)
        swing(p, where);
      if (p.top === 'railgun' && was && was.topCooldown > 0.4 && p.topCooldown <= 0.4)
        recharge(where, p.id);
      if (p.overheated && was && !was.overheated) overheat(where, p.id);
      const boosting = p.boostRemaining ?? 0;
      if (boosting > 0 && was && was.boost === 0) boost(where, p.id);
      const dt = was ? now - was.t : 0;
      const speed =
        was && dt > 0.01
          ? Math.min(20, Math.hypot(p.x - was.x, p.z - was.z) / dt) * 0.5 + was.speed * 0.5
          : 0;
      drive(p, where, speed, p.id === listener?.id, dt);
      previous.set(p.id, {
        topCooldown: p.topCooldown,
        overheated: p.overheated,
        boost: boosting,
        x: p.x,
        z: p.z,
        t: now,
        speed,
      });
    }
    // Loops of robots that died or left.
    for (const [key, h] of held) if (!h.seen) release(key, h);
    for (const [key, e] of engines) if (!e.seen) release(key, e);
    // A projectile gone before its range ran out struck something; robot hits already clang.
    const live = new Set(s.projectiles.map((q) => q.id));
    for (const q of flights.values()) {
      const step = PROJECTILE_RULES[q.weapon].speed * TICK_SECONDS;
      if (
        !live.has(q.id) &&
        q.distance + step * 1.5 < WEAPONS[q.weapon].range &&
        !events.some((e) => e.type === 'hit' && Math.hypot(e.x - q.x, e.z - q.z) < step + 2.5)
      )
        ricochet(q, spatial(listener, q.x, q.z));
    }
    flights.clear();
    for (const q of s.projectiles) flights.set(q.id, { ...q });
  } catch {
    /* Audio is optional. */
  }
}

/**
 * Menu blips: hover ticks, clicks and toggles. A blip wakes an existing context for a moment
 * (it is inside a user gesture), but never creates one, so a muted menu opens no audio.
 * Every layer ramps in over 1.5-3ms, so nothing pops.
 */
export function installUiSounds(enabled: () => boolean) {
  const control = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest('button, a, label, input, select, [role="button"]')
      : null;
  const blip = (kind: 'hover' | 'click') => {
    if (!enabled() || !uiMix()) return;
    const v = voice(
      `ui:${kind}`,
      kind === 'hover' ? 0.04 : 0.03,
      0.3,
      kind === 'hover' ? 2.2 : 2.9,
      centre,
      false,
      true,
      0.25,
      0.25,
    );
    if (!v) return;
    const r = vary(0.03);
    if (kind === 'hover') {
      // A soft glassy tick: two partials, slightly split across the ears.
      tone(v, 'sine', 2300 * r, 2250 * r, 0.07, 0.3, { attack: 0.002, pan: -0.2 });
      tone(v, 'sine', 3460 * r, 3400 * r, 0.05, 0.14, { attack: 0.002, pan: 0.25 });
      noise(v, 'highpass', 7000, 6000, 0.018, 0.08, { attack: 0.002 });
    } else {
      // A crisp mechanical switch: tick, a small bar ring and a mid body, no sub.
      noise(v, 'bandpass', 4200, 3000, 0.02, 0.35, { attack: 0.0015, q: 1.2 });
      tone(v, 'triangle', 1250 * r, 1050 * r, 0.06, 0.3, { attack: 0.002 });
      tone(v, 'sine', 640 * r, 560 * r, 0.08, 0.35, { attack: 0.003 });
      clang(v, 820 * r, 0.14, 0.25, 0.002, 'bar');
    }
  };
  document.addEventListener('pointerover', (e) => {
    const c = control(e.target);
    if (c && c !== control(e.relatedTarget)) blip('hover');
  });
  document.addEventListener('click', (e) => {
    if (control(e.target)) blip('click');
  });
}
