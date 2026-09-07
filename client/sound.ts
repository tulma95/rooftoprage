let audio: AudioContext | null = null;
export function tone(hit: boolean, enabled: boolean) {
  if (!enabled) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(hit ? 110 : 240, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(45, audio.currentTime + 0.09);
    gain.gain.setValueAtTime(0.035, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.13);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    /* Audio is optional. */
  }
}
