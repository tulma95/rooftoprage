# Robot arena game

Build a complete, playable 3D browser game inspired by **RobotRage 2: Rearmed**. Players attach weapons to a robot, join a private room, and fight on a rooftop. Use original artwork, models, and names.

Reference: [RobotRage history](https://robotrage.pro/?page=history). Use it for inspiration; the requirements below define what to build.

## First version

- Online free-for-all battles for 2, 3, or 4 players.
- Private rooms joined through a code or link.
- Player-chosen nicknames, with no registration or login.
- A camera that follows behind the robot.
- Fixed weapon slots and weapons that aim forward. Players aim by steering.
- One life per round. The last robot standing wins.
- Retro industrial visuals and custom 3D models.
- TypeScript throughout, with Node.js and Colyseus on the server.

Use these defaults for details not chosen by the user:

- One chassis, one rooftop, and all four weapons available from the start. No shop, currency, or upgrades.
- Desktop browsers and keyboard controls.
- Five-minute rounds. If more than one robot remains when time runs out, the round is a draw.
- Save the nickname, equipped weapons, and settings in the browser. Players can still play if saving fails.
- No moving arena hazards in the first version.

## Controls and combat

- **W/S:** drive forward/backward.
- **A/D:** turn the robot.
- **Space:** use the front weapon (default).
- **E:** use the top weapon (default).

Prevent these keys from scrolling the page during play. Show controls in the help screen and beside the weapons during combat.

Each robot has one weapon in each slot:

| Slot | Choices | Purpose |
| --- | --- | --- |
| Front | Ram or saw | Push opponents toward the edge, or deal damage at close range. |
| Top | Cannon or flamethrower | Fire projectiles at a distance, or deal sustained damage nearby. |

Players can change weapons before a round, but not during it. Show their choices on the robot in both the garage and arena. Choose and document each weapon's damage, range, firing behavior, and cooldown or heat limit. Adjust the values through playtesting.

Robots are eliminated when their health reaches zero or they fall off the rooftop. Eliminated players can watch the remaining robots or leave, but cannot return to combat in that round. If the final robots are eliminated simultaneously, declare a draw.

Make driving, pushing, and weapon hits feel responsive. Keep the camera from clipping through scenery or hiding the robot. Start players in separate, fair positions away from the edges.

## Screens

Make every button and screen transition work. Show useful messages when something is loading or goes wrong. Screens can be combined where that makes navigation simpler.

1. **Name entry:** choose a nickname. Reject empty or overly long names on both the browser and server. Display names as text and use separate internal IDs so players with the same name still work correctly.
2. **Home:** access play, garage, settings, and help; show whether the server is connected.
3. **Garage:** preview the robot in 3D, select front and top weapons, compare their stats, and save the selection. Only allow weapons that fit the selected slot.
4. **Create or join room:** create a private room or enter a code/link. Explain invalid codes, missing rooms, full rooms, and rounds already in progress.
5. **Room lobby:** show the join code/link, player names, equipped weapons, readiness, and a leave button. The host can start when 2–4 players are present and everyone is ready.
6. **Loading and countdown:** show the players and arena. Start combat together after everyone has loaded and the countdown finishes.
7. **Combat:** show the HUD described below. Make hits, damage, and elimination easy to see. After elimination, offer watching or leaving.
8. **In-game menu:** settings and confirmation before leaving. The online battle continues while the menu is open.
9. **Results:** show the winner or draw, useful match statistics, and actions to play again or return to the garage.
10. **Settings and help:** explain controls and offer audio, relevant graphics, and basic accessibility settings. Keep instructions available before the first match.

## HUD (on-screen combat information)

Keep the center of the screen mostly clear so players can see their robot, opponents, and rooftop edges. Use readable text and simple retro industrial panels that remain legible against the arena.

- **Top center:** remaining round time and number of robots still alive, such as “3 of 4 remaining.” Show the starting countdown here too, then replace it with the round timer.
- **Top left:** a compact list of player names with matching robot colors and clear alive/eliminated labels. Do not rely on color alone.
- **Bottom left:** the local player's name, health bar, and numeric health. Clearly signal low health without constant flashing.
- **Bottom center:** two weapon panels labeled Front and Top. Each shows the equipped weapon's icon and name, activation key, and whether it is ready, active, cooling down, or overheated. Show cooldown progress or heat when that weapon uses it.
- **Center aiming mark:** a small indicator of the forward weapon direction. It follows the robot's aim, not the mouse. Account for the camera position so it does not falsely imply where a shot will land. Keep it subtle during close combat.
- **Top right:** a menu button and a small connection indicator. Show a clear warning when the connection is lost or unstable.
- **Brief combat messages:** show confirmed hits, damage taken, and eliminations without covering the action. Elimination messages name the affected player and explain destruction or falling off the roof; identify the attacker only when known.
- **Round end:** show “Victory,” “Eliminated,” or “Draw” as appropriate, then move to results. A player eliminated early can continue watching until the round ends.

While watching after elimination, clearly display “Spectating” and the watched player's name. Let the user switch between surviving robots and leave the match. If health or weapons are shown, they must belong to the watched robot and be labeled clearly. Hide local weapon controls and aiming indicators while spectating.

Keep HUD values in step with the server's confirmed health, weapon status, timer, and eliminations. Adapt the layout to different desktop window sizes without overlapping panels. Keep essential information understandable with sound muted.

## Rooms and connections

- Support real players in separate browsers. Bots do not replace online multiplayer.
- Limit rooms to four players. Allow joining in the lobby; reject new joins during loading or combat with a clear message.
- Changing weapons in the lobby clears that player's ready status.
- If the host leaves, make the longest-present remaining player the host. An active battle must continue without the original host.
- After results, return remaining players to the same lobby and clear readiness for the next round.
- Delete empty rooms.
- Default connection-loss rule: remove the player from the lobby, or eliminate their robot if combat has started. Stop using their last movement input. They cannot reconnect to the ongoing round in this version.
- Show connection failures and provide a way back to room entry.
- Set a loading timeout. If a player cannot finish loading, return the room to the lobby and explain why.

## Technology

- Use **TypeScript** with strict type checking for the browser, server, and shared code.
- Use **Node.js and Colyseus**, with one room per match.
- The server decides movement, collisions, weapon hits, damage, eliminations, and results. Browsers send controls, not trusted positions or damage values.
- Use the Colyseus browser SDK and choose a suitable 3D library. Briefly explain the library choice.
- Keep controls responsive by showing local movement immediately where needed, correcting it against server updates, and smoothing other robots' movement between updates.
- Share weapon definitions, slot rules, message types, and reusable game rules between browser and server. Check incoming messages on the server; TypeScript alone does not validate received data.
- Keep rooms in server memory. No database is needed for this version.
- Run the server as a continuously running Node.js process, with secure connections when hosted online. A server restart ends active matches and clears rooms; show this connection loss to players.
- Separate browser, server, and shared code. Pin compatible dependency versions and include a lockfile.

## Models and visual style

Create original, simple 3D models with a retro industrial look: angular shapes, worn metal, muted colors, and distinct accent colors for players. Build the models in code by default and include their editable source.

- A wheeled chassis with armor panels and front/top weapon attachment points.
- Recognizable ram, saw, cannon, and flamethrower models, shared between the garage and combat.
- Moving wheels and weapon parts, with firing, impact, and destruction effects.
- A rooftop with visible drop-offs and simple industrial scenery.

Keep model sizes and attachment points consistent. Use simple shapes for collision checks and keep decorative scenery separate. Keep models and effects lightweight enough for browser play. Deliver working 3D models, not only concept images. Keep text and controls readable on modern screens.

## Delivery and checks

Provide the complete browser and server code, custom models, setup instructions, configuration examples, and commands to run, build, type-check, and test the game. Explain how to host it and connect from another computer. Do not put secrets in the code. Include any required asset credits and clearly describe unfinished features or limitations.

### Local startup script

Create an executable **`scripts/start-local.sh`** as the standard way to run the game locally. Use this same script when developing and checking the game so the user can repeat the process.

- Running `./scripts/start-local.sh` from the project folder starts both the browser client and multiplayer server. Find the project folder from the script's location so it also works when called from another directory.
- Check required tools and dependencies. Explain missing prerequisites and any one-time setup in the README. Keep any required setup steps in a reusable script too.
- Keep normal startup to this one command, without requiring separate terminals, hidden environment settings, or temporary inline commands.
- Use sensible default ports, allow documented overrides, and report port conflicts clearly.
- Print the browser URL and show clearly labeled client and server output. Explain how another local browser connects to the same game server.
- Stop both processes on Ctrl+C or startup failure, and do not leave background processes running. Only stop processes started by this script.
- Keep secrets out of the script. Document any optional configuration in an example file.
- Make the script work on macOS and Linux using Bash. Include its executable permission in the repository.

The README should put `./scripts/start-local.sh` near the top as the main local startup command. The script should run in the foreground and report failures clearly.

Test the important game and room rules, then play through the full experience:

- Choose a nickname → equip weapons → create/join a room → ready up → fight → view results → play again or return to the garage.
- Run matches with two, three, and four separate clients; confirm a fifth player cannot join.
- Confirm every player sees the correct weapons, movement, damage, eliminations, and result.
- Check weapon restrictions, round timers, falling off the roof, simultaneous eliminations, and watching after elimination.
- Check HUD health, weapon readiness, timer, player status, and spectator information against the game state. Check readability at different desktop window sizes.
- Check invalid room codes, loading failures, lost connections, host departures, and rematches.
- Start the game using `scripts/start-local.sh`, open its printed URL, and verify both services work. Check that Ctrl+C stops both, that the script works from another directory, and that it reports a port conflict clearly.

Report what was tested and any remaining problems.
