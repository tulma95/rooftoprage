import { ARENA_HALF, EMPTY_INPUT, WEAPONS, type Input, type PlayerState } from '../shared/game.js';

const retreating = new WeakSet<PlayerState>();

/** Bots use the same steering and weapon inputs as human pilots. */
export function botInput(bot: PlayerState, players: readonly PlayerState[]): Input {
  if (!bot.alive) return EMPTY_INPUT;
  let target: PlayerState | undefined,
    distance = Infinity;
  for (const player of players) {
    if (player.id === bot.id || !player.alive) continue;
    const d = Math.hypot(player.x - bot.x, player.z - bot.z);
    if (d < distance) {
      target = player;
      distance = d;
    }
  }
  if (!target) return EMPTY_INPUT;
  const edgeDistance = ARENA_HALF - Math.max(Math.abs(bot.x), Math.abs(bot.z));
  if (edgeDistance < 3) retreating.add(bot);
  else if (edgeDistance > 6) retreating.delete(bot);
  // Finish the retreat before re-aiming, rather than oscillating at the safety boundary.
  const nearEdge = retreating.has(bot);
  const dx = (nearEdge ? 0 : target.x) - bot.x,
    dz = (nearEdge ? 0 : target.z) - bot.z;
  const angle = Math.atan2(dx, dz) - bot.yaw;
  const error = Math.atan2(Math.sin(angle), Math.cos(angle));
  const aimed = !nearEdge && Math.abs(error) < 0.18;
  const targetAngle = Math.atan2(target.x - bot.x, target.z - bot.z) - bot.yaw;
  const frontAimed = Math.abs(Math.atan2(Math.sin(targetAngle), Math.cos(targetAngle))) < 0.3;
  const pusher = bot.front === 'ram' || bot.front === 'wedge' || bot.front === 'flipper';
  return {
    turn: Math.max(-1, Math.min(1, error * 2)),
    forward: Math.abs(error) < 0.8 && (nearEdge || distance > 2.5 || pusher) ? 1 : 0,
    boost:
      pusher &&
      aimed &&
      distance > 3 &&
      distance < 6 &&
      Math.max(Math.abs(bot.x), Math.abs(bot.z)) < ARENA_HALF - 7 &&
      (bot.boostCooldown ?? 0) <= 0,
    front: frontAimed && distance < WEAPONS[bot.front].range,
    top: aimed && distance < WEAPONS[bot.top].range && !bot.overheated,
  };
}
