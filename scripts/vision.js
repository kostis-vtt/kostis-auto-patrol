// Map vision: decide which parts of a battle-map image are walkable floor.
//
// 1. Every pixel goes to perceptual colour space (OKLab) and gets an edge strength (Sobel on lightness).
// 2. Colours are clustered (seeded k-means++), so the map's materials separate: floor, walls, water, void…
// 3. Logic picks the floor clusters: where tokens stand is floor, very dark material is wall, and colours close to
//    known floor are floor too. Painted hints (floor / wall) override everything.
// 4. The mask is cleaned like an image editor would: strong edge lines are cut, cracks closed, specks removed,
//    small enclosed blots filled and unreachable islands dropped.
//
// Pure functions on typed arrays: no Foundry, no DOM, so it runs (and is tested) anywhere.

/* -------------------------------------------- */
/*  Colour                                      */
/* -------------------------------------------- */

const LINEAR = new Float32Array(256);
for ( let i = 0; i < 256; i++ ) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** RGBA bytes → OKLab planes (L in 0..1, a/b roughly ±0.3) and an alpha plane. */
export function toOklab(data, n) {
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const alpha = new Uint8Array(n);
  for ( let i = 0, j = 0; i < n; i++, j += 4 ) {
    const r = LINEAR[data[j]];
    const g = LINEAR[data[j + 1]];
    const b = LINEAR[data[j + 2]];
    const l = Math.cbrt((0.4122214708 * r) + (0.5363325363 * g) + (0.0514459929 * b));
    const m = Math.cbrt((0.2119034982 * r) + (0.6806995451 * g) + (0.1073969566 * b));
    const s = Math.cbrt((0.0883024619 * r) + (0.2817188376 * g) + (0.6299787005 * b));
    L[i] = (0.2104542553 * l) + (0.7936177850 * m) - (0.0040720468 * s);
    A[i] = (1.9779984951 * l) - (2.4285922050 * m) + (0.4505937099 * s);
    B[i] = (0.0259040371 * l) + (0.7827717662 * m) - (0.8086757660 * s);
    alpha[i] = data[j + 3];
  }
  return {L, A, B, alpha};
}

/** Sobel gradient magnitude of a plane, normalised so the 98th percentile is 1. */
export function edgeStrength(P, W, H) {
  const G = new Float32Array(W * H);
  for ( let y = 1; y < H - 1; y++ ) {
    for ( let x = 1; x < W - 1; x++ ) {
      const i = (y * W) + x;
      const gx = (P[i - W + 1] + (2 * P[i + 1]) + P[i + W + 1]) - (P[i - W - 1] + (2 * P[i - 1]) + P[i + W - 1]);
      const gy = (P[i + W - 1] + (2 * P[i + W]) + P[i + W + 1]) - (P[i - W - 1] + (2 * P[i - W]) + P[i - W + 1]);
      G[i] = Math.hypot(gx, gy);
    }
  }
  // Robust normalisation (sample-based percentile)
  const step = Math.max(1, Math.floor(G.length / 20000));
  const sample = [];
  for ( let i = 0; i < G.length; i += step ) sample.push(G[i]);
  sample.sort((a, b) => a - b);
  const p98 = sample[Math.floor(sample.length * 0.98)] || 1;
  const k = 1 / Math.max(p98, 1e-6);
  for ( let i = 0; i < G.length; i++ ) G[i] = Math.min(1, G[i] * k);
  return G;
}

/* -------------------------------------------- */
/*  Clustering                                  */
/* -------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AB_WEIGHT = 2;

/**
 * Seeded k-means++ in OKLab (a/b weighted so hue differences count as much as lightness).
 * @returns {{centroids: {L:number,a:number,b:number}[], labels: Uint8Array}}
 */
export function kmeans(lab, n, {k=8, iterations=14, seed=1, valid}={}) {
  const {L, A, B} = lab;
  const rand = mulberry32(seed);
  const idx = [];
  const want = Math.min(n, 24000);
  for ( let t = 0; idx.length < want && t < want * 4; t++ ) {
    const i = Math.floor(rand() * n);
    if ( !valid || valid[i] ) idx.push(i);
  }
  if ( !idx.length ) return {centroids: [], labels: new Uint8Array(n)};
  const dist = (i, c) => {
    const dl = L[i] - c.L;
    const da = (A[i] - c.a) * AB_WEIGHT;
    const db = (B[i] - c.b) * AB_WEIGHT;
    return (dl * dl) + (da * da) + (db * db);
  };
  // k-means++ initialisation
  const first = idx[Math.floor(rand() * idx.length)];
  const cents = [{L: L[first], a: A[first], b: B[first]}];
  const d2 = new Float64Array(idx.length).fill(Infinity);
  while ( cents.length < k ) {
    let sum = 0;
    const c = cents.at(-1);
    for ( let s = 0; s < idx.length; s++ ) {
      d2[s] = Math.min(d2[s], dist(idx[s], c));
      sum += d2[s];
    }
    if ( sum <= 1e-12 ) break;
    let r = rand() * sum;
    let pick = idx[idx.length - 1];
    for ( let s = 0; s < idx.length; s++ ) {
      r -= d2[s];
      if ( r <= 0 ) {
        pick = idx[s];
        break;
      }
    }
    cents.push({L: L[pick], a: A[pick], b: B[pick]});
  }
  // Lloyd iterations on the sample
  const assign = new Uint8Array(idx.length);
  for ( let it = 0; it < iterations; it++ ) {
    const acc = cents.map(() => ({L: 0, a: 0, b: 0, n: 0}));
    for ( let s = 0; s < idx.length; s++ ) {
      let best = 0;
      let bd = Infinity;
      for ( let c = 0; c < cents.length; c++ ) {
        const d = dist(idx[s], cents[c]);
        if ( d < bd ) {
          bd = d;
          best = c;
        }
      }
      assign[s] = best;
      const a = acc[best];
      a.L += L[idx[s]];
      a.a += A[idx[s]];
      a.b += B[idx[s]];
      a.n++;
    }
    for ( let c = 0; c < cents.length; c++ ) {
      if ( acc[c].n ) cents[c] = {L: acc[c].L / acc[c].n, a: acc[c].a / acc[c].n, b: acc[c].b / acc[c].n};
    }
  }
  // Label every pixel
  const labels = new Uint8Array(n);
  for ( let i = 0; i < n; i++ ) {
    let best = 0;
    let bd = Infinity;
    for ( let c = 0; c < cents.length; c++ ) {
      const d = dist(i, cents[c]);
      if ( d < bd ) {
        bd = d;
        best = c;
      }
    }
    labels[i] = best;
  }
  return {centroids: cents, labels};
}

/* -------------------------------------------- */
/*  Binary morphology & components              */
/* -------------------------------------------- */

/** Dilate (max) or erode (min) a 0/1 mask with a square of radius r (separable running window). */
function morph(mask, W, H, r, dilate) {
  if ( r <= 0 ) return mask.slice();
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const want = dilate ? 1 : 0;
  // Horizontal
  for ( let y = 0; y < H; y++ ) {
    let count = 0;
    const row = y * W;
    for ( let x = -r; x < W; x++ ) {
      const add = x + r;
      if ( (add < W) && (mask[row + add] === want) ) count++;
      const rem = x - r - 1;
      if ( (rem >= 0) && (mask[row + rem] === want) ) count--;
      if ( x >= 0 ) tmp[row + x] = count > 0 ? want : 1 - want;
    }
  }
  // Vertical
  for ( let x = 0; x < W; x++ ) {
    let count = 0;
    for ( let y = -r; y < H; y++ ) {
      const add = y + r;
      if ( (add < H) && (tmp[(add * W) + x] === want) ) count++;
      const rem = y - r - 1;
      if ( (rem >= 0) && (tmp[(rem * W) + x] === want) ) count--;
      if ( y >= 0 ) out[(y * W) + x] = count > 0 ? want : 1 - want;
    }
  }
  return out;
}

export const dilate = (m, W, H, r) => morph(m, W, H, r, true);
export const erode = (m, W, H, r) => morph(m, W, H, r, false);
export const close = (m, W, H, r) => erode(dilate(m, W, H, r), W, H, r);
export const open = (m, W, H, r) => dilate(erode(m, W, H, r), W, H, r);

/**
 * Connected components (4-neighbour) of pixels equal to `value`.
 * @returns {{comp: Int32Array, sizes: number[], touchesBorder: boolean[]}}
 */
export function components(mask, W, H, value=1) {
  const comp = new Int32Array(W * H).fill(-1);
  const sizes = [];
  const touchesBorder = [];
  const stack = new Int32Array(W * H);
  for ( let s = 0; s < W * H; s++ ) {
    if ( (mask[s] !== value) || (comp[s] >= 0) ) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    let border = false;
    stack[top++] = s;
    comp[s] = id;
    while ( top ) {
      const i = stack[--top];
      size++;
      const x = i % W;
      const y = (i - x) / W;
      if ( (x === 0) || (y === 0) || (x === W - 1) || (y === H - 1) ) border = true;
      const push = j => {
        if ( (mask[j] === value) && (comp[j] < 0) ) {
          comp[j] = id;
          stack[top++] = j;
        }
      };
      if ( x > 0 ) push(i - 1);
      if ( x < W - 1 ) push(i + 1);
      if ( y > 0 ) push(i - W);
      if ( y < H - 1 ) push(i + W);
    }
    sizes.push(size);
    touchesBorder.push(border);
  }
  return {comp, sizes, touchesBorder};
}

/* -------------------------------------------- */
/*  Analysis                                    */
/* -------------------------------------------- */

/**
 * @typedef {object} VisionOptions
 * @property {number} S                         Samples per grid square
 * @property {{x:number,y:number}[]} [seeds]    Points known to be floor (token centres), in samples
 * @property {{x:number,y:number}[]} [floorHints]  Painted "this is floor"
 * @property {{x:number,y:number}[]} [wallHints]   Painted "this is wall"
 * @property {number} [clusters=8]
 * @property {number} [sensitivity=0.5]          0 = strict (only the floor's own colour), 1 = generous
 * @property {number} [darkness=0.22]            OKLab lightness below which material is treated as wall
 * @property {number} [edgeCut=0.7]              Edge strength (0..1) that always counts as a wall line
 * @property {number} [minIsland=1.5]            Smallest floor area kept, in squares (unless a token is on it)
 * @property {number} [minHole=0.35]             Enclosed blots smaller than this (squares) are filled in
 * @property {number} [seed=1]
 */

/**
 * Work out the walkable floor of a map image.
 * @param {{width:number, height:number, data:Uint8ClampedArray}} img
 * @param {VisionOptions} opts
 */
export function analyzeMap(img, opts) {
  const W = img.width;
  const H = img.height;
  const n = W * H;
  const S = Math.max(1, opts.S);
  const sens = Math.min(1, Math.max(0, opts.sensitivity ?? 0.5));
  const darkness = opts.darkness ?? 0.22;
  const edgeCut = opts.edgeCut ?? 0.7;
  const lab = toOklab(img.data, n);
  const opaque = new Uint8Array(n);
  for ( let i = 0; i < n; i++ ) opaque[i] = lab.alpha[i] >= 128 ? 1 : 0;
  const edges = edgeStrength(lab.L, W, H);
  const {centroids, labels} = kmeans(lab, n, {k: opts.clusters ?? 8, seed: opts.seed ?? 1, valid: opaque});
  const K = centroids.length;

  // Evidence per cluster
  const count = new Float64Array(K);
  const edgeSum = new Float64Array(K);
  for ( let i = 0; i < n; i++ ) {
    if ( !opaque[i] ) continue;
    count[labels[i]]++;
    edgeSum[labels[i]] += edges[i];
  }
  const tally = (points, radius) => {
    const t = new Float64Array(K);
    let total = 0;
    for ( const p of points ?? [] ) {
      const r = Math.max(1, Math.round(radius));
      for ( let dy = -r; dy <= r; dy++ ) {
        for ( let dx = -r; dx <= r; dx++ ) {
          if ( (dx * dx) + (dy * dy) > r * r ) continue;
          const x = Math.round(p.x) + dx;
          const y = Math.round(p.y) + dy;
          if ( (x < 0) || (y < 0) || (x >= W) || (y >= H) ) continue;
          const i = (y * W) + x;
          if ( !opaque[i] ) continue;
          t[labels[i]]++;
          total++;
        }
      }
    }
    return {t, total};
  };
  const seedT = tally(opts.seeds, S * 0.3);
  const floorT = tally(opts.floorHints, S * 0.25);
  const wallT = tally(opts.wallHints, S * 0.25);

  const clusters = centroids.map((c, i) => ({
    ...c, index: i, share: count[i] / Math.max(1, n), edge: edgeSum[i] / Math.max(1, count[i]),
    seedShare: seedT.total ? seedT.t[i] / seedT.total : 0, floor: false, reason: ""
  }));
  const dE = (p, q) => Math.hypot(p.L - q.L, (p.a - q.a) * AB_WEIGHT, (p.b - q.b) * AB_WEIGHT);

  // Floor clusters: where tokens stand, or (without tokens) the biggest mid-tone material
  if ( seedT.total ) {
    for ( const c of clusters ) {
      if ( (c.seedShare >= 0.12) && (c.L >= darkness * 0.75) ) {
        c.floor = true;
        c.reason = "tokens stand on it";
      }
    }
  }
  if ( !clusters.some(c => c.floor) ) {
    const candidates = clusters.filter(c => (c.L >= darkness) && (c.L <= 0.97)).sort((p, q) => q.share - p.share);
    if ( candidates[0] ) {
      candidates[0].floor = true;
      candidates[0].reason = "largest material";
    }
  }
  // Similar materials join the floor (a tiled floor has light and dark tiles…)
  const tol = 0.05 + (sens * 0.12);
  const core = clusters.filter(c => c.floor);
  for ( const c of clusters ) {
    if ( c.floor || (c.L < darkness) ) continue;
    if ( core.some(f => dE(c, f) < tol) ) {
      c.floor = true;
      c.reason = "close to the floor's colour";
    }
  }
  // Hints override
  for ( const c of clusters ) {
    const f = floorT.t[c.index];
    const w = wallT.t[c.index];
    if ( f > w && f > 0 ) {
      c.floor = true;
      c.reason = "painted as floor";
    } else if ( w > f && w > 0 ) {
      c.floor = false;
      c.reason = "painted as wall";
    }
  }
  for ( const c of clusters ) if ( !c.floor && !c.reason ) c.reason = c.L < darkness ? "too dark" : "not floor-like";

  // Pixel mask
  let mask = new Uint8Array(n);
  for ( let i = 0; i < n; i++ ) mask[i] = opaque[i] && clusters[labels[i]]?.floor && (edges[i] < edgeCut) ? 1 : 0;

  // Clean-up: close thin cracks (plank lines, grout), drop specks, fill small blots
  const r1 = Math.max(1, Math.round(S * 0.08));
  mask = close(mask, W, H, r1);
  mask = open(mask, W, H, Math.max(1, Math.round(S * 0.06)));
  const sq = S * S;
  const holes = components(mask, W, H, 0);
  const minHole = (opts.minHole ?? 0.35) * sq;
  for ( let i = 0; i < n; i++ ) {
    const h = holes.comp[i];
    if ( (h >= 0) && !holes.touchesBorder[h] && (holes.sizes[h] < minHole) && opaque[i] ) mask[i] = 1;
  }
  // Painted floor is always floor, painted walls always wall
  const paint = (points, v) => {
    const r = Math.max(1, Math.round(S * 0.25));
    for ( const p of points ?? [] ) {
      for ( let dy = -r; dy <= r; dy++ ) {
        for ( let dx = -r; dx <= r; dx++ ) {
          const x = Math.round(p.x) + dx;
          const y = Math.round(p.y) + dy;
          if ( (x >= 0) && (y >= 0) && (x < W) && (y < H) && ((dx * dx) + (dy * dy) <= r * r) ) mask[(y * W) + x] = v;
        }
      }
    }
  };
  paint(opts.floorHints, 1);
  paint(opts.wallHints, 0);
  // Islands: keep floor areas that are big enough or that have a token on them
  const islands = components(mask, W, H, 1);
  const seeded = new Set();
  for ( const p of opts.seeds ?? [] ) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if ( (x >= 0) && (y >= 0) && (x < W) && (y < H) ) {
      const c = islands.comp[(y * W) + x];
      if ( c >= 0 ) seeded.add(c);
    }
  }
  const minIsland = (opts.minIsland ?? 1.5) * sq;
  for ( let i = 0; i < n; i++ ) {
    const c = islands.comp[i];
    if ( (c >= 0) && !seeded.has(c) && (islands.sizes[c] < minIsland) ) mask[i] = 0;
  }
  let floor = 0;
  for ( let i = 0; i < n; i++ ) floor += mask[i];
  return {W, H, S, mask, labels, clusters, edges, floorShare: floor / n};
}
