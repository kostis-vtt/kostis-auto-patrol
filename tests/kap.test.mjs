// Tests for Kostis's Auto-Patrol System: the vision → walls → navigation → rooms → patrols pipeline runs on a
// synthetic dungeon image; Foundry glue is tested further down with mocks.
import {pathToFileURL, fileURLToPath} from "node:url";
import {dirname} from "node:path";

// Foundry's own files (Handlebars, PIXI, its stylesheets) come from a local install: set FOUNDRY_APP if it lives elsewhere
const FOUNDRY_APP = (process.env.FOUNDRY_APP ?? "C:/Program Files/Foundry Virtual Tabletop/resources/app").replace(/\\/g, "/");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))) + "/";
const MODS = dirname(ROOT) + "/";
let fails = 0;
const ok = (c, m) => { if ( !c ) { fails++; console.log("FAIL:", m); } else console.log("ok  :", m); };
const imp = f => import(pathToFileURL(ROOT + "scripts/" + f).href);

const {analyzeMap, kmeans, toOklab, close, open, components} = await imp("vision.js");
const {traceContours, simplify, wallSegments} = await imp("contours.js");
const {NavGrid, segmentsIntersect} = await imp("nav.js");
const {findRooms} = await imp("rooms.js");
const {planWaypoints, routeLegs, patrolAnimation, chooseStrategy, squads, seedOf} = await imp("patrols.js");

/* ---------------- A synthetic dungeon ---------------- */
// 30 x 20 squares, 10 samples per square. Black void; two stone rooms joined by a 2-square corridor; dark walls
// drawn around the floor; plank lines across the floor every square; a table (obstacle) in room A.
const S = 10;
const GW = 30;
const GH = 20;
const W = GW * S;
const H = GH * S;
const data = new Uint8ClampedArray(W * H * 4);
let rs = 7;
const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
const inRect = (x, y, r) => (x >= r[0] * S) && (x < r[2] * S) && (y >= r[1] * S) && (y < r[3] * S);
const roomA = [2, 2, 12, 10];      // squares [x0, y0, x1, y1)
const roomB = [18, 3, 26, 11];
const corridor = [12, 5, 18, 7];
const table = [5, 5, 7, 6];
const floorAt = (x, y) => inRect(x, y, roomA) || inRect(x, y, roomB) || inRect(x, y, corridor);
for ( let y = 0; y < H; y++ ) {
  for ( let x = 0; x < W; x++ ) {
    const i = ((y * W) + x) * 4;
    let c = [10, 10, 14];
    if ( floorAt(x, y) ) {
      const n = (rnd() - 0.5) * 30;
      c = [150 + n, 128 + n, 100 + n];                       // warm stone
      if ( (y % S) === 0 ) c = [118, 100, 78];               // plank / grout lines
      if ( inRect(x, y, table) ) c = [70, 42, 20];           // dark wooden table
    } else {
      // Wall band: 3 samples of dark grey around any floor
      let near = false;
      for ( let dy = -3; dy <= 3 && !near; dy++ ) for ( let dx = -3; dx <= 3 && !near; dx++ ) if ( floorAt(x + dx, y + dy) ) near = true;
      if ( near ) c = [45, 45, 50];
    }
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
}
const img = {width: W, height: H, data};
const sq = (x, y) => ({x: x * S, y: y * S});    // square coords → samples
const tokens = [{id: "goblin", at: sq(4, 8)}, {id: "wolf", at: sq(14.5, 6)}, {id: "orc", at: sq(19, 6)}, {id: "orc2", at: sq(19.8, 6.6)}];

/* ---------------- Vision ---------------- */
const t0 = performance.now();
const vis = analyzeMap(img, {S, seeds: tokens.map(t => t.at)});
const tVision = performance.now() - t0;
const M = (sx, sy) => vis.mask[(Math.round(sy * S) * W) + Math.round(sx * S)];
ok(vis.W === W && vis.H === H, "the mask matches the image");
ok(M(7, 3) && M(22, 8) && M(15, 6), "room A, room B and the corridor are floor");
ok(!M(0.5, 0.5) && !M(15, 2) && !M(28, 18), "the void is not floor");
ok(!M(12, 3.5) && !M(18, 10), "wall bands are not floor");
ok(!M(6, 5.5), "a dark table in the room is an obstacle");
const plankRow = Math.round(4 * S);
let cracks = 0;
for ( let x = Math.round(3 * S); x < Math.round(11 * S); x++ ) if ( !vis.mask[(plankRow * W) + x] ) cracks++;
ok(cracks === 0, `plank lines across the floor are closed up (${cracks} gaps)`);
const floorClusters = vis.clusters.filter(c => c.floor);
ok(floorClusters.length >= 1 && floorClusters.every(c => c.L > 0.3), `floor materials found (${floorClusters.length}: ${floorClusters.map(c => c.reason).join(", ")})`);
ok(tVision < 4000, `vision takes ${Math.round(tVision)} ms for ${W}x${H} samples`);
const truthFloor = (() => { let n = 0; for ( let y = 0; y < H; y++ ) for ( let x = 0; x < W; x++ ) if ( floorAt(x, y) && !inRect(x, y, table) ) n++; return n / (W * H); })();
ok(Math.abs(vis.floorShare - truthFloor) < 0.03, `floor area is accurate (${(vis.floorShare * 100).toFixed(1)}% vs ${(truthFloor * 100).toFixed(1)}%)`);
// Hints override
const hinted = analyzeMap(img, {S, seeds: tokens.map(t => t.at), wallHints: [sq(15, 6)]});
ok(!hinted.mask[(6 * S * W) + (15 * S)], "painting a wall hint blocks that spot");
const noSeeds = analyzeMap(img, {S});
ok(noSeeds.mask[(3 * S * W) + (7 * S)] === 1, "without tokens, the largest mid-tone material is taken as floor");
const again = analyzeMap(img, {S, seeds: tokens.map(t => t.at)});
ok(again.mask.every((v, i) => v === vis.mask[i]), "analysis is deterministic");
// Morphology & components sanity
const m = new Uint8Array(25); m[12] = 1;
ok(close(m, 5, 5, 1)[12] === 1 && open(m, 5, 5, 1)[12] === 0, "opening removes specks; closing keeps solids");
ok(components(new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3, 3, 1).sizes.length === 3, "components are 4-connected (diagonals don't join)");

/* ---------------- Walls ---------------- */
const segs = wallSegments(vis.mask, W, H, {S, tolerance: 0.2, minLength: 0.75});
ok(segs.length > 8 && segs.length < 120, `${segs.length} wall segments`);
// Every generated wall sits on the floor's edge: floor on one side, not-floor on the other
const onEdge = segs.filter(([x0, y0, x1, y1]) => {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const L = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = -(y1 - y0) / L;
  const ny = (x1 - x0) / L;
  const at = (x, y) => vis.mask[(Math.min(H - 1, Math.max(0, Math.floor(y))) * W) + Math.min(W - 1, Math.max(0, Math.floor(x)))];
  return at(mx + (nx * 2), my + (ny * 2)) !== at(mx - (nx * 2), my - (ny * 2));
});
ok(onEdge.length / segs.length > 0.9, `walls follow the floor's outline (${onEdge.length}/${segs.length})`);
const loop = traceContours(new Uint8Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]), 4, 4);
ok(loop.length === 1 && loop[0].length === 9 && loop[0][0].x === loop[0].at(-1).x && loop[0][0].y === loop[0].at(-1).y, "marching squares closes loops");
ok(simplify([{x: 0, y: 0}, {x: 1, y: 0.01}, {x: 2, y: 0}, {x: 2, y: 2}], 0.1).length === 3, "RDP keeps corners, drops wiggles");
const noEdges = wallSegments(new Uint8Array(100).fill(1), 10, 10, {S: 10, edges: false});
ok(noEdges.length === 0, "floor that runs off the map makes no walls when map edges are off");

/* ---------------- Navigation ---------------- */
const grid = 100;
const toScene = ([x0, y0, x1, y1]) => [x0 / S * grid, y0 / S * grid, x1 / S * grid, y1 / S * grid];
const sceneWalls = segs.map(toScene);
const nav = NavGrid.fromMask(vis, {sceneX: 0, sceneY: 0, grid, cellsPerSquare: 2, walls: sceneWalls});
ok(nav.cols === 60 && nav.rows === 40, "two navigation cells per square");
const P = (x, y) => ({x: x * grid, y: y * grid});
const t1 = performance.now();
const route = nav.route(P(4, 8), P(23, 9));
const tRoute = performance.now() - t1;
ok(route && route.length >= 2, `a route from room A to room B exists (${route?.length} waypoints, ${Math.round(tRoute)} ms)`);
const crossesAny = pts => pts.some((p, i) => i && sceneWalls.some(w => segmentsIntersect(pts[i - 1].x, pts[i - 1].y, p.x, p.y, ...w)));
ok(route && !crossesAny(route), "the route crosses no wall");
ok(route && route.every(p => nav.isWalkable(nav.cellAt(p.x, p.y))), "every waypoint is on the floor");
ok(route && route.some(p => (p.x > 12 * grid) && (p.x < 18 * grid)), "it goes through the corridor");
ok(route && route.length <= 8, "string pulling keeps routes simple");
// A closed door (wall across the corridor) cuts the map in two
const door = [15 * grid, 5 * grid, 15 * grid, 7 * grid];
const shut = NavGrid.fromMask(vis, {sceneX: 0, sceneY: 0, grid, cellsPerSquare: 2, walls: [...sceneWalls, door]});
ok(shut.route(P(4, 8), P(23, 9)) === null, "a closed door blocks the way");
ok(shut.route(P(4, 8), P(10, 3)) !== null, "but each side is still walkable");
const tableCell = nav.cellAt(6 * grid, 5.5 * grid);
ok(!nav.isWalkable(tableCell), "the table blocks navigation");
ok(nav.clearance[nav.cellAt(7 * grid, 6.5 * grid)] < nav.clearance[nav.cellAt(9 * grid, 7 * grid)] + 3, "clearance grows away from obstacles");

/* ---------------- Rooms ---------------- */
const rooms = findRooms(nav, {cellsPerSquare: 2});
const roomAt = (x, y) => rooms.roomOf[nav.cellAt(x * grid, y * grid)];
ok(rooms.rooms.length >= 2 && rooms.rooms.length <= 5, `${rooms.rooms.length} rooms found`);
ok(roomAt(7, 4) !== roomAt(22, 7), "the two halls are different rooms");
ok(rooms.doorways.length >= 1, `${rooms.doorways.length} doorway(s)`);
const ra = rooms.rooms[roomAt(7, 4)];
ok(ra.area > 200 && Math.abs(ra.center.x - 700) < 300, "room sizes and hearts are sensible");
const corridorRoom = rooms.rooms[roomAt(15, 6)];
ok(corridorRoom && ((corridorRoom.elongation > 2) || (corridorRoom.id === ra.id) || (corridorRoom.id === roomAt(22, 7))), "the corridor is long and thin, or part of a hall");

/* ---------------- Patrols ---------------- */
const {buildShape} = await import(pathToFileURL(MODS + "kostis-actual-animator/scripts/shapes.js").href);
const sample = shape => {
  const lut = buildShape(shape).lut;
  const pts = [];
  for ( let i = 0; i < lut.count; i += 2 ) pts.push({x: lut.xs[i], y: lut.ys[i]});
  pts.push({x: lut.xs[lut.count - 1], y: lut.ys[lut.count - 1]});
  return pts;
};
const ctx = {nav, rooms: rooms.rooms, roomOf: rooms.roomOf, cellsPerSquare: 2};
const results = {};
for ( const strategy of ["rounds", "perimeter", "pace", "guard", "wander", "stationary", "auto"] ) {
  const at = strategy === "pace" ? P(15, 6) : P(4, 8);
  const plan = planWaypoints(ctx, at, strategy, {seed: seedOf("goblin")});
  const legs = routeLegs(nav, plan.waypoints);
  const anim = patrolAnimation(plan, legs, {name: "x", tokens: ["goblin"], speed: 1, sample, nav});
  const allPts = anim.steps.flatMap(st => (st.shape.type === "path" ? sample(st.shape) : [{x: st.shape.x, y: st.shape.y}]));
  results[strategy] = {plan, legs, anim, allPts};
}
ok(Object.values(results).every(r => r.anim.steps.length >= 1), "every strategy produces an animation");
ok(results.rounds.plan.waypoints.length >= 3 && results.rounds.legs.length >= 3, "rounds visit several rooms");
const rRooms = new Set(results.rounds.plan.waypoints.map(p => roomAt(p.x / grid, p.y / grid)));
ok(rRooms.size >= 2, `rounds cross into other rooms (${rRooms.size})`);
ok(results.perimeter.plan.waypoints.length >= 4, "the perimeter walk has a ring of waypoints");
ok(results.pace.plan.waypoints.length === 3, "pacing goes to both ends and back");
ok(results.guard.anim.steps[0].shape.type === "point" && results.guard.anim.facing.swayAmp > 0, "guards stand still and look around");
ok(results.wander.plan.waypoints.length >= 4, "wandering visits a few nearby spots");
for ( const [name, r] of Object.entries(results) ) {
  const clear = r.allPts.every((p, i) => !i || nav.lineClear(r.allPts[i - 1], p, {margin: 0}));
  ok(clear, `${name}: the final curved path stays on the floor and never crosses a wall`);
}
ok(Object.values(results).every(r => {
  const first = r.anim.steps[0].shape;
  const p0 = first.type === "path" ? first.nodes[0] : first;
  const lastStep = r.anim.steps.at(-1).shape;
  const pn = lastStep.type === "path" ? lastStep.nodes.at(-1) : lastStep;
  return Math.hypot(p0.x - pn.x, p0.y - pn.y) < 1e-6;
}), "every routine is a closed tour that starts and ends at the NPC");
const a1 = planWaypoints(ctx, P(4, 8), "wander", {seed: 5});
const a2 = planWaypoints(ctx, P(4, 8), "wander", {seed: 5});
ok(JSON.stringify(a1) === JSON.stringify(a2), "plans are deterministic per NPC");
ok(results.rounds.anim.motion.loop === "loop" && results.rounds.anim.motion.anchor === "absolute" && results.rounds.anim.motion.speedUnit === "grid", "patrols loop forever on absolute paths");
const autoPick = chooseStrategy(ctx, P(15, 6));
ok(autoPick === "pace" || autoPick === "guard", `an NPC in the corridor paces or guards (${autoPick})`);
const groups = squads(tokens.map(t => ({x: t.at.x * 10, y: t.at.y * 10})), 150);
ok(groups.length === 3 && groups.some(g => g.length === 2), "the two orcs standing together form a squad");

/* ============================================================================================================
   Foundry glue (mocked Foundry, mocked animator API with the animator's real geometry)
   ============================================================================================================ */
{
  const {readFileSync} = await import("node:fs");
  const {createRequire} = await import("node:module");
  const require = createRequire(import.meta.url);
  const Handlebars = require(`${FOUNDRY_APP}/node_modules/handlebars`);
  const MOD = "kostis-auto-patrol";
  const KAA = "kostis-actual-animator";
  const flush = () => new Promise(r => setTimeout(r, 5));
  class ForcedDeletion {}
  class Replace { constructor(v) { this.v = v; } }
  globalThis._replace = v => new Replace(v);
  const isDel = v => v instanceof ForcedDeletion;
  const applyChanges = (target, ch) => {
    for ( const [k, v] of Object.entries(ch) ) {
      if ( isDel(v) ) delete target[k];
      else if ( v instanceof Replace ) target[k] = structuredClone(v.v);
      else if ( v && (typeof v === "object") && !Array.isArray(v) ) {
        if ( !target[k] || (typeof target[k] !== "object") ) target[k] = {};
        applyChanges(target[k], v);
      } else target[k] = v;
    }
  };
  const hooks = {};
  globalThis.Hooks = {
    on: (n, f) => (hooks[n] ??= []).push(f), once: (n, f) => (hooks[n] ??= []).push(f),
    callAll: (n, ...a) => { for ( const f of hooks[n] ?? [] ) f(...a); }
  };
  class Collection extends Map {
    filter(fn) { return [...this.values()].filter(fn); }
    find(fn) { return [...this.values()].find(fn); }
    some(fn) { return [...this.values()].some(fn); }
    map(fn) { return [...this.values()].map(fn); }
    get contents() { return [...this.values()]; }
    [Symbol.iterator]() { return this.values(); }
  }
  let idn = 0;
  class Doc {
    constructor(parent, data, name) { this.parent = parent; this.documentName = name; this.id = data._id ?? `${name}${++idn}`; this.flags = {}; Object.assign(this, structuredClone(data)); }
    getFlag(s, k) { return this.flags?.[s]?.[k]; }
    async update(changes, options = {}) { this.lastUpdateOptions = options; applyChanges(this, changes); Hooks.callAll(`update${this.documentName}`, this, changes, options); return this; }
    toObject() { const {parent, id, documentName, ...rest} = this; return {...structuredClone(rest), _id: id}; }
  }
  class TokenD extends Doc {
    constructor(parent, data) { super(parent, {width: 1, height: 1, rotation: 0, disposition: -1, hidden: false, texture: {src: "icons/svg/mystery-man.svg"}, ...data}, "Token"); }
    get object() { return {center: {x: this.x + 50, y: this.y + 50}, document: this}; }
  }
  const scene = {
    id: "S1", flags: {}, tokens: new Collection(), walls: new Collection(),
    dimensions: {size: 100, distance: 5, sceneX: 0, sceneY: 0, sceneWidth: 3000, sceneHeight: 2000},
    getFlag(s, k) { return this.flags?.[s]?.[k]; },
    async update(changes) { applyChanges(this, changes); Hooks.callAll("updateScene", this, changes); return this; },
    async createEmbeddedDocuments(type, data, options) {
      const docs = data.map(d => (type === "Wall" ? new Doc(this, d, "Wall") : new TokenD(this, d)));
      for ( const d of docs ) { (type === "Wall" ? this.walls : this.tokens).set(d.id, d); Hooks.callAll(`create${type}`, d, options); }
      this.lastOptions = options;
      return docs;
    },
    async deleteEmbeddedDocuments(type, ids, options) {
      for ( const id of ids ) { const c = type === "Wall" ? this.walls : this.tokens; const d = c.get(id); c.delete(id); Hooks.callAll(`delete${type}`, d, options); }
      this.lastOptions = options;
    }
  };
  const mkToken = (id, sx, sy, extra = {}) => { const t = new TokenD(scene, {_id: id, name: id, x: (sx * 100) - 50, y: (sy * 100) - 50, ...extra}); scene.tokens.set(id, t); return t; };
  mkToken("goblin", 4, 8, {actor: {hasPlayerOwner: false, system: {attributes: {movement: {walk: 30, units: "ft"}}}}});
  mkToken("wolf", 14.5, 6, {actor: {hasPlayerOwner: false, system: {attributes: {movement: {walk: 40}}}}});
  mkToken("orc", 19, 6, {actor: {hasPlayerOwner: false, system: {attributes: {movement: {walk: 30}}}}});
  mkToken("orc2", 19.8, 6.6, {actor: {hasPlayerOwner: false, system: {attributes: {movement: {walk: 25}}}}});
  mkToken("ally", 8, 3, {disposition: 1, actor: {hasPlayerOwner: false}});
  const hero = mkToken("hero", 24, 9, {disposition: 1, actor: {hasPlayerOwner: true}});

  // Animator mock (real geometry)
  const {buildShape: realBuild} = await import(pathToFileURL(MODS + "kostis-actual-animator/scripts/shapes.js").href);
  const {normalizeShape} = await import(pathToFileURL(MODS + "kostis-actual-animator/scripts/shapes.js").href);
  const anims = new Map();
  const plays = [];
  const stops = [];
  let an = 0;
  const kaaApi = {
    createAnimation: async data => { const id = (data.id && !anims.has(data.id)) ? data.id : `A${++an}`; const a = {...structuredClone(data), id, steps: data.steps.map(s => ({...s, shape: normalizeShape(s.shape)}))}; anims.set(id, a); return a; },
    getAnimation: id => anims.get(id) ?? null,
    updateAnimation: async (id, changes) => {
      const a = anims.get(id);
      if ( !a ) return null;
      const copy = structuredClone(a);
      const next = (typeof changes === "function" ? changes(copy) : Object.assign(copy, changes)) ?? copy;
      next.steps = next.steps.map(st => ({...st, shape: normalizeShape(st.shape)}));
      anims.set(id, next);
      return next;
    },
    deleteAnimation: async id => { anims.delete(id); },
    play: async (id, tokens) => { plays.push({id, tokens: [...tokens]}); for ( const t of tokens ) { const d = scene.tokens.get(t); if ( d ) { d.flags[KAA] ??= {}; d.flags[KAA].playback = {anim: id}; } } },
    stop: async (tokens, opts) => { stops.push({tokens: [...tokens], opts}); for ( const t of tokens ) delete scene.tokens.get(t)?.flags?.[KAA]?.playback; },
    internals: {buildShape: realBuild}
  };
  const settings = new Map(Object.entries({watch: true, alertSeconds: 12, chaseSpeed: 1.8, alarmRadius: 12, whisper: true, pauseOnSpot: false, pauseInCombat: true}).map(([k, v]) => [`${MOD}.${k}`, v]));
  settings.set("kostis-flying-paths.assetFolder", "");
  const gmUser = {id: "gm", isGM: true, isSelf: true, active: true, can: () => true};
  const chats = [];
  globalThis.ChatMessage = {create: m => chats.push(m)};
  globalThis.foundry = {
    utils: {randomID: (n = 8) => Math.random().toString(36).slice(2, 2 + n), hasProperty: (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o) !== undefined,
      deepClone: o => structuredClone(o), mergeObject: (a, b) => Object.assign(a, b), debounce: f => f, Color: {from: c => ({valueOf: () => parseInt(String(c).replace("#", ""), 16) || 0})}},
    data: {operators: {ForcedDeletion}},
    canvas: {layers: {PlaceablesLayer: class {}, InteractionLayer: class { static get layerOptions() { return {}; } }}},
    applications: {
      api: {ApplicationV2: class { render() { this.rendered = true; return this; } _onClose() {} async _onFirstRender() {} bringToFront() {} },
        HandlebarsApplicationMixin: B => class extends B {}, DialogV2: {confirm: async () => true}},
      handlebars: {loadTemplates: () => {}},
      apps: {FilePicker: {implementation: {}}}, sidebar: {apps: {ModuleManagement: class {}}}
    }
  };
  globalThis._del = new ForcedDeletion();
  globalThis.CONST = {TOKEN_DISPOSITIONS: {HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1}, WALL_MOVEMENT_TYPES: {NONE: 0, NORMAL: 20}, EDGE_SENSE_TYPES: {NONE: 0, LIMITED: 10, NORMAL: 20},
    WALL_DOOR_STATES: {CLOSED: 0, OPEN: 1, LOCKED: 2}, OCCLUSION_MODES: {NONE: 0}, TEXT_ANCHOR_POINTS: {TOP: 1}};
  const collide = (a, b) => scene.walls.some(w => w.sight !== 0 && segmentsIntersect(a.x, a.y, b.x, b.y, ...w.c));
  globalThis.CONFIG = {Canvas: {layers: {}, polygonBackends: {sight: {testCollision: (a, b) => collide(a, b)}}}, queries: {}};
  globalThis.game = {
    ready: true, user: gmUser, paused: false,
    users: {activeGM: gmUser, filter: f => [gmUser].filter(f), get: () => gmUser},
    world: {id: "w"}, scenes: Object.assign([scene], {get: id => (id === scene.id ? scene : undefined)}),
    settings: {register: () => {}, get: (m, k) => settings.get(`${m}.${k}`), set: async (m, k, v) => settings.set(`${m}.${k}`, v)},
    keybindings: {register: () => {}},
    modules: {get: id => ({[KAA]: {active: true, api: kaaApi}, [MOD]: {active: true}, "kostis-flying-paths": {active: true}})[id] ?? null},
    i18n: {localize: k => k, format: (k, d) => `${k} ${JSON.stringify(d)}`},
    togglePause: p => { game.paused = p; },
    combats: []
  };
  globalThis.ui = {notifications: {info: () => {}, warn: () => {}, error: m => console.log("  [error]", m)}, controls: {render: () => {}, activate: () => {}}};
  class Gfx { constructor() { this.children = []; } lineStyle() { return this; } beginFill() { return this; } endFill() { return this; } drawCircle() { return this; } drawRect() { return this; } moveTo() { return this; } lineTo() { return this; } destroy() {} }
  globalThis.PIXI = {Graphics: Gfx, Sprite: class { constructor(t) { this.texture = t; this.position = {set() {}}; } destroy() {} }, Texture: {from: () => ({baseTexture: {}, destroy() {}})},
    Container: class { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } removeChildren() { const c = this.children; this.children = []; return c; } }, LINE_CAP: {ROUND: "round"}, SCALE_MODES: {NEAREST: 0}};
  globalThis.document = {createElement: () => ({getContext: () => ({createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}), putImageData() {}})})};
  const overlayRoot = new PIXI.Container();
  globalThis.canvas = {ready: true, scene, dimensions: scene.dimensions, tokens: {controlled: [], get: id => scene.tokens.get(id)?.object}, interface: {createScrollingText: (...a) => (canvas.texts = (canvas.texts ?? 0) + 1)},
    animatePan: () => {}};
  // The hub's overlay container for this module
  const {UndoStack} = await import(pathToFileURL(MODS + "kostis-flying-paths/scripts/history.js").href);
  const history = {push: (...a) => UndoStack.push(...a), undo: () => UndoStack.undo(), peek: () => UndoStack.peek(), clear: id => UndoStack.clear(id)};
  game.modules.get = (orig => id => (id === "kostis-flying-paths" ? {active: true, api: {layer: {overlay: () => overlayRoot}, math: null, activateTool: () => {}, history}} : orig(id)))(game.modules.get);
  Math.toRadians = d => d * Math.PI / 180;
  Math.toDegrees = r => r * 180 / Math.PI;

  const {Scanner, movementWalls} = await imp("scanner.js");
  const {createWalls, generatedWalls, removeGeneratedWalls} = await imp("walls.js");
  const {Patroller} = await imp("patroller.js");
  const {Behaviour, canSee, lookDirection} = await imp("behaviour.js");
  const {Hints} = await imp("hints.js");
  const {Overlay} = await imp("overlay.js");
  await imp("main.js");
  Hooks.callAll("init");
  ok(globalThis.KAP && typeof KAP.generate === "function", "API exposed as KAP");

  // Scan with tokens as floor seeds
  const image = {...img, S, sceneX: 0, sceneY: 0, grid: 100};
  const r = await Scanner.scan({image});
  ok(r && r.vision.floorShare > 0.2 && r.proposed.length > 8 && r.rooms.rooms.length >= 2, `scanning the scene finds floor, ${r.proposed.length} walls and ${r.rooms.rooms.length} rooms`);
  // Walls
  const proposed = [...r.proposed];
  const made = await createWalls(proposed);
  ok(made.length === proposed.length && generatedWalls(scene).length === made.length && scene.lastOptions.kfpNoHistory, "proposed walls are created (flagged, outside Ctrl+Z)");
  ok(made.every(w => w.move === 20 && w.sight === 20), "they block movement and sight");
  Scanner.refreshNav();
  ok(Scanner.current.proposed.length === 0, "once created, walls are no longer proposed");
  const rescan = await Scanner.scan({image});
  ok(rescan.proposed.length === 0 && movementWalls(scene).length === made.length, "a rescan does not propose existing walls again");
  ok(history.peek()?.label === "KAP.Undo.CreateWalls {\"count\":" + made.length + "}", "creating walls can be undone");
  await history.undo();
  ok(scene.walls.size === 0, "undo removes the created walls");
  const remade = await createWalls(proposed);
  const nGen = await removeGeneratedWalls(scene);
  ok(nGen === remade.length && scene.walls.size === 0, "generated walls can be removed");
  await history.undo();
  ok(scene.walls.size === remade.length && generatedWalls(scene).length === remade.length, "and undoing brings them back");
  made.length = 0;
  made.push(...scene.walls.contents);
  UndoStack.clear();
  Scanner.refreshNav();
  // Hints
  await Hints.add("wall", [{x: 1500, y: 600}]);
  ok(Hints.get(scene).wall.length === 1, "hints are saved on the scene");
  await Hints.add("floor", [{x: 1510, y: 610}]);
  ok(Hints.get(scene).wall.length === 0 && Hints.get(scene).floor.length === 1, "a floor hint cancels a nearby wall hint");
  await Hints.clear();
  ok(!Hints.get(scene).floor.length, "hints can be cleared");
  // Undo, erase
  await history.undo();
  ok(Hints.get(scene).floor.length === 1, "Ctrl+Z brings cleared hints back");
  await history.undo();
  ok(Hints.get(scene).floor.length === 0 && Hints.get(scene).wall.length === 1, "and undoes a floor stroke (restoring the wall hint it replaced)");
  await history.undo();
  ok(!Hints.get(scene).wall.length && !Hints.get(scene).floor.length, "and the stroke before it");
  const {Hints: H} = await imp("hints.js");
  const brush = H.brush("floor");
  brush.dragStart({}, {x: 300, y: 300});
  brush.dragMove({}, {x: 360, y: 300});
  brush.dragMove({}, {x: 420, y: 300});
  await brush.dragDrop({}, {x: 480, y: 300});
  const stroke = Hints.get(scene).floor.length;
  ok(stroke >= 3, `a dragged stroke paints a line of hints (${stroke})`);
  await brush.rightClick({}, {x: 420, y: 300});
  ok(Hints.get(scene).floor.length < stroke, "right-click with a brush erases the hints under it");
  await H.brush("erase").click({}, {x: 300, y: 300});
  const left = Hints.get(scene).floor.length;
  await history.undo();
  ok(Hints.get(scene).floor.length > left, "erasing can be undone");
  await Hints.clear();
  UndoStack.clear();

  // Patrol generation
  ok(Patroller.speedOf(scene.tokens.get("wolf")) > Patroller.speedOf(scene.tokens.get("orc2")), "faster creatures patrol faster");
  const candidates = Patroller.candidates(scene);
  ok(candidates.length === 4 && !candidates.some(t => ["hero", "ally"].includes(t.id)), "hostile NPCs are candidates; player characters and allies are not");
  const created = await KAP.generate(undefined, {response: "alert", range: 12, cone: 360});
  ok(created.length === 3, `three patrols (the two orcs share one): ${created.map(p => p.strategy).join(", ")}`);
  const orcs = created.find(p => p.tokens.includes("orc"));
  ok(orcs.tokens.includes("orc2") && anims.get(orcs.animId).stagger.mode === "delay", "the squad walks in file");
  ok(created.every(p => plays.some(pl => pl.id === p.animId)), "patrols start right away");
  ok(created.some(p => anims.get(p.animId).facing.smoothing === 60), "facing is smoothed over 0.6 squares of path (in pixels)");
  ok(created.every(p => scene.flags[MOD].patrols[p.animId].active === true && scene.flags[MOD].patrols[p.animId].waypoints?.length), "patrols remember that they are on, and the points they visit");
  ok(Object.keys(scene.flags[MOD].patrols).length === 3, "patrols are recorded on the scene");
  const allClear = [...anims.values()].every(a => a.steps.every(st => st.shape.type !== "path" || (() => {
    const lut = realBuild(st.shape).lut;
    for ( let i = 1; i < lut.count; i++ ) {
      if ( scene.walls.some(w => segmentsIntersect(lut.xs[i - 1], lut.ys[i - 1], lut.xs[i], lut.ys[i], ...w.c)) ) return false;
    }
    return true;
  })()));
  ok(allClear, "no patrol route crosses a wall");
  // Regenerating replaces
  const before = anims.size;
  const oldGoblin = Patroller.of("goblin").strategy;
  await KAP.generate([scene.tokens.get("goblin")], {strategy: "perimeter"});
  ok(anims.size === before && Patroller.of("goblin").strategy === "perimeter", "regenerating a token's patrol replaces the old one");
  await history.undo();
  ok(Patroller.of("goblin")?.strategy === oldGoblin && anims.size === before, `undoing a regenerate brings the old patrol back (${oldGoblin})`);
  await KAP.generate([scene.tokens.get("goblin")], {strategy: "perimeter"});
  const removedOne = await KAP.remove(["goblin"]);
  ok(removedOne === 1 && !Patroller.of("goblin"), "removing a patrol");
  await history.undo();
  ok(Patroller.of("goblin")?.strategy === "perimeter" && plays.some(p => p.id === Patroller.of("goblin").animId), "can be undone (and it starts patrolling again)");

  // Route ends never cross a wall
  {
    const {NavGrid} = await imp("nav.js");
    const walkable = new Uint8Array(100).fill(1);
    for ( let r = 0; r < 10; r++ ) walkable[(r * 10) + 5] = 0;
    const g = new NavGrid({cols: 10, rows: 10, cell: 10, x: 0, y: 0, walkable, walls: [[57, 0, 57, 100]]});
    const cell = g.nearestWalkable(56, 55);
    ok(g.center(cell).x === 45, "the nearest walkable cell is on this side of a wall (not the closer one behind it)");
    const route = [{x: 45, y: 55}, {x: 45, y: 75}];
    g.joinEnds(route, {x: 52, y: 55}, {x: 45, y: 79});
    ok(route[0].x === 52 && route.at(-1).y === 79, "routes start and end exactly on their points when the way is clear");
    const blockedRoute = [{x: 65, y: 55}, {x: 65, y: 75}];
    g.joinEnds(blockedRoute, {x: 50, y: 55}, null);
    ok(blockedRoute[0].x === 65, "but never through a wall");
    const lw = [{move: 20, c: [0, 0, 1, 1], includedInLevel: l => l.id === "L1"}, {move: 20, c: [2, 2, 3, 3], includedInLevel: l => l.id === "L2"}];
    ok(movementWalls({walls: lw}, {id: "L1"}).length === 1, "walls on other levels don't block this one");
    const sc = {getFlag: (m, k) => (k === "patrols" ? {P1: {}} : undefined), walls: [
      {move: 20, c: [0, 0, 5, 5], flags: {"kostis-particle-effects": {effectWall: {id: "w", animId: "P1"}}}},
      {move: 20, c: [0, 0, 5, 5], flags: {"kostis-particle-effects": {effectWall: {id: "v", animId: "Other"}}}}]};
    ok(movementWalls(sc, null).length === 1, "an effect wall painted along a patrol's own route doesn't block that patrol (no tug of war)");
  }

  // Watching
  const w = {x: 0, y: 0, dir: 0};
  const blockedNever = () => false;
  ok(canSee(w, {x: 300, y: 0}, {range: 500, cone: 90, blocked: blockedNever}), "an NPC sees what is in front of it");
  ok(!canSee(w, {x: -300, y: 0}, {range: 500, cone: 90, blocked: blockedNever}), "but not behind it");
  ok(!canSee(w, {x: 600, y: 0}, {range: 500, cone: 360, blocked: blockedNever}), "or out of range");
  ok(!canSee(w, {x: 300, y: 0}, {range: 500, cone: 90, blocked: () => true}), "or through walls");
  ok(Math.abs(lookDirection({rotation: 0}) - Math.PI / 2) < 1e-9, "rotation 0 looks down the screen (token art convention)");

  // A player's orb in plain sight is not an intruder
  {
    Behaviour.reset();
    const savedHero = {x: hero.x, y: hero.y};
    hero.x = 650; hero.y = 350;
    mkToken("orb", 20.5, 7.5, {actor: {hasPlayerOwner: true}, flags: {"kostis-particle-effects": {particle: {preset: {}}}}});
    await Behaviour.tick();
    ok(!Behaviour.state.has("orc"), "a player's particle isn't mistaken for an intruder");
    scene.tokens.delete("orb");
    hero.x = savedHero.x; hero.y = savedHero.y;
    Behaviour.reset();
  }
  // The orcs' patrol: the hero walks into room B, in plain sight
  const orc = scene.tokens.get("orc");
  hero.x = 2050; hero.y = 750;
  plays.length = 0; stops.length = 0;
  await Behaviour.tick();
  const st = Behaviour.state.get("orc");
  ok(st?.mode === "alert" && stops.some(s => s.tokens.includes("orc")), "a patroller that sees the hero stops");
  ok(chats.some(c => /orc/.test(c.content) && /hero/.test(c.content)) && canvas.texts > 0, "the GM is told and an exclamation mark pops up");
  ok(Math.abs(orc.rotation - (((Math.atan2(800 - 650, 2100 - 1950) * 180 / Math.PI) - 90 + 360) % 360)) < 1, `and turns to face the intruder (${orc.rotation.toFixed(1)}°)`);
  ok(orc.lastUpdateOptions?.kfpNoHistory === true, "(turning isn't something the GM did: it stays out of Ctrl+Z)");
  // Hero hides behind a wall (room A): out of sight
  hero.x = 650; hero.y = 350;
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  await Behaviour.tick();
  ok(Behaviour.state.get("orc").mode === "alert", "it stays alert for a while");
  // It had stepped away from its route (say, to look around)
  orc.x += 250;
  orc.y += 150;
  fake += 13000;
  await Behaviour.tick();
  const back = [...anims.values()].find(a => /Return: orc$/.test(a.name));
  ok(Behaviour.state.get("orc").mode === "return" && back && plays.some(p => p.id === back.id), "then walks back to its route");
  ok(scene.flags[MOD].temp?.[back.id] === "orc", "(the walk is recorded on the scene, so a reload can't leave it behind)");
  const backEnd = back.steps[0].shape.nodes.at(-1);
  const routeStart = anims.get(orcs.animId).steps[0].shape.nodes[0];
  ok(Math.hypot(backEnd.x - routeStart.x, backEnd.y - routeStart.y) < 1e-6, "the walk back ends exactly where the route starts");
  delete orc.flags[KAA].playback;
  plays.length = 0;
  await Behaviour.tick();
  ok(!Behaviour.state.has("orc") && plays.some(p => (p.id === orcs.animId) && p.tokens.includes("orc")) && !anims.has(back.id)
    && !scene.flags[MOD].temp?.[back.id], "and carries on patrolling (the walk back is deleted)");
  // Spotting someone on the way back: that walk is deleted, not left behind
  orc.x += 300;
  await Behaviour.sendHome(orc, Patroller.of("orc"));
  const back2 = [...anims.values()].find(a => /Return: orc$/.test(a.name));
  ok(back2 && Behaviour.state.get("orc")?.mode === "return", "(walking back again)");
  hero.x = 2050; hero.y = 750;
  await Behaviour.tick();
  ok(Behaviour.state.get("orc")?.mode === "alert" && !anims.has(back2.id) && !scene.flags[MOD].temp?.[back2.id], "an NPC that spots someone on its way back drops that walk");
  hero.x = 650; hero.y = 350;
  Behaviour.reset();
  // A reload in the middle of a walk: the walk is cleaned up and the NPC sent home
  anims.set("Tleft", {id: "Tleft", name: "KAP.Temp.Chase: orc", steps: [], tokens: ["orc"]});
  await scene.update({flags: {[MOD]: {temp: {Tleft: "orc"}}}});
  await Behaviour.sweep(scene);
  ok(!anims.has("Tleft") && !scene.flags[MOD].temp?.Tleft && Behaviour.state.get("orc")?.mode === "return", "walks interrupted by a reload are cleaned up, and the NPC heads back to its route");
  Behaviour.reset();
  for ( const a of [...anims.values()] ) if ( /^KAP\.Temp/.test(a.name) ) anims.delete(a.id);
  delete orc.flags[KAA]?.playback;
  // Chase
  await Patroller.configure(orcs.animId, {response: "chase"});
  hero.x = 2450; hero.y = 950;
  delete scene.tokens.get("orc").flags[KAA]?.playback;
  Behaviour.reset();
  await Behaviour.tick();
  const chase = [...anims.values()].find(a => /Chase: orc$/.test(a.name));
  ok(Behaviour.state.get("orc")?.mode === "chase" && chase, "chasers run after the intruder");
  const chaseEnd = chase.steps[0].shape.nodes.at(-1);
  const short = Math.hypot(chaseEnd.x - 2500, chaseEnd.y - 1000);
  ok(short > 90 && short < 110, `stopping a square short (${short.toFixed(1)}px)`);
  ok(chase.motion.speed > anims.get(orcs.animId).motion.speed, "faster than their patrol pace");
  // Alarm
  Behaviour.reset();
  await Patroller.configure(orcs.animId, {response: "alarm"});
  const wolfP = Patroller.of("wolf");
  delete scene.tokens.get("orc").flags[KAA]?.playback;
  await Behaviour.tick();
  ok(Behaviour.state.get("wolf")?.mode === "investigate" || Behaviour.state.get("wolf")?.mode === "alert", "an alarm brings nearby patrols to investigate");
  ok(wolfP, "the wolf has a patrol");
  // Someone coming to investigate who finds an intruder reacts to them
  const wolf = scene.tokens.get("wolf");
  Behaviour.state.set("wolf", {mode: "investigate", since: Date.now(), lastSeen: Date.now(), patrol: wolfP.animId, sceneId: "S1"});
  hero.x = wolf.x + 150; hero.y = wolf.y;
  await Behaviour.tick();
  ok(["alert", "chase"].includes(Behaviour.state.get("wolf")?.mode), `an investigator that finds the intruder reacts (${Behaviour.state.get("wolf")?.mode})`);
  Date.now = realNow;
  // A stopped patrol stays stopped, whatever its NPCs see
  Behaviour.reset();
  await Patroller.stop([wolfP.animId]);
  ok(Patroller.of("wolf").active === false, "stopping a patrol is remembered");
  plays.length = 0;
  await Behaviour.tick();
  ok(!Behaviour.state.has("wolf") && !plays.some(p => p.tokens.includes("wolf")), "and its NPCs neither react nor set off again on their own");
  await Patroller.start([wolfP.animId]);
  ok(Patroller.of("wolf").active === true && (plays.some(p => p.tokens.includes("wolf")) || Behaviour.state.get("wolf")?.mode === "return"), "starting it again");
  hero.x = 650; hero.y = 350;
  // Combat (checked on every tick: any GM may start it, on any client)
  Behaviour.reset();
  stops.length = 0;
  game.combats = [{started: true, scene: {id: "S1"}, combatants: []}];
  await Behaviour.tick();
  ok(stops.length >= 1 && Array.isArray(scene.flags[MOD].combatPaused) && scene.flags[MOD].combatPaused.length >= 1, "patrols hold still while the scene is in combat");
  hero.x = 2050; hero.y = 750;
  const animsInCombat = anims.size;
  await Behaviour.tick();
  ok(!Behaviour.state.size && anims.size === animsInCombat, "and nobody reacts to intruders mid-fight");
  hero.x = 650; hero.y = 350;
  scene.tokens.get("goblin").x += 600;
  plays.length = 0;
  game.combats = [];
  await Behaviour.tick();
  ok([...anims.values()].some(a => /Return/.test(a.name)) && Behaviour.state.get("goblin")?.mode === "return" && !scene.flags[MOD].combatPaused,
    "after combat, NPCs that moved walk back to their routes first");
  // A patrol stopped before the fight stays stopped after it
  Behaviour.reset();
  await Patroller.stop([wolfP.animId]);
  game.combats = [{started: true, scene: {id: "S1"}, combatants: []}];
  await Behaviour.tick();
  game.combats = [];
  plays.length = 0;
  await Behaviour.tick();
  ok(!plays.some(p => p.tokens.includes("wolf")) && Patroller.of("wolf").active === false, "a patrol stopped before the fight stays stopped after it");
  await Patroller.start([wolfP.animId]);
  Behaviour.reset();

  // Doors: a door that closes on a route sends the patrol around it (and back when it opens)
  {
    const p0 = Patroller.of("orc");
    const before0 = JSON.stringify(anims.get(p0.animId).steps.map(st => st.shape.nodes?.map(n => [Math.round(n.x), Math.round(n.y)])));
    // Find a stretch of the route and drop a closed door across it
    const sampleShape = sh => { const lut = realBuild(sh).lut; const out = []; for ( let i = 0; i < lut.count; i++ ) out.push({x: lut.xs[i], y: lut.ys[i]}); return out; };
    // The middle of the route's longest straight stretch
    let seg = null;
    for ( const st of anims.get(p0.animId).steps ) {
      const n = st.shape.nodes ?? [];
      for ( let k = 1; k < n.length; k++ ) {
        const len = Math.hypot(n[k].x - n[k - 1].x, n[k].y - n[k - 1].y);
        if ( !seg || (len > seg.len) ) seg = {a: n[k - 1], b: n[k], len};
      }
    }
    const mid = {x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2};
    const nx = -(seg.b.y - seg.a.y) / seg.len;
    const ny = (seg.b.x - seg.a.x) / seg.len;
    const door = (await scene.createEmbeddedDocuments("Wall", [{c: [mid.x - (nx * 60), mid.y - (ny * 60), mid.x + (nx * 60), mid.y + (ny * 60)].map(Math.round),
      move: 20, sight: 20, door: 1, ds: 0}], {}))[0];
    await new Promise(r => setTimeout(r, 30));
    const crosses = () => anims.get(p0.animId).steps.some(st => st.shape.type === "path" && (() => {
      const q = sampleShape(st.shape);
      for ( let k = 1; k < q.length; k++ ) if ( segmentsIntersect(q[k - 1].x, q[k - 1].y, q[k].x, q[k].y, ...door.c) ) return true;
      return false;
    })());
    ok(seg.len > 100 && !crosses() && Patroller.of("orc").rerouted, `a door closing on a route sends the patrol around it (${door.c.join(",")})`);
    await door.update({ds: 1});
    await new Promise(r => setTimeout(r, 30));
    const reopened = JSON.stringify(anims.get(p0.animId).steps.map(st => st.shape.nodes?.map(n => [Math.round(n.x), Math.round(n.y)])));
    ok(reopened === before0, "and back on its old way once the door opens");
    await scene.deleteEmbeddedDocuments("Wall", [door.id], {});
    await new Promise(r => setTimeout(r, 30));
  }

  // Quick clicks with a hint brush: every one counts
  await Promise.all([Hints.add("floor", [{x: 100, y: 100}]), Hints.add("floor", [{x: 900, y: 900}]), Hints.add("floor", [{x: 1700, y: 300}])]);
  ok(Hints.get(scene).floor.length === 3, "quick clicks each add their hint");
  await Hints.clear();
  UndoStack.clear();

  // Overlay
  Overlay.enabled = true;
  Overlay.show = {mask: true, rooms: true, walls: true, routes: true, hints: true};
  Overlay.draw();
  ok(overlayRoot.children.length >= 4, `the overlay draws floor, rooms, hints and routes (${overlayRoot.children.length} layers)`);
  Overlay.enabled = false;
  Overlay.draw();
  ok(overlayRoot.children.length === 0, "and clears when planning ends");

  // Planner
  Handlebars.registerHelper("eq", (a, b) => a === b);
  const tpl = Handlebars.compile(readFileSync(ROOT + "templates/planner.hbs", "utf8"));
  const {PatrolPlanner} = await imp("planner.js");
  const planner = new PatrolPlanner();
  planner.render = function() { return this; };
  let html = "";
  for ( const tab of ["scan", "patrols", "behaviour"] ) {
    PatrolPlanner.DEFAULT_OPTIONS.actions.switchTab.call(planner, {}, {dataset: {tab}});
    html += tpl(await planner._prepareContext({}));
  }
  ok(/data-action="scan"/.test(html) && /data-action="generateAll"/.test(html) && /name="setting.watch"/.test(html), "all three planner tabs render");
  const used = [...readFileSync(ROOT + "templates/planner.hbs", "utf8").matchAll(/data-action="([^"{]+)"/g)].map(m => m[1]);
  const missing = used.filter(a => !(a in PatrolPlanner.DEFAULT_OPTIONS.actions));
  ok(!missing.length, `every planner button is wired${missing.length ? ": missing " + missing.join(", ") : ""}`);
  ok(/orc/.test(html) && /kap-patrol/.test(html), "the planner lists NPCs and their patrols");
  if ( process.env.KAP_PREVIEW ) {
    const {writeFileSync} = await import("node:fs");
    const color = await import(pathToFileURL(MODS + "kostis-flying-paths/scripts/math/color.js").href);
    const getMod = game.modules.get;
    game.modules.get = id => (id === "kostis-flying-paths" ? {active: true, api: {layer: {overlay: () => overlayRoot}, math: {color}, activateTool: () => {}}} : getMod(id));
    const PUB = pathToFileURL(`${FOUNDRY_APP}/public/`).href;
    for ( const tab of ["scan", "patrols", "behaviour"] ) {
      PatrolPlanner.DEFAULT_OPTIONS.actions.switchTab.call(planner, {}, {dataset: {tab}});
      const body = tpl(await planner._prepareContext({}));
      writeFileSync(process.env.KAP_PREVIEW + `planner-${tab}.html`, `<!doctype html><html><head><meta charset="utf-8"><base href="${PUB}">
<link rel="stylesheet" href="${PUB}css/foundry2.css"><link rel="stylesheet" href="${PUB}fonts/fontawesome/css/all.min.css">
<link rel="stylesheet" href="file:///${MODS}kostis-flying-paths/styles/hub.css"><link rel="stylesheet" href="file:///${ROOT}styles/kap.css">
<style>html,body{margin:0;width:600px;height:800px;background:#2b2d33;overflow:hidden}#kap-planner{position:absolute;left:20px;top:20px;width:560px;height:760px;display:flex;flex-direction:column}#kap-planner .window-content{flex:1;min-height:0}</style></head>
<body class="vtt game theme-dark"><div id="kap-planner" class="application kfp-app kap-planner themed theme-dark"><header class="window-header"><i class="window-icon fa-solid fa-person-military-pointing"></i><h1 class="window-title">Kostis's Auto-Patrol System</h1></header>
<section class="window-content">${body.replaceAll("icons/svg/mystery-man.svg", PUB + "icons/svg/mystery-man.svg")}</section></div></body></html>`);
    }
    game.modules.get = getMod;
    console.log("planner previews written");
  }

  // Removing
  const removed = await KAP.remove();
  ok(removed === 3 && !Object.keys(scene.flags[MOD].patrols ?? {}).length && ![...anims.values()].some(a => /Patrol/.test(a.name)), "removing patrols deletes their animations and records");
  const nw = await removeGeneratedWalls(scene);
  ok(nw === made.length && scene.walls.size === 0, "generated walls can be removed in one go");
}

/* ---------------- Visual check (written only when KAP_PREVIEW is set) ---------------- */
if ( process.env.KAP_PREVIEW ) {
  const {writeFileSync} = await import("node:fs");
  const b64 = Buffer.from(data.buffer).toString("base64");
  const mask64 = Buffer.from(vis.mask.buffer).toString("base64");
  const colors = ["#3fa7ff", "#3ddc84", "#f78c40", "#c56cf0", "#ff5d6c"];
  const roomCells = rooms.rooms.map((r, i) => r.cells.map(c => { const p = nav.center(c); return [p.x / grid * S, p.y / grid * S, colors[i % colors.length]]; })).flat();
  const routes = Object.entries(results).filter(([k]) => ["rounds", "perimeter", "pace", "wander"].includes(k)).map(([k, r]) => ({k, pts: r.allPts.map(p => [p.x / grid * S, p.y / grid * S]), color: r.anim.color}));
  const html = `<!doctype html><html><body style="margin:0;background:#111"><canvas id="c" width="${W * 3}" height="${H * 3}"></canvas><script>
const W=${W},H=${H},Z=3;const raw=Uint8ClampedArray.from(atob("${b64}"),c=>c.charCodeAt(0));const mask=Uint8Array.from(atob("${mask64}"),c=>c.charCodeAt(0));
const c=document.getElementById("c").getContext("2d");const tmp=document.createElement("canvas");tmp.width=W;tmp.height=H;tmp.getContext("2d").putImageData(new ImageData(raw,W,H),0,0);
c.imageSmoothingEnabled=false;c.drawImage(tmp,0,0,W*Z,H*Z);
const rc=${JSON.stringify(roomCells)};c.globalAlpha=0.28;for(const [x,y,col] of rc){c.fillStyle=col;c.fillRect((x-2.5)*Z,(y-2.5)*Z,5*Z,5*Z);}c.globalAlpha=1;
for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(!mask[y*W+x]){c.fillStyle="rgba(255,40,40,0.18)";c.fillRect(x*Z,y*Z,Z,Z);}
const segs=${JSON.stringify(segs)};c.strokeStyle="#ffe14d";c.lineWidth=3;for(const s of segs){c.beginPath();c.moveTo(s[0]*Z,s[1]*Z);c.lineTo(s[2]*Z,s[3]*Z);c.stroke();}
c.fillStyle="#ffe14d";for(const s of segs){c.beginPath();c.arc(s[0]*Z,s[1]*Z,3,0,7);c.fill();}
const routes=${JSON.stringify(routes)};for(const r of routes){c.strokeStyle=r.color;c.lineWidth=2.5;c.setLineDash([8,5]);c.beginPath();r.pts.forEach((p,i)=>i?c.lineTo(p[0]*Z,p[1]*Z):c.moveTo(p[0]*Z,p[1]*Z));c.stroke();}
c.setLineDash([]);const doors=${JSON.stringify(rooms.doorways.map(d => [d.point.x / grid * S, d.point.y / grid * S]))};for(const d of doors){c.fillStyle="#fff";c.beginPath();c.arc(d[0]*Z,d[1]*Z,6,0,7);c.fill();}
const toks=${JSON.stringify(tokens.map(t => [t.at.x, t.at.y]))};for(const t of toks){c.fillStyle="#000";c.strokeStyle="#fff";c.lineWidth=2;c.beginPath();c.arc(t[0]*Z,t[1]*Z,9,0,7);c.fill();c.stroke();}
</script></body></html>`;
  writeFileSync(process.env.KAP_PREVIEW + "pipeline.html", html);
  console.log("preview written");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
