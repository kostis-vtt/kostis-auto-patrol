// The Patrol Planner: scan the map, check and fix what it found, create walls, generate patrols and set how NPCs
// react. Shows its findings on the map while open.

import {ANIMATOR_ID, FLAG_PATROLS, HUB_ID, MODULE_ID, MODULE_TITLE, RESPONSES} from "./const.js";
import {Scanner, movementWalls} from "./scanner.js";
import {Patroller} from "./patroller.js";
import {STRATEGIES} from "./patrols.js";
import {Overlay} from "./overlay.js";
import {Hints} from "./hints.js";
import {createWalls, generatedWalls, removeGeneratedWalls} from "./walls.js";

const {ApplicationV2, HandlebarsApplicationMixin, DialogV2} = foundry.applications.api;
const hub = () => game.modules.get(HUB_ID)?.api;

const SCAN_FIELDS = {
  samples: {label: "Detail (samples per square)", min: 6, max: 16, step: 1},
  sensitivity: {label: "Floor colour tolerance", min: 0, max: 1, step: 0.05},
  darkness: {label: "Darker than this is wall", min: 0.05, max: 0.5, step: 0.01},
  edgeCut: {label: "Lines stronger than this are walls", min: 0.3, max: 1, step: 0.05},
  minIsland: {label: "Ignore floor patches under (squares)", min: 0, max: 10, step: 0.5}
};
const SETTINGS = ["watch", "alertSeconds", "chaseSpeed", "alarmRadius", "whisper", "pauseOnSpot", "pauseInCombat"];

export class PatrolPlanner extends HandlebarsApplicationMixin(ApplicationV2) {

  static #instance = null;

  static DEFAULT_OPTIONS = {
    id: "kap-planner",
    classes: ["kfp-app", "kap-planner"],
    window: {title: `${MODULE_TITLE}`, icon: "fa-solid fa-person-military-pointing", resizable: true},
    position: {width: 560, height: 760},
    actions: {
      switchTab: PatrolPlanner.#onTab,
      scan: PatrolPlanner.#onScan,
      paintFloor: PatrolPlanner.#onPaintFloor,
      paintWall: PatrolPlanner.#onPaintWall,
      eraseHints: PatrolPlanner.#onEraseHints,
      undo: PatrolPlanner.#onUndo,
      clearHints: PatrolPlanner.#onClearHints,
      createWalls: PatrolPlanner.#onCreateWalls,
      removeWalls: PatrolPlanner.#onRemoveWalls,
      generateAll: PatrolPlanner.#onGenerateAll,
      generateSelected: PatrolPlanner.#onGenerateSelected,
      startAll: PatrolPlanner.#onStart,
      stopAll: PatrolPlanner.#onStop,
      removeAll: PatrolPlanner.#onRemoveAll,
      removePatrol: PatrolPlanner.#onRemovePatrol,
      panTo: PatrolPlanner.#onPanTo
    }
  };

  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/planner.hbs`, scrollable: [".kap-scroll"]}
  };

  static open({tab}={}) {
    this.#instance ??= new this();
    if ( tab ) this.#instance.#tab = tab;
    this.#instance.render({force: true});
    this.#instance.bringToFront?.();
    return this.#instance;
  }

  static get instance() {
    return this.#instance;
  }

  #tab = "scan";

  #busy = false;

  /** Patrol choices made in the list before generating. */
  #choices = {};

  #defaults = {strategy: "auto", speed: 1, response: "alert", range: 8, cone: 140, squad: 1.6, hostile: true, neutral: false, friendly: false};

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(_options) {
    const scene = canvas.scene;
    const r = Scanner.current;
    const color = hub()?.math?.color;
    const ctx = {
      tab: this.#tab,
      tabs: [
        {key: "scan", label: "Map", icon: "fa-solid fa-map", active: this.#tab === "scan"},
        {key: "patrols", label: "Patrols", icon: "fa-solid fa-route", active: this.#tab === "patrols"},
        {key: "behaviour", label: "Behaviour", icon: "fa-solid fa-eye", active: this.#tab === "behaviour"}
      ],
      busy: this.#busy,
      undo: hub()?.history.peek()?.label ?? null,
      scene: !!scene,
      animator: !!game.modules.get(ANIMATOR_ID)?.active,
      overlay: Overlay.show
    };
    if ( !scene ) return ctx;

    // Map tab
    ctx.scanned = !!r;
    ctx.scanFields = Object.entries(SCAN_FIELDS).map(([key, f]) => ({key, ...f, value: Scanner.options[key]}));
    ctx.includeEdges = Scanner.options.includeEdges;
    const hints = Hints.get(scene);
    ctx.hints = hints.floor.length + hints.wall.length;
    ctx.generated = generatedWalls(scene).length;
    ctx.existing = movementWalls(scene).length;
    if ( r ) {
      ctx.stats = {
        floor: Math.round(r.vision.floorShare * 100),
        proposed: r.proposed.length,
        rooms: r.rooms.rooms.length,
        doorways: r.rooms.doorways.length,
        size: `${r.vision.W}×${r.vision.H}`
      };
      ctx.clusters = r.vision.clusters
        .filter(c => c.share > 0.002)
        .sort((a, b) => b.share - a.share)
        .map(c => ({swatch: color ? color.rgbToHex(color.oklabToRgb([c.L, c.a, c.b])) : "#888", floor: c.floor, reason: c.reason,
          share: Math.round(c.share * 100)}));
    }

    // Patrols tab
    const d = this.#defaults;
    const dispositions = [d.hostile && CONST.TOKEN_DISPOSITIONS.HOSTILE, d.neutral && CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      d.friendly && CONST.TOKEN_DISPOSITIONS.FRIENDLY].filter(v => v !== false);
    const patrols = Patroller.list(scene);
    const inPatrol = new Map();
    for ( const p of patrols ) for ( const id of p.tokens ) inPatrol.set(id, p);
    const npcs = [...new Set([...Patroller.candidates(scene, {dispositions}), ...patrols.flatMap(p => p.tokens.map(id => scene.tokens.get(id)).filter(Boolean))])];
    const strategyOptions = (value, withNone) => [
      ...(withNone ? [{value: "none", label: "No patrol", selected: value === "none"}] : []),
      ...Object.entries(STRATEGIES).map(([k, s]) => ({value: k, label: s.label, selected: k === value}))
    ];
    ctx.defaults = d;
    ctx.defaultStrategies = strategyOptions(d.strategy, false);
    ctx.responses = Object.entries(RESPONSES).map(([k, v]) => ({value: k, label: v.label, selected: k === d.response}));
    ctx.npcs = npcs.map(t => {
      const p = inPatrol.get(t.id);
      return {
        id: t.id, name: t.name, img: t.texture.src,
        disposition: {[-1]: "hostile", 0: "neutral", 1: "friendly"}[t.disposition] ?? "secret",
        patrol: p ? STRATEGIES[p.strategy]?.label ?? p.strategy : null,
        playing: !!t.getFlag(ANIMATOR_ID, "playback"),
        choices: strategyOptions(this.#choices[t.id] ?? (p ? p.strategy : "auto"), true)
      };
    });
    ctx.patrols = patrols.map(p => ({
      ...p,
      label: STRATEGIES[p.strategy]?.label ?? p.strategy,
      icon: STRATEGIES[p.strategy]?.icon ?? "fa-solid fa-route",
      color: STRATEGIES[p.strategy]?.color ?? "#fff",
      count: p.tokens.length,
      responses: Object.entries(RESPONSES).map(([k, v]) => ({value: k, label: v.label, selected: k === p.response}))
    }));
    ctx.hasPatrols = patrols.length > 0;

    // Behaviour tab
    ctx.settings = Object.fromEntries(SETTINGS.map(k => [k, game.settings.get(MODULE_ID, k)]));
    ctx.isGM = game.user.isGM;
    return ctx;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("change", event => this.#onChange(event));
    this.element.addEventListener("input", event => {
      const out = event.target.closest(".kfp-range")?.querySelector("output");
      if ( out ) out.textContent = event.target.value;
    });
    Overlay.enabled = true;
    Overlay.draw();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    Overlay.enabled = false;
    Overlay.draw();
    PatrolPlanner.#instance = null;
  }

  async #onChange(event) {
    const el = event.target;
    const name = el.name;
    if ( !name ) return;
    const value = el.type === "checkbox" ? el.checked : (el.type === "range" || el.type === "number" ? Number(el.value) : el.value);
    if ( name.startsWith("scan.") ) {
      Scanner.options[name.slice(5)] = value;
      return;
    }
    if ( name.startsWith("overlay.") ) {
      Overlay.show[name.slice(8)] = value;
      Overlay.draw();
      return;
    }
    if ( name.startsWith("default.") ) {
      this.#defaults[name.slice(8)] = value;
      if ( ["hostile", "neutral", "friendly"].includes(name.slice(8)) ) this.render();
      return;
    }
    if ( name.startsWith("choice.") ) {
      this.#choices[name.slice(7)] = value;
      return;
    }
    if ( name.startsWith("patrol.") ) {
      const [, animId, key] = name.split(".");
      await Patroller.configure(animId, {[key]: value});
      return;
    }
    if ( name.startsWith("setting.") ) {
      await game.settings.set(MODULE_ID, name.slice(8), value);
    }
  }

  async #run(fn) {
    if ( this.#busy ) return;
    this.#busy = true;
    this.render();
    try {
      await fn();
    } catch(err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(err.message);
    } finally {
      this.#busy = false;
      this.render();
      Overlay.draw();
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onTab(_event, target) {
    this.#tab = target.dataset.tab;
    this.render();
  }

  static #onScan() {
    return this.#run(async () => {
      const r = await Scanner.scan();
      if ( r ) ui.notifications.info(game.i18n.format("KAP.Info.Scanned", {floor: Math.round(r.vision.floorShare * 100), walls: r.proposed.length, rooms: r.rooms.rooms.length}));
    });
  }

  static #onPaintFloor() {
    hub()?.activateTool("kapFloor");
  }

  static #onPaintWall() {
    hub()?.activateTool("kapWall");
  }

  static #onEraseHints() {
    hub()?.activateTool("kapErase");
  }

  static async #onUndo() {
    await hub()?.history.undo();
    Scanner.current && Overlay.draw();
    this.render();
  }

  static async #onClearHints() {
    await Hints.clear();
    Overlay.draw();
    this.render();
  }

  static #onCreateWalls() {
    return this.#run(async () => {
      const r = Scanner.current;
      if ( !r?.proposed.length ) return;
      const created = await createWalls(r.proposed, {sight: true});
      Scanner.refreshNav();
      ui.notifications.info(game.i18n.format("KAP.Info.WallsCreated", {count: created.length}));
    });
  }

  static #onRemoveWalls() {
    return this.#run(async () => {
      const n = await removeGeneratedWalls();
      if ( Scanner.current ) await Scanner.scan();
      ui.notifications.info(game.i18n.format("KAP.Info.WallsRemoved", {count: n}));
    });
  }

  #generateOptions() {
    const d = this.#defaults;
    const perToken = {};
    for ( const [id, v] of Object.entries(this.#choices) ) if ( v !== "none" ) perToken[id] = v;
    return {strategy: d.strategy, perToken, speed: d.speed, response: d.response, range: d.range, cone: d.cone, squad: d.squad};
  }

  static #onGenerateAll() {
    return this.#run(async () => {
      const ctx = await this._prepareContext({});
      const ids = ctx.npcs.filter(n => (this.#choices[n.id] ?? "auto") !== "none").map(n => n.id);
      const docs = ids.map(id => canvas.scene.tokens.get(id)).filter(Boolean);
      if ( !docs.length ) return ui.notifications.warn("KAP.Warn.NoNPCs", {localize: true});
      const made = await Patroller.generate(docs, this.#generateOptions());
      ui.notifications.info(game.i18n.format("KAP.Info.Generated", {count: made.length}));
    });
  }

  static #onGenerateSelected() {
    return this.#run(async () => {
      // The hub remembers the selection: switching to the Flying Paths controls makes Foundry release it
      const selected = game.modules.get(HUB_ID)?.api?.selection?.tokens() ?? canvas.tokens.controlled;
      const docs = selected.map(t => t.document);
      if ( !docs.length ) return ui.notifications.warn("KAP.Warn.SelectTokens", {localize: true});
      const made = await Patroller.generate(docs, this.#generateOptions());
      ui.notifications.info(game.i18n.format("KAP.Info.Generated", {count: made.length}));
    });
  }

  static #onStart() {
    return this.#run(() => Patroller.start());
  }

  static #onStop() {
    return this.#run(() => Patroller.stop());
  }

  static async #onRemoveAll() {
    const ok = await DialogV2.confirm({window: {title: "Remove patrols"}, content: "<p>Remove every patrol on this scene?</p>"});
    if ( ok ) await this.#run(() => Patroller.remove());
  }

  static #onRemovePatrol(_event, target) {
    const animId = target.closest("[data-anim]").dataset.anim;
    const p = Patroller.list().find(x => x.animId === animId);
    if ( p ) return this.#run(() => Patroller.remove(p.tokens));
  }

  static #onPanTo(_event, target) {
    const t = canvas.tokens.get(target.closest("[data-token]").dataset.token);
    if ( !t ) return;
    t.control({releaseOthers: true});
    canvas.animatePan({x: t.center.x, y: t.center.y, duration: 300});
  }
}

export {FLAG_PATROLS};
