// Generated walls: create the walls a scan proposes (flagged, so they can be removed again in one go).

import {FLAG_GENERATED, HUB_ID, MODULE_ID, NO_HISTORY} from "./const.js";

const remember = (label, undo, scene) => game.modules.get(HUB_ID)?.api?.history?.push(label, undo, {sceneId: scene.id, module: MODULE_ID});

const SENSE = () => CONST.EDGE_SENSE_TYPES ?? {NONE: 0, LIMITED: 10, NORMAL: 20};

/**
 * Create walls from segments.
 * @param {number[][]} segments      [x0, y0, x1, y1] in scene pixels
 * @param {object} [options]
 * @param {Scene} [options.scene]
 * @param {boolean} [options.sight=true]   Walls also block sight and light (false: movement only)
 */
export async function createWalls(segments, {scene=canvas.scene, sight=true}={}) {
  if ( !segments?.length || !scene ) return [];
  const S = SENSE();
  const scan = foundry.utils.randomID(8);
  // A scan reads one level's map: on a scene with several levels its walls belong to that level only
  const levels = (scene === canvas.scene) && canvas.level && ((scene.levels?.size ?? 0) > 1) ? [canvas.level.id] : null;
  const data = segments
    .map(c => c.map(v => Math.round(v)))
    .filter(c => (c[0] !== c[2]) || (c[1] !== c[3]))
    .map(c => ({
      c,
      move: CONST.WALL_MOVEMENT_TYPES?.NORMAL ?? S.NORMAL,
      sight: sight ? S.NORMAL : S.NONE,
      light: sight ? S.NORMAL : S.NONE,
      sound: sight ? S.NORMAL : S.NONE,
      flags: {[MODULE_ID]: {[FLAG_GENERATED]: {scan}}},
      ...(levels ? {levels} : {})
    }));
  const made = await scene.createEmbeddedDocuments("Wall", data, {[NO_HISTORY]: true});
  const ids = made.map(w => w.id);
  remember(game.i18n.format("KAP.Undo.CreateWalls", {count: ids.length}), async () => {
    const live = ids.filter(id => scene.walls.has(id));
    if ( live.length ) await scene.deleteEmbeddedDocuments("Wall", live, {[NO_HISTORY]: true});
  }, scene);
  return made;
}

/** Generated walls on a scene. */
export function generatedWalls(scene=canvas.scene) {
  return scene?.walls.filter(w => w.getFlag(MODULE_ID, FLAG_GENERATED)) ?? [];
}

/** Remove every generated wall (walls you drew yourself are never touched). */
export async function removeGeneratedWalls(scene=canvas.scene) {
  const walls = generatedWalls(scene);
  if ( !walls.length ) return 0;
  const saved = walls.map(w => w.toObject());
  await scene.deleteEmbeddedDocuments("Wall", walls.map(w => w.id), {[NO_HISTORY]: true});
  remember(game.i18n.format("KAP.Undo.RemoveWalls", {count: saved.length}), async () => {
    await scene.createEmbeddedDocuments("Wall", saved, {[NO_HISTORY]: true, keepId: true});
  }, scene);
  return saved.length;
}
