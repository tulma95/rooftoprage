import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Server, Room, type Client, ServerError } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { makePlayer, validName, validEquipment, validInput, type FrontWeapon, type TopWeapon } from '../shared/game.js';
import { Simulation } from './simulation.js';
const codes = new Set<string>();
export class ArenaRoom extends Room {
  maxClients = 4; autoDispose = true; sim = new Simulation(); phaseElapsed = 0; practice = false;
  onCreate(options: { practice?: unknown } = {}) {
    this.practice = options.practice === true;
    if (this.practice) this.maxClients = 1;
    do { this.roomId = randomBytes(3).toString('hex').toUpperCase(); } while (codes.has(this.roomId)); codes.add(this.roomId); this.sim.state.code = this.roomId; this.setPrivate(true);
    this.onMessage('sync', c => c.send('snapshot', this.sim.state));
    this.onMessage('input', (c, data: unknown) => { if (validInput(data) && this.sim.state.phase === 'combat') this.sim.inputs.set(c.sessionId, { input: data, time: this.sim.time }); });
    this.onMessage('equipment', (c, data: unknown) => { const p = this.player(c); if (p && this.sim.state.phase === 'lobby' && validEquipment(data)) { p.front = data.front; p.top = data.top; p.ready = false; } });
    this.onMessage('ready', (c, data: unknown) => { const p = this.player(c); if (p && this.sim.state.phase === 'lobby' && typeof data === 'boolean') p.ready = data; });
    this.onMessage('start', c => { const s = this.sim.state; if (c.sessionId !== s.hostId || s.phase !== 'lobby' || s.players.length < 2 || !s.players.every(p => p.ready)) return c.send('notice', 'The host can start once 2–4 players are ready.'); this.sim.start(); s.phase = 'loading'; s.notice = ''; this.phaseElapsed = 0; void this.lock(); });
    this.onMessage('loaded', c => { const p = this.player(c); if (p && this.sim.state.phase === 'loading') p.loaded = true; });
    this.onMessage('again', () => { if (this.sim.state.phase === 'results') this.lobby('Ready up for another round.'); });
    this.onMessage('*', () => {});
    this.setSimulationInterval(() => {
      const s = this.sim.state; this.phaseElapsed += .05;
      if (s.phase === 'loading') { if (s.players.every(p => p.loaded)) { s.phase = 'countdown'; this.phaseElapsed = 0; } else if (this.phaseElapsed > 20) this.lobby('Loading timed out. Check your connection and try again.'); }
      else if (s.phase === 'countdown') { s.countdown = Math.max(0, 3 - this.phaseElapsed); if (s.countdown === 0) s.phase = 'combat'; }
      this.sim.step(.05); this.broadcast('snapshot', s);
    }, 50);
  }
  player(c: Client) { return this.sim.state.players.find(p => p.id === c.sessionId); }
  onAuth(_c: Client, options: unknown) { const o = options as Record<string, unknown> | null; if (!o || !validName(o.name) || !validEquipment(o)) throw new ServerError(400, 'Choose a name of 1–20 characters and valid weapons.'); if (this.sim.state.phase !== 'lobby') throw new ServerError(409, 'This round is already in progress.'); return true; }
  onJoin(c: Client, o: { name: string; front: FrontWeapon; top: TopWeapon }) { const s = this.sim.state; const used = new Set(s.players.map(p => p.color)); let i = 0; while (used.has(makePlayer('', '', 'ram', 'cannon', i).color)) i++; s.players.push(makePlayer(c.sessionId, o.name, o.front, o.top, i)); if (!s.hostId) s.hostId = c.sessionId;
    if (this.practice && s.players.length === 1) {
      const loadouts = [['ram', 'cannon'], ['saw', 'flamethrower'], ['hammer', 'scattergun']] as const;
      loadouts.forEach(([front, top], i) => {
        const bot = makePlayer(`bot-${i}`, ['Rivet', 'Cinder', 'Scrapper'][i]!, front, top, i + 1);
        bot.bot = true; bot.ready = true; s.players.push(bot);
      });
      s.notice = 'Practice against three bots. Ready up, then launch when you are set.';
    }
    c.send('snapshot', s); }
  onLeave(c: Client) { const s = this.sim.state; const p = this.player(c); this.sim.inputs.delete(c.sessionId); if (p) { p.connected = false; if (s.phase === 'combat') { this.sim.eliminate(p, 'disconnected'); this.sim.finishIfNeeded(); } else if (s.phase === 'loading' || s.phase === 'countdown') this.lobby('A player left before combat. Ready up again.'); if (s.phase === 'lobby') s.players = s.players.filter(a => a.id !== c.sessionId); } if (s.hostId === c.sessionId) s.hostId = s.players.find(a => a.connected && !a.bot)?.id ?? ''; }
  lobby(notice: string) { const s = this.sim.state; s.phase = 'lobby'; s.players = s.players.filter(p => p.connected); s.players.forEach(p => { p.ready = !!p.bot; p.loaded = false; }); s.notice = notice; this.sim.inputs.clear(); void this.unlock(); }
  onDispose() { codes.delete(this.roomId); }
}
const browserAssets = fileURLToPath(new URL('../../dist/', import.meta.url));
const server = new Server({
  transport: new WebSocketTransport({ maxPayload: 2048 }),
  express: app => {
    const health = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ status: 'ok', game: 'Rooftop / Rearmed' })); };
    app.get('/health', health);
    if (existsSync(browserAssets)) {
      app.use('/assets', express.static(`${browserAssets}/assets`, { immutable: true, maxAge: '1y' }));
      app.use(express.static(browserAssets, { maxAge: 0 }));
    } else {
      app.get('/', health);
    }
  },
});
server.define('arena', ArenaRoom);
await server.listen(Number(process.env.SERVER_PORT ?? 2567), '0.0.0.0');
console.log(`Arena online on port ${process.env.SERVER_PORT ?? 2567}`);
