# Combat presentation

Hits move the suspended body while wheels and tracks stay grounded, weapons recoil, and impacts combine bass and metallic audio. Settings include an impact-camera-shake toggle; the former reduced-motion and low-graphics options have been removed.

Decisive eliminations get a skippable 3.6-second cinematic: roof falls tumble down the skyscraper, while destroyed robots collapse on the roof. Draws and disconnect wins go directly to results. These animations do not alter server timing or match rules.

The rooftop overlooks a city 130 world units below, with lit windows, moving traffic, clouds, and an aircraft. Nearby towers form a skyline visible from the arena center; lower blocks preserve the view down to the streets. Facing outward near an edge tilts the camera toward the streets.

Run `node scripts/presentation-browser-check.mjs` with the local game running to check center skyline framing, grounded repeated hits, edge framing, the final fall, cinematic expiry, and round reset. Screenshots are saved in `artifacts/`.

Weapon fire adds directional gold cannon blasts, wide scattergun flashes, cyan railgun streaks, and drifting flamethrower embers. Hits and eliminations send expanding spark rings across the roof. All effects share a fixed 256-particle instance batch and preallocated projectile meshes. Run `node scripts/weapon-performance-check.mjs` with the client running to verify sustained-fire GPU resource stability and capture `artifacts/weapon-effects.png`.

Melee hits carry an optional `melee` attachment identifier from the server, including powered wedge contact with zero damage. Only confirmed contact produces armor flashes and directional suspension kicks. Hammer, ram, sweeper, flipper, and hook contact briefly holds the attachment pose for 40–65 ms; movement, input, damage, and match clocks keep running. Contact poses do not rewind into the windup after the hold. Saw, drill, and wedge feedback is limited to one small burst per target every 90 ms. Moving attachments leave short positional afterimages even on misses, without a hit flash. Camera shake still respects the existing setting, and round resets clear all reaction state.

The visual approach follows Jiesang Song's firsthand [Improving the Combat 'Impact' Of Action Games](https://www.gamedeveloper.com/audio/improving-the-combat-impact-of-action-games): attack trails make fast motion readable, momentary pose holds suggest resistance, hit lighting confirms contact, and directional reactions explain the force. The hold lengths and effect strengths here are implementation choices for this game.

Run `node scripts/melee-effects-browser-check.mjs` against the local client for an audio-free check of all eight attachments, contact poses, isolated armor flashes, movement during holds, grounded wheels, and round resets. Captures are written to `artifacts/melee-impact-<weapon>.png`.
