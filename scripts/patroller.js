// Patrols on a scene: generate them from a scan (one animator animation per NPC or squad), start, stop and remove
// them. Which animations are patrols, and how their NPCs react to intruders, is kept in the scene's flags.

import {ANIMATOR_ID, DEL, FLAG_PATROLS, HUB_ID, MODULE_ID} from "./const.js";
import {CELLS_PER_SQUARE, Scanner} from "./scanner.js";
import {patrolAnimation, planWaypoints, routeLegs, seedOf, squads} from "./patrols.js";
import {Behaviour, levelOf} from "./behaviour.js";

const kaa = () => {
  const m = game.modules.get(ANIMATOR_ID);
  if ( !m?.active ) throw new Error(game.i18n.localize("KAP.Error.NoAnimator"));
  return m.api;
};

const remember = (label, undo, scene) => game.modules.get(HUB_ID)?.api?.history?.push(label, undo, {sceneId: scene.id, module: MODULE_ID});

const center = d => {
  const g = d.parent.dimensions.size;
  return {x: d.x + ((d.width * g) / 2), y: d.y + ((d.height * g) / 2)};
};

/** Patrol settings stored per patrol. */
export function normalizePatrol(p={}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    tokens: Array.isArray(p.tokens) ? p.tokens.filter(t => typeof t === "string") : [],
    strategy: typeof p.strategy === "string" ? p.strategy : "auto",
    response: ["ignore", "alert", "chase", "alarm"].includes(p.response) ? p.response : "alert",
    range: Math.max(1, Math.min(60, num(p.range, 8))),
    cone: Math.max(10, Math.min(360, num(p.cone, 140))),
    name: typeof p.name === "string" ? p.name : "",
    // Started (true) or stopped (false) by the GM; unknown for patrols made before this was kept
    active: typeof p.active === "boolean" ? p.active : null,
    // The points the route visits ({x, y, wait}), to route it again when walls or doors change
    waypoints: Array.isArray(p.waypoints)
      ? p.waypoints.filter(w => Number.isFinite(w?.x) && Number.isFinite(w?.y)).map(w => ({x: w.x, y: w.y, wait: Math.max(0, num(w.wait, 0))}))
      : null,
    rerouted: !!p.rerouted
  };
}

export class Patroller {
  /** Patrols on a scene whose animation still exists. */
  static list(scene=canvas.scene) {
    if ( !scene ) return [];
    const flags = scene.getFlag(MODULE_ID, FLAG_PATROLS) ?? {};
    const api = game.modules.get(ANIMATOR_ID)?.active ? game.modules.get(ANIMATOR_ID).api : null;
    return Object.entries(flags)
      .filter(([, p]) => p)
      .map(([animId, p]) => ({animId, ...normalizePatrol(p), exists: !!api?.getAnimation(animId, scene)}));
  }

  /** The patrol a token belongs to, if any. */
  static of(tokenId, scene=canvas.scene) {
    return this.list(scene).find(p => p.tokens.includes(tokenId)) ?? null;
  }

  /** Is a patrol switched on? (Older patrols: whether its NPCs are walking it.) */
  static isActive(p, scene=canvas.scene) {
    if ( typeof p.active === "boolean" ) return p.active;
    return p.tokens.some(id => scene.tokens.get(id)?.getFlag(ANIMATOR_ID, "playback")?.anim === p.animId);
  }

  /**
   * NPCs worth patrolling: not player-owned, not particles or animator copies, of the chosen dispositions, on the
   * level being viewed (the scan reads that level's map).
   */
  static candidates(scene=canvas.scene, {dispositions=[CONST.TOKEN_DISPOSITIONS.HOSTILE]}={}) {
    const level = scene === canvas.scene ? canvas.level?.id ?? null : null;
    return scene.tokens.filter(t => {
      if ( t.actor?.hasPlayerOwner ) return false;
      if ( t.getFlag("kostis-particle-effects", "particle") || t.getFlag(ANIMATOR_ID, "copy") ) return false;
      if ( level && levelOf(t) && (levelOf(t) !== level) ) return false;
      return dispositions.includes(t.disposition);
    });
  }

  /** Patrol speed in squares per second, from the actor's movement (30 ft walk ≈ 1 square/s). */
  static speedOf(doc) {
    const mv = doc.actor?.system?.attributes?.movement ?? doc.actor?.system?.movement ?? {};
    const walk = Number(mv.walk) || 0;
    const fly = Number(mv.fly) || 0;
    const base = walk || fly || 30;
    const units = String(mv.units ?? "ft");
    const feet = units === "m" ? base * 3.33 : base;
    return Math.min(2.2, Math.max(0.5, feet / 30));
  }

  /** Sample a path shape exactly as the animator will draw it (for the wall check). */
  static #sampler() {
    const build = game.modules.get(ANIMATOR_ID)?.api?.internals?.buildShape;
    if ( !build ) return null;
    return shape => {
      const lut = build(shape).lut;
      const pts = [];
      for ( let i = 0; i < lut.count; i += 2 ) pts.push({x: lut.xs[i], y: lut.ys[i]});
      pts.push({x: lut.xs[lut.count - 1], y: lut.ys[lut.count - 1]});
      return pts;
    };
  }

  /**
   * Generate patrols for tokens (scanning the map first if needed).
   * @param {TokenDocument[]} docs
   * @param {object} [options]
   * @param {string} [options.strategy="auto"]      For every token without its own choice
   * @param {object} [options.perToken]             {tokenId: strategy}
   * @param {number} [options.speed=1]              Multiplier on each NPC's speed
   * @param {string} [options.response="alert"]
   * @param {number} [options.range=8]              Detection range in squares
   * @param {number} [options.cone=140]             Field of view in degrees
   * @param {number} [options.squad=1.6]            NPCs this close (squares) share a route
   * @param {boolean} [options.start=true]
   * @returns {Promise<object[]>}  The created patrols
   */
  static async generate(docs, {strategy="auto", perToken={}, speed=1, response="alert", range=8, cone=140, squad=1.6, start=true}={}) {
    const api = kaa();
    const scene = canvas.scene;
    docs = docs.filter(d => d.parent === scene);
    if ( !docs.length ) return [];
    const scan = Scanner.current ?? await Scanner.scan();
    if ( !scan ) return [];
    // Patrols these tokens had are replaced (and come back if this is undone)
    const replaced = await this.#take(scene, docs.map(d => d.id));
    const ctx = {nav: scan.nav, rooms: scan.rooms.rooms, roomOf: scan.rooms.roomOf, cellsPerSquare: CELLS_PER_SQUARE};
    const grid = scene.dimensions.size;
    const sample = this.#sampler();
    const groups = squads(docs.map(center), squad * grid);
    const created = [];
    const flags = {};
    for ( const g of groups ) {
      const members = g.map(i => docs[i]);
      const leader = members[0];
      const choice = perToken[leader.id] ?? strategy;
      const plan = planWaypoints(ctx, center(leader), choice, {seed: seedOf(leader.id)});
      const legs = routeLegs(scan.nav, plan.waypoints);
      const slowest = Math.min(...members.map(d => this.speedOf(d)));
      const data = patrolAnimation(plan, legs, {
        name: `${game.i18n.localize("KAP.Patrol")}: ${leader.name}${members.length > 1 ? ` +${members.length - 1}` : ""}`,
        tokens: members.map(d => d.id),
        speed: Math.round(slowest * speed * 100) / 100,
        stagger: members.length > 1 ? 1400 : 0,
        sample, nav: scan.nav, grid
      });
      const anim = await api.createAnimation(data, {scene});
      if ( !anim ) continue;
      const entry = normalizePatrol({tokens: members.map(d => d.id), strategy: plan.strategy, response, range, cone, name: anim.name,
        active: !!start, waypoints: plan.waypoints});
      flags[anim.id] = entry;
      created.push({animId: anim.id, ...entry});
    }
    if ( Object.keys(flags).length ) await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: flags}}});
    const madeIds = created.map(p => p.animId);
    remember(game.i18n.format("KAP.Undo.Generate", {count: created.length}), async () => {
      await this.#take(scene, null, madeIds);
      await this.#put(scene, replaced);
    }, scene);
    if ( start ) await this.start(created.map(p => p.animId));
    Hooks.callAll(`${MODULE_ID}.generated`, scene, created);
    return created;
  }

  /** Where a patrol's route begins. */
  static routeStart(anim) {
    const first = anim?.steps[0]?.shape;
    if ( !first ) return null;
    return first.type === "path" ? {x: first.nodes[0].x, y: first.nodes[0].y} : {x: first.x, y: first.y};
  }

  /**
   * Start patrols (all of the scene's, or some by animation id). NPCs that have wandered off their route walk
   * back to it around walls first (the animator alone would take the straight line).
   */
  static async start(animIds, {walkHome=true}={}) {
    const api = kaa();
    const scene = canvas.scene;
    const grid = scene.dimensions.size;
    const patrols = this.list(scene).filter(p => p.exists && (!animIds || animIds.includes(p.animId)));
    if ( !patrols.length ) return;
    const off = patrols.filter(p => p.active !== true);
    if ( off.length ) {
      await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: Object.fromEntries(off.map(p => [p.animId, {active: true}]))}}});
    }
    for ( const p of patrols ) {
      const home = this.routeStart(api.getAnimation(p.animId, scene));
      const direct = [];
      for ( const id of p.tokens ) {
        const doc = scene.tokens.get(id);
        if ( !doc ) continue;
        const c = center(doc);
        const away = home && (Math.hypot(c.x - home.x, c.y - home.y) > grid * 0.75);
        // NPCs away from their route walk back around walls (scanning the map first if it hasn't been yet):
        // the animator alone would take the straight line, through walls
        if ( walkHome && away && await Scanner.ensure() ) await Behaviour.sendHome(doc, p);
        else direct.push(id);
      }
      if ( direct.length ) await api.play(p.animId, direct);
    }
  }

  /** Stop patrols: their NPCs stay where they stand, and won't set off again on their own. */
  static async stop(animIds) {
    const api = kaa();
    const scene = canvas.scene;
    const patrols = this.list(scene).filter(p => !animIds || animIds.includes(p.animId));
    if ( !patrols.length ) return;
    await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: Object.fromEntries(patrols.map(p => [p.animId, {active: false}]))}}});
    const tokens = patrols.flatMap(p => p.tokens).filter(id => scene.tokens.has(id));
    await Behaviour.forget(tokens);
    if ( tokens.length ) await api.stop(tokens, {mode: "here"});
  }

  /** The points a patrol's route visits (read off the route for patrols made before they were kept). */
  static waypoints(p, anim) {
    if ( p.waypoints?.length ) return p.waypoints;
    const steps = anim?.steps ?? [];
    const n = steps.length;
    return steps.map((st, i) => {
      const s = st.shape;
      const at = s?.type === "path" ? s.nodes?.[0] : s;
      return {x: at?.x, y: at?.y, wait: Number(steps[(i - 1 + n) % n]?.wait) || 0};
    }).filter(w => Number.isFinite(w.x) && Number.isFinite(w.y));
  }

  /** Does a patrol's route cross a wall now (a door closed on it)? */
  static #blocked(anim, nav, sample) {
    for ( const st of anim.steps ) {
      if ( st.shape?.type !== "path" ) continue;
      const pts = sample ? sample(st.shape) : st.shape.nodes;
      for ( let k = 1; k < pts.length; k++ ) {
        if ( nav.crossesWall(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) ) return true;
      }
    }
    return false;
  }

  /**
   * Walls changed (a door opened or closed): patrols whose route now crosses a wall are routed again between their
   * waypoints, around it. Waypoints their NPCs can no longer reach are left out until they can be reached again.
   * Active GM only, with a scan of the scene.
   * @returns {Promise<number>}  How many routes changed
   */
  static async replan(scene=canvas.scene) {
    const scan = Scanner.current;
    const api = game.modules.get(ANIMATOR_ID)?.active ? game.modules.get(ANIMATOR_ID).api : null;
    if ( !scan || !api || (scene !== canvas.scene) || !game.users.activeGM?.isSelf ) return 0;
    const nav = scan.nav;
    const grid = scene.dimensions.size;
    const sample = this.#sampler();
    const flags = {};
    let changed = 0;
    for ( const p of this.list(scene) ) {
      const anim = p.exists ? api.getAnimation(p.animId, scene) : null;
      if ( !anim ) continue;
      if ( !p.rerouted && !this.#blocked(anim, nav, sample) ) continue;
      const all = this.waypoints(p, anim);
      if ( !all.length ) continue;
      // The waypoints its NPCs can walk to from where they stand
      const leader = p.tokens.map(id => scene.tokens.get(id)).find(Boolean);
      const at = leader ? center(leader) : all[0];
      const startCell = nav.nearestWalkable(at.x, at.y);
      const reach = startCell >= 0 ? nav.reachable(startCell) : null;
      const ok = reach ? all.filter(w => {
        const c = nav.nearestWalkable(w.x, w.y);
        return (c >= 0) && reach[c];
      }) : [];
      // Shut in: stand watch where it is
      const waypoints = ok.length ? ok : [{x: at.x, y: at.y, wait: 1000}];
      const legs = routeLegs(nav, waypoints);
      const {steps} = patrolAnimation({strategy: p.strategy, waypoints, facing: {}}, legs, {grid, sample, nav});
      const sig = list => JSON.stringify(list.map(st => [st.shape.type, (st.shape.nodes ?? [st.shape]).map(q => [Math.round(q.x), Math.round(q.y)]),
        Math.round(st.wait ?? 0)]));
      // Once re-routed, a patrol is checked on every change (the door may open again and the old way come back)
      flags[p.animId] = {waypoints: all, rerouted: true};
      if ( sig(steps) === sig(anim.steps) ) continue;
      await api.updateAnimation(p.animId, a => {
        a.steps = steps;
      }, {scene, undo: false});
      changed++;
    }
    if ( Object.keys(flags).length ) await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: flags}}});
    return changed;
  }

  /**
   * Remove patrols: by token ids (any patrol containing them) or all of them.
   * @param {string[]} [tokenIds]
   */
  static async remove(tokenIds) {
    const scene = canvas.scene;
    const taken = await this.#take(scene, tokenIds);
    if ( taken.length ) {
      remember(game.i18n.format("KAP.Undo.Remove", {count: taken.length}), () => this.#put(scene, taken), scene);
    }
    return taken.length;
  }

  /**
   * Remove patrols (by token ids, by animation ids, or all) and return what is needed to put them back.
   * @returns {Promise<{entry: object, anim: object|null, playing: boolean}[]>}
   */
  static async #take(scene, tokenIds, animIds) {
    const api = game.modules.get(ANIMATOR_ID)?.active ? game.modules.get(ANIMATOR_ID).api : null;
    const doomed = this.list(scene).filter(p => (animIds ? animIds.includes(p.animId) : (!tokenIds || p.tokens.some(t => tokenIds.includes(t)))));
    if ( !doomed.length ) return [];
    const flags = scene.getFlag(MODULE_ID, FLAG_PATROLS) ?? {};
    const saved = doomed.map(p => {
      const anim = api?.getAnimation(p.animId, scene);
      return {
        animId: p.animId,
        entry: foundry.utils.deepClone(flags[p.animId]),
        anim: anim ? foundry.utils.deepClone(anim) : null,
        playing: p.tokens.some(id => scene.tokens.get(id)?.getFlag(ANIMATOR_ID, "playback"))
      };
    });
    for ( const p of doomed ) {
      if ( api && p.exists ) await api.deleteAnimation(p.animId, {scene});
    }
    await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: Object.fromEntries(doomed.map(p => [p.animId, DEL()]))}}});
    return saved;
  }

  /** Put removed patrols back (and set them going again if they were). */
  static async #put(scene, saved) {
    const api = kaa();
    const flags = {};
    const restart = [];
    for ( const s of saved ) {
      if ( !s.anim ) continue;
      // Keep the original id unless something has taken it since
      const data = api.getAnimation(s.anim.id, scene) ? {...s.anim, id: undefined} : s.anim;
      const anim = await api.createAnimation(data, {scene});
      if ( !anim ) continue;
      flags[anim.id] = s.entry;
      if ( s.playing ) restart.push(anim.id);
    }
    if ( Object.keys(flags).length ) await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: flags}}});
    if ( restart.length && (scene === canvas.scene) ) await this.start(restart);
  }

  /** Change how a patrol reacts to intruders. */
  static async configure(animId, changes) {
    const scene = canvas.scene;
    const cur = (scene.getFlag(MODULE_ID, FLAG_PATROLS) ?? {})[animId];
    if ( !cur ) return;
    await scene.update({flags: {[MODULE_ID]: {[FLAG_PATROLS]: {[animId]: normalizePatrol({...cur, ...changes})}}}});
  }
}
