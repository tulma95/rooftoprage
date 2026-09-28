// Original synthwave-rock score, "Rooftop Rage", in D minor. Two pieces, switched on bar lines:
//   menu    — 112 BPM, 32 bars: intro (4), verse (12, rock beat, octave bass, palm-muted
//             guitar), chorus (16, the hook over big power chords), then loops to the verse.
//             Every bar walks i-VI-III-VII (Dm Bb F C).
//   combat  — 128 BPM: intro (8), build (8, snare roll), drop A (16, the fight hook), breakdown
//             (8), drop B (16, hook doubled, 16th bass), then loops to the build. Drops run
//             i-bVII-bVI-V (Dm C Bb A); the breakdown runs VI-III-VII-i.
//   tension — the combat piece at drop intensity over Dm Eb Dm A, with a semitone ostinato.
// Drums are synthesized once into sample buffers; bass, arp and ostinato are persistent mono
// voices; the "guitar" is saws through heavy drive and a cabinet-ish low-pass. There is no
// sustained noise anywhere in the score: only drum hits carry noise.
import { audioMix, mood, want, tanhCurve, type Mood } from './audio-engine.js';

const LOOKAHEAD = 0.25;
const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);

interface Chord {
  root: number;
  pad: number[];
}
const chord = (root: number, ...pad: number[]): Chord => ({ root, pad });
const Dm = chord(38, 50, 53, 57, 62),
  C = chord(36, 52, 55, 60, 64),
  Bb = chord(34, 50, 53, 58, 62),
  A = chord(33, 49, 52, 57, 61),
  F = chord(41, 53, 57, 60, 65),
  Eb = chord(39, 51, 55, 58, 63);

const MENU_CHORDS = [Dm, Bb, F, C];

type Section = 'intro' | 'build' | 'dropA' | 'breakdown' | 'dropB';
const PIECES = {
  // `level`: the fight score sits lower, leaving explosions headroom over it.
  menu: { bpm: 112, bars: 32, loop: 4, level: 1 },
  combat: { bpm: 128, bars: 56, loop: 8, level: 0.68 },
};
/** Combat form: section of a bar and the bar within it. */
export function combatSection(bar: number): [Section, number] {
  if (bar < 8) return ['intro', bar];
  if (bar < 16) return ['build', bar - 8];
  if (bar < 32) return ['dropA', bar - 16];
  if (bar < 40) return ['breakdown', bar - 32];
  return ['dropB', bar - 40];
}

/** Hooks over a 4-bar cycle: [step within 4 bars, note, length in steps]. */
// Menu chorus: a call on Dm/F, answers on Bb and C.
const HOOK_MENU: [number, number, number][] = [
  [0, 81, 3],
  [3, 81, 3],
  [6, 79, 2],
  [8, 77, 4],
  [12, 76, 2],
  [14, 77, 2],
  [16, 74, 6],
  [22, 77, 2],
  [24, 74, 4],
  [28, 72, 4],
  [32, 81, 3],
  [35, 81, 3],
  [38, 79, 2],
  [40, 77, 4],
  [44, 79, 2],
  [46, 81, 2],
  [48, 84, 6],
  [54, 82, 2],
  [56, 81, 4],
  [60, 79, 4],
];
// Fight: one rising figure sequenced up over Dm C Bb, falling home over A.
const HOOK_FIGHT: [number, number, number][] = [
  [0, 74, 2],
  [2, 77, 2],
  [4, 81, 4],
  [8, 79, 2],
  [10, 77, 2],
  [12, 76, 4],
  [16, 76, 2],
  [18, 79, 2],
  [20, 84, 4],
  [24, 82, 2],
  [26, 81, 2],
  [28, 79, 4],
  [32, 77, 2],
  [34, 81, 2],
  [36, 86, 4],
  [40, 84, 2],
  [42, 82, 2],
  [44, 81, 4],
  [48, 81, 6],
  [54, 79, 2],
  [56, 76, 4],
  [60, 73, 4],
];

const LAYERS = ['drums', 'perc', 'bass', 'guitar', 'arp', 'pad', 'lead', 'tension'] as const;
type LayerName = (typeof LAYERS)[number];
const MIXES: Record<Mood, Record<LayerName, number>> = {
  menu: {
    drums: 0.6,
    perc: 0.45,
    bass: 0.35,
    guitar: 0.5,
    arp: 0.45,
    pad: 0.7,
    lead: 0.8,
    tension: 0,
  },
  combat: {
    drums: 0.5,
    perc: 0.4,
    bass: 0.32,
    guitar: 0.45,
    arp: 0.4,
    pad: 0.4,
    lead: 0.6,
    tension: 0,
  },
  tension: {
    drums: 0.5,
    perc: 0.4,
    bass: 0.32,
    guitar: 0.5,
    arp: 0.45,
    pad: 0.35,
    lead: 0.4,
    tension: 0.5,
  },
};
/** Non-bass layers are high-passed so only the kick and bass own the low end. */
const HIGHPASS: Partial<Record<LayerName, number>> = {
  perc: 400,
  guitar: 90,
  arp: 220,
  pad: 180,
  lead: 250,
  tension: 200,
};
const LEVEL = 0.8;

type Kit = Record<
  'kick' | 'snare' | 'clap' | 'hat' | 'open' | 'crash' | 'tom' | 'impact',
  AudioBuffer
>;

/** Synthesizes the drum kit sample by sample, once per context. */
function drumKit(ctx: BaseAudioContext): Kit {
  const rate = ctx.sampleRate;
  const make = (seconds: number, fn: (t: number, noise: number) => number) => {
    const buffer = ctx.createBuffer(1, Math.floor(seconds * rate), rate),
      data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      data[i] = fn(i / rate, Math.random() * 2 - 1);
      peak = Math.max(peak, Math.abs(data[i]!));
    }
    for (let i = 0; i < data.length; i++) data[i]! /= peak || 1;
    // 2ms fade-out so no buffer ends on a step.
    const tail = Math.floor(rate * 0.002);
    for (let i = 0; i < tail; i++) data[data.length - 1 - i]! *= i / tail;
    return buffer;
  };
  /** One-pole low-pass state factory. */
  const onePole = (hz: number) => {
    const a = 1 - Math.exp((-2 * Math.PI * hz) / rate);
    let y = 0;
    return (x: number) => (y += a * (x - y));
  };
  const metal = (t: number, scale: number) =>
    [205.3, 304.4, 369.6, 522.7, 540, 800].reduce(
      (sum, f) => sum + Math.sign(Math.sin(2 * Math.PI * f * scale * t)),
      0,
    ) / 6;
  let phase = 0;
  const clickHp = onePole(2500);
  // Punchy kick: a 52Hz body, a pitch sweep and a beater click.
  const kick = make(0.42, (t, n) => {
    phase += (2 * Math.PI * (52 + 110 * Math.exp(-t * 30) + 380 * Math.exp(-t * 320))) / rate;
    const amp = t < 0.03 ? 1 : Math.exp(-(t - 0.03) * 11);
    const click = n - clickHp(n);
    return Math.tanh((Math.sin(phase) * amp + click * Math.exp(-t * 450) * 0.6) * 2.2);
  });
  // Fat 80s snare: a strong tonal body, wires darkened to 6kHz.
  const snareLp = onePole(6000),
    snareHp = onePole(1200);
  const snare = make(0.5, (t, n) => {
    const body =
      Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 20) * 0.8 +
      Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t * 28) * 0.4;
    const lp = snareLp(n);
    const wires = (lp - snareHp(lp)) * Math.exp(-t * 13) * 1.1;
    return Math.tanh((body + wires) * 1.8);
  });
  const clapLp = onePole(3200),
    clapHp = onePole(900);
  const clap = make(0.4, (t, n) => {
    const bursts = [0, 0.011, 0.023, 0.034].reduce(
      (sum, at) => sum + (t >= at ? Math.exp(-(t - at) * (at === 0.034 ? 14 : 180)) : 0),
      0,
    );
    const lp = clapLp(n);
    return (lp - clapHp(lp)) * bursts;
  });
  // Hats are mostly metal, little noise, so the tops tick instead of hiss.
  const hatHp = [onePole(6000), onePole(6000)];
  const hatOf = (decay: number) => (t: number, n: number) => {
    const x = metal(t, 1.7) * 0.8 + n * 0.2;
    const once = x - hatHp[0]!(x);
    return (once - hatHp[1]!(once)) * Math.exp(-t * decay);
  };
  const hat = make(0.06, hatOf(70));
  hatHp.forEach((f) => f(0));
  const open = make(0.35, hatOf(10));
  const crashHp = onePole(3000);
  const crash = make(2.2, (t, n) => {
    const x = n * 0.5 + metal(t, 2.3) * 0.5;
    return (x - crashHp(x)) * Math.exp(-t * 1.8) * Math.min(1, t / 0.004);
  });
  const tom = make(0.6, (t, n) =>
    Math.tanh(
      (Math.sin(2 * Math.PI * (95 + 50 * Math.exp(-t * 18)) * t) * Math.exp(-t * 7) +
        n * Math.exp(-t * 90) * 0.3) *
        1.8,
    ),
  );
  let impactPhase = 0;
  const impact = make(1.6, (t) => {
    impactPhase += (2 * Math.PI * (40 + 60 * Math.exp(-t * 6))) / rate;
    return Math.tanh(Math.sin(impactPhase) * Math.exp(-t * 2.4) * 1.6);
  });
  return { kick, snare, clap, hat, open, crash, tom, impact };
}

/** A persistent monophonic synth: oscillators into drive, a resonant low-pass and a VCA. */
class Mono {
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode;
  private vca: GainNode;
  constructor(
    ctx: AudioContext,
    out: AudioNode,
    voices: [OscillatorType, number, number][],
    q: number,
    drive?: Float32Array<ArrayBuffer>,
  ) {
    const sum = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.Q.value = q;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    for (const [type, octave, level] of voices) {
      const osc = ctx.createOscillator(),
        g = ctx.createGain();
      osc.type = type;
      osc.detune.value = octave;
      g.gain.value = level;
      osc.connect(g).connect(sum);
      osc.start();
      this.oscs.push(osc);
    }
    if (drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = drive;
      shaper.oversample = '2x';
      sum.connect(shaper).connect(this.filter);
    } else sum.connect(this.filter);
    this.filter.connect(this.vca).connect(out);
  }
  note(
    time: number,
    note: number,
    length: number,
    peak: number,
    base: number,
    level: number,
    decay = 0.08,
  ) {
    for (const osc of this.oscs) osc.frequency.setValueAtTime(frequency(note), time);
    this.filter.frequency.setValueAtTime(peak, time);
    this.filter.frequency.setTargetAtTime(base, time + 0.004, decay);
    this.vca.gain.setTargetAtTime(level, time, 0.002);
    this.vca.gain.setTargetAtTime(0, time + length, 0.02);
  }
}

export class SynthwaveMusic {
  private context?: AudioContext;
  private mix?: GainNode;
  private echo?: DelayNode[];
  private echoIn?: GainNode;
  private send?: GainNode;
  private pump?: GainNode;
  private drums?: GainNode;
  private drumFilter?: BiquadFilterNode;
  private padFilter?: BiquadFilterNode;
  private guitar?: GainNode;
  private layers = {} as Record<LayerName, GainNode>;
  private kit?: Kit;
  private bass?: Mono;
  private arp?: Mono;
  private ostinato?: Mono;
  private timer?: ReturnType<typeof setInterval>;
  private enabled = true;
  private unlocked = false;
  private next = 0;
  /** Step within the bar (16ths) and bar within the current piece. */
  private beat = 0;
  private bar = 0;
  private piece: 'menu' | 'combat' = 'menu';
  private playing: Mood = 'menu';

  constructor() {
    document.addEventListener('pointerdown', () => this.unlock());
    document.addEventListener('keydown', () => this.unlock());
    document.addEventListener('visibilitychange', () => this.sync());
    window.addEventListener('pagehide', () => this.pause());
    window.addEventListener('pageshow', () => this.sync());
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.sync();
  }

  private unlock() {
    this.unlocked = true;
    this.sync();
  }

  private get step() {
    return 60 / PIECES[this.piece].bpm / 4;
  }

  private sync() {
    if (!this.enabled || !this.unlocked || document.hidden) {
      this.pause();
      return;
    }
    try {
      if (!this.context) this.create();
      const context = this.context!;
      want('music', true);
      void context
        .resume()
        .then(() => {
          if (!this.enabled || document.hidden) {
            this.pause();
            return;
          }
          if (context.state !== 'running' || this.timer !== undefined) return;
          this.next = Math.max(this.next, context.currentTime + 0.05);
          this.mix!.gain.setTargetAtTime(
            LEVEL * PIECES[this.piece].level,
            context.currentTime,
            0.3,
          );
          this.schedule();
          this.timer = setInterval(() => this.schedule(), 40);
        })
        .catch(() => {
          /* Retry on the next gesture if autoplay is blocked. */
        });
    } catch {
      /* Audio is optional on unsupported devices. */
    }
  }

  private pause() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    // The context may keep running for SFX, so silence the score itself.
    if (this.context) this.mix!.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
    want('music', false);
  }

  private create() {
    const { ctx, music, reverb } = audioMix();
    this.context = ctx;
    this.kit = drumKit(ctx);
    this.mix = ctx.createGain();
    this.mix.gain.value = 0;
    this.mix.connect(music);
    this.send = ctx.createGain();
    this.send.gain.value = 0.45;
    const sendHp = ctx.createBiquadFilter();
    sendHp.type = 'highpass';
    sendHp.frequency.value = 250;
    this.send.connect(sendHp).connect(reverb);
    // Ping-pong echo: left and right taps feed each other through a darkening loop.
    this.echoIn = ctx.createGain();
    const merger = ctx.createChannelMerger(2),
      wet = ctx.createGain(),
      tone = ctx.createBiquadFilter(),
      hp = ctx.createBiquadFilter();
    this.echoIn.channelCount = 1;
    this.echoIn.channelCountMode = 'explicit';
    tone.frequency.value = 3800;
    hp.type = 'highpass';
    hp.frequency.value = 300;
    wet.gain.value = 0.3;
    const left = ctx.createDelay(1),
      right = ctx.createDelay(1),
      fbL = ctx.createGain(),
      fbR = ctx.createGain();
    fbL.gain.value = fbR.gain.value = 0.38;
    this.echoIn.connect(hp).connect(tone).connect(left);
    left.connect(merger, 0, 0);
    left.connect(fbL).connect(right);
    right.connect(merger, 0, 1);
    right.connect(fbR).connect(left);
    merger.connect(wet).connect(this.mix);
    this.echo = [left, right];
    for (const d of this.echo) d.delayTime.value = this.step * 3;
    for (const name of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = MIXES.menu[name];
      const cut = HIGHPASS[name];
      if (cut) {
        const f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = cut;
        f.Q.value = 0.6;
        g.connect(f).connect(this.mix);
      } else g.connect(this.mix);
      this.layers[name] = g;
    }
    // Sidechain pump: bass, pad and arp breathe around every kick.
    this.pump = ctx.createGain();
    // Drums go through a sweepable low-pass (intros and builds), gentle drive, then the fader.
    this.drums = ctx.createGain();
    this.drumFilter = ctx.createBiquadFilter();
    this.drumFilter.frequency.value = 20000;
    this.drumFilter.Q.value = 0.9;
    const drumDrive = ctx.createWaveShaper();
    drumDrive.curve = tanhCurve(1.4);
    this.drums.connect(this.drumFilter).connect(drumDrive).connect(this.layers.drums);
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.frequency.value = 2400;
    this.padFilter.Q.value = 0.8;
    const padPump = ctx.createGain();
    this.padFilter.connect(padPump).connect(this.layers.pad);
    this.pump.connect(padPump.gain);
    padPump.gain.value = 0;
    this.pump.gain.value = 1;
    // A constant 1 source drives the shared pump envelope into every pumped layer.
    const one = ctx.createConstantSource();
    one.connect(this.pump);
    one.start();
    const pumped = (name: LayerName) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      this.pump!.connect(g.gain);
      g.connect(this.layers[name]);
      return g;
    };
    // Guitar: saws into heavy drive, then a mid bump and a cabinet low-pass that eats the fizz.
    this.guitar = ctx.createGain();
    const fuzz = ctx.createWaveShaper(),
      mid = ctx.createBiquadFilter(),
      cab = ctx.createBiquadFilter(),
      cab2 = ctx.createBiquadFilter(),
      guitarOut = ctx.createGain();
    fuzz.curve = tanhCurve(7);
    fuzz.oversample = '4x';
    mid.type = 'peaking';
    mid.frequency.value = 900;
    mid.Q.value = 0.8;
    mid.gain.value = 4;
    cab.frequency.value = cab2.frequency.value = 3200;
    cab.Q.value = cab2.Q.value = 0.7;
    guitarOut.gain.value = 0.14;
    this.guitar.connect(fuzz).connect(mid).connect(cab).connect(cab2).connect(guitarOut);
    guitarOut.connect(this.layers.guitar);
    guitarOut.connect(this.send);
    this.bass = new Mono(
      ctx,
      pumped('bass'),
      [
        ['sawtooth', 0, 0.5],
        ['sawtooth', 9, 0.5],
        ['sine', -1200, 0.25],
      ],
      3,
      tanhCurve(2.5),
    );
    const arpOut = pumped('arp');
    arpOut.connect(this.echoIn);
    this.arp = new Mono(
      ctx,
      arpOut,
      [
        ['square', 0, 0.4],
        ['sawtooth', 7, 0.4],
      ],
      4,
    );
    const ost = ctx.createGain();
    ost.connect(this.layers.tension);
    ost.connect(this.send);
    this.ostinato = new Mono(
      ctx,
      ost,
      [
        ['sawtooth', -5, 0.5],
        ['sawtooth', 5, 0.5],
      ],
      3,
      tanhCurve(2),
    );
  }

  private hit(
    buffer: AudioBuffer,
    time: number,
    level: number,
    pan = 0,
    rate = 1,
    send = 0,
    out: AudioNode = this.drums!,
  ) {
    const ctx = this.context!,
      source = ctx.createBufferSource(),
      gain = ctx.createGain(),
      panner = ctx.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.02);
    gain.gain.value = level * (0.9 + Math.random() * 0.1);
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(out);
    if (send) {
      const s = ctx.createGain();
      s.gain.value = send;
      panner.connect(s).connect(this.send!);
      source.onended = () => [source, gain, panner, s].forEach((n) => n.disconnect());
    } else source.onended = () => [source, gain, panner].forEach((n) => n.disconnect());
    source.start(time);
  }

  /** One-off voice: two detuned oscillators, spread to `width`, through a filter envelope. */
  private synth(
    note: number,
    time: number,
    duration: number,
    volume: number,
    out: AudioNode,
    {
      type = 'sawtooth' as OscillatorType,
      cutoff = 1800,
      attack = 0.01,
      detune = 8,
      echo = false,
      reverb = true,
      pan = 0,
      width = 0,
      release = 0.08,
    } = {},
  ) {
    const ctx = this.context!,
      filter = ctx.createBiquadFilter(),
      gain = ctx.createGain(),
      nodes: AudioNode[] = [filter, gain];
    const oscs = [-1, 1].map((side) => {
      const osc = ctx.createOscillator(),
        p = ctx.createStereoPanner();
      osc.type = type;
      osc.frequency.value = frequency(note);
      osc.detune.value = side * detune;
      p.pan.value = Math.max(-1, Math.min(1, pan + side * width));
      osc.connect(p).connect(filter);
      osc.start(time);
      osc.stop(time + duration + release * 5);
      nodes.push(osc, p);
      return osc;
    });
    filter.frequency.setValueAtTime(cutoff, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.4), time + duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + attack);
    gain.gain.setTargetAtTime(0, time + Math.max(attack, duration - release * 2), release);
    filter.connect(gain).connect(out);
    if (echo) gain.connect(this.echoIn!);
    if (reverb) gain.connect(this.send!);
    oscs[0]!.onended = () => nodes.forEach((n) => n.disconnect());
  }

  /** Power chord (root, fifth, octave) on the driven guitar; `mute` is a short palm-muted chug. */
  private power(root: number, time: number, duration: number, mute: boolean) {
    for (const [i, n] of [12, 19, 24].entries())
      this.synth(root + n, time, duration, mute ? 0.5 : 0.4, this.guitar!, {
        cutoff: mute ? 650 : 3000,
        detune: 6,
        attack: 0.004,
        reverb: false,
        pan: [-0.35, 0.35, 0][i],
        release: mute ? 0.025 : 0.12,
      });
  }

  /** The hook voice: a bright saw lead with echo, doubled an octave down when `fat`. */
  private lead(motif: [number, number, number][], in4: number, time: number, fat: boolean) {
    for (const [s, note, len] of motif)
      if (s === in4)
        for (const oct of fat ? [0, -12] : [0])
          this.synth(note + oct, time, this.step * len, oct ? 0.035 : 0.065, this.layers.lead, {
            cutoff: 4200,
            attack: 0.012,
            detune: 10,
            echo: !oct,
            width: 0.25,
            pan: 0.05,
          });
  }

  private crossfade(to: Mood, time: number) {
    for (const name of LAYERS) this.layers[name].gain.setTargetAtTime(MIXES[to][name], time, 0.4);
  }

  private schedule() {
    const context = this.context!;
    // Skip a stalled wall-clock interval without bursting a backlog of notes.
    if (this.next < context.currentTime) this.next = context.currentTime + 0.02;
    while (this.next < context.currentTime + LOOKAHEAD) {
      this.play(this.next);
      const step = this.step;
      if (++this.beat === 16) {
        this.beat = 0;
        const piece = PIECES[this.piece];
        if (++this.bar >= piece.bars) this.bar = piece.loop;
      }
      this.next += step;
    }
  }

  private play(time: number) {
    if (this.beat === 0 && mood !== this.playing) {
      const from = this.playing;
      this.playing = mood;
      this.crossfade(mood, time);
      const piece = mood === 'menu' ? 'menu' : 'combat';
      // Entering the fight (or going back to the menu) restarts that piece from its top.
      if (piece !== this.piece || from === 'menu') {
        this.piece = piece;
        this.mix!.gain.setTargetAtTime(LEVEL * PIECES[piece].level, time, 0.5);
        this.bar = 0;
        const s = this.step;
        for (const d of this.echo!) d.delayTime.setValueAtTime(s * 3, time);
      }
    }
    if (this.piece === 'menu') this.menu(time);
    else this.combat(time);
  }

  /** Crash on the left and right, a hair apart, plus the sub impact. */
  private downbeat(time: number, level: number) {
    const k = this.kit!;
    this.hit(k.crash, time, level, -0.35, 1, 0.3, this.layers.perc);
    this.hit(k.crash, time + 0.012, level * 0.8, 0.4, 0.94, 0.3, this.layers.perc);
    this.hit(k.impact, time, 0.35, 0, 1);
  }

  /** Pad chord, wide, `steps` long. */
  private pad(ch: Chord, time: number, steps: number, volume: number, attack: number) {
    for (const [i, note] of ch.pad.entries())
      this.synth(note, time, this.step * steps + 0.2, volume, this.padFilter!, {
        attack,
        cutoff: 20000,
        detune: 12,
        width: 0.8,
        pan: (i / 3) * 0.6 - 0.3,
        release: 0.2,
      });
  }

  /** Menu: intro, verse, chorus over Dm Bb F C, one chord a bar. */
  private menu(time: number) {
    const { bar, beat } = this,
      k = this.kit!,
      ch = MENU_CHORDS[bar % 4]!,
      section = bar < 4 ? 'intro' : bar < 16 ? 'verse' : 'chorus',
      chorus = section === 'chorus',
      in4 = (bar % 4) * 16 + beat,
      step = this.step;

    // Drums muffled through the intro, opening into the verse.
    if (beat === 0)
      this.drumFilter!.frequency.setTargetAtTime(
        section === 'intro' ? 600 + bar * 500 : 20000,
        time,
        0.3,
      );
    if (beat === 0 && (bar === 4 || bar === 16 || bar === 24))
      this.downbeat(time, chorus ? 0.35 : 0.25);

    // Rock beat: kick on 1, 3 and the "and" of 3, snare on 2 and 4; four on the floor in the
    // chorus. Last bar of each 4 pushes with a kick on the "and" of 4.
    const kickOn = chorus
      ? beat % 4 === 0 || (bar % 4 === 3 && beat === 14)
      : beat === 0 || beat === 8 || beat === 10 || (bar % 4 === 3 && beat === 14);
    if (kickOn && (section !== 'intro' || beat === 0 || beat === 8)) {
      this.hit(k.kick, time, 0.6);
      this.duckPump(time);
    }
    if (section !== 'intro' && (beat === 4 || beat === 12)) {
      this.hit(k.snare, time, 0.55, 0, 1, 0.5);
      if (chorus) this.hit(k.clap, time + 0.006, 0.25, 0.2, 1, 0.3);
    }
    if (section !== 'intro' && beat % 2 === 0)
      this.hit(
        beat === 14 && chorus ? k.open : k.hat,
        time,
        beat % 4 === 0 ? 0.18 : 0.26,
        0.3,
        1,
        0,
        this.layers.perc,
      );
    // Tom run into the chorus and back round.
    if ((bar === 15 || bar === 31) && beat >= 8 && beat % 2 === 0)
      this.hit(k.tom, time, 0.5, 0.7 - (beat - 8) * 0.2, 1.4 - (beat - 8) * 0.06, 0.2);

    // Pads on every chord.
    if (beat === 0) this.pad(ch, time, 16, chorus ? 0.03 : 0.04, section === 'intro' ? 0.6 : 0.2);

    // Driving octave bass in 8ths.
    if (section !== 'intro' && beat % 2 === 0)
      this.bass!.note(time, ch.root + (beat % 4 === 2 ? 12 : 0), step * 1.6, 1800, 300, 0.2);
    else if (section === 'intro' && beat === 0)
      this.bass!.note(time, ch.root, step * 15, 600, 250, 0.16, 0.3);

    // Guitar: palm-muted 8th chugs in the verse; big held chords with a push in the chorus.
    if (section === 'verse' && beat % 2 === 0 && bar >= 8)
      this.power(ch.root, time, step * 1.2, true);
    if (chorus && (beat === 0 || beat === 10))
      this.power(ch.root, time, step * (beat ? 6 : 10), false);

    // Arp: quarter notes in the intro, 16ths over chord tones after.
    if (section === 'intro' ? beat % 4 === 0 : true) {
      const tones = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];
      this.arp!.note(
        time,
        ch.pad[tones[beat]!]! + (chorus ? 24 : 12),
        step * 0.6,
        section === 'intro' ? 2500 : 4200,
        1100,
        section === 'intro' ? 0.06 : chorus ? 0.05 : 0.07,
        0.05,
      );
    }

    // The hook: chorus only, doubled down an octave in its second half.
    if (chorus) this.lead(HOOK_MENU, in4, time, bar >= 24);
  }

  /** The fight: intro, build, drop A, breakdown, drop B; tension forces drop intensity. */
  private combat(time: number) {
    const { bar, beat } = this,
      k = this.kit!,
      tense = this.playing === 'tension',
      [raw, at] = combatSection(bar),
      section: Section = tense && (raw === 'intro' || raw === 'breakdown') ? 'dropA' : raw,
      drop = section === 'dropA' || section === 'dropB',
      step = this.step;
    const ch = tense
      ? [Dm, Eb, Dm, A][bar % 4]!
      : section === 'breakdown'
        ? [Bb, F, C, Dm][Math.floor(at / 2) % 4]!
        : drop
          ? [Dm, C, Bb, A][bar % 4]!
          : [Dm, Dm, Bb, Bb, C, C, A, A][at % 8]!;
    const in4 = (bar % 4) * 16 + beat;

    // Drum filter: muffled intro opening up, a sweep through the build and breakdown's end.
    if (beat === 0) {
      const target =
        section === 'intro'
          ? 700 + at * 250
          : section === 'build'
            ? 2500 * 2 ** (at / 2)
            : section === 'breakdown'
              ? at < 4
                ? 20000
                : 900 * 2 ** (at - 4)
              : 20000;
      this.drumFilter!.frequency.setTargetAtTime(Math.min(20000, target), time, 0.4);
    }
    if (beat === 0 && (drop ? at % 8 === 0 : at === 0)) this.downbeat(time, drop ? 0.4 : 0.25);

    // Kick: rock beat in the intro and build, four on the floor in the drops.
    const kickOn =
      section === 'intro' || section === 'build'
        ? (beat === 0 || beat === 8 || beat === 10) &&
          !(section === 'build' && at === 7 && beat >= 8)
        : section === 'breakdown'
          ? at >= 4 && beat % 4 === 0 && !(at === 7 && beat >= 8)
          : beat % 4 === 0 || (beat === 14 && bar % 2 === 1);
    if (kickOn) {
      this.hit(k.kick, time, 0.6);
      this.duckPump(time);
    }
    // Snare on 2 and 4; the build and breakdown end in accelerating rolls.
    const roll = (section === 'build' && at >= 4) || (section === 'breakdown' && at >= 6);
    if (roll) {
      const n = at - 4;
      const every = n <= 1 ? 4 : n === 2 ? 2 : 1;
      if (beat % every === 0) {
        const rise = (at % 4) * 16 + beat;
        this.hit(k.snare, time, 0.2 + rise * 0.006, spread(beat), 1 + rise * 0.004, 0.2);
      }
    } else if (section !== 'breakdown' && (beat === 4 || beat === 12)) {
      this.hit(k.snare, time, section === 'intro' ? 0.4 : 0.6, 0, 1, 0.5);
      if (drop) this.hit(k.clap, time + 0.006, 0.3, 0.2, 1, 0.3);
    }
    // Fills: a tom run closing every 8 bars of a drop.
    if (drop && at % 8 === 7 && beat >= 8 && beat % 2 === 0)
      this.hit(k.tom, time, 0.5, 0.7 - (beat - 8) * 0.2, 1.4 - (beat - 8) * 0.06, 0.2);
    // Hats in 8ths, an open hat on the offbeat in the drops.
    if ((section !== 'breakdown' || at >= 4) && beat % 2 === 0)
      this.hit(
        drop && beat % 4 === 2 ? k.open : k.hat,
        time,
        beat % 4 === 2 ? 0.2 : 0.14,
        0.3,
        1,
        0,
        this.layers.perc,
      );

    // Pad on every chord change.
    const chordLen = drop || tense ? 16 : 32;
    if (beat === 0 && (chordLen === 16 || at % 2 === 0))
      this.pad(
        ch,
        time,
        chordLen,
        section === 'breakdown' ? 0.05 : 0.03,
        section === 'breakdown' ? 0.8 : 0.15,
      );

    // Bass: whole notes in the intro, octave 8ths in the build and drop A, 16ths in drop B.
    if (section === 'intro' && beat === 0 && at % 2 === 0)
      this.bass!.note(time, ch.root, step * 30, 500 + at * 60, 200, 0.18, 0.3);
    else if (
      (section === 'build' || section === 'dropA' || tense) &&
      beat % 2 === 0 &&
      !(section === 'build' && at === 7 && beat >= 8)
    )
      this.bass!.note(
        time,
        ch.root + (beat % 4 === 2 ? 12 : 0),
        step * 1.6,
        drop ? 2200 : 800 + at * 200,
        280,
        0.2,
      );
    else if (section === 'breakdown' && at >= 4 && beat % 4 === 2)
      this.bass!.note(time, ch.root, step * 1.6, 700 + (at - 4) * 300, 200, 0.16);
    else if (section === 'dropB' && !tense)
      this.bass!.note(time, ch.root + (beat % 4 === 2 ? 12 : 0), step * 0.8, 2400, 280, 0.2);

    // Guitar: chugs through the build, held chords with a push through the drops.
    if (section === 'build' && beat % 2 === 0 && !(at === 7 && beat >= 8))
      this.power(ch.root, time, step * 1.2, true);
    if (drop && (beat === 0 || beat === 10))
      this.power(ch.root, time, step * (beat ? 6 : 10), false);
    if (drop && beat % 2 === 1 && beat !== 9 && bar % 2 === 1 && !tense)
      this.power(ch.root, time, step * 0.6, true);

    // Arp: 16ths over chord tones two octaves up.
    if (section !== 'intro' && section !== 'breakdown') {
      const tones = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];
      this.arp!.note(
        time,
        ch.pad[tones[beat]!]! + (drop ? 24 : 12),
        step * 0.6,
        section === 'build' ? 1500 + at * 400 : 4200,
        1100,
        section === 'build' ? 0.07 : 0.045,
        0.05,
      );
    }
    // Breakdown: a slow echoing pluck over the new progression.
    if (section === 'breakdown' && beat % 4 === 0)
      this.synth(ch.pad[(at * 4 + beat / 4) % 4]! + 12, time, step * 3, 0.05, this.layers.arp, {
        type: 'square',
        cutoff: 3200,
        detune: 6,
        width: 0.5,
        pan: beat % 8 ? 0.5 : -0.5,
        echo: true,
        release: 0.1,
      });

    // The fight hook over the drops; doubled in drop B.
    if (drop && !tense && !(section === 'dropA' && at < 4))
      this.lead(HOOK_FIGHT, in4, time, section === 'dropB');
    if (tense)
      this.ostinato!.note(
        time,
        ch.root + 24 + (beat % 2 ? 1 : 0),
        step * 0.7,
        3000,
        900,
        0.09,
        0.04,
      );
  }

  private duckPump(time: number) {
    const g = this.pump!.gain;
    g.setTargetAtTime(0.35, time, 0.004);
    g.setTargetAtTime(1, time + 0.03, 0.07);
  }
}

/** Alternating pan for rolls: -0.3, 0.3, ... */
const spread = (i: number) => (i % 2 ? 0.3 : -0.3);
