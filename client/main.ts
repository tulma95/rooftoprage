import { screenMarkup, settingsForm, help } from './screens.js';
import { escape, button, tag } from './html.js';
import { loadProfile, saveProfile } from './profile.js';
import { KeyboardInput } from './input.js';
import { tone } from './sound.js';
import { sendClientMessage } from '../shared/protocol.js';
import { ArenaSession, connectionError } from './session.js';
import { isScreen, type Screen, type Modal } from './navigation.js';
import { type Room } from '@colyseus/sdk';
import { GameScene } from './scene.js';
import { SynthwaveMusic } from './music.js';
import {
  CHASSIS,
  isChassis,
  type Chassis,
  EMPTY_INPUT,
  WEAPONS,
  WEAPON_ICONS,
  isFrontWeapon,
  isTopWeapon,
  validName,
  validEquipment,
  type FrontWeapon,
  type TopWeapon,
  type RoomState,
  type PlayerState,
} from '../shared/game.js';
import './style.css';
const app = document.querySelector<HTMLElement>('#app')!;
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
  combatMessageUntil = 0;
const controls = new KeyboardInput(playing, () => {
  modal = modal ? '' : 'menu';
  renderModal();
});
const input = controls.state;
function save() {
  if (!saveProfile({ nickname, chassis, front, top, settings }))
    error = 'Browser saving is unavailable. You can still play this session.';
}
function applySettings() {
  music.setEnabled(settings.music);
  scene.setQuality(settings.low);
  scene.setReducedMotion(settings.reduced);
  document.body.classList.toggle('high-contrast', settings.contrast);
  document.body.classList.toggle('reduced-motion', settings.reduced);
}
applySettings();
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
  error = '';
  render();
}
function render() {
  const inGame = playing();
  document.body.classList.toggle('in-game', inGame);
  scene.preview(front, top, chassis);
  if (inGame) {
    app.innerHTML = `<div id="hud"></div><div id="overlay"></div>`;
    renderHud();
    renderModal();
    return;
  }
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
  });
}
function weaponHud(p: PlayerState, slot: 'front' | 'top', spectator: boolean) {
  const key = p[slot],
    w = WEAPONS[key],
    cooldown = slot === 'front' ? p.frontCooldown : p.topCooldown,
    active = slot === 'front' ? p.frontActive : p.topActive;
  const heat = slot === 'top' && key === 'flamethrower';
  const status =
    heat && p.overheated
      ? 'OVERHEATED'
      : active
        ? 'ACTIVE'
        : cooldown > 0
          ? 'COOLING DOWN'
          : 'READY';
  const progress = heat ? p.heat : cooldown / (w.cooldown || 1);
  return `<div class="weapon-hud">${tag(slot)}<strong><span aria-hidden="true">${WEAPON_ICONS[key]}</span>${w.name} ${spectator ? '' : `<kbd>${slot === 'front' ? 'Space' : 'E'}</kbd>`}</strong><small>${status}</small><div class="meter"><i style="width:${Math.min(100, progress * 100)}%"></i></div></div>`;
}
function renderHud() {
  const hud = document.querySelector('#hud');
  if (!hud || !state || !room) return;
  const s = state,
    p = watched(),
    me = local(),
    spectator = !me?.alive;
  const alive = s.players.filter((p) => p.alive).length;
  const seconds = Math.ceil(s.remaining);
  const unstable = performance.now() - lastSnapshot > 1500;
  const markup = `<div class="hud-roster glass">${s.players.map((p) => `<div><span class="swatch" style="background:${p.color}"></span><span>${escape(p.name)}</span><small>${p.alive ? 'ALIVE' : 'OUT'}</small></div>`).join('')}</div><div class="hud-timer glass"><strong>${s.phase === 'loading' ? 'LOADING' : s.phase === 'countdown' ? Math.ceil(s.countdown) : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</strong><span>${alive} of ${s.players.length} remaining</span></div><div class="hud-menu">${button('menu', 'Menu / Esc')}<span class="connection ${unstable ? '' : 'connected'}">${unstable ? '⚠ CONNECTION UNSTABLE' : '● CONNECTED'}</span></div>${p ? `<div class="hud-health glass ${p.hp < CHASSIS[p.chassis].hp * 0.3 ? 'low-health' : ''}">${tag(spectator ? `Spectating / ${escape(p.name)}` : escape(p.name))}<strong>${Math.ceil(p.hp)} <small>/ ${CHASSIS[p.chassis].hp} HP</small></strong><div class="meter"><i style="width:${(p.hp / CHASSIS[p.chassis].hp) * 100}%"></i></div></div><div class="hud-weapons">${weaponHud(p, 'front', spectator)}${weaponHud(p, 'top', spectator)}</div>` : ''}${spectator && s.phase === 'combat' ? `<div class="spectator glass"><b>ELIMINATED · SPECTATING</b>${button('spectate', 'Next survivor →')}${button('leave', 'Leave match', 'quiet')}</div>` : ''}${!spectator && s.phase === 'combat' ? '<span id="aim" aria-hidden="true">⊹</span>' : ''}<p class="combat-message" aria-live="polite">${performance.now() < combatMessageUntil ? escape(combatMessage) : ''}</p>${s.phase === 'loading' ? `<div class="center-card glass"><h2>Preparing the rooftop</h2>${s.players.map((p) => `<p>${escape(p.name)} · ${p.loaded ? 'LOADED' : 'LOADING'}</p>`).join('')}</div>` : ''}${s.phase === 'countdown' ? '<div class="countdown-label">ENGINES ON. STAY ON THE ROOF.</div>' : ''}${s.phase === 'results' ? `<section class="results glass">${tag(`Round ${s.round} complete`)}<h1>${s.draw ? 'DRAW' : s.winnerId === room.sessionId ? 'VICTORY' : 'ELIMINATED'}</h1><p>${s.draw ? 'No single survivor. The roof wins.' : `${escape(s.players.find((p) => p.id === s.winnerId)?.name || 'Unknown pilot')} is the last robot standing.`}</p><table><thead><tr><th>Pilot</th><th>Damage</th><th>KOs</th><th>Shots</th></tr></thead><tbody>${s.players.map((p) => `<tr><td>${escape(p.name)}</td><td>${Math.round(p.stats.damage)}</td><td>${p.stats.kills}</td><td>${p.stats.shots}</td></tr>`).join('')}</tbody></table><div class="actions">${button('again', 'Play again', 'primary')}${button('results-garage', 'Return to garage')}</div></section>` : ''}`;
  const template = document.createElement('template');
  template.innerHTML = markup;
  patchChildren(hud, template.content);
}
function patchChildren(parent: Node, incoming: Node): void {
  const children = Array.from(incoming.childNodes);
  children.forEach((next, index) => {
    const current = parent.childNodes[index];
    if (!current) {
      parent.appendChild(next.cloneNode(true));
      return;
    }
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      parent.replaceChild(next.cloneNode(true), current);
      return;
    }
    if (current.isEqualNode(next)) return;
    if (current instanceof Element && next instanceof Element) {
      for (const attr of Array.from(current.attributes))
        if (!next.hasAttribute(attr.name) && !(current.id === 'aim' && attr.name === 'style'))
          current.removeAttribute(attr.name);
      for (const attr of Array.from(next.attributes))
        if (current.getAttribute(attr.name) !== attr.value)
          current.setAttribute(attr.name, attr.value);
      patchChildren(current, next);
    } else current.nodeValue = next.nodeValue;
  });
  while (parent.childNodes.length > children.length) parent.removeChild(parent.lastChild!);
}
function renderModal() {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return;
  overlay.innerHTML = modal
    ? `<div class="modal-backdrop"><section class="modal glass">${modal === 'leave' ? `<h2>Leave this round?</h2><p>Your robot will be eliminated. You cannot rejoin this round.</p>${button('confirm-leave', 'Leave match', 'primary')}${button('resume', 'Keep playing')}` : `${settingsForm(settings)}${button('resume', 'Resume', 'primary')}${button('help-modal', 'Controls')}${button('leave', 'Leave match')}${modal === 'help' ? help() : ''}`}</section></div>`
    : '';
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
    for (const e of s.events)
      if (e.id > lastEvent) {
        lastEvent = e.id;
        const victim = s.players.find((p) => p.id === e.playerId),
          attacker = s.players.find((p) => p.id === e.attackerId);
        if (e.type === 'elimination') {
          combatMessage = `${victim?.name ?? 'Robot'} ${e.reason}${attacker ? ` · ${attacker.name}` : ''}`;
          combatMessageUntil = performance.now() + 3500;
        } else if (
          e.type === 'hit' &&
          (e.playerId === joined.sessionId || e.attackerId === joined.sessionId)
        ) {
          if (performance.now() > combatMessageUntil) {
            combatMessage = e.playerId === joined.sessionId ? 'Armor hit!' : 'Hit confirmed';
            combatMessageUntil = performance.now() + 550;
          }
          tone(true, settings.audio);
        } else if (e.type === 'shot' && e.playerId === joined.sessionId)
          tone(false, settings.audio);
      }
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
  if (action === 'spectate' && state) {
    const alive = state.players.filter((p) => p.alive);
    spectatorId =
      alive[(alive.findIndex((p) => p.id === watched()?.id) + 1) % alive.length]?.id || '';
  }
});
setInterval(() => {
  controls.sample(state?.phase === 'combat' && !!local()?.alive && !modal);
  if (room && state?.phase === 'combat') sendClientMessage(room, 'input', input);
  scene.update(state, room?.sessionId || '', input, watched()?.id);
  if (playing() && performance.now() - lastSnapshot > 1500) renderHud();
}, 50);
function aimLoop() {
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
