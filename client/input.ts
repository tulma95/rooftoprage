import { EMPTY_INPUT, type Input } from '../shared/game.js';

export class KeyboardInput {
  readonly state: Input = { ...EMPTY_INPUT };
  private keys = new Set<string>();

  constructor(playing: () => boolean, toggleMenu: () => void) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).matches('input,textarea')) return;
      if (
        !playing() ||
        !['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyE', 'Escape'].includes(e.code)
      )
        return;
      e.preventDefault();
      if (e.code === 'Escape') {
        if (!e.repeat) {
          this.clear();
          toggleMenu();
        }
      } else this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }

  clear() {
    this.keys.clear();
    Object.assign(this.state, EMPTY_INPUT);
  }

  sample(enabled: boolean): Input {
    enabled = enabled && !document.hidden;
    this.state.forward = enabled
      ? Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'))
      : 0;
    this.state.turn = enabled ? Number(this.keys.has('KeyA')) - Number(this.keys.has('KeyD')) : 0;
    this.state.front = enabled && this.keys.has('Space');
    this.state.top = enabled && this.keys.has('KeyE');
    return this.state;
  }
}
