# Rooftop / Rearmed

A desktop robot arena inspired by RobotRage. Build your machine and battle on an industrial rooftop, solo against bots or in a private room with friends.

Drive with WASD or the arrow keys. Tap Shift for a short burst: forward by default, or toward the direction you hold for a quick dodge. Burst recharges in 2.5 seconds. Speed, chassis weight, and impact angle determine how robots shove and spin each other, so leave room to recover near the rooftop edge.

The Impact Ram delivers a shove with recoil (Space). The new Lifter Wedge gets underneath opponents at front contact, reducing their traction while you drive them backward; hold Space for a powered shove at close range. Side and rear rams receive extra force, with rear hits strongest. Existing top weapons remain on E. Solo opponents also use bursts and pushing attachments.

Three more front attachments offer different ways to move opponents. Side Sweeper knocks them sideways and spins them; Flip Fork launches them forward and briefly lifts them; Tow Hook catches the nearest opponent in its forward arc and yanks both machines toward each other. Activate them with Space and use the short burst to line up a hit or escape after committing.

**[Play Rooftop / Rearmed](https://rooftoprage.rigster.cv/)**

## Run locally

Install Node.js and npm, then run:

```bash
./scripts/setup.sh
./scripts/start-local.sh
```

Open the URL printed by the launcher. Ctrl+C stops the game services.

For configuration, copy [`.env.example`](.env.example) to `.env` and adjust it before starting. To play over a local network, open the game using the host computer’s LAN address and share that address instead of `localhost`. Allow the client and server ports through the host’s firewall.

## Development

See [`package.json`](package.json) for build, formatting, and test commands.

Browser checks require Google Chrome and a running local game. Run `npm run test:browser` in a separate terminal; set `BROWSER_URL` if using a different address.

Other checks in `scripts/*-check.mjs` cover individual features; run them with `node scripts/<name>.mjs`. Screenshots go to `artifacts/`.

See [combat presentation](docs/combat-presentation.md) for the effects, cinematic, settings, and city details.

## Hosting

Use `./deploy.sh --help` for container publishing and Coolify deployment instructions.

Public hosting needs an HTTPS reverse proxy with WebSocket support. Set production configuration through environment variables; `.env` is loaded by the local launcher only.

Run a single game server instance. Rooms are kept in memory, so restarting or deploying ends active matches. Schedule deployments accordingly.

## Credits

Inspired by the RobotRage genre, with original procedural models, effects, and music. Dependencies retain their respective licenses. Barlow Condensed and IBM Plex Sans are provided through Google Fonts under the SIL Open Font License.

Scanned PBR textures and the sky HDRI are from [Poly Haven](https://polyhaven.com) under CC0 1.0 (public domain): concrete_floor_worn_001, blue_metal_plate, rusty_metal_04, rubberized_track, concrete_wall_008 and belfast_sunset_puresky. See `client/assets.ts`.
