// Painted hints: click or drag with the floor / wall brush to tell the scan what it got wrong, and the eraser (or
// a right-click with either brush) to take hints away. Stored in the scene's flags (scene pixels); every change can
// be undone with Ctrl+Z.

import {FLAG_HINTS, HUB_ID, MODULE_ID} from "./const.js";

const hub = () => game.modules.get(HUB_ID)?.api;
const REPLACE = v => (globalThis._replace ? globalThis._replace(v) : foundry.data.operators.ForcedReplacement.create(v));

export class Hints {
  static #stroke = null;

  static get(scene=canvas.scene) {
    const h = scene?.getFlag(MODULE_ID, FLAG_HINTS) ?? {};
    return {floor: [...(h.floor ?? [])], wall: [...(h.wall ?? [])]};
  }

  /** Hint changes wait for the one before (quick clicks would otherwise each start from the same hints). */
  static #queue = Promise.resolve();

  static #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Write hints, recording an undo step that puts back what was there before. */
  static async #write(scene, next, label) {
    const before = this.get(scene);
    await scene.update({flags: {[MODULE_ID]: {[FLAG_HINTS]: REPLACE(next)}}});
    hub()?.history?.push(label, () => scene.update({flags: {[MODULE_ID]: {[FLAG_HINTS]: REPLACE(before)}}}),
      {sceneId: scene.id, module: MODULE_ID});
  }

  /** Erase radius around a point, in pixels. */
  static radius(scene=canvas.scene) {
    return (scene?.dimensions?.size ?? 100) * 0.45;
  }

  static add(kind, points, scene=canvas.scene) {
    if ( !points?.length ) return Promise.resolve();
    return this.#serial(() => this.#add(kind, points, scene));
  }

  static async #add(kind, points, scene) {
    const h = this.get(scene);
    h[kind] = [...h[kind], ...points.map(p => ({x: Math.round(p.x), y: Math.round(p.y)}))].slice(-2000);
    // A floor hint cancels nearby wall hints and vice versa
    const other = kind === "floor" ? "wall" : "floor";
    const r = (scene.dimensions?.size ?? 100) * 0.3;
    h[other] = h[other].filter(q => !points.some(p => Math.hypot(p.x - q.x, p.y - q.y) < r));
    await this.#write(scene, h, game.i18n.localize(kind === "floor" ? "KAP.Undo.PaintFloor" : "KAP.Undo.PaintWall"));
  }

  /** Remove every hint near some points. Returns how many went. */
  static erase(points, scene=canvas.scene) {
    return this.#serial(() => this.#erase(points, scene));
  }

  static async #erase(points, scene) {
    const h = this.get(scene);
    const r = this.radius(scene);
    const near = q => points.some(p => Math.hypot(p.x - q.x, p.y - q.y) <= r);
    const floor = h.floor.filter(q => !near(q));
    const wall = h.wall.filter(q => !near(q));
    const removed = (h.floor.length - floor.length) + (h.wall.length - wall.length);
    if ( removed ) await this.#write(scene, {floor, wall}, game.i18n.localize("KAP.Undo.Erase"));
    return removed;
  }

  static clear(scene=canvas.scene) {
    return this.#serial(async () => {
      const h = this.get(scene);
      if ( !h.floor.length && !h.wall.length ) return;
      await this.#write(scene, {floor: [], wall: []}, game.i18n.localize("KAP.Undo.ClearHints"));
    });
  }

  /**
   * Canvas handlers for a brush tool: "floor", "wall" or "erase". With a paint brush, right-click erases.
   * @param {"floor"|"wall"|"erase"} kind
   * @param {Function} [onChange]
   */
  static brush(kind, onChange) {
    const spacing = () => canvas.dimensions.size * 0.4;
    const commit = async points => {
      if ( kind === "erase" ) await this.erase(points);
      else await this.add(kind, points);
      onChange?.();
    };
    return {
      click: (_e, p) => commit([p]),
      rightClick: async (_e, p) => {
        await this.erase([p]);
        onChange?.();
      },
      dragStart: (_e, p) => {
        this.#stroke = {points: [p]};
      },
      dragMove: (_e, p) => {
        const s = this.#stroke;
        if ( !s ) return;
        const last = s.points.at(-1);
        if ( Math.hypot(p.x - last.x, p.y - last.y) >= spacing() ) s.points.push(p);
      },
      dragDrop: async (_e, p) => {
        const s = this.#stroke;
        this.#stroke = null;
        if ( !s ) return;
        s.points.push(p);
        await commit(s.points);
      },
      dragCancel: () => {
        this.#stroke = null;
      }
    };
  }
}
