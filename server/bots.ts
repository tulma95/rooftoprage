import { ARENA_HALF, EMPTY_INPUT, WEAPONS, type Input, type PlayerState } from '../shared/game.js';

/** Bots use the same steering and weapon inputs as human pilots. */
export function botInput(bot: PlayerState, players: readonly PlayerState[]): Input {
  if (!bot.alive) return EMPTY_INPUT;
  let target: PlayerState | undefined, distance = Infinity;
  for (const player of players) {
    if (player.id === bot.id || !player.alive) continue;
    const d = Math.hypot(player.x - bot.x, player.z - bot.z);
    if (d < distance) { target = player; distance = d; }
  }
  if (!target) return EMPTY_INPUT;
  const nearEdge = Math.max(Math.abs(bot.x), Math.abs(bot.z)) > ARENA_HALF - 4;
  const dx = (nearEdge ? 0 : target.x) - bot.x, dz = (nearEdge ? 0 : target.z) - bot.z;
  const angle = Math.atan2(dx, dz) - bot.yaw;
  const error = Math.atan2(Math.sin(angle), Math.cos(angle));
  const aimed = !nearEdge && Math.abs(error) < .18;
  return {
    turn: Math.max(-1, Math.min(1, error * 2)),
    forward: Math.abs(error) < .8 && (nearEdge || distance > 2.5) ? 1 : 0,
    front: aimed && distance < WEAPONS[bot.front].range,
    top: aimed && distance < WEAPONS[bot.top].range && !bot.overheated,
  };
}
