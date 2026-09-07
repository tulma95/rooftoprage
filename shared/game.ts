export const FRONT_WEAPONS = ['ram', 'saw', 'hammer', 'drill'] as const;
export const TOP_WEAPONS = ['cannon', 'flamethrower', 'scattergun', 'railgun'] as const;
export type FrontWeapon = typeof FRONT_WEAPONS[number];
export type TopWeapon = typeof TOP_WEAPONS[number];
export type ProjectileWeapon = Exclude<TopWeapon, 'flamethrower'>;
export type Phase = 'lobby' | 'loading' | 'countdown' | 'combat' | 'results';
export const ARENA_HALF = 22;
export const ROBOT_RADIUS = 1.05;
export const ROUND_SECONDS = 300;
export const MAX_NAME = 20;
export const COLORS = ['#e6aa3c', '#51bec9', '#cc6478', '#8cb961'];
export const WEAPONS = {
  ram: { name: 'Impact Ram', slot: 'front', damage: 12, range: 2.9, cooldown: 1.1, description: 'A short thrust that shoves opponents. 12 damage; 1.1s cooldown.' },
  saw: { name: 'Rotor Saw', slot: 'front', damage: 22, range: 2.7, cooldown: 0, description: 'Hold to cut: 22 damage per second at close range.' },
  hammer: { name: 'Forge Hammer', slot: 'front', damage: 32, range: 3.2, cooldown: 1.8, description: 'A heavy forward strike: 32 damage and a small shove; 1.8s cooldown.' },
  drill: { name: 'Auger Drill', slot: 'front', damage: 28, range: 3, cooldown: 0, description: 'Hold to bore: 28 damage/s in a narrow forward arc. No heat limit.' },
  cannon: { name: 'Bolt Cannon', slot: 'top', damage: 24, range: 38, cooldown: 1.5, description: 'A forward projectile: 24 damage; 1.5s cooldown.' },
  flamethrower: { name: 'Furnace Jet', slot: 'top', damage: 17, range: 6.5, cooldown: 0, description: 'Hold for a flame cone: 17 damage/s. Overheats after 3s; cools in 4s.' },
  scattergun: { name: 'Scrap Scattergun', slot: 'top', damage: 7, range: 16, cooldown: 1.2, description: 'Five spreading pellets, 7 damage each (35 maximum); 1.2s cooldown. Best up close.' },
  railgun: { name: 'Arc Railgun', slot: 'top', damage: 42, range: 50, cooldown: 2.6, description: 'A fast piercing bolt: 42 damage to each robot in its path, once per shot; 2.6s cooldown.' },
} as const;
export const PROJECTILE_RULES = {
  cannon: { speed: 24, angles: [0], piercing: false },
  scattergun: { speed: 30, angles: [-.18, -.09, 0, .09, .18], piercing: false },
  railgun: { speed: 65, angles: [0], piercing: true },
} as const;
export const FRONT_RULES = {
  ram: { aim: .45, push: 2.8, continuous: false },
  saw: { aim: .45, push: 0, continuous: true },
  hammer: { aim: .65, push: .7, continuous: false },
  drill: { aim: .85, push: 0, continuous: true },
} as const;
export const WEAPON_ICONS = { ram: '▰', saw: '✹', hammer: '⚒', drill: '⟫', cannon: '⊙', flamethrower: '♨', scattergun: '⁙', railgun: 'ϟ' } as const;
export function isFrontWeapon(value: unknown): value is FrontWeapon { return FRONT_WEAPONS.some(key => key === value); }
export function isTopWeapon(value: unknown): value is TopWeapon { return TOP_WEAPONS.some(key => key === value); }
export interface Input { forward: number; turn: number; front: boolean; top: boolean }
export const EMPTY_INPUT: Input = { forward: 0, turn: 0, front: false, top: false };
export interface PlayerState {
  id: string; name: string; color: string; front: FrontWeapon; top: TopWeapon;
  ready: boolean; loaded: boolean; connected: boolean; x: number; z: number; yaw: number;
  hp: number; alive: boolean; frontCooldown: number; topCooldown: number; heat: number;
  overheated: boolean; frontActive: boolean; topActive: boolean;
  stats: { damage: number; kills: number; shots: number };
}
export interface Projectile { id: number; ownerId: string; weapon: ProjectileWeapon; hitIds: string[]; x: number; z: number; yaw: number; distance: number }
export interface GameEvent { id: number; type: 'hit' | 'elimination' | 'shot'; playerId: string; attackerId?: string; reason?: string; x: number; z: number }
export interface RoomState {
  code: string; hostId: string; phase: Phase; players: PlayerState[]; projectiles: Projectile[];
  events: GameEvent[]; winnerId: string | null; draw: boolean; remaining: number; countdown: number; notice: string; round: number;
}
export function validName(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(value); }
export function validEquipment(value: unknown): value is { front: FrontWeapon; top: TopWeapon } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFrontWeapon(v.front) && isTopWeapon(v.top);
}
export function validInput(value: unknown): value is Input {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.forward === 'number' && Number.isFinite(v.forward) && Math.abs(v.forward) <= 1 && typeof v.turn === 'number' && Number.isFinite(v.turn) && Math.abs(v.turn) <= 1 && typeof v.front === 'boolean' && typeof v.top === 'boolean';
}
export function drive(p: { x: number; z: number; yaw: number }, input: Input, dt: number): void {
  p.yaw += input.turn * 2.25 * dt;
  const speed = input.forward >= 0 ? 8 : 5;
  p.x += Math.sin(p.yaw) * input.forward * speed * dt;
  p.z += Math.cos(p.yaw) * input.forward * speed * dt;
}
export function makePlayer(id: string, name: string, front: FrontWeapon, top: TopWeapon, index: number): PlayerState {
  return { id, name: name.trim(), front, top, color: COLORS[index % 4]!, ready: false, loaded: false, connected: true, x: 0, z: 0, yaw: 0, hp: 100, alive: true, frontCooldown: 0, topCooldown: 0, heat: 0, overheated: false, frontActive: false, topActive: false, stats: { damage: 0, kills: 0, shots: 0 } };
}

/** Payload contracts; the server still validates all received data at runtime. */
export interface ClientMessages {
  sync: undefined;
  input: Input;
  equipment: { front: FrontWeapon; top: TopWeapon };
  ready: boolean;
  start: undefined;
  loaded: undefined;
  again: undefined;
}
export interface ServerMessages { snapshot: RoomState; notice: string }
