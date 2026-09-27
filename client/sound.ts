import {
  FRONT_RULES,
  PROJECTILE_RULES,
  TICK_SECONDS,
  WEAPONS,
  type Projectile,
  type GameEvent,
  type PlayerState,
  type RoomState,
} from '../shared/game.js';

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

const MAX_VOICES = 28;
/** Absolute ceiling, which even important voices respect. */
const HARD_VOICES = 48;
let audio: AudioContext | null = null,
  master: GainNode,
  post: GainNode,
  bus: BiquadFilterNode,
  noiseBuffer: AudioBuffer,
  crunch: Float32Array<ArrayBuffer>,
  voices = 0;
const lastPlayed = new Map<string, number>();

function context() {
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = 0.55;
    const limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    // A low-pass on the whole mix, swept down after big booms so they muffle everything else.
    bus = audio.createBiquadFilter();
    bus.frequency.value = 20000;
    master.connect(bus).connect(limiter).connect(audio.destination);
    // Booms skip the bus they duck, so their own crack stays bright.
    post = audio.createGain();
    post.gain.value = 0.55;
    post.connect(limiter);
    noiseBuffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    crunch = new Float32Array(1024);
    for (let i = 0; i < crunch.length; i++) {
      const x = (i / (crunch.length - 1)) * 2 - 1;
      crunch[i] = Math.tanh(x * 4);
    }
  }
  if (audio.state === 'suspended') void audio.resume();
  return audio;
}

/** Slight random detune so repeated sounds never sound identical. */
const vary = (amount = 0.08) => 1 + (Math.random() * 2 - 1) * amount;

interface Voice {
  ctx: AudioContext;
  t: number;
  out: AudioNode;
  dirty: AudioNode;
}

/**
 * Opens a panned voice held for `duration`, or null when muted, too far, throttled, or over
 * the voice budget. Important voices (shots, booms) skip the soft cap, never the hard one.
 * `unducked` voices bypass the master duck and low-pass.
 */
function voice(
  key: string,
  gap: number,
  duration: number,
  volume: number,
  where: { pan: number; gain: number },
  important = false,
  unducked = false,
): Voice | null {
  if (where.gain * volume < 0.02 || voices >= HARD_VOICES || (!important && voices >= MAX_VOICES))
    return null;
  const ctx = context(),
    t = ctx.currentTime;
  if (t - (lastPlayed.get(key) ?? -Infinity) < gap) return null;
  lastPlayed.set(key, t);
  if (lastPlayed.size > 256) lastPlayed.clear();
  const out = ctx.createGain(),
    panner = ctx.createStereoPanner(),
    shaper = ctx.createWaveShaper();
  out.gain.value = where.gain * volume;
  panner.pan.value = where.pan;
  shaper.curve = crunch;
  shaper.connect(out);
  out.connect(panner).connect(unducked ? post : master);
  voices++;
  setTimeout(
    () => {
      voices--;
      out.disconnect();
      shaper.disconnect();
      panner.disconnect();
    },
    (duration + 0.1) * 1000,
  );
  return { ctx, t, out, dirty: shaper };
}

function tone(
  v: Voice,
  type: OscillatorType,
  from: number,
  to: number,
  duration: number,
  level: number,
  dirty = false,
  delay = 0,
) {
  const osc = v.ctx.createOscillator(),
    gain = v.ctx.createGain(),
    t = v.t + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(dirty ? v.dirty : v.out);
  osc.start(t);
  osc.stop(t + duration + 0.02);
  osc.onended = () => gain.disconnect();
}

function noise(
  v: Voice,
  type: BiquadFilterType,
  from: number,
  to: number,
  duration: number,
  level: number,
  q = 1,
  dirty = false,
  delay = 0,
) {
  const source = v.ctx.createBufferSource(),
    filter = v.ctx.createBiquadFilter(),
    gain = v.ctx.createGain(),
    t = v.t + delay;
  source.buffer = noiseBuffer;
  source.loop = true;
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  source
    .connect(filter)
    .connect(gain)
    .connect(dirty ? v.dirty : v.out);
  source.start(t, Math.random() * 2);
  source.stop(t + duration + 0.02);
  source.onended = () => {
    filter.disconnect();
    gain.disconnect();
  };
}

/** Inharmonic partials ringing out: struck armor plate. */
function clang(v: Voice, base: number, duration: number, level: number) {
  for (const [ratio, amp] of [
    [1, 1],
    [2.76, 0.6],
    [5.4, 0.35],
    [8.93, 0.2],
  ] as const)
    tone(v, 'sine', base * ratio, base * ratio * 0.97, duration / ratio ** 0.3, level * amp);
}

type Where = { pan: number; gain: number };

function fire(weapon: PlayerState['top'], where: Where, id: string) {
  const r = vary();
  if (weapon === 'cannon') {
    const v = voice(`fire:${id}`, 0.05, 0.6, 1, where, true);
    if (!v) return;
    tone(v, 'sine', 150 * r, 38, 0.45, 0.9);
    tone(v, 'square', 90 * r, 30, 0.18, 0.5, true);
    noise(v, 'lowpass', 2400, 180, 0.35, 0.8, 0.7, true);
    noise(v, 'bandpass', 5000, 2000, 0.05, 0.5, 1.5);
  } else if (weapon === 'scattergun') {
    const v = voice(`fire:${id}`, 0.05, 0.4, 0.9, where, true);
    if (!v) return;
    noise(v, 'highpass', 3000, 900, 0.09, 0.9, 0.7, true);
    noise(v, 'bandpass', 1400 * r, 300, 0.28, 0.7, 0.9);
    tone(v, 'sawtooth', 220 * r, 50, 0.14, 0.45, true);
    for (let i = 0; i < 3; i++)
      noise(v, 'bandpass', 3500 * vary(0.3), 2000, 0.03, 0.35, 4, false, 0.02 + i * 0.022);
  } else if (weapon === 'railgun') {
    const v = voice(`fire:${id}`, 0.05, 0.8, 0.85, where, true);
    if (!v) return;
    tone(v, 'sawtooth', 3200 * r, 90, 0.5, 0.35, true);
    tone(v, 'sine', 5200 * r, 700, 0.25, 0.3);
    tone(v, 'square', 60, 35, 0.6, 0.35, true);
    noise(v, 'highpass', 7000, 2500, 0.3, 0.45, 0.8);
    noise(v, 'bandpass', 900, 200, 0.7, 0.25, 0.6);
  }
}

interface Held {
  gain: GainNode;
  panner: StereoPannerNode;
  filter: BiquadFilterNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  osc?: OscillatorNode;
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

function holdVoice(kind: 'flamethrower' | 'saw' | 'drill'): Held {
  const ctx = context(),
    source = ctx.createBufferSource(),
    filter = ctx.createBiquadFilter(),
    gain = ctx.createGain(),
    panner = ctx.createStereoPanner(),
    noiseGain = ctx.createGain();
  source.buffer = noiseBuffer;
  source.loop = true;
  gain.gain.value = 0;
  filter.type = kind === 'flamethrower' ? 'lowpass' : 'bandpass';
  filter.frequency.value = { flamethrower: 900, saw: 4200, drill: 1300 }[kind];
  filter.Q.value = { flamethrower: 0.5, saw: 3, drill: 2 }[kind];
  noiseGain.gain.value = kind === 'flamethrower' ? 1 : 0.7;
  source.connect(filter).connect(noiseGain).connect(gain);
  gain.connect(panner).connect(master);
  source.start(ctx.currentTime, Math.random() * 2);
  const h: Held = {
    gain,
    panner,
    filter,
    nodes: [source, filter, noiseGain, gain, panner],
    sources: [source],
    pitch: kind === 'saw' ? 820 : 95,
    active: false,
    spinUntil: 0,
    lastActive: ctx.currentTime,
    seen: true,
  };
  if (kind !== 'flamethrower') {
    const osc = ctx.createOscillator(),
      shaper = ctx.createWaveShaper(),
      oscGain = ctx.createGain();
    osc.type = kind === 'saw' ? 'sawtooth' : 'square';
    osc.frequency.value = h.pitch * 0.35;
    shaper.curve = crunch;
    oscGain.gain.value = 0.5;
    osc.connect(shaper).connect(oscGain).connect(gain);
    osc.start();
    h.osc = osc;
    h.nodes.push(osc, shaper, oscGain);
    h.sources.push(osc);
  }
  return h;
}

function release(key: string, h: Held) {
  const t = audio!.currentTime;
  h.gain.gain.cancelScheduledValues(t);
  h.gain.gain.setTargetAtTime(0, t, 0.04);
  for (const source of h.sources) source.stop(t + 0.3);
  h.sources[0]!.onended = () => h.nodes.forEach((n) => n.disconnect());
  held.delete(key);
}

/** Stops every held weapon loop, e.g. on leaving a room or muting. */
export function stopCombatSounds() {
  for (const [key, h] of held) release(key, h);
  previous.clear();
  flights.clear();
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
  const t = audio!.currentTime;
  if (on) h.lastActive = t;
  else if (t - h.lastActive > 1) {
    // Idle for a while: free the loop; it is rebuilt on the next trigger.
    release(key, h);
    return;
  }
  const level = on ? where.gain * (kind === 'flamethrower' ? 0.65 : 0.3) : 0;
  // Fade to the new level, then to silence unless the next snapshot renews it: a stalled
  // connection can never leave a weapon roaring.
  h.gain.gain.cancelScheduledValues(t);
  h.gain.gain.setTargetAtTime(level, t, 0.03);
  h.gain.gain.setTargetAtTime(0, t + 0.3, 0.06);
  h.panner.pan.setTargetAtTime(where.pan, t, 0.03);
  if (kind === 'flamethrower') {
    // Flicker the roar so it breathes instead of droning.
    h.filter.frequency.setTargetAtTime(650 + Math.random() * 600, t, 0.05);
  } else if (h.osc) {
    const f = h.osc.frequency;
    if (on && !h.active) {
      // Spin-up: the motor climbs to speed over 0.4s.
      f.cancelScheduledValues(t);
      f.setValueAtTime(Math.max(f.value, h.pitch * 0.35), t);
      f.linearRampToValueAtTime(h.pitch, t + 0.4);
      h.spinUntil = t + 0.4;
    } else if (!on) f.setTargetAtTime(h.pitch * 0.35, t, 0.12);
    else if (t >= h.spinUntil) {
      // The whine bogs down while it bites into armor.
      const biting = (grinding.get(p.id) ?? 0) > t;
      f.setTargetAtTime(h.pitch * (biting ? 0.68 : 1) * vary(0.01), t, biting ? 0.04 : 0.1);
      h.filter.frequency.setTargetAtTime(
        (kind === 'saw' ? 4200 : 1300) * (biting ? 0.7 : 1),
        t,
        0.05,
      );
    }
  }
  h.active = on;
}

/** The swing of a one-shot front weapon, heard whether or not it connects. */
function swing(p: PlayerState, where: Where) {
  const v = voice(`swing:${p.id}`, 0.3, 0.5, 0.55, where);
  if (!v) return;
  const r = vary();
  if (p.front === 'ram') {
    noise(v, 'highpass', 4000, 1200, 0.18, 0.5, 0.7);
    tone(v, 'square', 70 * r, 40, 0.12, 0.5, true);
  } else if (p.front === 'flipper') {
    noise(v, 'highpass', 5000, 2000, 0.3, 0.55, 0.6);
    tone(v, 'triangle', 180 * r, 520, 0.2, 0.4, true);
  } else if (p.front === 'hook') {
    tone(v, 'sawtooth', 1600 * r, 260, 0.35, 0.25);
    noise(v, 'bandpass', 6000, 2500, 0.3, 0.3, 5);
  } else {
    // Sweeper and hammer: a heavy whoosh.
    noise(v, 'bandpass', 300, p.front === 'hammer' ? 900 : 2200, 0.3, 0.7, 1.4);
  }
}

/** How long each hit kind rings, so short grains free their voice quickly. */
const HIT_SECONDS: Record<string, number> = {
  hammer: 0.8,
  ram: 0.35,
  collision: 0.35,
  flipper: 0.45,
  sweeper: 0.4,
  hook: 0.4,
  saw: 0.15,
  drill: 0.15,
  wedge: 0.13,
  burn: 0.14,
  cannon: 0.6,
  scattergun: 0.2,
  railgun: 0.7,
};

function hit(e: GameEvent, s: RoomState, where: Where) {
  const attacker = s.players.find((p) => p.id === e.attackerId),
    victim = s.players.find((p) => p.id === e.playerId),
    r = vary();
  const kind =
    e.melee ??
    (e.reason === 'collision'
      ? 'collision'
      : attacker?.top === 'flamethrower' || (!attacker && victim?.burning)
        ? 'burn'
        : (attacker?.top ?? 'thud'));
  if ((kind === 'saw' || kind === 'drill') && e.attackerId)
    grinding.set(e.attackerId, context().currentTime + 0.15);
  const duration = HIT_SECONDS[kind] ?? 0.25;
  const v = voice(`hit:${e.playerId}:${kind}`, duration < 0.2 ? 0.12 : 0.03, duration, 1, where);
  if (!v) return;
  switch (kind) {
    case 'hammer':
      clang(v, 190 * r, 0.8, 0.35);
      tone(v, 'sine', 110 * r, 35, 0.4, 0.9, true);
      noise(v, 'lowpass', 3000, 200, 0.3, 0.8, 0.8, true);
      break;
    case 'ram':
    case 'collision':
      tone(v, 'sine', 95 * r, 40, 0.3, 0.8, true);
      noise(v, 'bandpass', 900 * r, 250, 0.25, 0.9, 0.9, true);
      clang(v, 320 * r, 0.3, 0.12);
      break;
    case 'flipper':
      tone(v, 'sine', 130 * r, 55, 0.25, 0.7, true);
      clang(v, 410 * r, 0.45, 0.2);
      noise(v, 'highpass', 3000, 900, 0.4, 0.35, 0.5);
      break;
    case 'sweeper':
    case 'hook':
      clang(v, 520 * r, 0.4, 0.22);
      noise(v, 'bandpass', 2200, 800, 0.12, 0.6, 1.2, true);
      break;
    case 'saw':
      noise(v, 'bandpass', 5500 * r, 3200, 0.14, 0.45, 5, true);
      tone(v, 'sawtooth', 1900 * r, 1500, 0.12, 0.15);
      break;
    case 'drill':
      noise(v, 'bandpass', 2600 * r, 1800, 0.14, 0.45, 3, true);
      tone(v, 'square', 160 * r, 120, 0.12, 0.2, true);
      break;
    case 'wedge':
      noise(v, 'bandpass', 1500 * r, 700, 0.12, 0.3, 4);
      break;
    case 'burn':
      noise(v, 'highpass', 4000 * r, 6000, 0.12, 0.3, 0.7);
      noise(v, 'bandpass', 1800, 900, 0.1, 0.2, 6, false, 0.03);
      break;
    case 'cannon':
      clang(v, 240 * r, 0.6, 0.3);
      tone(v, 'sine', 120 * r, 40, 0.35, 0.8, true);
      noise(v, 'lowpass', 4000, 300, 0.25, 0.7, 0.7, true);
      break;
    case 'scattergun':
      clang(v, 900 * r, 0.18, 0.18);
      noise(v, 'bandpass', 3500 * r, 1500, 0.06, 0.6, 2, true);
      break;
    case 'railgun':
      tone(v, 'sawtooth', 2600 * r, 300, 0.2, 0.3, true);
      clang(v, 350 * r, 0.7, 0.25);
      noise(v, 'highpass', 6000, 2000, 0.25, 0.5, 0.8);
      break;
    default:
      tone(v, 'sine', 140 * r, 50, 0.2, 0.6, true);
      noise(v, 'bandpass', 1200, 400, 0.15, 0.5, 1, true);
  }
}

function boom(where: Where, key: string, size: number) {
  const v = voice(key, 0.04, 1.6 * size, size, where, true, true);
  if (!v) return;
  // Muffle and duck the whole mix for a moment, scaled by how close the blast is.
  const punch = Math.min(1, where.gain * size);
  bus.frequency.cancelScheduledValues(v.t);
  bus.frequency.setTargetAtTime(20000 - 19200 * punch, v.t, 0.01);
  bus.frequency.setTargetAtTime(20000, v.t + 0.1, 0.35);
  master.gain.cancelScheduledValues(v.t);
  master.gain.setTargetAtTime(0.55 * (1 - 0.35 * punch), v.t, 0.01);
  master.gain.setTargetAtTime(0.55, v.t + 0.1, 0.3);
  const r = vary(0.1);
  tone(v, 'sine', 95 * r, 24, 1.1 * size, 1, true);
  tone(v, 'triangle', 55 * r, 28, 0.8 * size, 0.6);
  noise(v, 'lowpass', 5000, 120, 1.5 * size, 1, 0.6, true);
  noise(v, 'bandpass', 3000, 600, 0.4, 0.5, 0.8);
  for (let i = 0; i < 5; i++)
    noise(v, 'bandpass', 2500 * vary(0.5), 1200, 0.04, 0.3, 3, true, 0.1 + Math.random() * 0.5);
}

/** Last seen per-player weapon state, to catch railgun recharge and overheat edges. */
const previous = new Map<string, { topCooldown: number; overheated: boolean }>();
/** Projectiles in flight last snapshot, to hear the ones that stop short on something. */
const flights = new Map<number, Projectile>();

function recharge(where: Where, id: string) {
  const v = voice(`charge:${id}`, 1, 0.5, 0.35, where);
  if (!v) return;
  tone(v, 'sine', 300, 2400, 0.4, 0.35);
  tone(v, 'triangle', 150, 1200, 0.4, 0.25, true);
  noise(v, 'bandpass', 3000, 9000, 0.4, 0.15, 4);
}

function overheat(where: Where, id: string) {
  const v = voice(`overheat:${id}`, 1, 0.9, 0.6, where, true);
  if (!v) return;
  noise(v, 'highpass', 6000, 2500, 0.8, 0.5, 0.7);
  for (let i = 0; i < 4; i++)
    noise(v, 'lowpass', 1200 * vary(0.3), 300, 0.06, 0.6, 1, true, 0.08 + i * 0.11 * vary(0.3));
  tone(v, 'square', 120, 60, 0.25, 0.2, true);
}

function ricochet(q: Projectile, where: Where) {
  const v = voice(`ricochet:${q.id}`, 0, 0.35, 0.6, where);
  if (!v) return;
  const r = vary(0.15);
  clang(v, (q.weapon === 'scattergun' ? 1100 : 450) * r, 0.3, 0.15);
  tone(v, 'sine', 3800 * r, 1400, 0.18, 0.12);
  noise(v, 'bandpass', 2500 * r, 900, 0.08, 0.4, 1.5, true);
}

/**
 * Plays everything audible in a fresh snapshot: new events plus held weapons.
 * The listener is the watched robot; its absence yields centred, unattenuated sound.
 */
export function playCombatSounds(
  s: RoomState,
  events: GameEvent[],
  listener: PlayerState | undefined,
  enabled: boolean,
) {
  if (typeof AudioContext === 'undefined') return;
  if (!enabled) {
    if (audio) stopCombatSounds();
    return;
  }
  try {
    for (const e of events) {
      const where = spatial(listener, e.x, e.z);
      if (e.type === 'shot') {
        const p = s.players.find((p) => p.id === e.playerId);
        if (p) fire(p.top, where, p.id);
      } else if (e.type === 'hit') hit(e, s, where);
      else if (e.type === 'explosion') boom(where, `boom:${e.playerId}`, 1.2);
      else if (e.type === 'elimination') {
        boom(where, `ko:${e.playerId}`, 1);
        const v = voice(`ko-whine:${e.playerId}`, 1, 1.2, 0.5, where, true, true);
        if (v) tone(v, 'sawtooth', 700, 40, 1.1, 0.3, true);
      }
    }
    if (s.phase !== 'combat') {
      stopCombatSounds();
      return;
    }
    for (const h of held.values()) h.seen = false;
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
      previous.set(p.id, { topCooldown: p.topCooldown, overheated: p.overheated });
    }
    // Held loops of robots that died or left.
    for (const [key, h] of held) if (!h.seen) release(key, h);
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
