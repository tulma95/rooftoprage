import { EMPTY_INPUT, type Input } from '../shared/game.js';

export class KeyboardInput {
  readonly state: Input = { ...EMPTY_INPUT };
  private keys = new Set<string>();
  private burstPending = false;
  private burstForward = 1;
  private burstSide = 0;

  constructor(playing: () => boolean, toggleMenu: () => void) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof Element && e.target.matches('input:not([type=checkbox]),textarea'))
        return;
      if (
        !playing() ||
        ![
          'KeyW',
          'KeyS',
          'KeyA',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'ShiftLeft',
          'ShiftRight',
          'Space',
          'KeyE',
          'Escape',
        ].includes(e.code)
      )
        return;
      e.preventDefault();
      if (e.code === 'Escape') {
        if (!e.repeat) {
          this.clear();
          toggleMenu();
        }
      } else {
        if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
          this.burstPending = true;
          this.burstSide = this.turn();
          this.burstForward = this.forward() || (this.burstSide ? 0 : 1);
        }
        this.keys.add(e.code);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }

  clear() {
    this.keys.clear();
    this.burstPending = false;
    Object.assign(this.state, EMPTY_INPUT);
    this.state.boost = false;
    this.state.boostX = this.state.boostZ = 0;
  }

  private forward() {
    return (
      Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) -
      Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'))
    );
  }

  private turn() {
    return (
      Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) -
      Number(this.keys.has('KeyD') || this.keys.has('ArrowRight'))
    );
  }

  sample(enabled: boolean, yaw = 0): Input {
    enabled = enabled && !document.hidden;
    this.state.forward = enabled ? this.forward() : 0;
    this.state.turn = enabled ? this.turn() : 0;
    this.state.front = enabled && this.keys.has('Space');
    this.state.top = enabled && this.keys.has('KeyE');
    this.state.boost = enabled && this.burstPending;
    this.burstPending = false;
    const forward = this.burstForward;
    const side = this.burstSide;
    const length = Math.hypot(forward, side);
    this.state.boostX = this.state.boost
      ? (Math.sin(yaw) * forward + Math.cos(yaw) * side) / length
      : 0;
    this.state.boostZ = this.state.boost
      ? (Math.cos(yaw) * forward - Math.sin(yaw) * side) / length
      : 0;
    return this.state;
  }
}
