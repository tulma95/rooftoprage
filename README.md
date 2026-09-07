# Rooftop / Rearmed

A desktop 3D robot arena for solo practice against bots or private matches with 2–4 real players. Build a loadout, share a private room code, and push or destroy the other robots on an industrial rooftop. One life, five minutes, last robot standing; a timeout or simultaneous final elimination is a draw.

Start locally with:

```bash
./scripts/start-local.sh
```

First-time setup requires **Node.js 22.12+ with npm**, then:

```bash
./scripts/setup.sh
./scripts/start-local.sh
```

Setup installs the pinned dependencies using `npm ci` and the committed lockfile. The startup script runs the client and multiplayer server together in the foreground, labels their output, and prints the browser URL (default **http://localhost:5173**). Ctrl+C stops both services and their subprocesses. It also works when invoked by its absolute path from another directory. Missing prerequisites and occupied ports produce startup errors.

Open the printed URL in separate browser windows or on other computers, choose nicknames, and join the same room using its code or invite link. Each browser is an independent player; duplicate nicknames are supported. Everybody readies up, then the host starts. Weapons cannot change during a round. After results, Play again returns the group to its lobby with readiness cleared.

## Solo practice with bots

Start the local game with `./scripts/start-local.sh` and open http://localhost:5173. Enter a nickname, choose **Play with bots**, then **Ready up** and **Launch round**. Only one browser is needed. Your saved loadout is used; you can change it in the staging area.

Three bots steer, aim, use their weapons, and try to avoid the edge. They follow the same damage, cooldown, heat, and elimination rules as human pilots. **Play again** returns to the lobby with bots ready for a rematch. Practice rooms are reserved for one human; use **Create private room** to play with friends.

## Controls and weapons

| Key | Action |
| --- | --- |
| W / S | Drive forward / reverse |
| A / D | Turn left / right; steering also aims weapons |
| Space | Activate front weapon |
| E | Activate top weapon |

Each robot has 100 health and one weapon per slot. Hold an activation key to repeat attacks or sustain the saw, drill, or flame. Damage, cooldown, heat, and results are decided by the server. Distances below are world units; the roof is 44 × 44 units. The editable definitions are in `shared/game.ts`.

| Slot | Weapon | Damage | Range | Behavior / limit |
| --- | --- | --- | --- | --- |
| Front | Impact Ram | 12 per strike | 2.9 | Forward strike and strong shove; 1.1 s cooldown |
| Front | Rotor Saw | 22 per second | 2.7 | Continuous close-range cutting while held; no heat or cooldown |
| Front | Forge Hammer | 32 per strike | 3.2 | Heavy forward strike and small shove; 1.8 s cooldown |
| Front | Auger Drill | 28 per second | 3 | Continuous cutting in a narrow forward arc; no heat or cooldown |
| Top | Bolt Cannon | 24 per projectile | 38 travel distance | Forward projectile; 1.5 s cooldown |
| Top | Furnace Jet | 17 per second | 6.5 | Forward cone; overheats after 3 s, cools from full in 4 s; must fully cool after overheating |
| Top | Scrap Scattergun | 7 × 5 pellets (35 maximum) | 16 travel distance | Five spreading projectiles at 30 units/s; 1.2 s cooldown |
| Top | Arc Railgun | 42 per target | 50 travel distance | Piercing bolt at 65 units/s; hits each opponent once; 2.6 s cooldown |

There are four choices per slot and 16 possible loadouts. The scattergun spreads across roughly 21 degrees, rewarding close-range aim; the railgun rewards lining up multiple opponents. Shot statistics count trigger pulls, so a scattergun volley counts as one shot. Projectile ranges are measured from the muzzle.

These are initial tuning values, pending human playtesting. Falling off the roof eliminates a robot regardless of health. Eliminated players can watch surviving players or leave. Settings and help are available from the interface; nickname, equipment, and settings are saved locally when browser storage is available. Storage failure does not prevent play.

## Configuration and LAN play

Defaults need no configuration. Copy `.env.example` to `.env` to override:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIENT_PORT` | `5173` | Local Vite browser port |
| `SERVER_PORT` | `2567` | Multiplayer HTTP / WebSocket port |
| `VITE_SERVER_URL` | Development: page hostname + server port; production: page origin | Explicit multiplayer URL, for example `wss://game-server.example.com` |

Ports must be distinct integers from 1024–65535. Exported environment variables take precedence over `.env`. Restart after changes; browser configuration is incorporated at build time for production.

For another computer on the same network, open `http://<host-LAN-IP>:5173` using the host's real LAN address, then share a room code. Allow the client and server ports through the host firewall. The client uses the page's hostname to reach the game server, so an invite must use the LAN address rather than `localhost`. LAN development uses unencrypted HTTP/WebSocket connections.

## Build, checks, and hosting

```bash
npm run typecheck
npm test
npm run build
npm start
```

`build` creates browser assets in `dist/` and compiled server/shared code in `dist-server/`. `npm start` serves both the browser and multiplayer HTTP/WebSocket traffic on port 2567. Production browser connections use the page’s hostname, port, and protocol automatically. For public hosting, put this port behind an HTTPS reverse proxy with WebSocket support. No `VITE_SERVER_URL` is needed for same-domain hosting. Run `./deploy.sh ghcr.io/owner/image` to build and publish to GHCR; `./deploy.sh --help` includes Coolify setup and automatic deployment options. Configure `SERVER_PORT` in the process environment for `npm start`; the local launcher loads `.env`, while production startup does not.

The Docker runtime uses Alpine’s Node 24 package with only server dependencies and compiled assets. npm, Yarn, TypeScript, and browser-only libraries stay in the build stages. The default deployment target is Linux ARM64.

One Node process owns its rooms in memory. A restart loses rooms and ends matches. This version has no persistence, accounts, reconnection into an active round, matchmaking, or multi-process room coordination. A dropped connection removes a lobby player or eliminates an active robot. Host ownership moves to the longest-present connected player. Empty rooms are disposed. Loading has a 20-second timeout and a three-second shared countdown.

## Code and assets

- `client/`: TypeScript browser interface, Three.js renderer, procedural models, effects, audio, and input. Three.js provides lightweight editable meshes, lighting, and a follow camera without an external modeling pipeline.
- `server/`: Colyseus private rooms and authoritative movement, collision, combat, eliminations, and round rules. The simulation runs at 20 Hz and broadcasts confirmed snapshots; clients send controls rather than positions or damage.
- `shared/`: equipment definitions, message/state types, validators, and reusable movement rules shared by both sides.
- `tests/`: automated rule and room checks.
- `scripts/`: reproducible setup, foreground local startup, and browser regression checks.
- `vite.config.ts` / `client/sdk-storage.ts`: a scoped adapter for the pinned SDK’s optional auth-storage access, so a failed browser storage read cannot block account-free play.

Robot chassis, interchangeable weapon meshes, rooftop scenery, and effects are original procedural assets with editable source. No downloaded model, image, or music assets are required. The project is inspired by the RobotRage genre and uses its own game title and models. Dependencies retain their respective licenses.

Typography uses Barlow Condensed and IBM Plex Sans, served by Google Fonts under the SIL Open Font License. CSS includes local fallback fonts, so the game remains usable when the font service is unavailable. Fonts are fetched from Google when network access permits; no font binaries are bundled.

## Verification and limitations

All 30 automated game-rule, bot, rendering-resource, and multiplayer room tests pass, along with strict TypeScript checks and the production build. Startup was checked through `scripts/start-local.sh` from another working directory with alternate ports: both HTTP endpoints responded, occupied server and client ports produced clear errors, Ctrl+C exited cleanly and released both ports, and a child startup failure stopped the other service. Missing dependency handling and Bash/Node script syntax were also checked.

Automated browser playthroughs cover two-, three-, and four-browser matches, loadouts, ready/countdown, menu settings, roof falls, results, rematches, spectator switching, host departure, invalid codes, text-only names, and blocked-storage room creation. Screenshots were inspected at 1440×900 and 1024×768. The repeatable browser check uses installed Google Chrome: start the game with `./scripts/start-local.sh`, then run `npm run test:browser` in another terminal. Set `BROWSER_URL` if the browser port is overridden. It captures screenshots in `artifacts/`. Human balancing of 2-, 3-, and 4-player matches still requires playtesting. The first version targets desktop keyboard play; mobile/touch controls, moving hazards, upgrades, and progression are outside scope. Server authority prevents trusting client damage or positions, but this prototype is not a production abuse-prevention service.

The new-weapon browser regression is `node scripts/weapons-browser-check.mjs` with the local game running. It checks all four additions, saved loadouts, synchronized lobby choices, firing, combat damage, and weapon HUD states.

The solo-practice browser regression is `node scripts/bots-browser-check.mjs`. It checks a single browser entering a room with three bots, combat through results, rematching, and leaving.
