import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Client, type Room } from '@colyseus/sdk';
import type { RoomState } from '../shared/game.js';

let process: ChildProcess;
let endpoint: string;
let output = '';
const rooms = new Set<Room>();
const states = new Map<Room, RoomState>();
const options = { name: 'Duplicate', front: 'ram', top: 'cannon' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error(`Timed out waiting for room state. Server output: ${output}`);
    await delay(25);
  }
}
function observe(room: Room) {
  rooms.add(room);
  room.onMessage('snapshot', (state: RoomState) => states.set(room, state));
  room.onMessage('notice', () => {});
  room.send('sync');
  return room;
}
async function create() {
  try {
    return observe(await new Client(endpoint).create('arena', options));
  } catch (cause) {
    throw new Error(`Could not create room. Server output: ${output}`, { cause });
  }
}
async function join(code: string, overrides = {}) {
  return observe(await new Client(endpoint).joinById(code, { ...options, ...overrides }));
}
function state(room: Room) {
  return states.get(room)!;
}
async function leave(room: Room) {
  rooms.delete(room);
  await room.leave();
}
before(async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  endpoint = `ws://127.0.0.1:${port}`;
  process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...globalThis.process.env, SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  process.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  await until(() => output.includes('Arena online'), 15000);
});
after(async () => {
  await Promise.all([...rooms].map((room) => room.leave().catch(() => {})));
  if (process && process.exitCode === null) {
    process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      process.once('exit', () => resolve());
      setTimeout(() => {
        process.kill('SIGKILL');
        resolve();
      }, 2000).unref();
    });
  }
});

test('server rejects invalid names, slots and missing room codes', async () => {
  for (const overrides of [
    { name: '' },
    { name: 'x'.repeat(21) },
    { front: 'cannon' },
    { top: 'ram' },
  ]) {
    await assert.rejects(new Client(endpoint).create('arena', { ...options, ...overrides }));
  }
  await assert.rejects(new Client(endpoint).joinById('MISSING', options));
  await assert.rejects(new Client(endpoint).joinById('?!invalid', options));
});

test('malformed lobby messages cannot forge readiness, loadouts or state; lost host transfers ownership', async () => {
  const host = await create(),
    guest = await join(host.roomId),
    third = await join(host.roomId);
  await until(() => state(guest)?.players.length === 3);
  host.send('ready', 'true');
  host.send('ready', { playerId: guest.sessionId, ready: true });
  host.send('equipment', null);
  host.send('equipment', { front: 'saw' });
  host.send('input', { forward: 1, turn: 0, front: true, top: true });
  host.send('damage', { playerId: guest.sessionId, hp: 0 });
  host.send('loaded');
  host.send('again');
  await delay(150);
  assert.ok(state(guest).players.every((p) => !p.ready && !p.loaded && p.hp === 100));
  assert.equal(state(guest).players[0]!.front, 'ram');
  assert.equal(state(guest).phase, 'lobby');
  rooms.delete(host);
  host.connection.close();
  await until(() => state(guest).players.length === 2);
  assert.equal(state(guest).hostId, guest.sessionId);
  assert.equal(
    state(third).players.some((p) => p.id === host.sessionId),
    false,
  );
  await leave(guest);
  await until(() => state(third).hostId === third.sessionId);
  await leave(third);
  await delay(150);
  await assert.rejects(new Client(endpoint).joinById(host.roomId, options));
});

for (const count of [2, 3, 4])
  test(`${count} real clients synchronize a round, disconnect elimination and rematch`, async () => {
    const host = await create(),
      clients = [host];
    for (let i = 1; i < count; i++)
      clients.push(
        await join(host.roomId, {
          front: i % 2 ? 'saw' : 'ram',
          top: i % 2 ? 'flamethrower' : 'cannon',
        }),
      );
    await until(() => clients.every((c) => state(c)?.players.length === count));
    assert.equal(new Set(state(host).players.map((p) => p.id)).size, count);
    assert.equal(new Set(state(host).players.map((p) => p.color)).size, count);
    if (count === 4) await assert.rejects(new Client(endpoint).joinById(host.roomId, options));
    host.send('start');
    await delay(100);
    assert.equal(state(host).phase, 'lobby');
    clients.forEach((c) => c.send('ready', true));
    await until(() => state(host).players.every((p) => p.ready));
    clients[1]!.send('equipment', { front: 'ram', top: 'flamethrower' });
    await until(() => state(host).players[1]!.ready === false);
    clients[1]!.send('equipment', { front: 'cannon', top: 'ram' });
    await delay(100);
    assert.equal(state(host).players[1]!.front, 'ram');
    assert.equal(state(host).players[1]!.top, 'flamethrower');
    clients[1]!.send('ready', true);
    await until(() => state(host).players.every((p) => p.ready));
    clients[1]!.send('start');
    await delay(100);
    assert.equal(state(host).phase, 'lobby');
    host.send('start');
    await until(() => clients.every((c) => state(c).phase === 'loading'));
    await assert.rejects(new Client(endpoint).joinById(host.roomId, options));
    host.send('equipment', { front: 'saw', top: 'flamethrower' });
    clients.slice(0, -1).forEach((c) => c.send('loaded'));
    await delay(150);
    assert.equal(state(host).phase, 'loading');
    clients.at(-1)!.send('loaded');
    await until(() => clients.every((c) => state(c).phase === 'combat'));
    assert.equal(state(host).players[0]!.front, 'ram');
    host.send('input', { forward: 100, turn: 0, front: false, top: false });
    await delay(100);
    assert.equal(state(host).players[0]!.z, 12);
    if (count === 2) {
      host.send('input', { forward: 0, turn: 0, front: false, top: true });
      await until(() => clients.every((c) => state(c).players[1]!.hp === 76));
      assert.equal(state(host).players[0]!.stats.damage, 24);
    }
    host.send('input', { forward: 1, turn: 0, front: false, top: false });
    await until(() => clients.every((c) => state(c).players[0]!.z < 12));
    const survivor = clients.at(-1)!;
    for (let i = 0; i < clients.length - 1; i++) {
      await leave(clients[i]!);
      await until(() => state(survivor).players[i]!.alive === false);
      if (i < clients.length - 2) {
        assert.equal(state(survivor).phase, 'combat');
        assert.equal(state(survivor).hostId, clients[i + 1]!.sessionId);
      }
    }
    await until(() => state(survivor).phase === 'results');
    assert.equal(state(survivor).winnerId, survivor.sessionId);
    assert.equal(state(survivor).hostId, survivor.sessionId);
    assert.equal(state(survivor).players.filter((p) => p.alive).length, 1);
    survivor.send('again');
    await until(() => state(survivor).phase === 'lobby');
    assert.equal(state(survivor).players.length, 1);
    assert.equal(state(survivor).players[0]!.ready, false);
    const newcomer = await join(host.roomId);
    await until(() => state(survivor).players.length === 2);
    await leave(newcomer);
    await leave(survivor);
  });

test('host departure during loading returns remaining players to lobby', async () => {
  const host = await create(),
    guest = await join(host.roomId);
  host.send('ready', true);
  guest.send('ready', true);
  await until(() => state(host)?.players.every((p) => p.ready) && state(host).players.length === 2);
  host.send('start');
  await until(() => state(guest).phase === 'loading');
  await leave(host);
  await until(() => state(guest).phase === 'lobby' && state(guest).players.length === 1);
  assert.equal(state(guest).hostId, guest.sessionId);
  assert.equal(state(guest).players[0]!.ready, false);
  assert.match(state(guest).notice, /left/);
  await leave(guest);
});

test('new weapons synchronize, equipment changes clear readiness, and combat locks loadouts', async () => {
  const host = observe(
    await new Client(endpoint).create('arena', { ...options, front: 'hammer', top: 'scattergun' }),
  );
  const guest = await join(host.roomId, { front: 'drill', top: 'railgun' });
  await until(() => state(host)?.players.length === 2 && state(guest)?.players.length === 2);
  assert.deepEqual(
    state(guest).players.map((p) => [p.front, p.top]),
    [
      ['hammer', 'scattergun'],
      ['drill', 'railgun'],
    ],
  );
  host.send('ready', true);
  guest.send('ready', true);
  await until(() => state(host).players.every((p) => p.ready));
  host.send('equipment', { front: 'drill', top: 'railgun' });
  await until(() => state(guest).players[0]!.front === 'drill' && !state(guest).players[0]!.ready);
  assert.equal(state(guest).players[0]!.top, 'railgun');
  host.send('equipment', { front: 'scattergun', top: 'hammer' });
  await delay(100);
  assert.equal(state(host).players[0]!.front, 'drill');
  assert.equal(state(host).players[0]!.top, 'railgun');
  host.send('ready', true);
  await until(() => state(host).players.every((p) => p.ready));
  host.send('start');
  await until(() => state(host).phase === 'loading');
  host.send('loaded');
  guest.send('loaded');
  await until(() => state(guest).phase === 'combat');
  host.send('equipment', { front: 'hammer', top: 'scattergun' });
  await delay(100);
  assert.equal(state(guest).players[0]!.front, 'drill');
  assert.equal(state(guest).players[0]!.top, 'railgun');
  await leave(host);
  await leave(guest);
});

test('loading timeout returns the room to lobby with an explanation', async () => {
  const host = await create(),
    guest = await join(host.roomId);
  host.send('ready', true);
  guest.send('ready', true);
  await until(() => state(host)?.players.length === 2 && state(host).players.every((p) => p.ready));
  host.send('start');
  await until(() => state(host).phase === 'loading');
  host.send('loaded');
  await until(() => state(host).phase === 'lobby', 23000);
  assert.match(state(host).notice, /timed out/);
  assert.ok(state(host).players.every((p) => !p.ready));
  await leave(host);
  await leave(guest);
});

test('one human can launch bot practice; bots load, fight, and do not keep an empty room alive', async () => {
  const host = observe(await new Client(endpoint).create('arena', { ...options, practice: true }));
  await until(() => state(host)?.players.length === 4);
  assert.equal(state(host).hostId, host.sessionId);
  const bots = state(host).players.filter((p) => p.bot);
  assert.equal(bots.length, 3);
  assert.ok(bots.every((p) => p.ready));
  assert.equal(new Set(state(host).players.map((p) => p.color)).size, 4);
  await assert.rejects(new Client(endpoint).joinById(host.roomId, options));
  host.send('ready', true);
  await until(() => state(host).players.every((p) => p.ready));
  host.send('start');
  await until(() => state(host).phase === 'loading');
  assert.ok(
    state(host)
      .players.filter((p) => p.bot)
      .every((p) => p.loaded),
  );
  host.send('loaded');
  await until(() => state(host).phase === 'combat');
  await until(() => state(host).players.some((p) => p.bot && p.stats.shots > 0));
  await leave(host);
  await delay(150);
  await assert.rejects(new Client(endpoint).joinById(host.roomId, options));
});

test('chassis selection synchronizes, clears ready, and stays locked through combat', async () => {
  const host = observe(await new Client(endpoint).create('arena', { ...options, chassis: 'dart' }));
  const guest = await join(host.roomId, { chassis: 'bulwark' });
  await until(() => state(guest)?.players.length === 2);
  assert.deepEqual(
    state(guest).players.map((p) => [p.chassis, p.hp]),
    [
      ['dart', 70],
      ['bulwark', 170],
    ],
  );
  host.send('ready', true);
  await until(() => state(guest).players[0]!.ready);
  host.send('equipment', { ...options, chassis: 'bruiser' });
  await until(
    () => state(guest).players[0]!.chassis === 'bruiser' && !state(guest).players[0]!.ready,
  );
  assert.equal(state(guest).players[0]!.hp, 130);
  host.send('equipment', { ...options, chassis: '__proto__' });
  await delay(100);
  assert.equal(state(guest).players[0]!.chassis, 'bruiser');
  host.send('ready', true);
  guest.send('ready', true);
  await until(() => state(host).players.every((p) => p.ready));
  host.send('start');
  await until(() => state(guest).phase === 'loading');
  host.send('loaded');
  guest.send('loaded');
  await until(() => state(guest).phase === 'combat');
  host.send('equipment', { ...options, chassis: 'dart' });
  await delay(100);
  assert.equal(state(guest).players[0]!.chassis, 'bruiser');
  assert.equal(state(guest).players[0]!.hp, 130);
  await leave(host);
  await leave(guest);
});
