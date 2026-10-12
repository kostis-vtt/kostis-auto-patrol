// Walls from a floor mask: trace the floor's outline (marching squares), simplify it (Ramer–Douglas–Peucker) and
// cut it into straight wall segments. Pure functions; coordinates are in mask samples.

/**
 * Trace the boundaries between floor (1) and not-floor (0).
 * @param {Uint8Array} mask
 * @param {number} W
 * @param {number} H
 * @param {object} [options]
 * @param {boolean} [options.edges=true]   Also trace where the floor meets the edge of the map
 * @returns {{x:number,y:number}[][]}      Polylines (closed ones repeat their first point at the end)
 */
export function traceContours(mask, W, H, {edges=true}={}) {
  // Pad by one sample so outlines close at the map border (or stay open when edges are off)
  const PW = W + 2;
  const PH = H + 2;
  const at = (x, y) => {
    if ( (x < 0) || (y < 0) || (x >= W) || (y >= H) ) {
      if ( edges ) return 0;
      return mask[(Math.min(H - 1, Math.max(0, y)) * W) + Math.min(W - 1, Math.max(0, x))];
    }
    return mask[(y * W) + x];
  };
  // Each segment joins two edge midpoints of a 2x2 cell; key points by doubled coordinates to avoid floats
  const segs = [];
  for ( let cy = -1; cy < PH - 2; cy++ ) {
    for ( let cx = -1; cx < PW - 2; cx++ ) {
      const tl = at(cx, cy);
      const tr = at(cx + 1, cy);
      const br = at(cx + 1, cy + 1);
      const bl = at(cx, cy + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if ( (code === 0) || (code === 15) ) continue;
      // Edge midpoints (in doubled sample coordinates, pixel centres at odd values)
      const X = (2 * cx) + 1;
      const Y = (2 * cy) + 1;
      const top = [X + 1, Y];
      const right = [X + 2, Y + 1];
      const bottom = [X + 1, Y + 2];
      const left = [X, Y + 1];
      const add = (a, b) => segs.push([a, b]);
      switch ( code ) {
        case 1: case 14: add(left, bottom); break;
        case 2: case 13: add(bottom, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(top, right); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, top); break;
        case 5: add(left, top); add(bottom, right); break;
        case 10: add(top, right); add(left, bottom); break;
      }
    }
  }
  // Link segments into polylines
  const key = p => `${p[0]},${p[1]}`;
  const adj = new Map();
  segs.forEach((s, i) => {
    for ( const p of s ) {
      const k = key(p);
      if ( !adj.has(k) ) adj.set(k, []);
      adj.get(k).push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  const walk = (start, segIndex) => {
    const pts = [start];
    let cur = start;
    let si = segIndex;
    while ( si !== -1 ) {
      used[si] = 1;
      const s = segs[si];
      const next = key(s[0]) === key(cur) ? s[1] : s[0];
      pts.push(next);
      cur = next;
      si = (adj.get(key(cur)) ?? []).find(j => !used[j]) ?? -1;
    }
    return pts;
  };
  // Open chains first (start at endpoints with a single segment), then closed loops
  for ( const [k, list] of adj ) {
    if ( list.length !== 1 || used[list[0]] ) continue;
    const [x, y] = k.split(",").map(Number);
    lines.push(walk([x, y], list[0]));
  }
  for ( let i = 0; i < segs.length; i++ ) {
    if ( used[i] ) continue;
    lines.push(walk(segs[i][0], i));
  }
  return lines.map(l => l.map(([x, y]) => ({x: x / 2, y: y / 2})));
}

/** Perpendicular distance from p to segment ab. */
function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = (dx * dx) + (dy * dy);
  if ( L2 < 1e-12 ) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / L2));
  return Math.hypot(p.x - (a.x + (t * dx)), p.y - (a.y + (t * dy)));
}

/** Ramer–Douglas–Peucker simplification (iterative). */
export function simplify(points, epsilon) {
  if ( points.length < 3 ) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while ( stack.length ) {
    const [a, b] = stack.pop();
    let best = -1;
    let bd = epsilon;
    for ( let i = a + 1; i < b; i++ ) {
      const d = segDist(points[i], points[a], points[b]);
      if ( d > bd ) {
        bd = d;
        best = i;
      }
    }
    if ( best >= 0 ) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Total length of a polyline. */
export function polylineLength(pts) {
  let L = 0;
  for ( let i = 1; i < pts.length; i++ ) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/**
 * Wall segments for a floor mask, in mask samples.
 * @param {Uint8Array} mask
 * @param {number} W
 * @param {number} H
 * @param {object} options
 * @param {number} options.S                 Samples per grid square
 * @param {number} [options.tolerance=0.12]   Allowed deviation from the outline, in squares
 * @param {number} [options.minLength=0.75]  Outlines shorter than this (squares) are noise
 * @param {boolean} [options.edges=true]
 * @returns {number[][]}  [x0, y0, x1, y1] per segment
 */
export function wallSegments(mask, W, H, {S, tolerance=0.12, minLength=0.75, edges=true}) {
  const out = [];
  for ( const line of traceContours(mask, W, H, {edges}) ) {
    if ( polylineLength(line) < minLength * S ) continue;
    const closed = (line.length > 2) && (line[0].x === line.at(-1).x) && (line[0].y === line.at(-1).y);
    let pts;
    if ( closed ) {
      // Split a loop at its farthest point so RDP keeps both halves' corners
      let far = 0;
      let fd = -1;
      for ( let i = 1; i < line.length; i++ ) {
        const d = Math.hypot(line[i].x - line[0].x, line[i].y - line[0].y);
        if ( d > fd ) {
          fd = d;
          far = i;
        }
      }
      pts = [...simplify(line.slice(0, far + 1), tolerance * S), ...simplify(line.slice(far), tolerance * S).slice(1)];
    } else pts = simplify(line, tolerance * S);
    for ( let i = 1; i < pts.length; i++ ) {
      const a = pts[i - 1];
      const b = pts[i];
      if ( Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 ) continue;
      out.push([a.x, a.y, b.x, b.y]);
    }
  }
  return out;
}
