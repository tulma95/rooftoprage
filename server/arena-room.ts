import { clientMessageValidators, sendServerMessage } from '../shared/protocol.js';
import type { ClientMessages, ServerMessages } from '../shared/game.js';
import { randomBytes } from 'node:crypto';
import {
  Room,
  type Client,
  type RoomException,
  type RoomMethodName,
  ServerError,
} from '@colyseus/core';
import {
  CHASSIS,
  COLORS,
  TICK_SECONDS,
  type Chassis,
  makePlayer,
  validName,
  validEquipment,
  type FrontWeapon,
  type TopWeapon,
} from '../shared/game.js';
import { Simulation } from './simulation.js';
const codes = new Set<string>();
export class ArenaRoom extends Room {
  maxClients = 4;
  // Real clients send about 20 inputs per second; anything far above that is abuse.
  maxMessagesPerSecond = 60;
  autoDispose = true;
  sim = new Simulation();
  practice = false;
  private sentEvent = 0;
  private sentSignature = '';
  private sentAt = 0;
  private synced = new Set<string>();
  onCreate(options: { practice?: unknown } = {}) {
    this.practice = options.practice === true;
    if (this.practice) this.maxClients = 1;
    do {
      this.roomId = randomBytes(3).toString('hex').toUpperCase();
    } while (codes.has(this.roomId));
    codes.add(this.roomId);
    this.sim.state.code = this.roomId;
    this.setPrivate(true);
    // One full snapshot per session; repeats would let a client make the server resend state.
    this.onClientMessage('sync', (c) => {
      if (this.synced.has(c.sessionId)) return;
      this.synced.add(c.sessionId);
      sendServerMessage(c, 'snapshot', this.sim.state);
    });
    this.onClientMessage('input', (c, data) => {
      if (this.sim.state.phase === 'combat') this.sim.setInput(c.sessionId, data);
    });
    this.onClientMessage('equipment', (c, data) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'lobby') {
        p.front = data.front;
        p.top = data.top;
        p.chassis = data.chassis ?? p.chassis;
        p.hp = CHASSIS[p.chassis].hp;
        p.ready = false;
      }
    });
    this.onClientMessage('ready', (c, data) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'lobby') p.ready = data;
    });
    this.onClientMessage('start', (c) => {
      const s = this.sim.state;
      if (
        c.sessionId !== s.hostId ||
        s.phase !== 'lobby' ||
        s.players.length < 2 ||
        !s.players.every((p) => p.ready)
      )
        return sendServerMessage(c, 'notice', 'The host can start once 2–4 players are ready.');
      this.sim.start();
      void this.lock();
    });
    this.onClientMessage('loaded', (c) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'loading') p.loaded = true;
    });
    this.onClientMessage('again', (c) => {
      const s = this.sim.state;
      if (s.phase === 'results' && c.sessionId === s.hostId)
        this.lobby('Ready up for another round.');
    });
    this.onMessage('*', () => {});
    this.setSimulationInterval(() => {
      const s = this.sim.state;
      const previousPhase = s.phase;
      this.sim.step(TICK_SECONDS);
      if (previousPhase !== 'lobby' && s.phase === 'lobby') void this.unlock();
      this.broadcastSnapshot();
    }, TICK_SECONDS * 1000);
  }
  private onClientMessage<K extends keyof ClientMessages>(
    type: K,
    handler: (client: Client, payload: ClientMessages[K]) => void,
  ) {
    this.onMessage(type, (client, payload: unknown) => {
      if (clientMessageValidators[type](payload)) handler(client, payload);
    });
  }
  /** Send only unseen events; idle phases resend on change, with a 1 s heartbeat. */
  private broadcastSnapshot() {
    const s = this.sim.state;
    if (s.phase === 'lobby' || s.phase === 'results') {
      const signature = JSON.stringify(s);
      if (signature === this.sentSignature && this.clock.currentTime - this.sentAt < 1000) return;
      this.sentSignature = signature;
    }
    this.sentAt = this.clock.currentTime;
    const events = s.events.filter((e) => e.id > this.sentEvent);
    this.sentEvent = this.sim.serial;
    this.broadcastMessage('snapshot', { ...s, events });
  }
  private broadcastMessage<K extends keyof ServerMessages>(type: K, payload: ServerMessages[K]) {
    this.broadcast(type, payload);
  }
  player(c: Client) {
    return this.sim.state.players.find((p) => p.id === c.sessionId);
  }
  onAuth(_c: Client, options: unknown) {
    const o = options as Record<string, unknown> | null;
    if (!o || !validName(o.name) || !validEquipment(o))
      throw new ServerError(400, 'Choose a name of 1–20 characters and a valid loadout.');
    if (this.sim.state.phase !== 'lobby')
      throw new ServerError(409, 'This round is already in progress.');
    return true;
  }
  onJoin(c: Client, o: { name: string; chassis?: Chassis; front: FrontWeapon; top: TopWeapon }) {
    const s = this.sim.state;
    // A seat reserved just before launch can still connect; onAuth alone cannot stop it.
    if (s.phase !== 'lobby') throw new ServerError(409, 'This round is already in progress.');
    const used = new Set(s.players.map((p) => p.color));
    let i = 0;
    while (used.has(COLORS[i]!)) i++;
    s.players.push(makePlayer(c.sessionId, o.name, o.front, o.top, i, o.chassis));
    if (!s.hostId) s.hostId = c.sessionId;
    if (this.practice && s.players.length === 1) {
      const loadouts = [
        ['ram', 'cannon'],
        ['wedge', 'flamethrower'],
        ['sweeper', 'scattergun'],
      ] as const;
      loadouts.forEach(([front, top], i) => {
        const bot = makePlayer(
          `bot-${i}`,
          ['Rivet', 'Cinder', 'Scrapper'][i]!,
          front,
          top,
          i + 1,
          (['dart', 'bruiser', 'bulwark'] as const)[i],
        );
        bot.bot = true;
        bot.ready = true;
        s.players.push(bot);
      });
      s.notice = 'Practice against three bots. Ready up, then launch when you are set.';
    }
    sendServerMessage(c, 'snapshot', s);
  }
  /** Hold the robot for a short network blip; onLeave runs only if the client never returns. */
  onDrop(c: Client) {
    // Lobby and results seats cost nothing to retake, so free them at once.
    const phase = this.sim.state.phase;
    if (phase === 'lobby' || phase === 'results') return;
    this.sim.inputs.delete(c.sessionId);
    // Colyseus runs onLeave itself if this window expires.
    void this.allowReconnection(c, 10);
  }
  onReconnect(c: Client) {
    sendServerMessage(c, 'snapshot', this.sim.state);
  }
  onLeave(c: Client) {
    this.synced.delete(c.sessionId);
    const previousPhase = this.sim.state.phase;
    this.sim.disconnect(c.sessionId);
    if (previousPhase !== 'lobby' && this.sim.state.phase === 'lobby') void this.unlock();
  }
  lobby(notice: string) {
    this.sim.returnToLobby(notice);
    void this.unlock();
  }
  /** Without this, Colyseus lets a tick error crash the process and every room on it. */
  onUncaughtException(error: RoomException, method: RoomMethodName) {
    if (error.cause instanceof ServerError) return; // Deliberate rejections, e.g. a late join.
    console.error(`ArenaRoom ${this.roomId} ${method}:`, error);
    if (method === 'setTimestep' || method === 'onMessage')
      this.lobby('A server error ended the round. Ready up again.');
  }
  onDispose() {
    codes.delete(this.roomId);
  }
}
