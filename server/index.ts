import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ArenaRoom } from './arena-room.js';
const browserAssets = fileURLToPath(new URL('../../dist/', import.meta.url));
const server = new Server({
  transport: new WebSocketTransport({ maxPayload: 2048 }),
  express: (app) => {
    const health = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', game: 'Rooftop / Rearmed' }));
    };
    app.get('/health', health);
    if (existsSync(browserAssets)) {
      app.use(
        '/assets',
        express.static(`${browserAssets}/assets`, { immutable: true, maxAge: '1y' }),
      );
      app.use(express.static(browserAssets, { maxAge: 0 }));
    } else {
      app.get('/', health);
    }
  },
});
server.define('arena', ArenaRoom);
await server.listen(Number(process.env.SERVER_PORT ?? 2567), '0.0.0.0');
console.log(`Arena online on port ${process.env.SERVER_PORT ?? 2567}`);
