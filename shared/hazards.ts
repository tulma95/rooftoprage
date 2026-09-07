import { drive, type Chassis, type Input } from './game.js';

export const HAZARD_RULES = { tankRadius: .9, tankHp: 36, blastRadius: 5, blastDamage: 38, oilBurnSeconds: 10, fireDamage: 9, robotBurnSeconds: 3 };
export const OIL_SLICKS = [ { x: -8, z: -5, radius: 3.2 }, { x: 8, z: 5, radius: 3.2 }, { x: -13, z: 10, radius: 2.6 }, { x: 13, z: -10, radius: 2.6 } ];
export const COOLING_POOLS = [ { x: -7, z: 5, radius: 2.8 }, { x: 7, z: -5, radius: 2.8 } ];
export interface Tank { id: string; x: number; z: number; hp: number }
export interface Oil { burning: number; attackerId?: string }
export function makeHazards(): { tanks: Tank[]; oil: Oil[] } {
  return { tanks: [{ x: -8, z: -7 }, { x: -11, z: -7 }, { x: 8, z: 7 }, { x: 11, z: 7 }, { x: -14, z: 11 }, { x: 14, z: -11 }].map((p,i) => ({ ...p, id: `tank-${i}`, hp: HAZARD_RULES.tankHp })), oil: OIL_SLICKS.map(() => ({ burning: 0 })) };
}
export function within(p: { x: number; z: number }, area: { x: number; z: number; radius: number }): boolean { return Math.hypot(p.x-area.x,p.z-area.z) < area.radius; }
export function driveTerrain(p: { x: number; z: number; yaw: number; chassis?: Chassis }, input: Input, dt: number): void {
  const cooling = COOLING_POOLS.some(pool => within(p,pool));
  const oily = OIL_SLICKS.some(oil => within(p,oil));
  drive(p, { ...input, forward: input.forward * (cooling ? .6 : 1), turn: input.turn * (oily ? .4 : 1) }, dt);
}
