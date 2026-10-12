// Navigation over a scanned map: a fine grid of walkable cells, blocked by movement walls, with a clearance map
// (distance to the nearest obstacle), A* routes that keep a respectful distance from walls, and line-of-sight
// smoothing so routes are natural curves rather than staircase steps. Pure; coordinates are scene pixels.

const SQRT2 = Math.SQRT2;
const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

/** Do segments p1p2 and p3p4 intersect (touching counts)? */
export function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = ((x2 - x1) * (y4 - y3)) - ((y2 - y1) * (x4 - x3));
  if ( Math.abs(d) < 1e-12 ) return false;
  const t = (((x3 - x1) * (y4 - y3)) - ((y3 - y1) * (x4 - x3))) / d;
  const u = (((x3 - x1) * (y2 - y1)) - ((y3 - y1) * (x2 - x1))) / d;
  return (t >= -1e-9) && (t <= 1 + 1e-9) && (u >= -1e-9) && (u <= 1 + 1e-9);
}

/** A tiny binary heap keyed by f-score. */
class Heap {
  constructor() {
    this.items = [];
    this.keys = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, key) {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while ( i > 0 ) {
      const p = (i - 1) >> 1;
      if ( k[p] <= key ) break;
      [a[i], a[p]] = [a[p], a[i]];
      [k[i], k[p]] = [k[p], k[i]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastItem = a.pop();
    const lastKey = k.pop();
    if ( a.length ) {
      a[0] = lastItem;
      k[0] = lastKey;
      let i = 0;
      for ( ;; ) {
        const l = (2 * i) + 1;
        const r = l + 1;
        let m = i;
        if ( (l < a.length) && (k[l] < k[m]) ) m = l;
        if ( (r < a.length) && (k[r] < k[m]) ) m = r;
        if ( m === i ) break;
        [a[i], a[m]] = [a[m], a[i]];
        [k[i], k[m]] = [k[m], k[i]];
        i = m;
      }
    }
    return top;
  }
}

export class NavGrid {
  /**
   * @param {object} o
   * @param {number} o.cols
   * @param {number} o.rows
   * @param {number} o.cell                  Cell size in pixels
   * @param {number} o.x                     Scene x of the grid's left edge
   * @param {number} o.y                     Scene y of the grid's top edge
   * @param {Uint8Array} o.walkable          1 = floor
   * @param {number[][]} [o.walls]           Movement-blocking segments [x0, y0, x1, y1] in scene pixels
   */
  constructor({cols, rows, cell, x, y, walkable, walls=[]}) {
    Object.assign(this, {cols, rows, cell, x, y});
    this.walkable = walkable;
    this.walls = walls;
    this.#bucketWalls();
    this.clearance = this.#computeClearance();
  }

  /** Build a grid from a vision mask. A cell is walkable when most of its samples are floor. */
  static fromMask({mask, W, H, S}, {sceneX, sceneY, grid, cellsPerSquare=2, threshold=0.6, walls=[]}) {
    const cell = grid / cellsPerSquare;
    const per = S / cellsPerSquare;
    const cols = Math.max(1, Math.floor(W / per));
    const rows = Math.max(1, Math.floor(H / per));
    const walkable = new Uint8Array(cols * rows);
    for ( let r = 0; r < rows; r++ ) {
      for ( let c = 0; c < cols; c++ ) {
        let on = 0;
        let tot = 0;
        const x0 = Math.floor(c * per);
        const x1 = Math.min(W, Math.floor((c + 1) * per));
        const y0 = Math.floor(r * per);
        const y1 = Math.min(H, Math.floor((r + 1) * per));
        for ( let y = y0; y < y1; y++ ) {
          for ( let x = x0; x < x1; x++ ) {
            on += mask[(y * W) + x];
            tot++;
          }
        }
        walkable[(r * cols) + c] = tot && ((on / tot) >= threshold) ? 1 : 0;
      }
    }
    return new NavGrid({cols, rows, cell, x: sceneX, y: sceneY, walkable, walls});
  }

  /* -------------------------------------------- */

  index(c, r) {
    return (r * this.cols) + c;
  }

  center(i) {
    const c = i % this.cols;
    const r = (i - c) / this.cols;
    return {x: this.x + ((c + 0.5) * this.cell), y: this.y + ((r + 0.5) * this.cell)};
  }

  cellAt(px, py) {
    const c = Math.floor((px - this.x) / this.cell);
    const r = Math.floor((py - this.y) / this.cell);
    if ( (c < 0) || (r < 0) || (c >= this.cols) || (r >= this.rows) ) return -1;
    return this.index(c, r);
  }

  isWalkable(i) {
    return (i >= 0) && (this.walkable[i] === 1);
  }

  /* -------------------------------------------- */
  /*  Walls                                       */
  /* -------------------------------------------- */

  #buckets = null;

  /** Index each wall by the coarse buckets (4x4 cells) it crosses, for fast crossing tests. */
  #bucketWalls() {
    const B = this.cell * 4;
    this.#buckets = new Map();
    this.walls.forEach((w, wi) => {
      const [x0, y0, x1, y1] = w;
      const L = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(L / (B * 0.5)));
      const seen = new Set();
      for ( let s = 0; s <= steps; s++ ) {
        const t = s / steps;
        const bx = Math.floor((x0 + ((x1 - x0) * t) - this.x) / B);
        const by = Math.floor((y0 + ((y1 - y0) * t) - this.y) / B);
        for ( let dy = -1; dy <= 1; dy++ ) {
          for ( let dx = -1; dx <= 1; dx++ ) {
            const k = `${bx + dx},${by + dy}`;
            if ( seen.has(k) ) continue;
            seen.add(k);
            if ( !this.#buckets.has(k) ) this.#buckets.set(k, []);
            this.#buckets.get(k).push(wi);
          }
        }
      }
    });
  }

  /** Does the straight move from a to b cross a wall? */
  crossesWall(ax, ay, bx, by) {
    if ( !this.walls.length ) return false;
    const B = this.cell * 4;
    const L = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(L / (B * 0.5)));
    const tested = new Set();
    for ( let s = 0; s <= steps; s++ ) {
      const t = s / steps;
      const k = `${Math.floor((ax + ((bx - ax) * t) - this.x) / B)},${Math.floor((ay + ((by - ay) * t) - this.y) / B)}`;
      for ( const wi of this.#buckets.get(k) ?? [] ) {
        if ( tested.has(wi) ) continue;
        tested.add(wi);
        const w = this.walls[wi];
        if ( segmentsIntersect(ax, ay, bx, by, w[0], w[1], w[2], w[3]) ) return true;
      }
    }
    return false;
  }

  /** Can we step from cell i to neighbour j? */
  canStep(i, j, dc, dr) {
    if ( !this.isWalkable(j) ) return false;
    // No squeezing diagonally between two blocked cells
    if ( dc && dr ) {
      const c = i % this.cols;
      const r = (i - c) / this.cols;
      if ( !this.isWalkable(this.index(c + dc, r)) || !this.isWalkable(this.index(c, r + dr)) ) return false;
    }
    const a = this.center(i);
    const b = this.center(j);
    return !this.crossesWall(a.x, a.y, b.x, b.y);
  }

  /* -------------------------------------------- */
  /*  Clearance                                   */
  /* -------------------------------------------- */

  /** Chamfer distance (in cells) from every walkable cell to the nearest obstacle or wall. */
  #computeClearance() {
    const {cols, rows} = this;
    const n = cols * rows;
    const d = new Float32Array(n).fill(Infinity);
    for ( let i = 0; i < n; i++ ) if ( !this.walkable[i] ) d[i] = 0;
    // Cells a wall passes through count as obstacles for clearance
    for ( const [x0, y0, x1, y1] of this.walls ) {
      const L = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(L / (this.cell * 0.5)));
      for ( let s = 0; s <= steps; s++ ) {
        const t = s / steps;
        const i = this.cellAt(x0 + ((x1 - x0) * t), y0 + ((y1 - y0) * t));
        if ( i >= 0 ) d[i] = Math.min(d[i], 0.5);
      }
    }
    // Map edges count as obstacles too
    for ( let c = 0; c < cols; c++ ) {
      d[c] = Math.min(d[c], 1);
      d[((rows - 1) * cols) + c] = Math.min(d[((rows - 1) * cols) + c], 1);
    }
    for ( let r = 0; r < rows; r++ ) {
      d[r * cols] = Math.min(d[r * cols], 1);
      d[(r * cols) + cols - 1] = Math.min(d[(r * cols) + cols - 1], 1);
    }
    const pass = (r0, r1, dr, c0, c1, dc) => {
      for ( let r = r0; r !== r1; r += dr ) {
        for ( let c = c0; c !== c1; c += dc ) {
          const i = (r * cols) + c;
          let v = d[i];
          if ( (c - dc >= 0) && (c - dc < cols) ) v = Math.min(v, d[i - dc] + 1);
          if ( (r - dr >= 0) && (r - dr < rows) ) {
            v = Math.min(v, d[i - (dr * cols)] + 1);
            if ( (c - dc >= 0) && (c - dc < cols) ) v = Math.min(v, d[i - (dr * cols) - dc] + SQRT2);
            if ( (c + dc >= 0) && (c + dc < cols) ) v = Math.min(v, d[i - (dr * cols) + dc] + SQRT2);
          }
          d[i] = v;
        }
      }
    };
    pass(0, rows, 1, 0, cols, 1);
    pass(rows - 1, -1, -1, cols - 1, -1, -1);
    for ( let i = 0; i < n; i++ ) if ( !Number.isFinite(d[i]) ) d[i] = Math.max(cols, rows);
    return d;
  }

  /* -------------------------------------------- */
  /*  Search                                      */
  /* -------------------------------------------- */

  /**
   * Nearest walkable cell to a point (breadth-first outward). Cells on this side of every wall come first: the
   * nearest cell behind a wall is only used when nothing is reachable in a straight line.
   */
  nearestWalkable(px, py, maxRadius=40) {
    let start = this.cellAt(px, py);
    if ( start < 0 ) {
      const c = Math.min(this.cols - 1, Math.max(0, Math.floor((px - this.x) / this.cell)));
      const r = Math.min(this.rows - 1, Math.max(0, Math.floor((py - this.y) / this.cell)));
      start = this.index(c, r);
    }
    const open = i => {
      const q = this.center(i);
      return !this.crossesWall(px, py, q.x, q.y);
    };
    if ( this.isWalkable(start) && open(start) ) return start;
    let fallback = this.isWalkable(start) ? start : -1;
    const c0 = start % this.cols;
    const r0 = (start - c0) / this.cols;
    for ( let rad = 1; rad <= maxRadius; rad++ ) {
      let best = -1;
      let bd = Infinity;
      for ( let dr = -rad; dr <= rad; dr++ ) {
        for ( let dc = -rad; dc <= rad; dc++ ) {
          if ( (Math.abs(dr) !== rad) && (Math.abs(dc) !== rad) ) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if ( (c < 0) || (r < 0) || (c >= this.cols) || (r >= this.rows) ) continue;
          const i = this.index(c, r);
          if ( !this.isWalkable(i) ) continue;
          const d = Math.hypot(dc, dr);
          if ( d >= bd ) continue;
          if ( fallback < 0 ) fallback = i;
          if ( !open(i) ) continue;
          bd = d;
          best = i;
        }
      }
      if ( best >= 0 ) return best;
    }
    return fallback;
  }

  /**
   * Routes run between cell centres. Start them exactly at `from` and end them exactly at `to` where the straight
   * line there is clear (replacing the first/last centre when that is clear too, adding to the route otherwise).
   * @param {{x:number,y:number}[]} pts   A route from route(); changed in place
   */
  joinEnds(pts, from, to) {
    if ( !pts.length ) return pts;
    const clear = (a, b) => !this.crossesWall(a.x, a.y, b.x, b.y);
    if ( from ) {
      if ( (pts.length > 1) && clear(from, pts[1]) ) pts[0] = {x: from.x, y: from.y};
      else if ( clear(from, pts[0]) && (Math.hypot(pts[0].x - from.x, pts[0].y - from.y) > 0.5) ) pts.unshift({x: from.x, y: from.y});
    }
    if ( to ) {
      const n = pts.length;
      if ( (n > 1) && clear(pts[n - 2], to) ) pts[n - 1] = {x: to.x, y: to.y};
      else if ( clear(pts[n - 1], to) && (Math.hypot(pts[n - 1].x - to.x, pts[n - 1].y - to.y) > 0.5) ) pts.push({x: to.x, y: to.y});
    }
    return pts;
  }

  /**
   * A* between two cells. Moving close to walls costs extra, so routes keep to the middle of corridors.
   * @returns {number[]|null}  Cell indices from a to b
   */
  findPath(a, b, {wallAversion=1.2, maxNodes=200000}={}) {
    if ( !this.isWalkable(a) || !this.isWalkable(b) ) return null;
    if ( a === b ) return [a];
    const {cols} = this;
    const n = cols * this.rows;
    const g = new Float32Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const bc = b % cols;
    const br = (b - bc) / cols;
    const h = i => {
      const c = i % cols;
      const r = (i - c) / cols;
      const dx = Math.abs(c - bc);
      const dy = Math.abs(r - br);
      return (Math.max(dx, dy) - Math.min(dx, dy)) + (SQRT2 * Math.min(dx, dy));
    };
    const heap = new Heap();
    g[a] = 0;
    heap.push(a, h(a));
    let visited = 0;
    while ( heap.size ) {
      const i = heap.pop();
      if ( closed[i] ) continue;
      if ( i === b ) break;
      closed[i] = 1;
      if ( ++visited > maxNodes ) return null;
      const c = i % cols;
      const r = (i - c) / cols;
      for ( const [dc, dr, cost] of DIRS ) {
        const nc = c + dc;
        const nr = r + dr;
        if ( (nc < 0) || (nr < 0) || (nc >= cols) || (nr >= this.rows) ) continue;
        const j = (nr * cols) + nc;
        if ( closed[j] || !this.canStep(i, j, dc, dr) ) continue;
        const near = wallAversion / Math.max(0.75, this.clearance[j]);
        const ng = g[i] + (cost * (1 + near));
        if ( ng < g[j] ) {
          g[j] = ng;
          from[j] = i;
          heap.push(j, ng + h(j));
        }
      }
    }
    if ( from[b] < 0 ) return null;
    const path = [b];
    for ( let i = b; i !== a; ) {
      i = from[i];
      path.push(i);
    }
    return path.reverse();
  }

  /** Can you walk in a straight line between two points (floor all the way, no wall crossed, some clearance)? */
  lineClear(p, q, {margin=0.35}={}) {
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.max(1, Math.ceil(L / (this.cell * 0.25)));
    for ( let s = 0; s <= steps; s++ ) {
      const t = s / steps;
      const i = this.cellAt(p.x + ((q.x - p.x) * t), p.y + ((q.y - p.y) * t));
      if ( !this.isWalkable(i) || (this.clearance[i] < margin) ) return false;
    }
    return !this.crossesWall(p.x, p.y, q.x, q.y);
  }

  /** Straighten a cell path into as few waypoints as line of sight allows (string pulling). */
  smooth(cells) {
    if ( !cells?.length ) return [];
    const pts = cells.map(i => this.center(i));
    if ( pts.length < 3 ) return pts;
    const out = [pts[0]];
    let anchor = 0;
    while ( anchor < pts.length - 1 ) {
      let next = anchor + 1;
      for ( let k = pts.length - 1; k > anchor + 1; k-- ) {
        if ( this.lineClear(pts[anchor], pts[k]) ) {
          next = k;
          break;
        }
      }
      out.push(pts[next]);
      anchor = next;
    }
    return out;
  }

  /** A walkable route between two points, smoothed. Null when unreachable. */
  route(p, q) {
    const a = this.nearestWalkable(p.x, p.y);
    const b = this.nearestWalkable(q.x, q.y);
    if ( (a < 0) || (b < 0) ) return null;
    const cells = this.findPath(a, b);
    return cells ? this.smooth(cells) : null;
  }

  /** Cells reachable from a cell (flood fill respecting walls). */
  reachable(start) {
    const seen = new Uint8Array(this.cols * this.rows);
    if ( !this.isWalkable(start) ) return seen;
    const queue = [start];
    seen[start] = 1;
    while ( queue.length ) {
      const i = queue.pop();
      const c = i % this.cols;
      const r = (i - c) / this.cols;
      for ( const [dc, dr] of DIRS ) {
        const nc = c + dc;
        const nr = r + dr;
        if ( (nc < 0) || (nr < 0) || (nc >= this.cols) || (nr >= this.rows) ) continue;
        const j = (nr * this.cols) + nc;
        if ( !seen[j] && this.canStep(i, j, dc, dr) ) {
          seen[j] = 1;
          queue.push(j);
        }
      }
    }
    return seen;
  }
}
