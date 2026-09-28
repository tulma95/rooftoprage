import {
  CHASSIS,
  BOOST_COOLDOWN,
  WEAPONS,
  type GameEvent,
  type RoomState,
  type PlayerState,
} from '../shared/game.js';
import { button, escape, icon, tag } from './html.js';

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

/** Places a feathered red glow on the screen edge facing the attacker (0 rad = ahead). */
function edgeGlow(angle: number) {
  const x = Math.sin(angle),
    y = -Math.cos(angle),
    k = 50 / Math.max(Math.abs(x), Math.abs(y));
  return `--x:${50 + x * k}%;--y:${50 + y * k}%`;
}

/** Appends a self-removing element; CSS animations drive all the motion. */
function transient(parent: Element, html: string, ms: number, style = '') {
  const node = document.createElement('div');
  node.innerHTML = html;
  const child = node.firstElementChild as HTMLElement;
  child.style.cssText = style;
  parent.append(child);
  setTimeout(() => child.remove(), ms);
  return child;
}

/** Persistent controls and meters; structural sections update only when their content changes. */
export class BattleHud {
  private rosterSignature = '';
  private weaponSignature = '';
  private loadingSignature = '';
  private resultsSignature = '';
  private countdownShown = '';
  private phase = '';
  private hp = new Map<string, number>();
  private aim = document.createElement('span');

  constructor(readonly element: HTMLElement) {
    element.innerHTML = `
      <div class="vignette" aria-hidden="true"><i></i></div>
      <div class="hud-roster glass"></div>
      <div class="hud-timer glass"><strong></strong><span></span><div class="pips"></div></div>
      <div class="hud-menu">${button('menu', 'Menu / Esc')}<span class="connection"></span></div>
      <ol class="kill-feed" aria-label="Kill feed"></ol>
      <div class="popups" aria-hidden="true"></div>
      <div class="hud-health glass"><span class="eyebrow"></span><strong><span></span> <small></small></strong><div class="meter"><b></b><i></i></div></div>
      <div class="hud-weapons"></div>
      <div class="spectator glass"><b>ELIMINATED · SPECTATING</b>${button('spectate', 'Next survivor →')}${button('leave', 'Leave match', 'quiet')}</div>
      <p class="combat-message" aria-live="polite"></p>
      <div class="center-card glass"></div>
      <div class="countdown" aria-hidden="true"></div>
      <div class="countdown-label">ENGINES ON. STAY ON THE ROOF.</div>
      <section class="results"></section>
      <div class="cinematic-caption"><span>FINAL ELIMINATION</span>${button('skip-cinematic', 'Skip cinematic')}</div>`;
    this.aim.id = 'aim';
    this.aim.setAttribute('aria-hidden', 'true');
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

  /** Feeds fresh server events: kill feed, damage popups, hurt flash and hit direction. */
  events(fresh: GameEvent[], s: RoomState, sessionId: string, watched?: PlayerState) {
    const name = (id?: string) => s.players.find((p) => p.id === id);
    for (const e of fresh) {
      const victim = name(e.playerId),
        attacker = name(e.attackerId);
      if (e.type === 'elimination' && victim) {
        const feed = this.node('.kill-feed');
        const who = (p: PlayerState) =>
          `<b class="${p.id === sessionId ? 'me' : ''}" style="--c:${p.color}">${escape(p.name)}</b>`;
        transient(
          feed,
          `<li class="${e.playerId === sessionId || e.attackerId === sessionId ? 'mine' : ''}">${attacker && attacker !== victim ? `${who(attacker)}<span class="how">${e.reason === 'destroyed' ? '✖' : '⤓'}</span>` : `<span class="how">${e.reason === 'destroyed' ? '✖' : '⤓'}</span>`}${who(victim)}<small>${escape(e.reason === 'destroyed' ? '' : (e.reason ?? ''))}</small></li>`,
          6000,
        );
        while (feed.children.length > 5) feed.firstElementChild!.remove();
      }
      if (e.type !== 'hit' || !victim) continue;
      const lost = Math.round((this.hp.get(victim.id) ?? victim.hp) - victim.hp);
      this.hp.set(victim.id, victim.hp);
      if (e.attackerId === sessionId && lost > 0) {
        const x = parseFloat(this.aim.style.left) || innerWidth / 2,
          y = parseFloat(this.aim.style.top) || innerHeight / 2;
        this.aim.classList.remove('hit');
        void this.aim.offsetWidth; // restart the hit-marker animation
        this.aim.classList.add('hit');
        transient(
          this.node('.popups'),
          `<span class="dmg${victim.hp <= 0 ? ' kill' : lost >= 20 ? ' big' : ''}">${lost}</span>`,
          900,
          `left:${x + (Math.random() - 0.5) * 60}px;top:${y - 24}px`,
        );
      }
      if (watched && e.playerId === watched.id && watched.id === sessionId) {
        const v = this.node('.vignette');
        v.style.setProperty('--hurt', String(Math.min(1, 0.35 + Math.max(lost, 4) / 30)));
        v.classList.remove('hurt');
        void v.offsetWidth;
        v.classList.add('hurt');
        const from = attacker && attacker !== victim ? attacker : e;
        const dx = from.x - watched.x,
          dz = from.z - watched.z;
        if (Math.hypot(dx, dz) > 0.5) {
          const f = dx * Math.sin(watched.yaw) + dz * Math.cos(watched.yaw),
            r = -dx * Math.cos(watched.yaw) + dz * Math.sin(watched.yaw);
          transient(
            this.node('.popups'),
            '<span class="hit-dir"></span>',
            700,
            edgeGlow(Math.atan2(r, f)),
          );
        }
      }
    }
  }

  update({ state: s, sessionId, watched: p, unstable, message }: HudView) {
    if (this.element.dataset.phase !== s.phase) this.element.dataset.phase = s.phase;
    const spectator = !s.players.find((player) => player.id === sessionId)?.alive;
    for (const player of s.players) this.hp.set(player.id, player.hp);
    const roster = JSON.stringify(
      s.players.map(({ id, name, color, alive }) => [id, name, color, alive]),
    );
    if (roster !== this.rosterSignature) {
      this.rosterSignature = roster;
      this.node('.hud-roster').innerHTML = s.players
        .map(
          (player) =>
            `<div class="${player.alive ? '' : 'out'}${player.id === sessionId ? ' me' : ''}" style="--c:${player.color}"><span class="swatch"></span><span class="who">${escape(player.name)}</span><small>${player.alive ? 'ALIVE' : 'OUT'}</small><i class="hp"><b></b></i></div>`,
        )
        .join('');
      this.node('.pips').innerHTML = s.players
        .map(
          (player) =>
            `<span class="pip${player.alive ? '' : ' out'}${player.id === sessionId ? ' me' : ''}"><i style="background:${player.color}"></i></span>`,
        )
        .join('');
    }
    this.element.querySelectorAll<HTMLElement>('.pips i, .hud-roster .hp b').forEach((bar, i) => {
      const player = s.players[i % s.players.length];
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
    this.node('.hud-timer').classList.toggle('urgent', s.phase === 'combat' && seconds <= 30);
    this.text(
      '.hud-timer span',
      `${s.players.filter((player) => player.alive).length} of ${s.players.length} remaining`,
    );
    this.text('.connection', unstable ? '⚠ CONNECTION UNSTABLE' : '● CONNECTED');
    this.node('.connection').classList.toggle('connected', !unstable);
    this.visible('.hud-health', !!p);
    this.visible('.hud-weapons', !!p);
    const vignette = this.node('.vignette');
    if (p) {
      const maxHp = CHASSIS[p.chassis].hp,
        ratio = Math.max(0, p.hp / maxHp);
      const health = this.node('.hud-health');
      this.text('.hud-health .eyebrow', spectator ? `Spectating / ${p.name}` : p.name);
      this.text('.hud-health strong span', Math.ceil(p.hp));
      this.text('.hud-health strong small', `/ ${maxHp} HP`);
      health.classList.toggle('low-health', ratio < 0.3);
      health.classList.toggle('mid-health', ratio >= 0.3 && ratio < 0.6);
      health.style.setProperty('--segments', String(Math.round(maxHp / 20)));
      this.node('.hud-health .meter i').style.width = `${ratio * 100}%`;
      this.node('.hud-health .meter b').style.width = `${ratio * 100}%`;
      vignette.classList.toggle('critical', !spectator && ratio < 0.3 && s.phase === 'combat');
      const weapons = `${p.front}/${p.top}/${spectator}`;
      if (weapons !== this.weaponSignature) {
        this.weaponSignature = weapons;
        for (const [slot, key] of [
          ['front', p.front],
          ['top', p.top],
          ['boost', 'burst'],
        ]) {
          const glyph = document.querySelector(`[data-touch="${slot}"] b`);
          if (glyph) glyph.innerHTML = icon(key!);
        }
        const card = (slot: string, label: string, glyph: string, title: string, key: string) =>
          `<div class="weapon-hud" data-slot="${slot}"><span class="ring" aria-hidden="true">${icon(glyph)}</span><div>${tag(label)}<strong>${title}</strong><small></small></div>${spectator ? '' : `<kbd>${key}</kbd>`}</div>`;
        this.node('.hud-weapons').innerHTML =
          (['front', 'top'] as const)
            .map((slot) =>
              card(slot, slot, p[slot], WEAPONS[p[slot]].name, slot === 'front' ? 'Space' : 'E'),
            )
            .join('') + card('boost', 'Movement', 'burst', 'Short burst', 'Shift');
      }
      const ready = (slot: string, value: number, label: string, seconds = 0) => {
        value = Math.min(1, Math.max(0, value));
        const card = this.node(`[data-slot="${slot}"]`);
        const sec = seconds > 0 ? seconds.toFixed(seconds < 10 ? 1 : 0) : '';
        const ring = card.querySelector<HTMLElement>('.ring')!;
        if (ring.dataset.sec !== sec) ring.dataset.sec = sec;
        card.style.setProperty('--ready', value.toFixed(3));
        card.classList.toggle('ready', value >= 1);
        this.text(`[data-slot="${slot}"] small`, label);
        touchReady(slot, value);
      };
      const boostCooldown = p.boostCooldown ?? 0;
      ready(
        'boost',
        1 - boostCooldown / BOOST_COOLDOWN,
        (p.boostRemaining ?? 0) > 0 ? 'BURSTING' : boostCooldown > 0 ? 'RECHARGING' : 'READY',
        boostCooldown,
      );
      for (const slot of ['front', 'top'] as const) {
        const key = p[slot],
          cooldown = slot === 'front' ? p.frontCooldown : p.topCooldown;
        const active = slot === 'front' ? p.frontActive : p.topActive;
        const heat = key === 'flamethrower';
        const node = this.node(`[data-slot="${slot}"]`);
        node.classList.toggle('active', active);
        node.classList.toggle('hot', heat && p.overheated);
        ready(
          slot,
          1 - (heat ? p.heat : cooldown / (WEAPONS[key].cooldown || 1)),
          heat && p.overheated
            ? 'OVERHEATED'
            : active
              ? 'FIRING'
              : cooldown > 0
                ? 'COOLING'
                : heat && p.heat > 0
                  ? `HEAT ${Math.round(p.heat * 100)}%`
                  : 'READY',
          heat ? 0 : cooldown,
        );
      }
    } else vignette.classList.remove('critical');
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
          `${tag('Stand by')}<h2>Preparing the rooftop</h2>${s.players.map((player) => `<p class="${player.loaded ? 'loaded' : ''}"><span class="swatch" style="background:${player.color}"></span>${escape(player.name)}<b>${player.loaded ? 'LOADED' : 'LOADING'}</b></p>`).join('')}`;
      }
    }
    // Big stylized countdown; each new number is a fresh node so its slam animation replays.
    const count = s.phase === 'countdown' ? String(Math.ceil(s.countdown)) : '';
    if (count !== this.countdownShown) {
      this.countdownShown = count;
      this.node('.countdown').innerHTML = count ? `<b>${count}</b>` : '';
    }
    if (s.phase === 'combat' && this.phase === 'countdown')
      transient(this.node('.countdown'), '<b class="go">FIGHT</b>', 1100);
    this.phase = s.phase;
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
        const ranked = [...s.players].sort(
          (a, b) =>
            Number(b.id === s.winnerId) - Number(a.id === s.winnerId) ||
            Number(b.alive) - Number(a.alive) ||
            b.stats.kills - a.stats.kills ||
            b.stats.damage - a.stats.damage,
        );
        const outcome = s.draw ? 'draw' : s.winnerId === sessionId ? 'victory' : 'defeat';
        this.node('.results').innerHTML =
          `<div class="results-card ${outcome}">${tag(`Round ${s.round} complete`)}<h1 data-text="${s.draw ? 'DRAW' : s.winnerId === sessionId ? 'VICTORY' : 'ELIMINATED'}">${s.draw ? 'DRAW' : s.winnerId === sessionId ? 'VICTORY' : 'ELIMINATED'}</h1><p class="verdict">${s.draw ? 'No single survivor. The roof wins.' : `<b>${escape(s.players.find((player) => player.id === s.winnerId)?.name || 'Unknown pilot')}</b> is the last robot standing.`}</p><table><thead><tr><th>#</th><th>Pilot</th><th>Damage</th><th>KOs</th><th>Shots</th></tr></thead><tbody>${ranked.map((player, i) => `<tr class="${player.id === s.winnerId ? 'winner' : ''}${player.id === sessionId ? ' me' : ''}" style="--i:${i};--c:${player.color}"><td class="rank">${i + 1}</td><td><span class="swatch"></span>${escape(player.name)}</td><td>${Math.round(player.stats.damage)}</td><td>${player.stats.kills}</td><td>${player.stats.shots}</td></tr>`).join('')}</tbody></table><div class="actions">${s.hostId === sessionId ? button('again', 'Play again', 'primary') : '<p class="muted">The host starts the next round.</p>'}${button('results-garage', 'Return to garage')}</div></div>`;
      }
    }
  }
}
