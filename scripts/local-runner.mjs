import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const fail = (message) => { console.error(`[startup] ${message}`); process.exit(1); };
if (((v) => v[0] < 22 || (v[0] === 22 && v[1] < 12))(process.versions.node.split('.').map(Number))) fail('Node.js 22.12+ is required.');
// Optional local configuration; exported environment variables take precedence.
if (existsSync('.env')) {
  const original = { ...process.env };
  try { process.loadEnvFile('.env'); Object.assign(process.env, original); }
  catch (error) { fail(`Cannot load .env: ${error.message}`); }
}
for (const dependency of ['tsx', 'vite', '@colyseus/core', 'three']) {
  if (!existsSync(`node_modules/${dependency}/package.json`)) fail(`Missing ${dependency}. Run ./scripts/setup.sh first.`);
}
function port(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) fail(`${name} must be an integer from 1024 to 65535.`);
  return Number(value);
}
const serverPort = port('SERVER_PORT', 2567);
const clientPort = port('CLIENT_PORT', 5173);
if (serverPort === clientPort) fail('SERVER_PORT and CLIENT_PORT must be different.');
for (const [name, value] of [['server', serverPort], ['client', clientPort]]) {
  await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error) => {
      const advice = error.code === 'EADDRINUSE'
        ? `Stop the conflicting service or set ${name.toUpperCase()}_PORT in .env.`
        : error.code === 'EPERM' || error.code === 'EACCES'
          ? 'This environment does not permit listening on the port. Allow local network access and retry.'
          : 'Check local network configuration and retry.';
      fail(`Cannot use ${name} port ${value}: ${error.code}. ${advice}`);
    });
    probe.listen(value, '0.0.0.0', () => probe.close(resolve));
  });
}
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  console.log('\n[startup] Stopping client and server…');
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  // Kill entire owned process groups, including npm grandchildren that ignored TERM.
  setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
    }
    process.exit(code);
  }, 1000);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
const env = { ...process.env, SERVER_PORT: String(serverPort), CLIENT_PORT: String(clientPort), VITE_SERVER_PORT: String(serverPort), FORCE_COLOR: '0' };
function start(label, args) {
  const child = spawn('npm', args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream }).on('line', (line) => output.write(`[${label}] ${line}\n`));
  }
  child.once('error', (error) => { console.error(`[${label}] Failed to start: ${error.message}`); stop(1); });
  child.once('exit', (code, signal) => {
    if (!stopping) { console.error(`[${label}] Exited unexpectedly (${signal ?? code}).`); stop(code || 1); }
  });
}
console.log(`[startup] Browser: http://localhost:${clientPort}`);
console.log(`[startup] Multiplayer server: port ${serverPort}`);
console.log('[startup] Choose Play with bots for solo practice, or share a room code with friends.');
console.log(`[startup] Other computers: use http://<this-computer-LAN-IP>:${clientPort} (allow both ports through your firewall).`);
console.log('[startup] Running in foreground. Ctrl+C stops both services.');
start('server', ['run', 'dev:server']);
start('client', ['run', 'dev:client', '--', '--port', String(clientPort), '--strictPort']);
