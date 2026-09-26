import {
  makeHazards,
  driveTerrain,
  within,
  OIL_SLICKS,
  COOLING_POOLS,
  HAZARD_RULES as H,
  type Tank,
} from '../shared/hazards.js';
import {
  ARENA_HALF,
  CHASSIS,
  ROBOT_RADIUS,
  robotRadius,
  ROUND_SECONDS,
  WEAPONS,
  WEDGE_RULES,
  FRONT_RULES,
  PROJECTILE_RULES,
  EMPTY_INPUT,
  type FrontWeapon,
  type Input,
  type PlayerState,
  type RoomState,
} from '../shared/game.js';
import { botInput } from './bots.js';
const SPAWN_RADIUS = 14;
const SPAWN_ROTATION = (85 * Math.PI) / 180;
interface TickDamage {
  lastAttacker: Map<string, string>;
  hurt(player: PlayerState, amount: number, attackerId?: string, melee?: FrontWeapon): void;
  hitTank(tank: Tank, amount: number, attackerId: string): void;
  explode(tank: Tank, attackerId?: string): void;
}

export class Simulation {
  state: RoomState = {
    code: '',
    hostId: '',
    phase: 'lobby',
    ...makeHazards(),
    players: [],
    projectiles: [],
    events: [],
    winnerId: null,
    draw: false,
    remaining: ROUND_SECONDS,
    countdown: 3,
    notice: '',
    round: 0,
  };
  inputs = new Map<string, { input: Input; time: number }>();
  time = 0;
  serial = 0;
  private phaseElapsed = 0;
  private pushCredit = new Map<string, { attackerId: string; until: number }>();
  private movement = new Map<string, Input>();
  event(
    type: 'hit' | 'elimination' | 'shot',
    p: PlayerState,
    attackerId?: string,
    reason?: string,
    melee?: FrontWeapon,
  ) {
    this.state.events.push({
      id: ++this.serial,
      type,
      playerId: p.id,
      attackerId,
      reason,
      ...(melee ? { melee } : {}),
      x: p.x,
      z: p.z,
    });
    this.state.events = this.state.events.slice(-24);
  }
  setInput(id: string, input: Input) {
    const previous = this.inputs.get(id);
    // Preserve a press that arrived since the last tick, even if its release arrives first.
    const pendingBoost = previous?.time === this.time && previous.input.boost;
    this.inputs.set(id, {
      input: pendingBoost
        ? {
            ...input,
            boost: true,
            boostX: previous.input.boostX,
            boostZ: previous.input.boostZ,
          }
        : { ...input },
      time: this.time,
    });
  }
  start() {
    const s = this.state;
    s.phase = 'loading';
    s.notice = '';
    this.phaseElapsed = 0;
    Object.assign(s, makeHazards());
    s.round++;
    s.remaining = ROUND_SECONDS;
    s.winnerId = null;
    s.draw = false;
    s.events = [];
    s.projectiles = [];
    s.countdown = 3;
    this.inputs.clear();
    this.pushCredit.clear();
    this.movement.clear();
    s.players.forEach((p, i) => {
      // Rotated ring keeps 2–4 spawns outside tank blast radius and off oil and pools.
      const a = (i * Math.PI * 2) / s.players.length + SPAWN_ROTATION;
      Object.assign(p, {
        x: Math.sin(a) * SPAWN_RADIUS,
        z: Math.cos(a) * SPAWN_RADIUS,
        yaw: a + Math.PI,
        hp: CHASSIS[p.chassis].hp,
        alive: true,
        vx: 0,
        vz: 0,
        boostCooldown: 0,
        boostRemaining: 0,
        boostHeld: false,
        lifted: 0,
        burning: 0,
        burnAttackerId: undefined,
        loaded: !!p.bot,
        frontCooldown: 0,
        topCooldown: 0,
        heat: 0,
        overheated: false,
        frontActive: false,
        topActive: false,
        stats: { damage: 0, kills: 0, shots: 0 },
      });
    });
  }
  returnToLobby(notice: string) {
    const s = this.state;
    s.phase = 'lobby';
    this.phaseElapsed = 0;
    s.players = s.players.filter((p) => p.connected);
    for (const p of s.players) {
      p.ready = !!p.bot;
      p.loaded = false;
    }
    s.notice = notice;
    this.inputs.clear();
  }

  disconnect(id: string) {
    const s = this.state;
    const player = s.players.find((p) => p.id === id);
    this.inputs.delete(id);
    if (player) {
      player.connected = false;
      if (s.phase === 'combat') {
        this.eliminate(player, 'disconnected');
        this.finishIfNeeded();
      } else if (s.phase === 'loading' || s.phase === 'countdown') {
        this.returnToLobby('A player left before combat. Ready up again.');
      }
      if (s.phase === 'lobby') s.players = s.players.filter((p) => p.id !== id);
    }
    if (s.hostId === id) s.hostId = s.players.find((p) => p.connected && !p.bot)?.id ?? '';
  }

  private advanceLoading(dt: number) {
    const s = this.state;
    this.phaseElapsed += dt;
    if (s.phase === 'loading') {
      if (s.players.every((p) => p.loaded)) {
        s.phase = 'countdown';
        this.phaseElapsed = 0;
      } else if (this.phaseElapsed > 20) {
        this.returnToLobby('Loading timed out. Check your connection and try again.');
      }
    } else if (s.phase === 'countdown') {
      s.countdown = Math.max(0, 3 - this.phaseElapsed);
      if (s.countdown === 0) s.phase = 'combat';
    }
  }

  eliminate(p: PlayerState, reason: string, attackerId?: string) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.frontActive = p.topActive = false;
    p.vx = p.vz = p.boostRemaining = p.lifted = 0;
    p.boostHeld = false;
    this.inputs.delete(p.id);
    this.event('elimination', p, attackerId, reason);
    const attacker = this.state.players.find((a) => a.id === attackerId);
    if (attacker && attacker !== p) attacker.stats.kills++;
  }
  finishIfNeeded() {
    const s = this.state;
    const alive = s.players.filter((p) => p.alive);
    if (s.phase === 'combat' && (alive.length <= 1 || s.remaining <= 0)) {
      s.phase = 'results';
      s.draw = alive.length !== 1;
      s.winnerId = s.draw ? null : alive[0]!.id;
      this.inputs.clear();
    }
  }
  step(dt: number) {
    this.time += dt;
    const s = this.state;
    this.advanceLoading(dt);
    if (s.phase !== 'combat') return;
    s.remaining = Math.max(0, s.remaining - dt);
    const active = s.players.filter((p) => p.alive);
    const damage = this.damageForTick(active);
    for (const oil of s.oil) oil.burning = Math.max(0, oil.burning - dt);
    this.moveAndFire(active, dt);
    this.resolveTankContact(active, dt, damage);
    this.resolveCloseCombat(active, dt, damage);
    this.advanceProjectiles(active, dt, damage);
    this.applyBurning(active, dt, damage);
    // Keep the tick's active roster until all attacks resolve, allowing simultaneous KOs.
    this.resolveEliminations(active, damage.lastAttacker);
    this.finishIfNeeded();
  }

  private damageForTick(active: PlayerState[]): TickDamage {
    const s = this.state;
    const lastAttacker = new Map<string, string>();
    const hurt = (p: PlayerState, amount: number, attackerId?: string, melee?: FrontWeapon) => {
      if (!p.alive || p.hp <= 0 || amount <= 0) return;
      const attacker = s.players.find((a) => a.id === attackerId);
      if (attacker && attacker !== p) attacker.stats.damage += Math.min(p.hp, amount);
      p.hp = Math.max(0, p.hp - amount);
      this.event('hit', p, attackerId, undefined, melee);
      if (attackerId) lastAttacker.set(p.id, attackerId);
      else lastAttacker.delete(p.id);
    };
    const explode = (tank: (typeof s.tanks)[number], attackerId?: string) => {
      if (tank.hp <= 0) return;
      tank.hp = 0;
      s.events.push({
        id: ++this.serial,
        type: 'explosion',
        playerId: tank.id,
        attackerId,
        x: tank.x,
        z: tank.z,
      });
      s.events = s.events.slice(-24);
      for (const p of active) {
        const d = Math.hypot(p.x - tank.x, p.z - tank.z);
        if (d < H.blastRadius) hurt(p, H.blastDamage * (1 - (0.5 * d) / H.blastRadius), attackerId);
      }
      OIL_SLICKS.forEach((oil, i) => {
        if (Math.hypot(oil.x - tank.x, oil.z - tank.z) < H.blastRadius + oil.radius)
          this.ignite(i, attackerId);
      });
      for (const other of s.tanks)
        if (other.hp > 0 && Math.hypot(other.x - tank.x, other.z - tank.z) < H.blastRadius)
          explode(other, attackerId);
    };
    const hitTank = (tank: (typeof s.tanks)[number], amount: number, attackerId: string) => {
      if (tank.hp <= 0) return;
      if (tank.hp <= amount) explode(tank, attackerId);
      else tank.hp -= amount;
    };
    return { lastAttacker, hurt, hitTank, explode };
  }

  private moveAndFire(active: PlayerState[], dt: number) {
    const s = this.state;
    this.movement.clear();
    for (const p of active) {
      const stored = this.inputs.get(p.id);
      const input = p.bot
        ? botInput(p, active)
        : stored && this.time - stored.time < 0.3
          ? stored.input
          : EMPTY_INPUT;
      this.movement.set(p.id, input);
    }
    // Small movement steps prevent a short, fast burst passing through a robot or tank.
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const movementDt = dt / steps;
    for (let step = 0; step < steps; step++) {
      for (const p of active) driveTerrain(p, this.movement.get(p.id)!, movementDt);
      this.resolveRobotCollisions(active);
      this.blockTanks(active);
    }
    for (const p of active) {
      const input = this.movement.get(p.id)!;
      p.frontCooldown = Math.max(0, p.frontCooldown - dt);
      p.topCooldown = Math.max(0, p.topCooldown - dt);
      p.frontActive = input.front && p.frontCooldown === 0;
      p.topActive = input.top && p.topCooldown === 0 && !p.overheated;
      if (p.top === 'flamethrower') {
        p.heat = Math.max(0, Math.min(1, p.heat + (p.topActive ? dt / 3 : -dt / 4)));
        if (p.heat >= 1) p.overheated = true;
        if (p.heat === 0) p.overheated = false;
      }
      if (p.frontActive) p.frontCooldown = WEAPONS[p.front].cooldown;
      if (p.topActive && p.top !== 'flamethrower') {
        p.topCooldown = WEAPONS[p.top].cooldown;
        p.stats.shots++;
        for (const angle of PROJECTILE_RULES[p.top].angles) {
          s.projectiles.push({
            id: ++this.serial,
            ownerId: p.id,
            weapon: p.top,
            hitIds: [],
            x: p.x + Math.sin(p.yaw) * 1.7,
            z: p.z + Math.cos(p.yaw) * 1.7,
            yaw: p.yaw + angle,
            distance: 0,
          });
        }
        this.event('shot', p);
      }
    }
  }

  private creditPush(target: PlayerState, attacker: PlayerState) {
    this.pushCredit.set(target.id, { attackerId: attacker.id, until: this.time + 3 });
  }

  private velocity(p: PlayerState) {
    const input = this.movement.get(p.id) ?? EMPTY_INPUT;
    const stats = CHASSIS[p.chassis];
    const cooling = COOLING_POOLS.some((pool) => within(p, pool));
    const speed =
      input.forward *
      (input.forward >= 0 ? stats.speed : stats.reverse) *
      (cooling ? 0.6 : 1) *
      ((p.lifted ?? 0) > 0 ? WEDGE_RULES.traction : 1);
    return { x: Math.sin(p.yaw) * speed + (p.vx ?? 0), z: Math.cos(p.yaw) * speed + (p.vz ?? 0) };
  }

  private flankPower(target: PlayerState, nx: number, nz: number) {
    const facing = Math.sin(target.yaw) * nx + Math.cos(target.yaw) * nz;
    // A frontal hit meets the armor; side and rear hits break traction more easily.
    return 1 + 0.8 * (1 - Math.abs(facing)) + 1.2 * Math.max(0, facing);
  }

  private resolveRobotCollisions(active: PlayerState[]) {
    for (let i = 0; i < active.length; i++)
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!,
          b = active[j]!;
        const dx = b.x - a.x,
          dz = b.z - a.z,
          d = Math.hypot(dx, dz),
          contact = robotRadius(a.chassis) + robotRadius(b.chassis);
        if (d > contact) continue;
        const nx = d > 0.001 ? dx / d : 1,
          nz = d > 0.001 ? dz / d : 0;
        const invA = 1 / CHASSIS[a.chassis].mass,
          invB = 1 / CHASSIS[b.chassis].mass;
        const overlap = contact - d;
        a.x -= (nx * overlap * invA) / (invA + invB);
        a.z -= (nz * overlap * invA) / (invA + invB);
        b.x += (nx * overlap * invB) / (invA + invB);
        b.z += (nz * overlap * invB) / (invA + invB);
        const av = this.velocity(a),
          bv = this.velocity(b);
        const towardA = av.x * nx + av.z * nz;
        const towardB = -(bv.x * nx + bv.z * nz);
        const closing = towardA + towardB;
        const aimA = Math.sin(a.yaw) * nx + Math.cos(a.yaw) * nz;
        const aimB = -Math.sin(b.yaw) * nx - Math.cos(b.yaw) * nz;
        const wedgeA = a.front === 'wedge' && aimA > FRONT_RULES.wedge.aim;
        const wedgeB = b.front === 'wedge' && aimB > FRONT_RULES.wedge.aim;
        if (wedgeA) b.lifted = Math.max(b.lifted ?? 0, WEDGE_RULES.liftSeconds);
        if (wedgeB) a.lifted = Math.max(a.lifted ?? 0, WEDGE_RULES.liftSeconds);
        if (closing <= 0) continue;
        const attackA = towardA > 1 && aimA > 0.45;
        const attackB = towardB > 1 && aimB > 0.45;
        const flank = Math.max(
          attackA ? this.flankPower(b, nx, nz) : 1,
          attackB ? this.flankPower(a, -nx, -nz) : 1,
        );
        // Ramp the angle bonus in with speed so resting contact cannot amplify itself.
        const speedBonus = 1 + (flank - 1) * Math.min(1, Math.max(0, (closing - 2) / 4));
        const wedgePower =
          (wedgeA && attackA) || (wedgeB && attackB) ? WEDGE_RULES.contactPower : 1;
        const impulse =
          (closing * (closing > 5 ? 1.3 : 1) * speedBonus * wedgePower) / (invA + invB);
        a.vx = (a.vx ?? 0) - nx * impulse * invA;
        a.vz = (a.vz ?? 0) - nz * impulse * invA;
        b.vx = (b.vx ?? 0) + nx * impulse * invB;
        b.vz = (b.vz ?? 0) + nz * impulse * invB;
        if (closing > 0.5) {
          if (towardA > 0.5) this.creditPush(b, a);
          if (towardB > 0.5) this.creditPush(a, b);
        }
        if (closing > 5) {
          const spin = Math.min(0.5, closing * 0.015 * speedBonus);
          a.yaw -= (Math.cos(a.yaw) * nx - Math.sin(a.yaw) * nz) * spin * invA;
          b.yaw += (Math.cos(b.yaw) * nx - Math.sin(b.yaw) * nz) * spin * invB;
          this.event('hit', b, towardA >= towardB ? a.id : undefined, 'collision');
        }
      }
  }

  private blockTanks(active: PlayerState[]) {
    for (const p of active)
      for (const tank of this.state.tanks) {
        if (tank.hp <= 0) continue;
        const dx = p.x - tank.x,
          dz = p.z - tank.z,
          d = Math.hypot(dx, dz);
        const gap = robotRadius(p.chassis) + H.tankRadius;
        if (d >= gap) continue;
        const nx = d > 0.001 ? dx / d : 1,
          nz = d > 0.001 ? dz / d : 0;
        p.x = tank.x + nx * gap;
        p.z = tank.z + nz * gap;
        const inward = (p.vx ?? 0) * nx + (p.vz ?? 0) * nz;
        if (inward < 0) {
          p.vx = (p.vx ?? 0) - inward * nx;
          p.vz = (p.vz ?? 0) - inward * nz;
        }
      }
  }

  private resolveTankContact(active: PlayerState[], dt: number, damage: TickDamage) {
    const s = this.state;
    const { hitTank } = damage;
    for (const p of active) {
      for (const tank of s.tanks) {
        if (tank.hp <= 0) continue;
        const dx = tank.x - p.x,
          dz = tank.z - p.z,
          d = Math.hypot(dx, dz);
        const aim = (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) / Math.max(0.001, d);
        if (
          p.frontActive &&
          p.front !== 'hook' &&
          d < WEAPONS[p.front].range &&
          aim > FRONT_RULES[p.front].aim
        )
          hitTank(tank, WEAPONS[p.front].damage * (FRONT_RULES[p.front].continuous ? dt : 1), p.id);
        if (p.topActive && p.top === 'flamethrower' && d < WEAPONS.flamethrower.range && aim > 0.82)
          hitTank(tank, WEAPONS.flamethrower.damage * dt, p.id);
      }
      if (p.topActive && p.top === 'flamethrower')
        OIL_SLICKS.forEach((oil, i) => {
          const dx = oil.x - p.x,
            dz = oil.z - p.z,
            d = Math.hypot(dx, dz),
            aim = (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) / Math.max(0.001, d);
          if (d < oil.radius || (d < WEAPONS.flamethrower.range + oil.radius && aim > 0.82))
            this.ignite(i, p.id);
        });
    }
  }

  private ignite(index: number, attackerId?: string) {
    const oil = this.state.oil[index]!;
    if (oil.burning <= 0) Object.assign(oil, { burning: H.oilBurnSeconds, attackerId });
  }

  private resolveCloseCombat(active: PlayerState[], dt: number, damage: TickDamage) {
    // Weapon ranges are tuned against a standard hull; smaller hulls must be approached closer.
    const reach = (target: PlayerState, d: number) =>
      d - robotRadius(target.chassis) + ROBOT_RADIUS;
    const { hurt } = damage;
    for (const a of active) {
      let swept = false;
      // The hook catches only the closest robot inside its forward cone.
      const hookTarget =
        a.front === 'hook'
          ? active
              .filter((b) => {
                if (a === b || !b.alive || b.hp <= 0) return false;
                const dx = b.x - a.x,
                  dz = b.z - a.z,
                  distance = Math.hypot(dx, dz);
                const aim =
                  (dx * Math.sin(a.yaw) + dz * Math.cos(a.yaw)) / Math.max(0.001, distance);
                return reach(b, distance) <= WEAPONS.hook.range && aim > FRONT_RULES.hook.aim;
              })
              .sort(
                (b, c) => Math.hypot(b.x - a.x, b.z - a.z) - Math.hypot(c.x - a.x, c.z - a.z),
              )[0]
          : undefined;
      for (const b of active) {
        if (a === b) continue;
        const dx = b.x - a.x,
          dz = b.z - a.z,
          d = Math.hypot(dx, dz);
        const aim = (dx * Math.sin(a.yaw) + dz * Math.cos(a.yaw)) / Math.max(0.001, d);
        const frontRules = FRONT_RULES[a.front];
        if (
          a.frontActive &&
          reach(b, d) <= WEAPONS[a.front].range &&
          aim > frontRules.aim &&
          (a.front !== 'hook' || b === hookTarget)
        ) {
          hurt(b, WEAPONS[a.front].damage * (frontRules.continuous ? dt : 1), a.id, a.front);
          if (a.front === 'wedge' && b.alive && b.hp > 0)
            this.event('hit', b, a.id, undefined, a.front);
          if (a.front === 'sweeper') {
            const ratio = CHASSIS[a.chassis].mass / CHASSIS[b.chassis].mass;
            const pushX = Math.cos(a.yaw) * frontRules.push + Math.sin(a.yaw) * 4;
            const pushZ = -Math.sin(a.yaw) * frontRules.push + Math.cos(a.yaw) * 4;
            b.vx = (b.vx ?? 0) + pushX * ratio;
            b.vz = (b.vz ?? 0) + pushZ * ratio;
            a.vx = (a.vx ?? 0) - pushX * 0.18;
            a.vz = (a.vz ?? 0) - pushZ * 0.18;
            b.yaw += 0.6 * ratio;
            swept = true;
            this.creditPush(b, a);
          } else if (a.front === 'hook') {
            const nx = dx / Math.max(0.001, d),
              nz = dz / Math.max(0.001, d);
            const force = frontRules.push * CHASSIS[a.chassis].mass;
            b.vx = (b.vx ?? 0) - (nx * force) / CHASSIS[b.chassis].mass;
            b.vz = (b.vz ?? 0) - (nz * force) / CHASSIS[b.chassis].mass;
            a.vx = (a.vx ?? 0) + (nx * force) / CHASSIS[a.chassis].mass;
            a.vz = (a.vz ?? 0) + (nz * force) / CHASSIS[a.chassis].mass;
            this.creditPush(b, a);
            this.creditPush(a, b);
          } else if (a.front === 'wedge') {
            b.lifted = Math.max(b.lifted ?? 0, WEDGE_RULES.liftSeconds);
            const force = WEDGE_RULES.thrust * dt * CHASSIS[a.chassis].mass;
            b.vx = (b.vx ?? 0) + (Math.sin(a.yaw) * force) / CHASSIS[b.chassis].mass;
            b.vz = (b.vz ?? 0) + (Math.cos(a.yaw) * force) / CHASSIS[b.chassis].mass;
            a.vx = (a.vx ?? 0) - Math.sin(a.yaw) * WEDGE_RULES.thrust * dt * 0.1;
            a.vz = (a.vz ?? 0) - Math.cos(a.yaw) * WEDGE_RULES.thrust * dt * 0.1;
            this.creditPush(b, a);
          } else if (frontRules.push > 0) {
            const force =
              frontRules.push *
              CHASSIS[a.chassis].mass *
              (a.front === 'ram'
                ? this.flankPower(b, dx / Math.max(0.001, d), dz / Math.max(0.001, d))
                : 1);
            if (a.front === 'flipper') b.lifted = Math.max(b.lifted ?? 0, 1);
            const recoil = a.front === 'flipper' ? 0.22 : 0.18;
            b.vx = (b.vx ?? 0) + (Math.sin(a.yaw) * force) / CHASSIS[b.chassis].mass;
            b.vz = (b.vz ?? 0) + (Math.cos(a.yaw) * force) / CHASSIS[b.chassis].mass;
            a.vx = (a.vx ?? 0) - (Math.sin(a.yaw) * force * recoil) / CHASSIS[a.chassis].mass;
            a.vz = (a.vz ?? 0) - (Math.cos(a.yaw) * force * recoil) / CHASSIS[a.chassis].mass;
            this.creditPush(b, a);
          }
        }
        if (
          a.topActive &&
          a.top === 'flamethrower' &&
          reach(b, d) < WEAPONS.flamethrower.range &&
          aim > 0.82
        ) {
          hurt(b, WEAPONS.flamethrower.damage * dt, a.id);
        }
      }
      if (swept) a.yaw -= 0.1;
    }
  }

  private advanceProjectiles(active: PlayerState[], dt: number, damage: TickDamage) {
    const s = this.state;
    const { hurt, hitTank } = damage;
    // Positions are fixed during this pass; targets destroyed mid-pass are skipped below.
    const targets = [
      ...active.map((p) => ({
        id: p.id,
        x: p.x,
        z: p.z,
        radius: robotRadius(p.chassis),
        tank: null,
        p,
      })),
      ...s.tanks
        .filter((t) => t.hp > 0)
        .map((t) => ({ id: t.id, x: t.x, z: t.z, radius: H.tankRadius, tank: t, p: null })),
    ];
    s.projectiles = s.projectiles.filter((q) => {
      const rule = PROJECTILE_RULES[q.weapon],
        weapon = WEAPONS[q.weapon];
      const oldX = q.x,
        oldZ = q.z;
      // Clamp the swept segment at range, so fast bolts cannot hit beyond it.
      const length = Math.min(rule.speed * dt, weapon.range - q.distance);
      if (length <= 0) return false;
      const dx = Math.sin(q.yaw) * length,
        dz = Math.cos(q.yaw) * length;
      q.x += dx;
      q.z += dz;
      q.distance += length;
      const hits = targets
        .flatMap((p) => {
          // A robot knocked to 0 HP earlier this tick must not soak up shots meant for others.
          if (p.id === q.ownerId || q.hitIds.includes(p.id) || (p.tank ? p.tank.hp : p.p!.hp) <= 0)
            return [];
          // Ray-circle entry distance orders hits physically, independent of roster.
          const ox = p.x - oldX,
            oz = p.z - oldZ;
          const along = (ox * dx + oz * dz) / length;
          const perpendicularSq = ox * ox + oz * oz - along * along;
          if (perpendicularSq > p.radius * p.radius) return [];
          const halfChord = Math.sqrt(Math.max(0, p.radius * p.radius - perpendicularSq));
          const entry = Math.max(0, along - halfChord);
          return along + halfChord >= 0 && entry <= length ? [{ player: p, entry }] : [];
        })
        .sort((a, b) => a.entry - b.entry);
      const attacker = s.players.find((p) => p.id === q.ownerId);
      if (attacker)
        for (const hit of hits) {
          if (hit.player.tank) hitTank(hit.player.tank, weapon.damage, attacker.id);
          else hurt(hit.player.p!, weapon.damage, attacker.id);
          q.hitIds.push(hit.player.id);
          if (!rule.piercing) return false;
        }
      return q.distance < weapon.range;
    });
  }

  private applyBurning(active: PlayerState[], dt: number, damage: TickDamage) {
    const s = this.state;
    const { hurt, explode } = damage;
    for (const tank of s.tanks)
      if (tank.hp > 0) {
        const oilIndex = OIL_SLICKS.findIndex(
          (oil, i) => s.oil[i]!.burning > 0 && within(tank, oil),
        );
        if (oilIndex >= 0) {
          const owner = s.oil[oilIndex]!.attackerId;
          if (tank.hp <= H.fireDamage * dt) explode(tank, owner);
          else tank.hp -= H.fireDamage * dt;
        }
      }
    for (const p of active) {
      if (COOLING_POOLS.some((pool) => within(p, pool))) {
        p.burning = 0;
        p.burnAttackerId = undefined;
        p.heat = Math.max(0, p.heat - dt);
        if (p.heat === 0) p.overheated = false;
      } else {
        const index = OIL_SLICKS.findIndex((oil, i) => s.oil[i]!.burning > 0 && within(p, oil));
        if (index >= 0) {
          p.burning = H.robotBurnSeconds;
          p.burnAttackerId = s.oil[index]!.attackerId;
        }
        const burnTime = Math.min(dt, p.burning ?? 0);
        if (burnTime > 0) hurt(p, H.fireDamage * burnTime, p.burnAttackerId);
        p.burning = Math.max(0, (p.burning ?? 0) - dt);
      }
    }
  }

  private resolveEliminations(active: PlayerState[], lastAttacker: Map<string, string>) {
    for (const p of active) {
      if (p.hp <= 0) this.eliminate(p, 'destroyed', lastAttacker.get(p.id));
      else if (Math.abs(p.x) > ARENA_HALF || Math.abs(p.z) > ARENA_HALF)
        this.eliminate(
          p,
          'fell off the roof',
          (this.pushCredit.get(p.id)?.until ?? 0) >= this.time
            ? this.pushCredit.get(p.id)?.attackerId
            : lastAttacker.get(p.id),
        );
    }
  }
}
