import { makeHazards, driveTerrain, within, OIL_SLICKS, COOLING_POOLS, HAZARD_RULES as H } from '../shared/hazards.js';
import { ARENA_HALF, CHASSIS, ROBOT_RADIUS, ROUND_SECONDS, WEAPONS, FRONT_RULES, PROJECTILE_RULES, EMPTY_INPUT, type Input, type PlayerState, type RoomState } from '../shared/game.js';
import { botInput } from './bots.js';
export class Simulation {
  state: RoomState = { code: '', hostId: '', phase: 'lobby', ...makeHazards(), players: [], projectiles: [], events: [], winnerId: null, draw: false, remaining: ROUND_SECONDS, countdown: 3, notice: '', round: 0 };
  inputs = new Map<string, { input: Input; time: number }>();
  time = 0; serial = 0;
  event(type: 'hit' | 'elimination' | 'shot', p: PlayerState, attackerId?: string, reason?: string) {
    this.state.events.push({ id: ++this.serial, type, playerId: p.id, attackerId, reason, x: p.x, z: p.z });
    this.state.events = this.state.events.slice(-24);
  }
  start() {
    const s = this.state; Object.assign(s, makeHazards()); s.round++; s.remaining = ROUND_SECONDS; s.winnerId = null; s.draw = false; s.events = []; s.projectiles = []; s.countdown = 3; this.inputs.clear();
    s.players.forEach((p, i) => { const a = i * Math.PI * 2 / s.players.length; Object.assign(p, { x: Math.sin(a) * 12, z: Math.cos(a) * 12, yaw: a + Math.PI, hp: CHASSIS[p.chassis].hp, alive: true, burning: 0, burnAttackerId: undefined, loaded: !!p.bot, frontCooldown: 0, topCooldown: 0, heat: 0, overheated: false, frontActive: false, topActive: false, stats: { damage: 0, kills: 0, shots: 0 } }); });
  }
  eliminate(p: PlayerState, reason: string, attackerId?: string) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.frontActive = p.topActive = false; this.inputs.delete(p.id); this.event('elimination', p, attackerId, reason);
    const attacker = this.state.players.find(a => a.id === attackerId); if (attacker && attacker !== p) attacker.stats.kills++;
  }
  damage(p: PlayerState, amount: number, attacker: PlayerState) {
    if (!p.alive) return;
    if (attacker !== p) attacker.stats.damage += Math.min(p.hp, amount); p.hp = Math.max(0, p.hp - amount); this.event('hit', p, attacker.id);
  }
  finishIfNeeded() {
    const s = this.state; const alive = s.players.filter(p => p.alive);
    if (s.phase === 'combat' && (alive.length <= 1 || s.remaining <= 0)) { s.phase = 'results'; s.draw = alive.length !== 1; s.winnerId = s.draw ? null : alive[0]!.id; this.inputs.clear(); }
  }
  step(dt: number) {
    this.time += dt; const s = this.state; if (s.phase !== 'combat') return;
    s.remaining = Math.max(0, s.remaining - dt);
    const active = s.players.filter(p => p.alive); const lastAttacker = new Map<string, string>();
    const hurt = (p: PlayerState, amount: number, attackerId?: string) => {
      if (p.hp <= 0) return;
      const attacker = s.players.find(a => a.id === attackerId);
      if (attacker) this.damage(p, amount, attacker); else { p.hp = Math.max(0, p.hp - amount); this.event('hit', p); }
      if (attackerId) lastAttacker.set(p.id, attackerId);
    };
    const explode = (tank: typeof s.tanks[number], attackerId?: string) => {
      if (tank.hp <= 0) return;
      tank.hp = 0;
      s.events.push({ id: ++this.serial, type: 'explosion', playerId: tank.id, attackerId, x: tank.x, z: tank.z });
      s.events = s.events.slice(-24);
      for (const p of active) { const d = Math.hypot(p.x-tank.x,p.z-tank.z); if (d < H.blastRadius) hurt(p,H.blastDamage * (1-.5*d/H.blastRadius),attackerId); }
      OIL_SLICKS.forEach((oil,i) => { if (Math.hypot(oil.x-tank.x,oil.z-tank.z) < H.blastRadius+oil.radius && s.oil[i]!.burning <= 0) Object.assign(s.oil[i]!, { burning: H.oilBurnSeconds, attackerId }); });
      for (const other of s.tanks) if (other.hp > 0 && Math.hypot(other.x-tank.x,other.z-tank.z) < H.blastRadius) explode(other,attackerId);
    };
    const hitTank = (tank: typeof s.tanks[number], amount: number, attackerId: string) => {
      if (tank.hp <= 0) return;
      if (tank.hp <= amount) explode(tank,attackerId); else tank.hp -= amount;
    };
    for (const oil of s.oil) oil.burning = Math.max(0,oil.burning-dt);
    for (const p of active) {
      const stored = this.inputs.get(p.id); const input = p.bot ? botInput(p, active) : stored && this.time - stored.time < .3 ? stored.input : EMPTY_INPUT;
      driveTerrain(p, input, dt); p.frontCooldown = Math.max(0, p.frontCooldown - dt); p.topCooldown = Math.max(0, p.topCooldown - dt);
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
    for (const p of active) {
      for (const tank of s.tanks) {
        if (tank.hp <= 0) continue;
        let dx=p.x-tank.x, dz=p.z-tank.z, d=Math.hypot(dx,dz);
        if (d < ROBOT_RADIUS+H.tankRadius) { if (d < .001) { dx=1; dz=0; d=1; } const gap=ROBOT_RADIUS+H.tankRadius; p.x=tank.x+dx/d*gap; p.z=tank.z+dz/d*gap; }
        dx=tank.x-p.x; dz=tank.z-p.z; d=Math.hypot(dx,dz);
        const aim=(dx*Math.sin(p.yaw)+dz*Math.cos(p.yaw))/Math.max(.001,d);
        if (p.frontActive && d < WEAPONS[p.front].range && aim > FRONT_RULES[p.front].aim) hitTank(tank,WEAPONS[p.front].damage*(FRONT_RULES[p.front].continuous?dt:1),p.id);
        if (p.topActive && p.top==='flamethrower' && d < WEAPONS.flamethrower.range && aim > .82) hitTank(tank,WEAPONS.flamethrower.damage*dt,p.id);
      }
      if (p.topActive && p.top==='flamethrower') OIL_SLICKS.forEach((oil,i) => {
        const dx=oil.x-p.x,dz=oil.z-p.z,d=Math.hypot(dx,dz),aim=(dx*Math.sin(p.yaw)+dz*Math.cos(p.yaw))/Math.max(.001,d);
        if ((d < oil.radius || d < WEAPONS.flamethrower.range+oil.radius && aim > .82) && s.oil[i]!.burning <= 0) Object.assign(s.oil[i]!,{ burning:H.oilBurnSeconds, attackerId:p.id });
      });
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
      const targets = [...active.map(p => ({ ...p, radius: ROBOT_RADIUS, tank: false })), ...s.tanks.filter(t => t.hp > 0).map(t => ({ ...t, radius: H.tankRadius, tank: true }))];
      const hits = targets.flatMap(p => {
        if (p.id === q.ownerId || q.hitIds.includes(p.id)) return [];
        // Ray-circle entry distance orders hits physically, independent of roster.
        const ox = p.x - oldX, oz = p.z - oldZ;
        const along = (ox * dx + oz * dz) / length;
        const perpendicularSq = ox * ox + oz * oz - along * along;
        if (perpendicularSq > p.radius * p.radius) return [];
        const halfChord = Math.sqrt(Math.max(0, p.radius * p.radius - perpendicularSq));
        const entry = Math.max(0, along - halfChord);
        return along + halfChord >= 0 && entry <= length ? [{ player: p, entry }] : [];
      }).sort((a, b) => a.entry - b.entry);
      const attacker = s.players.find(p => p.id === q.ownerId);
      if (attacker) for (const hit of hits) {
        if (hit.player.tank) hitTank(s.tanks.find(t => t.id === hit.player.id)!,weapon.damage,attacker.id);
        else hurt(s.players.find(p => p.id === hit.player.id)!,weapon.damage,attacker.id);
        q.hitIds.push(hit.player.id);
        if (!rule.piercing) return false;
      }
      return q.distance < weapon.range;
    });
    for (const tank of s.tanks) if (tank.hp > 0) {
      const oilIndex = OIL_SLICKS.findIndex((oil,i) => s.oil[i]!.burning > 0 && within(tank,oil));
      if (oilIndex >= 0) { const owner=s.oil[oilIndex]!.attackerId; if (tank.hp <= H.fireDamage*dt) explode(tank,owner); else tank.hp -= H.fireDamage*dt; }
    }
    for (const p of active) {
      if (COOLING_POOLS.some(pool => within(p,pool))) {
        p.burning=0; p.burnAttackerId=undefined; p.heat=Math.max(0,p.heat-dt); if (p.heat===0) p.overheated=false;
      } else {
        const index=OIL_SLICKS.findIndex((oil,i) => s.oil[i]!.burning > 0 && within(p,oil));
        if (index >= 0) { p.burning=H.robotBurnSeconds; p.burnAttackerId=s.oil[index]!.attackerId; }
        const burnTime=Math.min(dt,p.burning??0); if (burnTime > 0) hurt(p,H.fireDamage*burnTime,p.burnAttackerId);
        p.burning=Math.max(0,(p.burning??0)-dt);
      }
    }
    for (const p of active) { if (p.hp <= 0) this.eliminate(p, 'destroyed', lastAttacker.get(p.id)); else if (Math.abs(p.x) > ARENA_HALF || Math.abs(p.z) > ARENA_HALF) this.eliminate(p, 'fell off the roof', lastAttacker.get(p.id)); }
    this.finishIfNeeded();
  }
}
