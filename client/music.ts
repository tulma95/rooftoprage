// Original 112 BPM synthwave score: Am / F / C / G, with a 32-bar arrangement.
// Schedule against the audio clock so rendering frame rate never controls rhythm.
const STEP = 60 / 112 / 4;
const CHORDS = [[45, 48, 52, 55], [41, 45, 48, 52], [48, 52, 55, 59], [43, 47, 50, 53]];
const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);

export class SynthwaveMusic {
  private context?: AudioContext;
  private mix?: GainNode;
  private echo?: DelayNode;
  private noise?: AudioBuffer;
  private timer?: ReturnType<typeof setInterval>;
  private enabled = true;
  private unlocked = false;
  private next = 0;
  private step = 0;

  constructor() {
    document.addEventListener('pointerdown', () => this.unlock());
    document.addEventListener('keydown', () => this.unlock());
    document.addEventListener('visibilitychange', () => this.sync());
    window.addEventListener('pagehide', () => this.pause());
    window.addEventListener('pageshow', () => this.sync());
  }

  setEnabled(enabled: boolean) { this.enabled = enabled; this.sync(); }

  private unlock() { this.unlocked = true; this.sync(); }

  private sync() {
    if (!this.enabled || !this.unlocked || document.hidden) { this.pause(); return; }
    try {
      if (!this.context) this.create();
      const context = this.context!;
      void context.resume().then(() => {
        if (!this.enabled || document.hidden) { this.pause(); return; }
        if (context.state !== 'running' || this.timer !== undefined) return;
        this.next = Math.max(this.next, context.currentTime + 0.04);
        this.mix!.gain.setTargetAtTime(0.48, context.currentTime, 0.08);
        this.schedule();
        this.timer = setInterval(() => this.schedule(), 50);
      }).catch(() => { /* Retry on the next gesture if autoplay is blocked. */ });
    } catch { /* Audio is optional on unsupported devices. */ }
  }

  private pause() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.context) void this.context.suspend().catch(() => {});
  }

  private create() {
    const context = new AudioContext();
    this.context = context;
    this.mix = context.createGain();
    this.mix.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    this.mix.connect(compressor).connect(context.destination);
    this.echo = context.createDelay(1);
    this.echo.delayTime.value = STEP * 3;
    const feedback = context.createGain(), wet = context.createGain();
    feedback.gain.value = 0.32;
    wet.gain.value = 0.24;
    this.echo.connect(feedback).connect(this.echo);
    this.echo.connect(wet).connect(this.mix);
    this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 1984;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = seed / 2147483648;
    }
  }

  private synth(note: number, time: number, duration: number, volume: number,
    type: OscillatorType = 'sawtooth', cutoff = 1800, pan = 0, delayed = false, attack = 0.008, detune = 0) {
    const context = this.context!, osc = context.createOscillator(), filter = context.createBiquadFilter();
    const gain = context.createGain(), stereo = context.createStereoPanner();
    osc.type = type;
    osc.frequency.value = frequency(note);
    osc.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(180, cutoff * 0.35), time + duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    stereo.pan.value = pan;
    osc.connect(filter).connect(gain).connect(stereo).connect(this.mix!);
    if (delayed) stereo.connect(this.echo!);
    osc.start(time);
    osc.stop(time + duration + 0.02);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); gain.disconnect(); stereo.disconnect(); };
  }

  private kick(time: number) {
    const context = this.context!, osc = context.createOscillator(), gain = context.createGain();
    osc.frequency.setValueAtTime(145, time);
    osc.frequency.exponentialRampToValueAtTime(43, time + 0.12);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.6, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
    osc.connect(gain).connect(this.mix!);
    osc.start(time); osc.stop(time + 0.32);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  private percussion(time: number, snare: boolean, open = false) {
    const context = this.context!, source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
    const duration = snare ? 0.19 : open ? 0.16 : 0.045;
    source.buffer = this.noise!;
    filter.type = 'highpass'; filter.frequency.value = snare ? 1300 : 7500;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(snare ? 0.24 : open ? 0.08 : 0.055, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter).connect(gain).connect(this.mix!);
    source.start(time); source.stop(time + duration + 0.01);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
    if (snare) this.synth(50, time, 0.12, 0.12, 'triangle', 1200);
  }

  private schedule() {
    const context = this.context!;
    // Skip a stalled wall-clock interval without bursting a backlog of notes.
    if (this.next < context.currentTime) this.next = context.currentTime + 0.02;
    while (this.next < context.currentTime + 0.2) {
      const bar = Math.floor(this.step / 16), beat = this.step % 16, time = this.next;
      const chord = CHORDS[Math.floor(bar / 2) % 4]!;
      const breakdown = bar >= 16 && bar < 20;
      if (!breakdown && beat % 4 === 0) this.kick(time);
      if (!breakdown && (beat === 4 || beat === 12)) this.percussion(time, true);
      if (!breakdown && beat % 2 === 0) this.percussion(time, false, beat % 4 === 2);
      if (!breakdown && bar % 8 === 7 && beat >= 14) this.percussion(time, true);
      if (beat % 2 === 0) this.synth(chord[0]! - 12 + (beat % 4 === 2 ? 12 : 0), time, STEP * 1.6, 0.17, 'sawtooth', 750);
      if (beat === 0) chord.forEach(note => {
        this.synth(note + 12, time, STEP * 15.5, 0.032, 'sawtooth', 1400, -0.65, true, 0.2, -7);
        this.synth(note + 12, time, STEP * 15.5, 0.032, 'sawtooth', 1600, 0.65, true, 0.2, 7);
      });
      const arp = [0, 1, 2, 3, 2, 1, 3, 2][beat % 8]!;
      if (beat % 2 === 0 || bar >= 24) this.synth(chord[arp]! + 24, time, STEP * 1.4, 0.045, 'square', 2400, beat % 4 < 2 ? -0.4 : 0.4, true);
      if ((bar >= 8 && bar < 16 || bar >= 24) && beat % 4 === 0) {
        const melody = [76, 79, 81, 79, 76, 74, 72, 74];
        this.synth(melody[(bar % 2) * 4 + beat / 4]!, time, STEP * 3.7, 0.065, 'sawtooth', 3200, 0.1, true, 0.015);
      }
      this.step = (this.step + 1) % (32 * 16);
      this.next += STEP;
    }
  }
}
