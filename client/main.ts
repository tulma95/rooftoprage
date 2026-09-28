import { BattleHud } from './hud.js';
import { screenMarkup, settingsForm, help } from './screens.js';
import { button } from './html.js';
import { loadProfile, saveProfile } from './profile.js';
import { KeyboardInput } from './input.js';
import { installUiSounds, playCombatSounds, stopCombatSounds } from './sound.js';
import { sendClientMessage } from '../shared/protocol.js';
import { ArenaSession, connectionError } from './session.js';
import { isScreen, type Screen, type Modal } from './navigation.js';
import { type Room } from '@colyseus/sdk';
import { GameScene } from './scene.js';
import { SynthwaveMusic } from './music.js';
import {
  isChassis,
  EMPTY_INPUT,
  isFrontWeapon,
  isTopWeapon,
  validName,
  type RoomState,
  type PlayerState,
} from '../shared/game.js';
import './style.css';
const app = document.querySelector<HTMLElement>('#app')!;
let hud: BattleHud | null = null;
const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
let scene: GameScene;
try {
  scene = new GameScene(canvas);
} catch {
  app.innerHTML =
    '<section class="panel"><h1>3D unavailable</h1><p>This game requires WebGL. Enable hardware acceleration in your browser, then reload.</p></section>';
  throw new Error('WebGL unavailable');
}
const serverAddress = import.meta.env.DEV
  ? `${location.hostname}:${import.meta.env.VITE_SERVER_PORT || '2567'}`
  : location.host;
const endpoint =
  import.meta.env.VITE_SERVER_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${serverAddress}`;

let { nickname, chassis, front, top, settings } = loadProfile();
const music = new SynthwaveMusic();
let screen: Screen = nickname ? 'home' : 'name';
let modal: Modal = '';
let busy = false,
  online = false,
  error = '',
  room: Room | null = null,
  state: RoomState | null = null,
  lastSnapshot = 0,
  spectatorId = '',
  lobbySignature = '',
  lastPhase = '',
  lastEvent = 0,
  combatMessage = '',
  combatMessageUntil = 0,
  saveError = '',
  renderedScreen = '';
const controls = new KeyboardInput(playing, () => {
  modal = modal ? '' : 'menu';
  renderModal();
});
const input = controls.state;
function save() {
  saveError = saveProfile({ nickname, chassis, front, top, settings })
    ? ''
    : 'Browser saving is unavailable. You can still play this session.';
}
function applySettings() {
  music.setEnabled(settings.music);
  scene.setCameraShake(settings.shake);
  document.body.classList.toggle('high-contrast', settings.contrast);
}
applySettings();
installUiSounds(() => settings.audio);
function local() {
  return state?.players.find((p) => p.id === room?.sessionId);
}
function watched(): PlayerState | undefined {
  const p = local();
  if (p?.alive) return p;
  return (
    state?.players.find((p) => p.id === spectatorId && p.alive) ??
    state?.players.find((p) => p.alive)
  );
}
function playing() {
  return !!state && ['loading', 'countdown', 'combat', 'results'].includes(state.phase);
}
function navigate(to: Screen) {
  if (room && (to === 'home' || to === 'play')) to = 'lobby';
  screen = to;
  // Surface a failed save on the next screen instead of silently dropping it.
  error = saveError;
  saveError = '';
  render();
}
function render() {
  const inGame = playing();
  document.body.classList.toggle('in-game', inGame);
  scene.preview(front, top, chassis);
  if (inGame) {
    if (!hud || !hud.element.isConnected) {
      app.innerHTML = `<div id="hud"></div><div id="overlay"></div>`;
      hud = new BattleHud(document.querySelector<HTMLElement>('#hud')!);
    }
    renderHud();
    renderModal();
    renderedScreen = '';
    return;
  }
  hud = null;
  // innerHTML replaces every control, so restore keyboard focus to the matching one.
  const focused = document.activeElement;
  const focusKey =
    focused instanceof HTMLElement && app.contains(focused)
      ? (['action', 'chassis', 'equip', 'setting']
          .filter((k) => focused.dataset[k])
          .map((k) => `[data-${k}="${focused.dataset[k]}"]`)[0] ??
        (focused.id && `#${focused.id}`))
      : '';
  app.innerHTML = screenMarkup({
    screen,
    nickname,
    chassis,
    front,
    top,
    settings,
    state,
    room,
    busy,
    online,
    error,
    inviteCode: new URLSearchParams(location.search).get('room') || '',
    touchOnly: !matchMedia('(any-pointer: fine)').matches,
  });
  // Entry animations play only when the screen changes, not on every re-render.
  if (screen === renderedScreen) app.querySelector('.shell')?.classList.add('same');
  renderedScreen = screen;
  if (focusKey) app.querySelector<HTMLElement>(focusKey)?.focus();
}
function renderHud() {
  if (!hud || !state || !room) return;
  hud.update({
    state,
    sessionId: room.sessionId,
    watched: watched(),
    unstable: performance.now() - lastSnapshot > 1500,
    message: performance.now() < combatMessageUntil ? combatMessage : '',
  });
}
function renderModal() {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return;
  overlay.innerHTML = modal
    ? `<div class="modal-backdrop"><section class="modal glass" role="dialog" aria-modal="true" aria-label="${modal === 'leave' ? 'Leave match' : 'Battle menu'}">${modal === 'leave' ? `<h2>Leave this round?</h2><p>Your robot will be eliminated. You cannot rejoin this round.</p>${button('confirm-leave', 'Leave match', 'primary')}${button('resume', 'Keep playing')}` : `${settingsForm(settings)}${button('resume', 'Resume', 'primary')}${button('help-modal', 'Controls')}${button('leave', 'Leave match')}${modal === 'help' ? help() : ''}`}</section></div>`
    : '';
  overlay.querySelector<HTMLElement>('.modal button')?.focus();
}
const session = new ArenaSession(endpoint, {
  joined(joined) {
    room = joined;
    lastPhase = '';
    lastEvent = 0;
    state = null;
    screen = 'lobby';
  },
  snapshot(s, joined) {
    state = s;
    lastSnapshot = performance.now();
    online = true;
    const fresh = s.events.filter((e) => e.id > lastEvent);
    for (const e of fresh) {
      lastEvent = e.id;
      if (e.type === 'elimination' && e.playerId === joined.sessionId) {
        const attacker = s.players.find((p) => p.id === e.attackerId);
        combatMessage = `${e.reason === 'destroyed' ? 'Destroyed' : e.reason === 'fell off the roof' ? 'Knocked off the roof' : 'Eliminated'}${attacker ? ` by ${attacker.name}` : ''}`;
        combatMessageUntil = performance.now() + 3500;
      }
    }
    hud?.events(fresh, s, joined.sessionId, watched());
    playCombatSounds(s, fresh, watched(), settings.audio);
    scene.update(s, joined.sessionId, input, watched()?.id);
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      screen = s.phase === 'lobby' ? 'lobby' : screen;
      modal = '';
      render();
      if (s.phase === 'loading') requestAnimationFrame(() => sendClientMessage(joined, 'loaded'));
    } else if (s.phase === 'lobby' && screen === 'lobby') {
      const signature = JSON.stringify([s.players, s.hostId, s.notice]);
      if (signature !== lobbySignature) {
        lobbySignature = signature;
        render();
      }
    } else renderHud();
  },
  notice(message) {
    error = message;
    render();
  },
  disconnected() {
    room = null;
    state = null;
    controls.clear();
    stopCombatSounds();
    screen = 'play';
    error =
      'Connection lost. Your robot cannot rejoin the ongoing round. Create or join another room.';
    scene.update(null, '', EMPTY_INPUT);
    render();
  },
});
async function connect(code?: string, practice = false) {
  if (busy || room) return;
  busy = true;
  error = '';
  render();
  try {
    await session.connect({ nickname, chassis, front, top }, code, practice);
  } catch (cause) {
    error = connectionError(cause);
  } finally {
    busy = false;
    render();
  }
}
async function leave(to: Screen = 'play') {
  room = null;
  state = null;
  modal = '';
  controls.clear();
  stopCombatSounds();
  scene.update(null, '', EMPTY_INPUT);
  await session.leave();
  navigate(to);
}
app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if (form.id === 'name-form') {
    const value = String(new FormData(form).get('nickname') || '').trim();
    if (!validName(value)) {
      error = 'Choose a nickname of 1–20 characters.';
      render();
      return;
    }
    nickname = value;
    save();
    navigate(new URLSearchParams(location.search).has('room') ? 'play' : 'home');
  }
  if (form.id === 'join-form') {
    let code = String(new FormData(form).get('code') || '').trim();
    try {
      if (code.includes('://')) code = new URL(code).searchParams.get('room') || '';
    } catch {}
    code = code.toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(code)) {
      error = 'Enter a six-character room code or a valid invite link.';
      render();
      return;
    }
    void connect(code);
  }
});
app.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  const key = target.dataset.setting as keyof typeof settings | undefined;
  if (key && key in settings) {
    settings[key] = target.checked;
    applySettings();
    save();
    if (saveError && !playing()) {
      error = saveError;
      saveError = '';
      render();
    }
  }
});
app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button,a');
  if (!el) return;
  const chosenChassis = el.dataset.chassis;
  if (isChassis(chosenChassis)) {
    chassis = chosenChassis;
    render();
    return;
  }
  const equip = el.dataset.equip;
  if (equip) {
    if (isFrontWeapon(equip)) front = equip;
    else if (isTopWeapon(equip)) top = equip;
    render();
    return;
  }
  const action = el.dataset.action;
  if (!action) return;
  e.preventDefault();
  if (isScreen(action)) {
    navigate(action);
    return;
  }
  if (action === 'rename') {
    if (room) await leave('name');
    else navigate('name');
  }
  if (action === 'save-equipment') {
    save();
    sendClientMessage(room, 'equipment', { front, top, chassis });
    navigate(room ? 'lobby' : 'home');
  }
  if (action === 'practice') void connect(undefined, true);
  if (action === 'create') void connect();
  if (action === 'ready') sendClientMessage(room, 'ready', !local()?.ready);
  if (action === 'start') sendClientMessage(room, 'start');
  if (action === 'again') sendClientMessage(room, 'again');
  if (action === 'copy') {
    try {
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('room', state!.code);
      await navigator.clipboard.writeText(url.toString());
      error = 'Invite link copied.';
    } catch {
      error = `Share room code ${state?.code}, or add ?room=${state?.code} to this page’s URL.`;
    }
    render();
  }
  if (action === 'results-garage') await leave('garage');
  if (action === 'leave') {
    if (playing() && state?.phase !== 'results') {
      modal = 'leave';
      controls.clear();
      renderModal();
    } else await leave();
  }
  if (action === 'confirm-leave') await leave();
  if (action === 'menu') {
    modal = 'menu';
    controls.clear();
    renderModal();
  }
  if (action === 'resume') {
    modal = '';
    renderModal();
  }
  if (action === 'help-modal') {
    modal = 'help';
    renderModal();
  }
  if (action === 'skip-cinematic') scene.skipCinematic();
  if (action === 'spectate' && state) {
    const alive = state.players.filter((p) => p.alive);
    spectatorId =
      alive[(alive.findIndex((p) => p.id === watched()?.id) + 1) % alive.length]?.id || '';
  }
});
setInterval(() => {
  controls.sample(state?.phase === 'combat' && !!local()?.alive && !modal, local()?.yaw);
  if (room && state?.phase === 'combat') sendClientMessage(room, 'input', input);
  scene.update(state, room?.sessionId || '', input, watched()?.id);
  if (playing() && performance.now() - lastSnapshot > 1500) renderHud();
}, 50);
function aimLoop() {
  document.body.classList.toggle('cinematic', scene.cinematicActive);
  const aim = document.querySelector<HTMLElement>('#aim');
  if (aim) {
    const point = scene.aimScreen();
    aim.style.display = point ? 'block' : 'none';
    if (point) {
      aim.style.left = `${point.x}px`;
      aim.style.top = `${point.y}px`;
    }
  }
  requestAnimationFrame(aimLoop);
}
aimLoop();
async function health() {
  if (room) return; // Snapshots already prove the connection during a match.
  online = await session.healthy();
  if (!room && !busy) {
    const badge = document.querySelector('.connection');
    if (badge) {
      badge.textContent = online ? '● SERVER ONLINE' : '○ SERVER OFFLINE';
      badge.classList.toggle('connected', online);
    }
  }
}
void health();
setInterval(() => void health(), 5000);
if (nickname && new URLSearchParams(location.search).has('room')) screen = 'play';
render();
