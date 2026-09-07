import { Client, type Room } from '@colyseus/sdk';
import type { RoomState } from '../shared/game.js';
import type { Profile } from './profile.js';
import { onServerMessage } from './messages.js';
import { sendClientMessage } from '../shared/protocol.js';

interface SessionEvents {
  joined(room: Room): void;
  snapshot(state: RoomState, room: Room): void;
  notice(message: string): void;
  disconnected(): void;
}

export class ArenaSession {
  private client: Client;
  private room: Room | null = null;
  constructor(
    readonly endpoint: string,
    private events: SessionEvents,
  ) {
    this.client = new Client(endpoint);
  }

  async connect(profile: Omit<Profile, 'settings'>, code?: string, practice = false) {
    const options = {
      name: profile.nickname,
      chassis: profile.chassis,
      front: profile.front,
      top: profile.top,
      practice,
    };
    const joined = code
      ? await this.client.joinById(code, options)
      : await this.client.create('arena', options);
    joined.reconnection.enabled = false;
    this.room = joined;
    this.events.joined(joined);
    onServerMessage(joined, 'snapshot', (state) => {
      if (this.room === joined) this.events.snapshot(state, joined);
    });
    onServerMessage(joined, 'notice', (message) => {
      if (this.room === joined) this.events.notice(message);
    });
    joined.onError((_code, message) => {
      if (this.room === joined) this.events.notice(message || 'Connection error.');
    });
    joined.onLeave(() => {
      if (this.room !== joined) return;
      this.room = null;
      this.events.disconnected();
    });
    sendClientMessage(joined, 'sync');
  }

  async leave() {
    const previous = this.room;
    this.room = null;
    try {
      await previous?.leave();
    } catch {
      /* Local session is already cleared. */
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.endpoint.replace(/^ws/, 'http').replace(/\/$/, '')}/health`,
        {
          signal: AbortSignal.timeout(2500),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function connectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|invalid room/i.test(message)
    ? 'Room not found. Check the code or ask for a new invite.'
    : /locked|full|seat/i.test(message)
      ? 'This room is full or its round has already started. Ask the host to invite you after the round.'
      : `Could not connect: ${message}. Check that the multiplayer server is running.`;
}
