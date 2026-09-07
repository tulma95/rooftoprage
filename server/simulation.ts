import { ARENA_HALF, ROBOT_RADIUS, ROUND_SECONDS, WEAPONS, FRONT_RULES, PROJECTILE_RULES, EMPTY_INPUT, drive, type Input, type PlayerState, type RoomState } from '../shared/game.js';
import { botInput } from './bots.js';
export class Simulation {
  state: RoomState = { code: '', hostId: '', phase: 'lobby', players: [], projectiles: [], events: [], winnerId: null, draw: false, remaining: ROUND_SECONDS, countdown: 3, notice: '', round: 0 };
  inputs = new Map<string, { input: Input; time: number }>();
  time = 0; serial = 0;
  event(type: 'hit' | 'elimination' | 'shot', p: PlayerState, attackerId?: string, reason?: string) {
    this.state.events.push({ id: ++this.serial, type, playerId: p.id, attackerId, reason, x: p.x, z: p.z });
    this.state.events = this.state.events.slice(-24);
  }
  start() {
    const s = this.state; s.round++; s.remaining = ROUND_SECONDS; s.winnerId = null; s.draw = false; s.events = []; s.projectiles = []; s.countdown = 3; this.inputs.clear();
    s.players.forEach((p, i) => { const a = i * Math.PI * 2 / s.players.length; Object.assign(p, { x: Math.sin(a) * 12, z: Math.cos(a) * 12, yaw: a + Math.PI, hp: 100, alive: true, loaded: !!p.bot, frontCooldown: 0, topCooldown: 0, heat: 0, overheated: false, frontActive: false, topActive: false, stats: { damage: 0, kills: 0, shots: 0 } }); });
  }
  eliminate(p: PlayerState, reason: string, attackerId?: string) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.frontActive = p.topActive = false; this.inputs.delete(p.id); this.event('elimination', p, attackerId, reason);
    const attacker = this.state.players.find(a => a.id === attackerId); if (attacker) attacker.stats.kills++;
  }
  damage(p: PlayerState, amount: number, attacker: PlayerState) {
    if (!p.alive) return;
    attacker.stats.damage += Math.min(p.hp, amount); p.hp = Math.max(0, p.hp - amount); this.event('hit', p, attacker.id);
  }
  finishIfNeeded() {
    const s = this.state; const alive = s.players.filter(p => p.alive);
    if (s.phase === 'combat' && (alive.length <= 1 || s.remaining <= 0)) { s.phase = 'results'; s.draw = alive.length !== 1; s.winnerId = s.draw ? null : alive[0]!.id; this.inputs.clear(); }
  }
  step(dt: number) {
    this.time += dt; const s = this.state; if (s.phase !== 'combat') return;
    s.remaining = Math.max(0, s.remaining - dt);
    const active = s.players.filter(p => p.alive); const lastAttacker = new Map<string, string>();
    for (const p of active) {
      const stored = this.inputs.get(p.id); const input = p.bot ? botInput(p, active) : stored && this.time - stored.time < .3 ? stored.input : EMPTY_INPUT;
      drive(p, input, dt); p.frontCooldown = Math.max(0, p.frontCooldown - dt); p.topCooldown = Math.max(0, p.topCooldown - dt);
      p.frontActive = input.front && p.frontCooldown === 0; p.topActive = input.top && p.topCooldown === 0 && !p.overheated;
      if (p.top === 'flamethrower') { p.heat = Math.max(0, Math.min(1, p.heat + (p.topActive ? dt / 3 : -dt / 4))); if (p.heat >= 1) p.overheated = true; if (p.heat === 0) p.overheated = false; }
      if (p.frontActive) p.frontCooldown = WEAPONS[p.front].cooldown;
      if (p.topActive && p.top !== 'flamethrower') {
        p.topCooldown = WEAPONS[p.top].cooldown; p.stats.shots++;
        for (const angle of PROJECTILE_RULES[p.top].angles) {
          s.projectiles.push({ id: ++this.serial, ownerId: p.id, weapon: p.top, hitIds: [], x: p.x + Math.sin(p.yaw) * 1.7, z: p.z + Math.cos(p.yaw) * 1.7, yaw: p.yaw + angle, distance: 0 });
        }
        this.event('shot', p);
      }
    }
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!, b = active[j]!; const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz); if (d < ROBOT_RADIUS * 2) { const nx = d > .001 ? dx / d : 1, nz = d > .001 ? dz / d : 0, overlap = (ROBOT_RADIUS * 2 - d) / 2; a.x -= nx * overlap; a.z -= nz * overlap; b.x += nx * overlap; b.z += nz * overlap; }
    }
    for (const a of active) for (const b of active) {
      if (a === b) continue; const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz); const aim = (dx * Math.sin(a.yaw) + dz * Math.cos(a.yaw)) / Math.max(.001, d);
      const frontRules = FRONT_RULES[a.front];
      if (a.frontActive && d <= WEAPONS[a.front].range && aim > frontRules.aim) {
        this.damage(b, WEAPONS[a.front].damage * (frontRules.continuous ? dt : 1), a); lastAttacker.set(b.id, a.id);
        b.x += Math.sin(a.yaw) * frontRules.push; b.z += Math.cos(a.yaw) * frontRules.push;
      }
      if (a.topActive && a.top === 'flamethrower' && d < WEAPONS.flamethrower.range && aim > .82) { this.damage(b, WEAPONS.flamethrower.damage * dt, a); lastAttacker.set(b.id, a.id); }
    }
    s.projectiles = s.projectiles.filter(q => {
      const rule = PROJECTILE_RULES[q.weapon], weapon = WEAPONS[q.weapon];
      const oldX = q.x, oldZ = q.z;
      // Clamp the swept segment at range, so fast bolts cannot hit beyond it.
      const length = Math.min(rule.speed * dt, weapon.range - q.distance);
      if (length <= 0) return false;
      const dx = Math.sin(q.yaw) * length, dz = Math.cos(q.yaw) * length;
      q.x += dx; q.z += dz; q.distance += length;
      const hits = active.flatMap(p => {
        if (p.id === q.ownerId || q.hitIds.includes(p.id)) return [];
        // Ray-circle entry distance orders hits physically, independent of roster.
        const ox = p.x - oldX, oz = p.z - oldZ;
        const along = (ox * dx + oz * dz) / length;
        const perpendicularSq = ox * ox + oz * oz - along * along;
        if (perpendicularSq > ROBOT_RADIUS * ROBOT_RADIUS) return [];
        const halfChord = Math.sqrt(Math.max(0, ROBOT_RADIUS * ROBOT_RADIUS - perpendicularSq));
        const entry = Math.max(0, along - halfChord);
        return along + halfChord >= 0 && entry <= length ? [{ player: p, entry }] : [];
      }).sort((a, b) => a.entry - b.entry);
      const attacker = s.players.find(p => p.id === q.ownerId);
      if (attacker) for (const hit of hits) {
        this.damage(hit.player, weapon.damage, attacker); lastAttacker.set(hit.player.id, attacker.id); q.hitIds.push(hit.player.id);
        if (!rule.piercing) return false;
      }
      return q.distance < weapon.range;
    });
    for (const p of active) { if (p.hp <= 0) this.eliminate(p, 'destroyed', lastAttacker.get(p.id)); else if (Math.abs(p.x) > ARENA_HALF || Math.abs(p.z) > ARENA_HALF) this.eliminate(p, 'fell off the roof', lastAttacker.get(p.id)); }
    this.finishIfNeeded();
  }
}
