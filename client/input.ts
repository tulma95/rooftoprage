import { EMPTY_INPUT, type Input } from '../shared/game.js';

export class KeyboardInput {
  readonly state: Input = { ...EMPTY_INPUT };
  private keys = new Set<string>();
  private burstPending = false;
  private burstForward = 1;
  private burstSide = 0;
  private stick = { x: 0, y: 0 };
  private held = new Set<string>();

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
    this.mountTouch();
  }

  // Joystick + buttons, shown by CSS only on coarse-pointer landscape screens during a match.
  private mountTouch() {
    const root = document.createElement('div');
    root.id = 'touch-controls';
    root.innerHTML =
      '<div class="stick-zone"><div class="stick"><i></i></div></div><div class="touch-buttons">' +
      '<button data-touch="boost" aria-label="Burst"><b>»</b><small>BURST</small></button>' +
      '<button data-touch="top" aria-label="Top weapon"><b></b><small>TOP</small></button>' +
      '<button data-touch="front" aria-label="Fire"><b></b><small>FIRE</small></button></div>';
    document.body.append(root);
    // Floating stick: the base re-centres wherever the thumb lands inside the zone.
    const zone = root.querySelector<HTMLElement>('.stick-zone')!;
    const pad = zone.querySelector<HTMLElement>('.stick')!;
    const knob = pad.querySelector<HTMLElement>('i')!;
    let stickId: number | null = null;
    const move = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const radius = r.width / 2;
      let x = (e.clientX - r.left - radius) / radius;
      let y = (e.clientY - r.top - radius) / radius;
      const length = Math.hypot(x, y);
      if (length > 1) ((x /= length), (y /= length));
      this.stick = { x, y };
      knob.style.transform = `translate(${x * radius * 0.6}px, ${y * radius * 0.6}px)`;
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.stick = { x: 0, y: 0 };
      knob.style.transform = pad.style.left = pad.style.top = '';
      pad.classList.remove('active');
    };
    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      const z = zone.getBoundingClientRect();
      const radius = pad.offsetWidth / 2;
      const clamp = (v: number, max: number) => Math.min(Math.max(v, 8), max - radius * 2 - 8);
      pad.style.left = `${clamp(e.clientX - z.left - radius, z.width)}px`;
      pad.style.top = `${clamp(e.clientY - z.top - radius, z.height)}px`;
      pad.classList.add('active');
      move(e);
    });
    zone.addEventListener('pointermove', (e) => e.pointerId === stickId && move(e));
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
    for (const button of root.querySelectorAll<HTMLElement>('[data-touch]')) {
      const action = button.dataset.touch!;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        if (action === 'boost') {
          this.burstPending = true;
          this.burstSide = this.turn();
          this.burstForward = this.forward() || (this.burstSide ? 0 : 1);
        } else this.held.add(action);
      });
      const up = () => this.held.delete(action);
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
    }
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // First thumb on the controls hides the browser chrome. iPhone Safari has no element
    // fullscreen, so there it's a no-op; "Add to Home Screen" gives a chrome-less app instead.
    root.addEventListener('pointerdown', () => {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (document.fullscreenElement) return;
      if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      else el.webkitRequestFullscreen?.();
    });
  }

  clear() {
    this.keys.clear();
    this.held.clear();
    this.burstPending = false;
    Object.assign(this.state, EMPTY_INPUT);
    this.state.boost = false;
    this.state.boostX = this.state.boostZ = 0;
  }

  private forward() {
    const keys =
      Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) -
      Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    return keys || (Math.abs(this.stick.y) > 0.2 ? -this.stick.y : 0);
  }

  private turn() {
    const keys =
      Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) -
      Number(this.keys.has('KeyD') || this.keys.has('ArrowRight'));
    return keys || (Math.abs(this.stick.x) > 0.2 ? -this.stick.x : 0);
  }

  sample(enabled: boolean, yaw = 0): Input {
    enabled = enabled && !document.hidden;
    this.state.forward = enabled ? this.forward() : 0;
    this.state.turn = enabled ? this.turn() : 0;
    this.state.front = enabled && (this.keys.has('Space') || this.held.has('front'));
    this.state.top = enabled && (this.keys.has('KeyE') || this.held.has('top'));
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
