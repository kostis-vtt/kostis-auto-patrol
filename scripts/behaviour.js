// Behaviour: patrolling NPCs keep watch. On the active GM's client, every few hundred milliseconds each patroller
// looks for player characters inside its view cone and range, with a real line of sight through walls. Then it
// reacts (stop and stare, chase, raise the alarm), and once the intruder has been out of sight for a while it walks
// back to its route (around walls) and carries on. Patrols hold still while there is combat on the scene.

import {ANIMATOR_ID, DEL, FLAG_PAUSED, FLAG_TEMP, MODULE_ID, NO_HISTORY} from "./const.js";
import {Patroller} from "./patroller.js";
import {Scanner} from "./scanner.js";

const kaa = () => (game.modules.get(ANIMATOR_ID)?.active ? game.modules.get(ANIMATOR_ID).api : null);
const setting = k => game.settings.get(MODULE_ID, k);
const now = () => Date.now();
const centerOf = d => {
  const g = d.parent.dimensions.size;
  return {x: d.x + ((d.width * g) / 2), y: d.y + ((d.height * g) / 2)};
};

/** The level a token stands on (v14 scene levels), or null. */
export const levelOf = doc => doc?._source?.level ?? doc?.level ?? null;

/** The direction a token looks, in radians (token art faces down at rotation 0). */
export function lookDirection(doc) {
  return Math.toRadians((doc.rotation ?? 0) + 90);
}

/**
 * Can `watcher` see `target`? Range in squares, cone in degrees, plus a sight-blocking line test.
 * @param {object} w          {x, y, dir} watcher centre and look direction (radians)
 * @param {{x:number,y:number}} t
 * @param {object} o          {range (px), cone (deg), blocked: (a, b) => boolean}
 */
export function canSee(w, t, {range, cone, blocked}) {
  const dx = t.x - w.x;
  const dy = t.y - w.y;
  const d = Math.hypot(dx, dy);
  if ( d > range ) return false;
  if ( cone < 360 ) {
    const diff = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - w.dir), Math.cos(Math.atan2(dy, dx) - w.dir)));
    if ( Math.toDegrees(diff) > (cone / 2) ) return false;
  }
  return !blocked(w, t);
}

/** Is a combat running on this scene? */
export function combatOn(scene) {
  return !!game.combats?.some(c => c.started && (c.scene ? (c.scene.id === scene.id)
    : c.combatants?.some(cb => cb.sceneId === scene.id)));
}

export class Behaviour {
  static #timer = null;

  /** tokenId → {mode, since, lastSeen, intruder, temp, walking, patrol, sceneId, chasedTo} */
  static state = new Map();

  /** Tokens being handled right now (a tick, a walk home): never two things at once for one NPC. */
  static #busy = new Set();

  /** Pausing for or resuming after combat. */
  static #combatBusy = false;

  /** NPCs that could not find their way back (told once). */
  static #lostTold = new Set();

  static start() {
    if ( this.#timer ) return;
    this.#timer = setInterval(() => this.tick().catch(err => console.error(`${MODULE_ID} | behaviour`, err)), 300);
  }

  static stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** A new scene: nothing carries over (temporary walks left behind are cleaned by sweep()). */
  static reset() {
    this.state.clear();
    this.#lostTold.clear();
  }

  static #blocked(a, b) {
    const backend = CONFIG.Canvas.polygonBackends?.sight;
    if ( !backend?.testCollision ) return false;
    return backend.testCollision(a, b, {type: "sight", mode: "any"});
  }

  /** The nearest player character this NPC can see (on its own level), or null. */
  static spot(doc, patrol, intruders) {
    const grid = doc.parent.dimensions.size;
    const c = doc.object?.center ?? centerOf(doc);
    const w = {x: c.x, y: c.y, dir: lookDirection(doc)};
    const level = levelOf(doc);
    let best = null;
    let bd = Infinity;
    for ( const t of intruders ) {
      const tl = levelOf(t);
      if ( level && tl && (tl !== level) ) continue;
      const tc = t.object?.center ?? centerOf(t);
      if ( !canSee(w, tc, {range: patrol.range * grid, cone: patrol.cone, blocked: (a, b) => this.#blocked(a, b)}) ) continue;
      const d = Math.hypot(tc.x - c.x, tc.y - c.y);
      if ( d < bd ) {
        bd = d;
        best = {doc: t, at: tc, distance: d};
      }
    }
    return best;
  }

  /** One round of watching. */
  static async tick() {
    if ( !game.users.activeGM?.isSelf || !canvas?.ready ) return;
    const scene = canvas.scene;
    if ( await this.#combat(scene) ) return;
    if ( !setting("watch") || game.paused ) return;
    const patrols = Patroller.list(scene).filter(p => p.exists && (p.response !== "ignore") && Patroller.isActive(p, scene));
    if ( !patrols.length ) return;
    // Player characters (not the particles a player controls: those have the shared particle actor)
    const intruders = scene.tokens.filter(t => t.actor?.hasPlayerOwner && !t.hidden && !t.getFlag("kostis-particle-effects", "particle"));
    for ( const p of patrols ) {
      for ( const id of p.tokens ) {
        if ( this.#busy.has(id) ) continue;
        const doc = scene.tokens.get(id);
        if ( !doc ) continue;
        const st = this.state.get(id) ?? {mode: "patrol"};
        const seen = intruders.length ? this.spot(doc, p, intruders) : null;
        this.#busy.add(id);
        try {
          await this.#step(doc, p, st, seen);
        } finally {
          this.#busy.delete(id);
        }
      }
    }
  }

  static async #step(doc, p, st, seen) {
    const t = now();
    switch ( st.mode ) {
      case "patrol":
        if ( seen ) await this.react(doc, p, seen);
        break;
      case "investigate":
        // Came to look and found someone: react as this patrol does
        if ( seen ) await this.react(doc, p, seen);
        else if ( t - (st.lastSeen ?? st.since) > setting("alertSeconds") * 1000 ) await this.#returnToRoute(doc, p, st);
        break;
      case "alert":
      case "chase":
        if ( seen ) {
          st.lastSeen = t;
          st.intruder = seen.doc.id;
          if ( (st.mode === "chase") && (t - (st.routed ?? 0) > 1500) ) {
            const moved = !st.chasedTo || (Math.hypot(seen.at.x - st.chasedTo.x, seen.at.y - st.chasedTo.y) > doc.parent.dimensions.size * 1.5);
            if ( moved ) await this.#chase(doc, p, seen.at, st);
          } else if ( st.mode === "alert" ) await this.#face(doc, seen.at);
        } else if ( t - (st.lastSeen ?? st.since) > setting("alertSeconds") * 1000 ) {
          await this.#returnToRoute(doc, p, st);
        }
        break;
      case "return":
        if ( seen ) await this.react(doc, p, seen);
        // Back on the route once the walk back has finished
        else if ( st.walking && !doc.getFlag(ANIMATOR_ID, "playback") ) await this.#resume(doc, p, st);
        break;
      case "lost":
        // No way back (a door closed behind it?): try again now and then
        if ( seen ) await this.react(doc, p, seen);
        else if ( t - st.since > 5000 ) await this.#returnToRoute(doc, p, st);
        break;
    }
  }

  /** Spotted someone. */
  static async react(doc, p, seen) {
    const api = kaa();
    if ( !api ) return;
    // The walk it was on (back to its route, to an alarm) is over
    await this.#cleanupTemp(this.state.get(doc.id));
    const st = {mode: p.response === "chase" ? "chase" : "alert", since: now(), lastSeen: now(), intruder: seen.doc.id,
      patrol: p.animId, sceneId: doc.parent.id};
    this.state.set(doc.id, st);
    await api.stop([doc.id], {mode: "here"});
    this.#exclaim(doc, "!");
    if ( setting("whisper") ) {
      ChatMessage.create({
        content: game.i18n.format("KAP.Chat.Spotted", {npc: doc.name, pc: seen.doc.name}),
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        speaker: {alias: game.i18n.localize("KAP.Chat.Speaker")}
      });
    }
    if ( setting("pauseOnSpot") && !game.paused ) game.togglePause(true, {broadcast: true});
    if ( st.mode === "chase" ) await this.#chase(doc, p, seen.at, st);
    else await this.#face(doc, seen.at);
    if ( p.response === "alarm" ) await this.#alarm(doc, seen.at);
  }

  /** Nearby patrollers come to have a look. */
  static async #alarm(caller, at) {
    const scene = caller.parent;
    const grid = scene.dimensions.size;
    const radius = setting("alarmRadius") * grid;
    for ( const p of Patroller.list(scene) ) {
      if ( !Patroller.isActive(p, scene) ) continue;
      for ( const id of p.tokens ) {
        if ( (id === caller.id) || this.#busy.has(id) ) continue;
        const doc = scene.tokens.get(id);
        const st = this.state.get(id);
        if ( !doc || (st && (st.mode !== "patrol")) ) continue;
        const c = centerOf(doc);
        if ( Math.hypot(c.x - at.x, c.y - at.y) > radius ) continue;
        this.#busy.add(id);
        try {
          const s = {mode: "investigate", since: now(), lastSeen: now(), patrol: p.animId, sceneId: scene.id};
          this.state.set(id, s);
          await kaa()?.stop([id], {mode: "here"});
          this.#exclaim(doc, "?");
          await this.#walk(doc, p, at, s, {speed: 1.5, stopShort: 1.5, label: "KAP.Temp.Investigate"});
        } finally {
          this.#busy.delete(id);
        }
      }
    }
  }

  static async #chase(doc, p, at, st) {
    st.chasedTo = {x: at.x, y: at.y};
    st.routed = now();
    await this.#walk(doc, p, at, st, {speed: setting("chaseSpeed"), stopShort: 1, label: "KAP.Temp.Chase"});
  }

  /**
   * Walk along a navigable route to a point (a temporary animation).
   * @returns {Promise<boolean>}  Whether the walk started
   */
  static async #walk(doc, p, to, st, {speed=1, stopShort=0, label}) {
    const api = kaa();
    const scan = api ? (Scanner.current ?? await Scanner.scan()) : null;
    if ( !api || !scan ) return false;
    const nav = scan.nav;
    const from = doc.object?.center ?? centerOf(doc);
    const pts = nav.route(from, to);
    if ( !pts?.length ) return false;
    // Routes run between cell centres: start where the NPC stands and end on the target where the line is clear
    nav.joinEnds(pts, from, to);
    if ( pts.length < 2 ) return false;
    // Stop a little short of the target
    if ( stopShort > 0 ) {
      const grid = doc.parent.dimensions.size;
      let cut = stopShort * grid;
      while ( (pts.length > 1) && cut > 0 ) {
        const a = pts.at(-2);
        const b = pts.at(-1);
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if ( L > cut ) {
          pts[pts.length - 1] = {x: b.x - (((b.x - a.x) / L) * cut), y: b.y - (((b.y - a.y) / L) * cut)};
          cut = 0;
        } else {
          pts.pop();
          cut -= L;
        }
      }
      if ( pts.length < 2 ) return false;
    }
    const scene = doc.parent;
    const base = api.getAnimation(p.animId, scene)?.motion.speed ?? 1;
    await this.#cleanupTemp(st);
    st.walking = false;
    const anim = await api.createAnimation({
      name: `${game.i18n.localize(label)}: ${doc.name}`,
      color: "#ff5d6c",
      tokens: [doc.id],
      steps: [{shape: {type: "path", closed: false, nodes: pts.map((q, i) => ({x: q.x, y: q.y, smooth: (i && (i < pts.length - 1)) ? 0.35 : 0}))}}],
      motion: {speed: base * speed, speedUnit: "grid", loop: "none", easeIn: 150, easeOut: 300, anchor: "absolute", finish: "stay"},
      facing: {mode: "path", smoothing: 0.3 * scene.dimensions.size}
    }, {scene});
    if ( !anim ) return false;
    st.temp = anim.id;
    st.sceneId = scene.id;
    // Remembered on the scene, so a reload mid-walk doesn't leave the animation behind
    await scene.update({flags: {[MODULE_ID]: {[FLAG_TEMP]: {[anim.id]: doc.id}}}});
    await api.play(anim.id, [doc.id]);
    st.walking = true;
    return true;
  }

  /** Lost them: walk back to the start of the route. */
  static async #returnToRoute(doc, p, st) {
    const api = kaa();
    const anim = api?.getAnimation(p.animId, doc.parent);
    if ( !anim ) {
      await this.#cleanupTemp(st);
      this.state.delete(doc.id);
      return;
    }
    const home = Patroller.routeStart(anim);
    st.mode = "return";
    st.since = now();
    if ( !home ) return;
    await api.stop([doc.id], {mode: "here"});
    const c = doc.object?.center ?? centerOf(doc);
    if ( Math.hypot(c.x - home.x, c.y - home.y) < 2 ) {
      st.walking = true;
      return;
    }
    if ( await this.#walk(doc, p, home, st, {speed: 1, stopShort: 0, label: "KAP.Temp.Return"}) ) {
      this.#lostTold.delete(doc.id);
      return;
    }
    // No way back: stay put (never cut through walls) and tell the GM once
    st.mode = "lost";
    st.since = now();
    if ( !this.#lostTold.has(doc.id) ) {
      this.#lostTold.add(doc.id);
      ui.notifications.warn(game.i18n.format("KAP.Warn.NoWayBack", {name: doc.name}));
    }
  }

  /**
   * Walk an NPC back to the start of its route (around walls), then let it carry on patrolling.
   * Used when patrols start while NPCs are elsewhere, and after combat.
   */
  static async sendHome(doc, p) {
    if ( this.#busy.has(doc.id) ) return;
    this.#busy.add(doc.id);
    try {
      await this.#cleanupTemp(this.state.get(doc.id));
      const st = {mode: "return", since: now(), lastSeen: 0, patrol: p.animId, sceneId: doc.parent.id};
      this.state.set(doc.id, st);
      await this.#returnToRoute(doc, p, st);
    } finally {
      this.#busy.delete(doc.id);
    }
  }

  /** Back on the route: carry on patrolling. */
  static async #resume(doc, p, st) {
    await this.#cleanupTemp(st);
    this.state.delete(doc.id);
    await kaa()?.play(p.animId, [doc.id]);
  }

  /** Forget NPCs (their patrol was stopped or removed): any walk they were on is deleted. */
  static async forget(tokenIds) {
    for ( const id of tokenIds ) {
      const st = this.state.get(id);
      this.state.delete(id);
      this.#lostTold.delete(id);
      await this.#cleanupTemp(st);
    }
  }

  static async #cleanupTemp(st) {
    if ( !st?.temp ) return;
    const id = st.temp;
    st.temp = null;
    st.walking = false;
    const scene = game.scenes.get(st.sceneId) ?? canvas.scene;
    const api = kaa();
    if ( api?.getAnimation(id, scene) ) await api.deleteAnimation(id, {scene});
    if ( scene?.getFlag(MODULE_ID, FLAG_TEMP)?.[id] ) await scene.update({flags: {[MODULE_ID]: {[FLAG_TEMP]: {[id]: DEL()}}}});
  }

  /**
   * Temporary walks left on a scene by a reload or a scene change: delete them, and send their NPCs (if their patrol
   * is on) back to their routes.
   */
  static async sweep(scene=canvas.scene) {
    if ( !scene || !game.users.activeGM?.isSelf ) return;
    const temps = scene.getFlag(MODULE_ID, FLAG_TEMP) ?? {};
    const live = new Set([...this.state.values()].map(s => s.temp).filter(Boolean));
    const stale = Object.entries(temps).filter(([animId]) => !live.has(animId));
    if ( !stale.length ) return;
    const api = kaa();
    const tokens = [...new Set(stale.map(([, tokenId]) => tokenId))].filter(id => scene.tokens.has(id));
    if ( api && tokens.length ) await api.stop(tokens, {mode: "here"});
    for ( const [animId] of stale ) if ( api?.getAnimation(animId, scene) ) await api.deleteAnimation(animId, {scene});
    await scene.update({flags: {[MODULE_ID]: {[FLAG_TEMP]: Object.fromEntries(stale.map(([id]) => [id, DEL()]))}}});
    if ( scene !== canvas.scene ) return;
    for ( const id of tokens ) {
      const p = Patroller.of(id, scene);
      const doc = scene.tokens.get(id);
      if ( p?.exists && doc && Patroller.isActive(p, scene) ) await this.sendHome(doc, p);
    }
  }

  /** Turn to face a point (outside Ctrl+Z: the GM didn't do it). */
  static async #face(doc, at) {
    const c = doc.object?.center ?? centerOf(doc);
    const deg = Math.toDegrees(Math.atan2(at.y - c.y, at.x - c.x)) - 90;
    const rotation = ((deg % 360) + 360) % 360;
    if ( Math.abs(rotation - doc.rotation) > 2 ) await doc.update({rotation}, {animate: true, [NO_HISTORY]: true});
  }

  /** A floating "!" above the NPC (GM only). */
  static #exclaim(doc, text) {
    const obj = doc.object;
    if ( !obj || !canvas.interface?.createScrollingText ) return;
    canvas.interface.createScrollingText(obj.center, text, {
      anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fontSize: 52, fill: text === "!" ? "#ff3b3b" : "#ffd23b",
      stroke: 0x000000, strokeThickness: 5, jitter: 0, duration: 1600
    });
  }

  /* -------------------------------------------- */
  /*  Combat                                      */
  /* -------------------------------------------- */

  /**
   * Hold patrols while the scene is in combat, and let them carry on afterwards. Checked every tick (combat can be
   * started by any GM, on any client) and remembered on the scene (survives reloads and scene changes).
   * @returns {Promise<boolean>}  Whether the scene is in combat (no watching)
   */
  static async #combat(scene) {
    if ( this.#combatBusy ) return true;
    const fighting = setting("pauseInCombat") && combatOn(scene);
    // An empty list still means "held for combat" (nothing was running)
    const paused = scene.getFlag(MODULE_ID, FLAG_PAUSED);
    if ( fighting === Array.isArray(paused) ) return fighting;
    this.#combatBusy = true;
    try {
      if ( fighting ) await this.#pauseForCombat(scene);
      else await this.#resumeAfterCombat(scene, paused);
    } catch(err) {
      console.error(`${MODULE_ID} | combat`, err);
    } finally {
      this.#combatBusy = false;
    }
    return fighting;
  }

  static async #pauseForCombat(scene) {
    const api = kaa();
    // The patrols that were on (and NPCs on their way back to one) carry on after the fight
    const running = Patroller.list(scene).filter(p => p.exists && Patroller.isActive(p, scene)).map(p => p.animId);
    await scene.update({flags: {[MODULE_ID]: {[FLAG_PAUSED]: running}}});
    const tokens = Patroller.list(scene).flatMap(p => p.tokens).filter(id => scene.tokens.has(id));
    await this.forget([...this.state.keys()]);
    if ( api && tokens.length ) await api.stop(tokens, {mode: "here"});
  }

  static async #resumeAfterCombat(scene, paused) {
    await scene.update({flags: {[MODULE_ID]: {[FLAG_PAUSED]: DEL()}}});
    if ( scene !== canvas.scene ) return;
    const ids = (Array.isArray(paused) ? paused : []).filter(id => id && Patroller.list(scene).some(p => (p.animId === id) && p.exists && (p.active !== false)));
    // Everyone walks back to their route (around walls) before carrying on
    if ( ids.length ) await Patroller.start(ids, {walkHome: true});
  }
}
