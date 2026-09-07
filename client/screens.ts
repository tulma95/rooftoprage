import { CHASSIS, WEAPONS, WEAPON_ICONS, type RoomState } from '../shared/game.js';
import type { Profile, Settings } from './profile.js';
import type { Screen } from './navigation.js';
import { escape, button, tag } from './html.js';
function equipment({ chassis, front, top }: Pick<Profile, 'chassis' | 'front' | 'top'>) {
  return `<div class="chassis-picker">${tag('Chassis')}<div class="choices">${Object.entries(
    CHASSIS,
  )
    .map(
      ([key, c]) =>
        `<button data-chassis="${key}" aria-pressed="${chassis === key}" class="choice ${chassis === key ? 'selected' : ''}"><strong>${c.name}</strong><small>${c.role}</small><small>${c.hp} HP · ${c.speed} m/s</small></button>`,
    )
    .join(
      '',
    )}</div><p class="muted">${CHASSIS[chassis].description} Reverse ${CHASSIS[chassis].reverse} m/s · Turn ${CHASSIS[chassis].turn} rad/s</p></div><div class="slots">${(
    ['front', 'top'] as const
  )
    .map(
      (slot) =>
        `<div>${tag(`${slot} attachment`)}<div class="choices">${Object.entries(WEAPONS)
          .filter(([, w]) => w.slot === slot)
          .map(
            ([key, w]) =>
              `<button data-equip="${key}" class="choice ${(slot === 'front' ? front : top) === key ? 'selected' : ''}"><span class="weapon-symbol">${WEAPON_ICONS[key as keyof typeof WEAPON_ICONS]}</span><strong>${w.name}</strong><small>${w.damage}${key === 'scattergun' ? ' × 5' : w.cooldown === 0 ? '/s' : ''} DMG · ${w.range}m</small></button>`,
          )
          .join(
            '',
          )}</div><p class="muted">${WEAPONS[slot === 'front' ? front : top].description}</p></div>`,
    )
    .join('')}</div>`;
}
export function settingsForm(settings: Settings) {
  return `${tag('Make it yours')}<h2>Settings</h2>${(
    [
      ['audio', 'Sound effects'],
      ['music', 'Synthwave music'],
      ['shake', 'Impact camera shake'],
      ['contrast', 'High contrast panels'],
    ] as const
  )
    .map(
      ([key, label]) =>
        `<label class="setting"><span>${label}</span><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}></label>`,
    )
    .join(
      '',
    )}<p class="muted">Settings save automatically. The online battle continues while this menu is open.</p>`;
}
export function help() {
  return `${tag('Field manual')}<h2>Stay on the roof.</h2><p>Destroy every other robot, or push them over the edge. One life. Five minutes. More than one survivor at timeout means a draw.</p><div class="controls"><p><kbd>W</kbd> <kbd>S</kbd> Forward / reverse</p><p><kbd>A</kbd> <kbd>D</kbd> Turn and aim</p><p><kbd>Space</kbd> Front weapon</p><p><kbd>E</kbd> Top weapon</p><p><kbd>Esc</kbd> Battle menu</p></div><p class="muted">Weapons fire forward. Steer to aim. Hold an activation key to keep firing. Falling is fatal. Eliminated pilots can watch the survivors.</p><p class="muted">Yellow-banded fuel tanks explode and chain together. Flames and tank blasts ignite dark oil slicks; oil reduces steering grip. Fire clings to robots for 3 seconds. Cyan cooling pools slow you down, extinguish fire, and cool the Furnace Jet faster.</p>`;
}
export interface ScreenView extends Profile {
  screen: Screen;
  state: RoomState | null;
  room: { sessionId: string } | null;
  busy: boolean;
  online: boolean;
  error: string;
  inviteCode: string;
}
export function screenMarkup({
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
  inviteCode,
}: ScreenView): string {
  let content = '';
  if (screen === 'name')
    content = `${tag('Pilot registration / no account needed')}<h1>WHO’S IN<br>THE DRIVER’S SEAT?</h1><form id="name-form"><label for="nickname">Pilot callsign</label><input id="nickname" name="nickname" maxlength="20" placeholder="Enter a nickname" value="${escape(nickname)}" autocomplete="nickname" required><button class="primary">Enter garage <span>↗</span></button></form><p class="muted">1–20 characters. Your machine is waiting.</p>`;
  if (screen === 'home')
    content = `${tag('Multiplayer rooftop combat')}<h1>BUILT TO BRAWL.<br>NOT TO LAST.</h1><p class="lede">Four machines. One rooftop.<br>Leave your manners on the ground floor.</p><div class="actions">${button('play', 'Find a fight <span>↗</span>', 'primary')}${button('practice', 'Play with bots')}${button('garage', 'Customize machine')}${button('help', 'How to play', 'quiet')}</div><div class="spec-strip"><span><b>01–04</b> PILOTS</span><span><b>05:00</b> TO SURVIVE</span><span><b>01</b> LIFE</span></div>`;
  if (screen === 'garage')
    content = `${tag('Workshop / choose your chassis')}<h1>YOUR MACHINE.<br>YOUR PROBLEM.</h1><p class="lede">${CHASSIS[chassis].name}. ${CHASSIS[chassis].description}</p>${equipment({ chassis, front, top })}<div class="actions">${button('save-equipment', 'Save loadout', 'primary')}${button(room ? 'lobby' : 'home', 'Back', 'quiet')}</div>`;
  if (screen === 'play')
    content = `${tag('Choose your fight')}<h1>TAKE IT<br>TO THE ROOF.</h1><p class="lede">Practice solo against three bots, or create a room and invite friends.</p>${button('practice', busy ? 'Connecting…' : 'Play with bots', '', busy)}${button('create', busy ? 'Connecting…' : 'Create private room', 'primary', busy)}<div class="divider">OR JOIN A CREW</div><form id="join-form"><label for="code">Room code or invite link</label><input id="code" name="code" placeholder="e.g. A1B2C3" value="${escape(inviteCode)}" required><button ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Join room →'}</button></form>${button('home', 'Back', 'quiet')}`;
  if (screen === 'lobby' && state && room) {
    const me = state.players.find((p) => p.id === room.sessionId);
    content = `${tag(state.players.some((p) => p.bot) ? 'Bot practice / staging area' : 'Private room / staging area')}<h1>ASSEMBLE<br>THE CREW.</h1><div class="room-code"><span>${state.players.some((p) => p.bot) ? 'YOU + 3 BOTS' : state.code}</span>${state.players.some((p) => p.bot) ? '' : button('copy', 'Copy invite ↗', 'quiet')}</div><p class="muted">${escape(state.notice || 'Share this code or link. Everyone must be ready before launch.')}</p><div class="roster">${state.players.map((p) => `<div class="pilot"><span class="swatch" style="background:${p.color}"></span><span><strong>${escape(p.name)}${p.bot ? ' · BOT' : ''}${p.id === state!.hostId ? ' · HOST' : ''}${p.id === room!.sessionId ? ' · YOU' : ''}</strong><small>${CHASSIS[p.chassis].name} · ${WEAPONS[p.front].name} / ${WEAPONS[p.top].name}</small></span><b class="${p.ready ? 'ready' : 'muted'}">${p.ready ? 'READY' : 'WAITING'}</b></div>`).join('')}</div><div class="actions">${button('ready', me?.ready ? 'Cancel ready' : 'Ready up', 'primary')}${state.hostId === room.sessionId ? button('start', 'Launch round →', '', state.players.length < 2 || !state.players.every((p) => p.ready)) : '<p class="muted">The host launches the round.</p>'}${button('garage', 'Change loadout', 'quiet')}${button('leave', 'Leave room', 'quiet')}</div>`;
  }
  if (screen === 'help') content = `${help()}${button('home', 'Back to home', 'primary')}`;
  if (screen === 'settings')
    content = `${settingsForm(settings)}${button('home', 'Done', 'primary')}${button('rename', 'Change nickname', 'quiet')}`;
  return `<header><a href="#" data-action="${room ? 'lobby' : 'home'}" class="brand"><span class="brand-icon">R/</span> ROOFTOP<span class="brand-sub">REARMED</span></a><nav>${nickname ? `<span class="pilot-name">${escape(nickname)}</span>${button('settings', 'Settings', 'quiet')}` : ''}<span class="connection ${online ? 'connected' : ''}">${online ? '● SERVER ONLINE' : '○ SERVER OFFLINE'}</span></nav></header><section class="shell ${screen === 'garage' ? 'garage' : ''}"><div class="panel">${error ? `<p class="notice" role="alert">${escape(error)}</p>` : ''}${content}</div><aside class="machine-caption">${tag(`${CHASSIS[chassis].name} / ${CHASSIS[chassis].role}`)}<p>SCRAP-BUILT.<br>BATTLE-READY.</p><span>FRONT / ${WEAPONS[front].name.toUpperCase()}<br>TOP / ${WEAPONS[top].name.toUpperCase()}</span></aside></section><footer><span>INDUSTRIAL VIOLENCE, ELEVATED.</span><span>SECTOR 07 &nbsp; / &nbsp; ROOFTOP ARENA</span></footer>`;
}
