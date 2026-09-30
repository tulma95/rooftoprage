# Rooftop / Rearmed

A robot arena inspired by RobotRage. Build your machine and battle on an industrial rooftop, solo against bots or in a private room with friends. Destroy the other robots or push them off the edge.

Drive with WASD or the arrow keys, Shift for a short burst, Space for the front attachment and E for the top weapon. On mobile, play in landscape with the touch joystick and buttons.

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

Browser checks need Chrome and a running local game: `npm run test:browser` (set `BROWSER_URL` for another address).
Other feature checks live in `scripts/*-check.mjs`. See [combat presentation](docs/combat-presentation.md) for effects and settings.

## Hosting

Use `./deploy.sh --help` for container publishing and Coolify deployment instructions.

Public hosting needs an HTTPS reverse proxy with WebSocket support. Run a single server instance: rooms live in memory, so a deploy ends active matches. `.env` is only read by the local launcher.

## Credits

Inspired by the RobotRage genre, with original procedural models, effects, and music. Dependencies retain their respective licenses. Barlow Condensed and IBM Plex Sans are provided through Google Fonts under the SIL Open Font License.

Scanned PBR textures and the sky HDRI are from [Poly Haven](https://polyhaven.com) under CC0 1.0 (public domain): concrete_floor_worn_001, blue_metal_plate, rusty_metal_04, rubberized_track, concrete_wall_008 and belfast_sunset_puresky. See `client/assets.ts`.
