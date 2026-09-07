# Rooftop / Rearmed

A desktop robot arena inspired by RobotRage. Build your machine and battle on an industrial rooftop, solo against bots or in a private room with friends.

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

## Hosting

Use `./deploy.sh --help` for container publishing and Coolify deployment instructions.

Public hosting needs an HTTPS reverse proxy with WebSocket support. Set production configuration through environment variables; `.env` is loaded by the local launcher only.

Run a single game server instance. Rooms are kept in memory, so restarting or deploying ends active matches. Schedule deployments accordingly.

## Credits

Inspired by the RobotRage genre, with original procedural models, effects, and music. Dependencies retain their respective licenses. Barlow Condensed and IBM Plex Sans are provided through Google Fonts under the SIL Open Font License.
