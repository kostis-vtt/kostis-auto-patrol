// Capture the map art of the viewed scene (its level background and the floor tiles on it, not roofs) into a
// pixel buffer at a few samples per grid square, ready for the vision pass.

/** Draw one sprite mesh (background or tile) into the 2D context, mapping scene pixels to samples. */
function drawMesh(ctx, mesh, origin, k) {
  const tex = mesh?.texture;
  const src = tex?.baseTexture?.resource?.source;
  if ( !src || !tex.valid ) return false;
  const f = tex.frame;
  ctx.save();
  ctx.translate((mesh.x - origin.x) * k, (mesh.y - origin.y) * k);
  ctx.rotate(mesh.rotation || 0);
  ctx.scale(mesh.scale.x * k, mesh.scale.y * k);
  ctx.globalAlpha = Math.max(0, Math.min(1, mesh.alpha ?? 1));
  try {
    ctx.drawImage(src, f.x, f.y, f.width, f.height, -mesh.anchor.x * f.width, -mesh.anchor.y * f.height, f.width, f.height);
  } finally {
    ctx.restore();
  }
  return true;
}

/** Is a tile overhead (a roof or canopy that fades when tokens walk under it)? */
function isOverhead(tile) {
  const modes = tile.document.occlusion?.modes;
  const set = modes instanceof Set ? modes : new Set(modes ?? []);
  return [...set].some(m => m !== CONST.OCCLUSION_MODES.NONE);
}

/**
 * @param {object} [options]
 * @param {number} [options.samples=10]        Samples per grid square
 * @param {number} [options.maxPixels=2500000] Larger maps are sampled more coarsely
 * @returns {{width:number, height:number, data:Uint8ClampedArray, S:number, sceneX:number, sceneY:number, grid:number}}
 */
export function captureScene({samples=10, maxPixels=2_500_000}={}) {
  const d = canvas.dimensions;
  let S = samples;
  let W = Math.max(1, Math.round((d.sceneWidth / d.size) * S));
  let H = Math.max(1, Math.round((d.sceneHeight / d.size) * S));
  if ( W * H > maxPixels ) {
    S *= Math.sqrt(maxPixels / (W * H));
    W = Math.max(1, Math.round((d.sceneWidth / d.size) * S));
    H = Math.max(1, Math.round((d.sceneHeight / d.size) * S));
  }
  const k = S / d.size;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d", {willReadFrequently: true});
  ctx.imageSmoothingQuality = "high";
  // v14: the background colour belongs to the level (Scene#backgroundColor is deprecated)
  const bg = canvas.level?.background?.color ?? canvas.scene.background?.color ?? null;
  ctx.fillStyle = bg ? (foundry.utils.Color.from(bg).css ?? "#000000") : "#000000";
  ctx.fillRect(0, 0, W, H);
  const origin = {x: d.sceneX, y: d.sceneY};
  let drawn = 0;
  if ( drawMesh(ctx, canvas.primary.background, origin, k) ) drawn++;
  const tiles = (canvas.tiles?.placeables ?? [])
    .filter(t => !t.document.hidden && !isOverhead(t) && t.mesh)
    .filter(t => !canvas.level || !t.document.includedInLevel || t.document.includedInLevel(canvas.level))
    .sort((a, b) => (a.document.elevation - b.document.elevation) || (a.document.sort - b.document.sort));
  for ( const t of tiles ) if ( drawMesh(ctx, t.mesh, origin, k) ) drawn++;
  let data;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch(err) {
    throw new Error(game.i18n.localize("KAP.Error.Tainted"));
  }
  return {width: W, height: H, data, S, sceneX: d.sceneX, sceneY: d.sceneY, grid: d.size, drawn};
}
