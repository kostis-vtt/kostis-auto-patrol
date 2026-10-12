# Kostis's Auto-Patrol System

[![Latest release](https://img.shields.io/github/v/release/kostis-vtt/kostis-auto-patrol?label=release)](https://github.com/kostis-vtt/kostis-auto-patrol/releases/latest) ![Foundry v14](https://img.shields.io/badge/Foundry-v14-orange) [![Downloads](https://img.shields.io/github/downloads/kostis-vtt/kostis-auto-patrol/total)](https://github.com/kostis-vtt/kostis-auto-patrol/releases) [![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/xgpro)

Part of **Kostis's Flying Paths**. Requires the *Kostis's Flying Paths* hub and *Kostis's Actual Animator*.

Open the **Patrol planner** from the *Kostis's Flying Paths* scene controls, the hub launcher, or a keybinding.

## Installation

In Foundry, go to *Add-on Modules → Install Module*, paste this manifest URL and press *Install*:

`https://github.com/kostis-vtt/kostis-auto-patrol/releases/latest/download/module.json`

Foundry offers to install *Kostis's Flying Paths* and *Kostis's Actual Animator* along with it (both are required).

## 1. Scan the map

The scan looks at the map art (the level's background and the floor tiles on it, not roofs) the way you would:

- Every pixel goes to a perceptual colour space, and similar colours are grouped into **materials**: stone floor, wooden planks, walls, water, the black void outside the map.
- **Logic picks the floor.** Wherever a token stands is floor. Very dark material is wall. Materials close in colour to the floor are floor too (a chequered floor has two tile colours).
- The result is cleaned up like an image editor would: plank and grout lines are closed, specks removed, small blots filled, and floor patches nobody can reach are dropped.
- The walkable area is split into **rooms** and **corridors** joined by **doorways**.

The planner shows what it found on the map (floor, rooms and doorways, proposed walls, patrol routes) and lists the materials it saw and why each counts as floor or blocked.

**Fix mistakes** with the *Paint floor* and *Paint wall* brushes (click or drag on the map), then scan again. Hints are saved with the scene. To take hints away, right-click with either brush, use the *Erase hints* tool, or press **Ctrl+Z** to undo the last stroke. Sliders tune detail, colour tolerance, how dark counts as wall, and how strong a line must be to count as one.

## 2. Walls

**Create walls** turns the floor's outline into straight wall segments, skipping any that duplicate walls you already have. Generated walls are flagged, so **Remove generated walls** takes them all away again without touching walls you drew yourself. Patrols always respect every movement wall, generated or hand-drawn, and closed doors. On a scene with several levels, the scan reads the level you are viewing, and its walls belong to that level.

## 3. Patrols

Pick who patrols (hostile, neutral and/or friendly NPCs; player characters never), choose a routine for each or leave it on **Automatic**, and press **Generate patrols**.

| Routine | What they do | Chosen automatically when |
|---|---|---|
| Rounds | Visit their room and the nearest neighbouring rooms, pausing in each | The room has neighbours |
| Walk the room's edge | A loop around the room, a step in from the walls | A big room |
| Pace back and forth | Up and down the length of a corridor or long hall | A long, thin room |
| Guard post | Stand watch, looking left and right | Standing in or near a doorway |
| Wander | A meandering loop between a few nearby spots | Otherwise |
| Stay put, look around | Don't move, just look around | A tiny space |

- Routes go **around walls**: A* over a fine navigation grid that prefers the middle of corridors, then straightened with line of sight and curved by the animator. Curved corners are checked against walls and sharpened where a curve would clip one.
- Every routine starts and ends where the NPC stands, so it never cuts across the map to reach its route.
- NPCs standing together form a **squad** that walks the same route in file.
- **Speed** comes from each creature's walking (or flying) speed: 30 ft ≈ 1 square per second. A squad keeps to its slowest member.
- Patrols are ordinary animator animations, named "Patrol: …", so you can open them in the animator and fine-tune them by hand.
- **Doors**: when a door closes on a route (or any wall appears across it), the patrol is routed around it. Rooms it can no longer reach are left out until the door opens again, and then the old route comes back.

**Start all** walks any NPC that has wandered off its route back to it (around walls, scanning the map first if needed) before it carries on. **Stop all** freezes everyone where they stand, and stopped patrols stay stopped: their NPCs don't react to intruders or set off again until you start them. **Remove all** deletes the patrols.

## 4. Behaviour

Patrolling NPCs keep watch: a cone of vision in the direction they face, out to their sight range, with a real line of sight through your walls. When a player character steps into view, the NPC reacts according to its patrol:

- **Stop and stare**: stops, turns to face the intruder, and stays alert.
- **Chase**: runs after the intruder along a walkable route and stops a square short, re-routing as they move.
- **Raise the alarm**: stops and stares, and patrols nearby come to investigate the spot.
- **Ignore**: carries on.

The GM sees a floating "!" above the NPC and gets a whisper ("Goblin spotted Valeros!"). Optionally the game pauses. Once the intruder has been out of sight for a while (12 s by default), the NPC walks back to its route (around walls) and carries on. If it can't find a way back (say a door was shut behind it), it stays put and you get a warning; it tries again every few seconds. NPCs only see intruders on their own level.

While there is combat on the scene, patrols hold still and nobody reacts, whoever started the combat. When it ends, NPCs walk back to their routes and resume (patrols you had stopped stay stopped). Walks that a reload or a scene change interrupted are cleaned up, and their NPCs head back to their routes.

## Undo

**Ctrl+Z** (or the planner's Undo button) undoes painting and erasing hints, clearing hints, creating or removing generated walls, and generating or removing patrols. Undoing a regenerate brings back the patrols it replaced, already patrolling.

## Macro API

```js
await KAP.scan();                       // scan the viewed scene
await KAP.createWalls();                // create the proposed walls
await KAP.generate();                   // patrols for every hostile NPC
await KAP.generate(canvas.tokens.controlled, {strategy: "pace", response: "chase", range: 10});
KAP.patrols();                          // what is patrolling
await KAP.stop(); await KAP.start();
KAP.route({x: 500, y: 500}, {x: 2400, y: 900});   // a walkable route between two points
```

Hooks: `kostis-auto-patrol.scanned` (the scan result) and `kostis-auto-patrol.generated` (scene, patrols).

## Support

Found a bug? [Report it](https://github.com/kostis-vtt/kostis-auto-patrol/issues/new/choose). For questions, ideas, or to show what you made with it, head to [Discussions](https://github.com/kostis-vtt/kostis-auto-patrol/discussions).

These modules are free. If you enjoy them, you can support their development on [Ko-fi](https://ko-fi.com/xgpro).

## Licence

MIT: see [LICENSE](LICENSE).

## Development

The tests run with plain Node, with Foundry mocked: run each file in `tests/` with `node` (for example
`node tests/kap.test.mjs`). Some load Handlebars and PIXI from a local Foundry install: set `FOUNDRY_APP` to its `resources/app`
folder if Foundry isn't installed in `C:/Program Files/Foundry Virtual Tabletop`. The family's other modules are
expected in folders next to this one.

To release a version: set it in `module.json`, add a `## <version>` section to `CHANGELOG.md`, commit, and push a tag
`v<version>`. GitHub Actions builds `module.zip` and publishes the release. The manifest URL of the latest version is
`https://github.com/kostis-vtt/kostis-auto-patrol/releases/latest/download/module.json`.
