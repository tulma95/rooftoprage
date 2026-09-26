import type { Tank, Oil } from './hazards.js';
const FRONT_WEAPONS = [
  'ram',
  'wedge',
  'sweeper',
  'flipper',
  'hook',
  'saw',
  'hammer',
  'drill',
] as const;
const TOP_WEAPONS = ['cannon', 'flamethrower', 'scattergun', 'railgun'] as const;
export type FrontWeapon = (typeof FRONT_WEAPONS)[number];
export type TopWeapon = (typeof TOP_WEAPONS)[number];
export type ProjectileWeapon = Exclude<TopWeapon, 'flamethrower'>;
export type Phase = 'lobby' | 'loading' | 'countdown' | 'combat' | 'results';
export const ARENA_HALF = 28;
export const CHASSIS = {
  mule: {
    mass: 1,
    name: 'Mule',
    role: 'All-rounder',
    hp: 100,
    speed: 8,
    reverse: 5,
    turn: 2.25,
    description: 'Dependable balance of armor, speed, and handling.',
  },
  dart: {
    mass: 0.72,
    name: 'Dart',
    role: 'Speedster',
    hp: 70,
    speed: 11,
    reverse: 7,
    turn: 2.9,
    description: 'Light armor, rapid turns. Strike fast and keep moving.',
  },
  bruiser: {
    mass: 1.4,
    name: 'Bruiser',
    role: 'Brawler',
    hp: 130,
    speed: 6.5,
    reverse: 4,
    turn: 1.95,
    description: 'Extra armor for close-range scraps, with a slower stride.',
  },
  bulwark: {
    mass: 1.85,
    name: 'Bulwark',
    role: 'Heavy tank',
    hp: 170,
    speed: 5,
    reverse: 3,
    turn: 1.5,
    description: 'Maximum durability. Slow travel and wide turns demand planning.',
  },
} as const;
export type Chassis = keyof typeof CHASSIS;
export function isChassis(value: unknown): value is Chassis {
  return typeof value === 'string' && Object.hasOwn(CHASSIS, value);
}
export const ROBOT_RADIUS = 1.05;
export const ROUND_SECONDS = 300;
/** Server simulation and snapshot interval. */
export const TICK_SECONDS = 0.05;
export const BOOST_COOLDOWN = 2.5;
const BOOST_DURATION = 0.16;
export const WEDGE_RULES = {
  liftSeconds: 0.4,
  traction: 0.15,
  contactPower: 1.3,
  thrust: 24,
} as const;
const MAX_NAME = 20;
export const COLORS = ['#e6aa3c', '#51bec9', '#cc6478', '#8cb961'];
export const WEAPONS = {
  ram: {
    name: 'Impact Ram',
    slot: 'front',
    damage: 6,
    range: 2.9,
    cooldown: 1.1,
    description: 'A recoiling piston shove. Build speed for harder hits; 6 damage, 1.1s cooldown.',
  },
  wedge: {
    name: 'Lifter Wedge',
    slot: 'front',
    damage: 0,
    range: 2.7,
    cooldown: 0,
    description:
      'Lift opponents and strip their traction. Hold Space to drive them back with powered shoves.',
  },
  sweeper: {
    name: 'Side Sweeper',
    slot: 'front',
    damage: 5,
    range: 3.2,
    cooldown: 1.4,
    description:
      'Sweep opponents sideways and spin them, with a kick back. 5 damage; 1.4s cooldown.',
  },
  flipper: {
    name: 'Flip Fork',
    slot: 'front',
    damage: 4,
    range: 2.9,
    cooldown: 1.8,
    description: 'Launch opponents forward and lift them for 1s. 4 damage; 1.8s cooldown.',
  },
  hook: {
    name: 'Tow Hook',
    slot: 'front',
    damage: 2,
    range: 3.6,
    cooldown: 1.6,
    description:
      'Tug the nearest opponent toward you; the cable pulls you toward them too. 2 damage; 1.6s cooldown.',
  },
  saw: {
    name: 'Rotor Saw',
    slot: 'front',
    damage: 11,
    range: 2.7,
    cooldown: 0,
    description: 'Hold to cut: 11 damage per second at close range.',
  },
  hammer: {
    name: 'Forge Hammer',
    slot: 'front',
    damage: 16,
    range: 3.2,
    cooldown: 1.8,
    description: 'A heavy forward strike: 16 damage and a solid shove; 1.8s cooldown.',
  },
  drill: {
    name: 'Auger Drill',
    slot: 'front',
    damage: 14,
    range: 3,
    cooldown: 0,
    description: 'Hold to bore: 14 damage/s in a narrow forward arc. No heat limit.',
  },
  cannon: {
    name: 'Bolt Cannon',
    slot: 'top',
    damage: 12,
    range: 38,
    cooldown: 1.5,
    description: 'A forward projectile: 12 damage; 1.5s cooldown.',
  },
  flamethrower: {
    name: 'Furnace Jet',
    slot: 'top',
    damage: 8,
    range: 6.5,
    cooldown: 0,
    description: 'Hold for a flame cone: 8 damage/s. Overheats after 3s; cools in 4s.',
  },
  scattergun: {
    name: 'Scrap Scattergun',
    slot: 'top',
    damage: 4,
    range: 16,
    cooldown: 1.2,
    description:
      'Five spreading pellets, 4 damage each (20 maximum); 1.2s cooldown. Best up close.',
  },
  railgun: {
    name: 'Arc Railgun',
    slot: 'top',
    damage: 21,
    range: 50,
    cooldown: 2.6,
    description:
      'A fast piercing bolt: 21 damage to each robot in its path, once per shot; 2.6s cooldown.',
  },
} as const;
export const PROJECTILE_RULES = {
  cannon: { speed: 24, angles: [0], piercing: false },
  scattergun: { speed: 30, angles: [-0.18, -0.09, 0, 0.09, 0.18], piercing: false },
  railgun: { speed: 65, angles: [0], piercing: true },
} as const;
export const FRONT_RULES = {
  ram: { aim: 0.45, push: 30, continuous: false },
  wedge: { aim: 0.72, push: 0, continuous: true },
  sweeper: { aim: 0.3, push: 26, continuous: false },
  flipper: { aim: 0.7, push: 22, continuous: false },
  hook: { aim: 0.75, push: 18, continuous: false },
  saw: { aim: 0.45, push: 0, continuous: true },
  hammer: { aim: 0.65, push: 14, continuous: false },
  drill: { aim: 0.85, push: 0, continuous: true },
} as const;
export const WEAPON_ICONS = {
  ram: '▰',
  wedge: '◢',
  sweeper: '↦',
  flipper: '⇧',
  hook: '↶',
  saw: '✹',
  hammer: '⚒',
  drill: '⟫',
  cannon: '⊙',
  flamethrower: '♨',
  scattergun: '⁙',
  railgun: 'ϟ',
} as const;
export function isFrontWeapon(value: unknown): value is FrontWeapon {
  return FRONT_WEAPONS.some((key) => key === value);
}
export function isTopWeapon(value: unknown): value is TopWeapon {
  return TOP_WEAPONS.some((key) => key === value);
}
export interface Input {
  forward: number;
  turn: number;
  front: boolean;
  top: boolean;
  boost?: boolean;
  boostX?: number;
  boostZ?: number;
}
export const EMPTY_INPUT: Input = { forward: 0, turn: 0, front: false, top: false };
export interface PlayerState {
  id: string;
  name: string;
  color: string;
  chassis: Chassis;
  front: FrontWeapon;
  top: TopWeapon;
  bot?: boolean;
  ready: boolean;
  loaded: boolean;
  connected: boolean;
  x: number;
  z: number;
  yaw: number;
  /** External momentum, added to commanded driving velocity. */
  vx?: number;
  vz?: number;
  boostCooldown?: number;
  boostRemaining?: number;
  boostHeld?: boolean;
  lifted?: number;
  hp: number;
  alive: boolean;
  frontCooldown: number;
  topCooldown: number;
  heat: number;
  burning?: number;
  burnAttackerId?: string;
  overheated: boolean;
  frontActive: boolean;
  topActive: boolean;
  stats: { damage: number; kills: number; shots: number };
}
export interface Projectile {
  id: number;
  ownerId: string;
  weapon: ProjectileWeapon;
  hitIds: string[];
  x: number;
  z: number;
  yaw: number;
  distance: number;
}
export interface GameEvent {
  melee?: FrontWeapon;
  id: number;
  type: 'hit' | 'elimination' | 'shot' | 'explosion';
  playerId: string;
  attackerId?: string;
  reason?: string;
  x: number;
  z: number;
}
export interface RoomState {
  code: string;
  hostId: string;
  phase: Phase;
  players: PlayerState[];
  projectiles: Projectile[];
  tanks: Tank[];
  oil: Oil[];
  events: GameEvent[];
  winnerId: string | null;
  draw: boolean;
  remaining: number;
  countdown: number;
  notice: string;
  round: number;
}
export function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_NAME &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
export function validEquipment(
  value: unknown,
): value is { front: FrontWeapon; top: TopWeapon; chassis?: Chassis } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    isFrontWeapon(v.front) &&
    isTopWeapon(v.top) &&
    (v.chassis === undefined || isChassis(v.chassis))
  );
}
export function validInput(value: unknown): value is Input {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.forward === 'number' &&
    Number.isFinite(v.forward) &&
    Math.abs(v.forward) <= 1 &&
    typeof v.turn === 'number' &&
    Number.isFinite(v.turn) &&
    Math.abs(v.turn) <= 1 &&
    typeof v.front === 'boolean' &&
    typeof v.top === 'boolean' &&
    (v.boost === undefined || typeof v.boost === 'boolean') &&
    [v.boostX, v.boostZ].every(
      (axis) =>
        axis === undefined ||
        (typeof axis === 'number' && Number.isFinite(axis) && Math.abs(axis) <= 1),
    )
  );
}
export interface MovementState {
  x: number;
  z: number;
  yaw: number;
  chassis?: Chassis;
  vx?: number;
  vz?: number;
  boostCooldown?: number;
  boostRemaining?: number;
  boostHeld?: boolean;
  lifted?: number;
}

export function drive(p: MovementState, input: Input, dt: number): void {
  if (dt <= 0) return;
  const stats = CHASSIS[p.chassis ?? 'mule'];
  p.boostCooldown = Math.max(0, (p.boostCooldown ?? 0) - dt);
  p.boostRemaining = Math.max(0, (p.boostRemaining ?? 0) - dt);
  p.lifted = Math.max(0, (p.lifted ?? 0) - dt);
  if (input.boost && !p.boostHeld && p.boostCooldown === 0) {
    const dx = input.boostX ?? 0,
      dz = input.boostZ ?? 0;
    const length = Math.hypot(dx, dz);
    p.vx = (p.vx ?? 0) + 20 * (length > 0.001 ? dx / length : Math.sin(p.yaw));
    p.vz = (p.vz ?? 0) + 20 * (length > 0.001 ? dz / length : Math.cos(p.yaw));
    p.boostCooldown = BOOST_COOLDOWN;
    p.boostRemaining = BOOST_DURATION;
  }
  p.boostHeld = !!input.boost;
  p.yaw += input.turn * stats.turn * dt * (p.boostRemaining > 0 ? 0.4 : 1);
  const traction = p.lifted > 0 ? WEDGE_RULES.traction : 1;
  const speed = (input.forward >= 0 ? stats.speed : stats.reverse) * traction;
  // Exact exponential integration keeps bursts and shoves consistent across tick rates.
  const drag = p.lifted > 0 ? 2 : 8;
  const decay = Math.exp(-drag * dt);
  const travel = (1 - decay) / drag;
  p.x += Math.sin(p.yaw) * input.forward * speed * dt + (p.vx ?? 0) * travel;
  p.z += Math.cos(p.yaw) * input.forward * speed * dt + (p.vz ?? 0) * travel;
  p.vx = (p.vx ?? 0) * decay;
  p.vz = (p.vz ?? 0) * decay;
}
export function makePlayer(
  id: string,
  name: string,
  front: FrontWeapon,
  top: TopWeapon,
  index: number,
  chassis: Chassis = 'mule',
): PlayerState {
  return {
    id,
    name: name.trim(),
    chassis,
    front,
    top,
    color: COLORS[index % 4]!,
    ready: false,
    loaded: false,
    connected: true,
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    boostCooldown: 0,
    boostRemaining: 0,
    boostHeld: false,
    lifted: 0,
    hp: CHASSIS[chassis].hp,
    alive: true,
    frontCooldown: 0,
    topCooldown: 0,
    heat: 0,
    overheated: false,
    frontActive: false,
    topActive: false,
    stats: { damage: 0, kills: 0, shots: 0 },
  };
}

/** Payload contracts; the server still validates all received data at runtime. */
export interface ClientMessages {
  sync: undefined;
  input: Input;
  equipment: { front: FrontWeapon; top: TopWeapon; chassis?: Chassis };
  ready: boolean;
  start: undefined;
  loaded: undefined;
  again: undefined;
}
export interface ServerMessages {
  snapshot: RoomState;
  notice: string;
}
