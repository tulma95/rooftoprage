import {
  CHASSIS,
  BOOST_COOLDOWN,
  WEAPONS,
  WEAPON_ICONS,
  type RoomState,
  type PlayerState,
} from '../shared/game.js';
import { button, escape, tag } from './html.js';

export interface HudView {
  state: RoomState;
  sessionId: string;
  watched?: PlayerState;
  unstable: boolean;
  message: string;
}

/** Fills the cooldown ring on the matching touch button (0 = just used, 1 = ready). */
function touchReady(slot: string, ready: number) {
  const button = document.querySelector<HTMLElement>(`[data-touch="${slot}"]`);
  if (!button) return;
  ready = Math.min(1, Math.max(0, ready));
  button.style.setProperty('--ready', String(ready));
  // A short buzz when a cooldown finishes, so readiness can be felt without looking.
  if (ready >= 1 && button.classList.contains('cooling')) navigator.vibrate?.(8);
  button.classList.toggle('ready', ready >= 1);
  button.classList.toggle('cooling', ready < 1);
}

/** Persistent controls and meters; structural sections update only when their content changes. */
export class BattleHud {
  private rosterSignature = '';
  private weaponSignature = '';
  private loadingSignature = '';
  private resultsSignature = '';
  private aim = document.createElement('span');

  constructor(readonly element: HTMLElement) {
    element.innerHTML = `
      <div class="hud-roster glass"></div>
      <div class="hud-timer glass"><strong></strong><span></span><div class="pips"></div></div>
      <div class="hud-menu">${button('menu', 'Menu / Esc')}<span class="connection"></span></div>
      <div class="hud-health glass"><span class="eyebrow"></span><strong><span></span> <small></small></strong><div class="meter"><i></i></div></div>
      <div class="hud-weapons"></div>
      <div class="spectator glass"><b>ELIMINATED · SPECTATING</b>${button('spectate', 'Next survivor →')}${button('leave', 'Leave match', 'quiet')}</div>
      <p class="combat-message" aria-live="polite"></p>
      <div class="center-card glass"></div>
      <div class="countdown-label">ENGINES ON. STAY ON THE ROOF.</div>
      <section class="results glass"></section>
      <div class="cinematic-caption"><span>FINAL ELIMINATION</span>${button('skip-cinematic', 'Skip cinematic')}</div>`;
    this.aim.id = 'aim';
    this.aim.setAttribute('aria-hidden', 'true');
    this.aim.textContent = '⊹';
  }

  private node(selector: string): HTMLElement {
    return this.element.querySelector<HTMLElement>(selector)!;
  }
  private text(selector: string, value: string | number) {
    const node = this.node(selector),
      text = String(value);
    if (node.textContent !== text) node.textContent = text;
  }
  private visible(selector: string, visible: boolean) {
    this.node(selector).style.display = visible ? '' : 'none';
  }

  update({ state: s, sessionId, watched: p, unstable, message }: HudView) {
    const spectator = !s.players.find((player) => player.id === sessionId)?.alive;
    const roster = JSON.stringify(
      s.players.map(({ id, name, color, alive }) => [id, name, color, alive]),
    );
    if (roster !== this.rosterSignature) {
      this.rosterSignature = roster;
      this.node('.hud-roster').innerHTML = s.players
        .map(
          (player) =>
            `<div><span class="swatch" style="background:${player.color}"></span><span>${escape(player.name)}</span><small>${player.alive ? 'ALIVE' : 'OUT'}</small></div>`,
        )
        .join('');
      this.node('.pips').innerHTML = s.players
        .map(
          (player) =>
            `<span class="pip${player.alive ? '' : ' out'}${player.id === sessionId ? ' me' : ''}"><i style="background:${player.color}"></i></span>`,
        )
        .join('');
    }
    this.element.querySelectorAll<HTMLElement>('.pips i').forEach((bar, i) => {
      const player = s.players[i];
      if (player) bar.style.width = `${Math.max(0, player.hp / CHASSIS[player.chassis].hp) * 100}%`;
    });
    const seconds = Math.ceil(s.remaining);
    this.text(
      '.hud-timer strong',
      s.phase === 'loading'
        ? 'LOADING'
        : s.phase === 'countdown'
          ? Math.ceil(s.countdown)
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    );
    this.text(
      '.hud-timer span',
      `${s.players.filter((player) => player.alive).length} of ${s.players.length} remaining`,
    );
    this.text('.connection', unstable ? '⚠ CONNECTION UNSTABLE' : '● CONNECTED');
    this.node('.connection').classList.toggle('connected', !unstable);
    this.visible('.hud-health', !!p);
    this.visible('.hud-weapons', !!p);
    if (p) {
      const maxHp = CHASSIS[p.chassis].hp;
      this.text('.hud-health .eyebrow', spectator ? `Spectating / ${p.name}` : p.name);
      this.text('.hud-health strong span', Math.ceil(p.hp));
      this.text('.hud-health strong small', `/ ${maxHp} HP`);
      this.node('.hud-health').classList.toggle('low-health', p.hp < maxHp * 0.3);
      this.node('.hud-health').classList.toggle(
        'mid-health',
        p.hp >= maxHp * 0.3 && p.hp < maxHp * 0.6,
      );
      this.node('.hud-health .meter i').style.width = `${(p.hp / maxHp) * 100}%`;
      const weapons = `${p.front}/${p.top}/${spectator}`;
      if (weapons !== this.weaponSignature) {
        this.weaponSignature = weapons;
        for (const slot of ['front', 'top'] as const) {
          const icon = document.querySelector(`[data-touch="${slot}"] b`);
          if (icon) icon.textContent = WEAPON_ICONS[p[slot]];
        }
        this.node('.hud-weapons').innerHTML =
          (['front', 'top'] as const)
            .map(
              (slot) =>
                `<div class="weapon-hud" data-slot="${slot}">${tag(slot)}<strong><span aria-hidden="true">${WEAPON_ICONS[p[slot]]}</span>${WEAPONS[p[slot]].name} ${spectator ? '' : `<kbd>${slot === 'front' ? 'Space' : 'E'}</kbd>`}</strong><small></small><div class="meter"><i></i></div></div>`,
            )
            .join('') +
          `<div class="weapon-hud burst-hud" data-slot="boost">${tag('Movement')}<strong>Short burst ${spectator ? '' : '<kbd>Shift</kbd>'}</strong><small></small><div class="meter"><i></i></div></div>`;
      }
      const boostCooldown = p.boostCooldown ?? 0;
      this.text(
        '[data-slot="boost"] small',
        (p.boostRemaining ?? 0) > 0
          ? 'BURSTING'
          : boostCooldown > 0
            ? `RECHARGING · ${boostCooldown.toFixed(1)}s`
            : 'READY · MOVE + SHIFT',
      );
      this.node('[data-slot="boost"] .meter i').style.width =
        `${Math.max(0, 1 - boostCooldown / BOOST_COOLDOWN) * 100}%`;
      touchReady('boost', 1 - boostCooldown / BOOST_COOLDOWN);
      for (const slot of ['front', 'top'] as const) {
        const key = p[slot],
          cooldown = slot === 'front' ? p.frontCooldown : p.topCooldown;
        const active = slot === 'front' ? p.frontActive : p.topActive;
        const heat = key === 'flamethrower';
        this.text(
          `[data-slot="${slot}"] small`,
          heat && p.overheated
            ? 'OVERHEATED'
            : active
              ? 'ACTIVE'
              : cooldown > 0
                ? 'COOLING DOWN'
                : 'READY',
        );
        const spent = heat ? p.heat : cooldown / (WEAPONS[key].cooldown || 1);
        this.node(`[data-slot="${slot}"] .meter i`).style.width = `${Math.min(100, spent * 100)}%`;
        touchReady(slot, 1 - spent);
      }
    }
    this.visible('.spectator', spectator && s.phase === 'combat');
    if (!spectator && s.phase === 'combat') {
      if (!this.aim.isConnected) this.element.append(this.aim);
    } else this.aim.remove();
    this.text('.combat-message', message);
    this.visible('.center-card', s.phase === 'loading');
    if (s.phase === 'loading') {
      const loading = JSON.stringify(s.players.map(({ name, loaded }) => [name, loaded]));
      if (loading !== this.loadingSignature) {
        this.loadingSignature = loading;
        this.node('.center-card').innerHTML =
          `<h2>Preparing the rooftop</h2>${s.players.map((player) => `<p>${escape(player.name)} · ${player.loaded ? 'LOADED' : 'LOADING'}</p>`).join('')}`;
      }
    }
    this.visible('.countdown-label', s.phase === 'countdown');
    this.visible('.results', s.phase === 'results');
    if (s.phase === 'results') {
      const results = JSON.stringify([
        s.round,
        s.winnerId,
        s.draw,
        s.hostId === sessionId,
        s.players.map(({ name, stats }) => [name, stats]),
      ]);
      if (results !== this.resultsSignature) {
        this.resultsSignature = results;
        this.node('.results').innerHTML =
          `${tag(`Round ${s.round} complete`)}<h1>${s.draw ? 'DRAW' : s.winnerId === sessionId ? 'VICTORY' : 'ELIMINATED'}</h1><p>${s.draw ? 'No single survivor. The roof wins.' : `${escape(s.players.find((player) => player.id === s.winnerId)?.name || 'Unknown pilot')} is the last robot standing.`}</p><table><thead><tr><th>Pilot</th><th>Damage</th><th>KOs</th><th>Shots</th></tr></thead><tbody>${s.players.map((player) => `<tr><td>${escape(player.name)}</td><td>${Math.round(player.stats.damage)}</td><td>${player.stats.kills}</td><td>${player.stats.shots}</td></tr>`).join('')}</tbody></table><div class="actions">${s.hostId === sessionId ? button('again', 'Play again', 'primary') : '<p class="muted">The host starts the next round.</p>'}${button('results-garage', 'Return to garage')}</div>`;
      }
    }
  }
}
