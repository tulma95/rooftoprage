let audio: AudioContext | null = null;
export function tone(hit: boolean, enabled: boolean) {
  if (!enabled) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.type = hit ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(hit ? 160 : 210, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(45, audio.currentTime + 0.18);
    gain.gain.setValueAtTime(0.13, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.26);
    if (hit) {
      const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * 0.18), audio.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++)
        samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length) ** 2;
      const noise = audio.createBufferSource(),
        filter = audio.createBiquadFilter(),
        metal = audio.createGain();
      noise.buffer = buffer;
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.8;
      metal.gain.value = 0.12;
      noise.connect(filter).connect(metal).connect(audio.destination);
      noise.start();
      noise.onended = () => {
        noise.disconnect();
        filter.disconnect();
        metal.disconnect();
      };
    }
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    /* Audio is optional. */
  }
}
