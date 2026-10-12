// Kostis's Auto-Patrol System — entry point. Part of the Kostis's Flying Paths family (requires the hub and the
// animator).

import {ANIMATOR_ID, FLAG_GENERATED, FLAG_HINTS, FLAG_PATROLS, HUB_ID, MODULE_ID} from "./const.js";
import {Scanner} from "./scanner.js";
import {Patroller} from "./patroller.js";
import {Behaviour} from "./behaviour.js";
import {Overlay} from "./overlay.js";
import {Hints} from "./hints.js";
import {PatrolPlanner} from "./planner.js";
import {createWalls, removeGeneratedWalls} from "./walls.js";
import {STRATEGIES} from "./patrols.js";

const redraw = () => {
  Overlay.draw();
  PatrolPlanner.instance?.render();
};

const api = {
  STRATEGIES,
  openPlanner: options => PatrolPlanner.open(options),
  /** Scan the viewed scene. Resolves with {vision, proposed, nav, rooms}. */
  scan: options => Scanner.scan(options),
  get result() {
    return Scanner.current;
  },
  /** Create the walls the last scan proposed. */
  createWalls: async () => {
    const r = Scanner.current ?? await Scanner.scan();
    const made = await createWalls(r?.proposed ?? []);
    Scanner.refreshNav();
    return made;
  },
  removeGeneratedWalls: () => removeGeneratedWalls(),
  /**
   * Generate patrols for tokens (all hostile NPCs on the scene when none are given).
   * @example KAP.generate(canvas.tokens.controlled, {strategy: "rounds", response: "chase"})
   */
  generate: (tokens, options) => {
    const docs = tokens ? [...tokens].map(t => t.document ?? t) : Patroller.candidates();
    return Patroller.generate(docs, options);
  },
  start: ids => Patroller.start(ids),
  stop: ids => Patroller.stop(ids),
  remove: tokenIds => Patroller.remove(tokenIds),
  patrols: () => Patroller.list(),
  /** A walkable route between two points (needs a scan). */
  route: (from, to) => Scanner.current?.nav.route(from, to) ?? null
};

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = api;
  globalThis.KAP = api;
  const reg = (key, type, def, extra={}) => game.settings.register(MODULE_ID, key, {
    name: `KAP.Settings.${key}.Name`, hint: `KAP.Settings.${key}.Hint`, scope: "world", config: true, type, default: def, ...extra
  });
  reg("watch", Boolean, true);
  reg("alertSeconds", Number, 12, {range: {min: 2, max: 120, step: 1}});
  reg("chaseSpeed", Number, 1.8, {range: {min: 1, max: 5, step: 0.1}});
  reg("alarmRadius", Number, 12, {range: {min: 1, max: 60, step: 1}});
  reg("whisper", Boolean, true);
  reg("pauseOnSpot", Boolean, false);
  reg("pauseInCombat", Boolean, true);
  game.keybindings.register(MODULE_ID, "openPlanner", {
    name: "KAP.Keybindings.OpenPlanner", editable: [],
    onDown: () => {
      PatrolPlanner.open();
      return true;
    }
  });
  foundry.applications.handlebars.loadTemplates([`modules/${MODULE_ID}/templates/planner.hbs`]);
});

Hooks.once("kostisFlyingPaths.register", kfp => {
  kfp.registerSubmodule({
    id: MODULE_ID,
    open: () => PatrolPlanner.open(),
    actions: [
      {label: "Scan this map", icon: "fa-solid fa-satellite-dish", visible: () => game.user.isGM, run: async () => {
        PatrolPlanner.open({tab: "scan"});
      }},
      {label: "Patrols", icon: "fa-solid fa-route", visible: () => game.user.isGM, run: () => PatrolPlanner.open({tab: "patrols"})}
    ]
  });
  const gm = () => game.user.isGM;
  kfp.registerTool({
    name: "kapPlanner", submodule: MODULE_ID, order: 30, button: true, visible: gm,
    title: "KAP.Tools.Planner", icon: "fa-solid fa-person-military-pointing",
    onChange: () => PatrolPlanner.open()
  });
  kfp.registerTool({
    name: "kapFloor", submodule: MODULE_ID, order: 31, visible: gm,
    title: "KAP.Tools.Floor", icon: "fa-solid fa-paintbrush",
    canvas: {...Hints.brush("floor", redraw), activate: () => { Overlay.enabled = true; Overlay.draw(); }}
  });
  kfp.registerTool({
    name: "kapWall", submodule: MODULE_ID, order: 32, visible: gm,
    title: "KAP.Tools.Wall", icon: "fa-solid fa-paint-roller",
    canvas: {...Hints.brush("wall", redraw), activate: () => { Overlay.enabled = true; Overlay.draw(); }}
  });
  kfp.registerTool({
    name: "kapErase", submodule: MODULE_ID, order: 33, visible: gm,
    title: "KAP.Tools.Erase", icon: "fa-solid fa-eraser",
    canvas: {...Hints.brush("erase", redraw), activate: () => { Overlay.enabled = true; Overlay.draw(); }}
  });
});

Hooks.once("ready", () => {
  if ( !game.modules.get(HUB_ID)?.active ) ui.notifications.error("KAP.Error.NoHub", {localize: true, permanent: true});
  if ( !game.modules.get(ANIMATOR_ID)?.active ) ui.notifications.warn("KAP.Error.NoAnimator", {localize: true});
  Behaviour.start();
});

Hooks.on("canvasReady", () => {
  Behaviour.reset();
  Overlay.enabled = !!PatrolPlanner.instance;
  Overlay.draw();
  PatrolPlanner.instance?.render();
  // Walks interrupted by a reload or a scene change
  Behaviour.sweep().catch(err => console.error(`${MODULE_ID} | sweep`, err));
});

Hooks.on("canvasTearDown", () => Overlay.clear());

// Walls changed: navigation must know (patrols route around every movement wall, and a door that closes on a route
// sends that patrol around it). Many walls change at once when they are generated: handle them together.
const navChanged = foundry.utils.debounce(async () => {
  if ( !Scanner.current ) return;
  Scanner.refreshNav();
  redraw();
  try {
    await Patroller.replan(canvas.scene);
  } catch(err) {
    console.error(`${MODULE_ID} | re-routing patrols`, err);
  }
}, 250);
const wallsChanged = doc => {
  if ( (doc.parent === canvas.scene) && Scanner.current ) navChanged();
};
Hooks.on("createWall", wallsChanged);
Hooks.on("updateWall", wallsChanged);
Hooks.on("deleteWall", wallsChanged);

Hooks.on("updateScene", (scene, changed) => {
  if ( (scene !== canvas.scene) || !foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`) ) return;
  redraw();
});

// Animations edited or patrols started/stopped: keep the overlay and planner in step
Hooks.on(`${ANIMATOR_ID}.started`, () => PatrolPlanner.instance?.render());
Hooks.on(`${ANIMATOR_ID}.stopped`, () => PatrolPlanner.instance?.render());

Hooks.on("kostisFlyingPaths.history", () => PatrolPlanner.instance?.render());

// Combat: Behaviour checks for it on every tick (combat can be started by any GM, on any client)

export {api, FLAG_GENERATED, FLAG_HINTS, FLAG_PATROLS};
