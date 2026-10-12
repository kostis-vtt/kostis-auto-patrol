// Scanning: capture the map, find the floor, propose walls, build the navigation grid and the rooms. Results are
// kept in memory for the viewed scene (they are quick to recompute) and drawn on the map while planning.

import {FLAG_GENERATED, FLAG_HINTS, FLAG_PATROLS, MODULE_ID} from "./const.js";
import {captureScene} from "./capture.js";
import {analyzeMap} from "./vision.js";
import {wallSegments} from "./contours.js";
import {NavGrid} from "./nav.js";
import {findRooms} from "./rooms.js";

export const CELLS_PER_SQUARE = 2;

/**
 * Movement-blocking walls of a scene as [x0, y0, x1, y1] (open doors let you through), on the level being viewed
 * (v14 scene levels: walls of other levels don't block this one).
 */
export function movementWalls(scene, level=(scene === canvas?.scene ? canvas.level : null)) {
  const out = [];
  const NONE = CONST.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  const OPEN = CONST.WALL_DOOR_STATES?.OPEN ?? 1;
  // Effect walls (Kostis's Particle Effects) painted along a patrol's own route don't block it: routing around them
  // would move the route, and the effect wall with it, again and again
  const patrols = new Set(Object.keys(scene.getFlag?.(MODULE_ID, FLAG_PATROLS) ?? {}));
  for ( const w of scene.walls ) {
    if ( w.move === NONE ) continue;
    if ( w.door && (w.ds === OPEN) ) continue;
    if ( level && w.includedInLevel && !w.includedInLevel(level) ) continue;
    const along = w.flags?.["kostis-particle-effects"]?.effectWall?.animId;
    if ( along && patrols.has(along) ) continue;
    out.push([...w.c]);
  }
  return out;
}

export class Scanner {
  /** @type {{sceneId: string, vision: object, image: object, proposed: number[][], nav: NavGrid, rooms: object, options: object, at: number}|null} */
  static result = null;

  /** Options of the last scan (also the defaults for the next). */
  static options = {samples: 10, sensitivity: 0.5, darkness: 0.22, edgeCut: 0.7, minIsland: 1.5, includeEdges: true, clusters: 8};

  static get current() {
    return this.result && (this.result.sceneId === canvas.scene?.id) && (this.result.levelId === (canvas.level?.id ?? null)) ? this.result : null;
  }

  /** Scenes (and levels) whose automatic scan failed this session: not tried again every tick. */
  static #failed = new Set();

  /** The current scan, scanning the viewed scene first if there is none (null when that fails). */
  static async ensure() {
    if ( this.current ) return this.current;
    const key = `${canvas.scene?.id}:${canvas.level?.id ?? ""}`;
    if ( !canvas.scene || this.#failed.has(key) ) return null;
    try {
      return await this.scan();
    } catch(err) {
      this.#failed.add(key);
      console.warn(`${MODULE_ID} | automatic scan failed`, err);
      return null;
    }
  }

  /** Points (scene pixels) where tokens stand: floor, for sure. */
  static #seeds(scene) {
    return scene.tokens.filter(t => !t.hidden).map(t => {
      const g = scene.dimensions.size;
      return {x: t.x + ((t.width * g) / 2), y: t.y + ((t.height * g) / 2)};
    });
  }

  /**
   * Run the whole scan on the viewed scene.
   * @param {object} [options]          Overrides of Scanner.options
   * @param {object} [options.image]    A ready pixel buffer (otherwise the map is captured)
   */
  static async scan({image, ...options}={}) {
    const scene = canvas.scene;
    if ( !scene ) return null;
    const opts = Object.assign(this.options, options);
    image ??= captureScene({samples: opts.samples});
    const toSample = p => ({x: (p.x - image.sceneX) / image.grid * image.S, y: (p.y - image.sceneY) / image.grid * image.S});
    const hints = scene.getFlag(MODULE_ID, FLAG_HINTS) ?? {};
    // Let the browser breathe before the heavy part
    await new Promise(r => setTimeout(r, 0));
    const vision = analyzeMap(image, {
      S: image.S,
      seeds: this.#seeds(scene).map(toSample),
      floorHints: (hints.floor ?? []).map(toSample),
      wallHints: (hints.wall ?? []).map(toSample),
      sensitivity: opts.sensitivity,
      darkness: opts.darkness,
      edgeCut: opts.edgeCut,
      minIsland: opts.minIsland,
      clusters: opts.clusters,
      seed: 1
    });
    const toScene = ([x0, y0, x1, y1]) => [
      image.sceneX + ((x0 / image.S) * image.grid), image.sceneY + ((y0 / image.S) * image.grid),
      image.sceneX + ((x1 / image.S) * image.grid), image.sceneY + ((y1 / image.S) * image.grid)
    ];
    const existing = movementWalls(scene);
    const proposed = wallSegments(vision.mask, vision.W, vision.H, {S: image.S, edges: opts.includeEdges})
      .map(toScene)
      .filter(w => !this.#covered(w, existing, image.grid * 0.3));
    // The floor mask already blocks what proposed walls would; existing walls (and doors) are added on top
    const nav = this.#buildNav(vision, image, existing);
    const rooms = findRooms(nav, {cellsPerSquare: CELLS_PER_SQUARE});
    this.result = {sceneId: scene.id, levelId: canvas.level?.id ?? null, vision, image, proposed, nav, rooms, options: {...opts},
      at: Date.now(), rev: 0};
    Hooks.callAll(`${MODULE_ID}.scanned`, this.result);
    return this.result;
  }

  /** Rebuild navigation (after walls changed) without re-reading the map. */
  static refreshNav() {
    const r = this.current;
    if ( !r ) return null;
    const walls = movementWalls(canvas.scene);
    r.nav = this.#buildNav(r.vision, r.image, walls);
    r.rooms = findRooms(r.nav, {cellsPerSquare: CELLS_PER_SQUARE});
    r.proposed = r.proposed.filter(w => !this.#covered(w, walls, r.image.grid * 0.3));
    r.rev = (r.rev ?? 0) + 1;
    Hooks.callAll(`${MODULE_ID}.scanned`, r);
    return r;
  }

  static #buildNav(vision, image, walls) {
    return NavGrid.fromMask(vision, {
      sceneX: image.sceneX, sceneY: image.sceneY, grid: image.grid, cellsPerSquare: CELLS_PER_SQUARE, walls
    });
  }

  /** Is a proposed wall already covered by an existing one (both ends within `tol` of it)? */
  static #covered(w, existing, tol) {
    const near = (px, py, e) => {
      const dx = e[2] - e[0];
      const dy = e[3] - e[1];
      const L2 = (dx * dx) + (dy * dy) || 1;
      const t = Math.max(0, Math.min(1, (((px - e[0]) * dx) + ((py - e[1]) * dy)) / L2));
      return Math.hypot(px - (e[0] + (t * dx)), py - (e[1] + (t * dy))) <= tol;
    };
    return existing.some(e => near(w[0], w[1], e) && near(w[2], w[3], e) && near((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, e));
  }

  static clear() {
    this.result = null;
  }
}

export {FLAG_GENERATED};
