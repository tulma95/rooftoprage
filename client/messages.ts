import type { Room } from '@colyseus/sdk';
import type { ServerMessages } from '../shared/game.js';

export function onServerMessage<K extends keyof ServerMessages>(
  room: Room,
  type: K,
  handler: (payload: ServerMessages[K]) => void,
): () => void {
  return room.onMessage(type, handler);
}
