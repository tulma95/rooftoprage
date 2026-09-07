import { randomBytes } from 'node:crypto';
import { Room, type Client, ServerError } from '@colyseus/core';
import {
  CHASSIS,
  type Chassis,
  makePlayer,
  validName,
  validEquipment,
  validInput,
  type FrontWeapon,
  type TopWeapon,
} from '../shared/game.js';
import { Simulation } from './simulation.js';
const codes = new Set<string>();
export class ArenaRoom extends Room {
  maxClients = 4;
  autoDispose = true;
  sim = new Simulation();
  practice = false;
  onCreate(options: { practice?: unknown } = {}) {
    this.practice = options.practice === true;
    if (this.practice) this.maxClients = 1;
    do {
      this.roomId = randomBytes(3).toString('hex').toUpperCase();
    } while (codes.has(this.roomId));
    codes.add(this.roomId);
    this.sim.state.code = this.roomId;
    this.setPrivate(true);
    this.onMessage('sync', (c) => c.send('snapshot', this.sim.state));
    this.onMessage('input', (c, data: unknown) => {
      if (validInput(data) && this.sim.state.phase === 'combat')
        this.sim.inputs.set(c.sessionId, { input: data, time: this.sim.time });
    });
    this.onMessage('equipment', (c, data: unknown) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'lobby' && validEquipment(data)) {
        p.front = data.front;
        p.top = data.top;
        p.chassis = data.chassis ?? p.chassis;
        p.hp = CHASSIS[p.chassis].hp;
        p.ready = false;
      }
    });
    this.onMessage('ready', (c, data: unknown) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'lobby' && typeof data === 'boolean') p.ready = data;
    });
    this.onMessage('start', (c) => {
      const s = this.sim.state;
      if (
        c.sessionId !== s.hostId ||
        s.phase !== 'lobby' ||
        s.players.length < 2 ||
        !s.players.every((p) => p.ready)
      )
        return c.send('notice', 'The host can start once 2–4 players are ready.');
      this.sim.start();
      void this.lock();
    });
    this.onMessage('loaded', (c) => {
      const p = this.player(c);
      if (p && this.sim.state.phase === 'loading') p.loaded = true;
    });
    this.onMessage('again', () => {
      if (this.sim.state.phase === 'results') this.lobby('Ready up for another round.');
    });
    this.onMessage('*', () => {});
    this.setSimulationInterval(() => {
      const s = this.sim.state;
      const previousPhase = s.phase;
      this.sim.step(0.05);
      if (previousPhase !== 'lobby' && s.phase === 'lobby') void this.unlock();
      this.broadcast('snapshot', s);
    }, 50);
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
    const used = new Set(s.players.map((p) => p.color));
    let i = 0;
    while (used.has(makePlayer('', '', 'ram', 'cannon', i).color)) i++;
    s.players.push(makePlayer(c.sessionId, o.name, o.front, o.top, i, o.chassis));
    if (!s.hostId) s.hostId = c.sessionId;
    if (this.practice && s.players.length === 1) {
      const loadouts = [
        ['ram', 'cannon'],
        ['saw', 'flamethrower'],
        ['hammer', 'scattergun'],
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
    c.send('snapshot', s);
  }
  onLeave(c: Client) {
    const previousPhase = this.sim.state.phase;
    this.sim.disconnect(c.sessionId);
    if (previousPhase !== 'lobby' && this.sim.state.phase === 'lobby') void this.unlock();
  }
  lobby(notice: string) {
    this.sim.returnToLobby(notice);
    void this.unlock();
  }
  onDispose() {
    codes.delete(this.roomId);
  }
}
