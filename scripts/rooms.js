// Rooms: split the walkable area into rooms and corridors joined by doorways, using the clearance map. Open
// "cores" far from walls become rooms; the narrow cells around and between them are shared out to the nearest
// room; where two rooms meet is a doorway. Pure.

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * @param {import("./nav.js").NavGrid} nav
 * @param {object} [options]
 * @param {number} [options.cellsPerSquare=2]
 * @param {number} [options.core]       Clearance (cells) a room's core needs; default 1.25 squares
 * @param {number} [options.minRoom]    Rooms smaller than this many cells are merged into a neighbour; default 6 squares
 * @returns {{roomOf: Int32Array, rooms: object[], doorways: object[]}}
 */
export function findRooms(nav, {cellsPerSquare=2, core, minRoom}={}) {
  const {cols, rows} = nav;
  const n = cols * rows;
  core ??= 1.25 * cellsPerSquare;
  minRoom ??= 6 * cellsPerSquare * cellsPerSquare;
  const roomOf = new Int32Array(n).fill(-1);
  const neighbors = (i, dirs, cb) => {
    const c = i % cols;
    const r = (i - c) / cols;
    for ( const [dc, dr] of dirs ) {
      const nc = c + dc;
      const nr = r + dr;
      if ( (nc < 0) || (nr < 0) || (nc >= cols) || (nr >= rows) ) continue;
      const j = (nr * cols) + nc;
      if ( nav.canStep(i, j, dc, dr) ) cb(j);
    }
  };

  // 1. Cores: connected areas with enough clearance
  let rooms = 0;
  for ( let s = 0; s < n; s++ ) {
    if ( (roomOf[s] >= 0) || !nav.isWalkable(s) || (nav.clearance[s] < core) ) continue;
    const id = rooms++;
    const stack = [s];
    roomOf[s] = id;
    while ( stack.length ) {
      const i = stack.pop();
      neighbors(i, N8, j => {
        if ( (roomOf[j] < 0) && (nav.clearance[j] >= core) ) {
          roomOf[j] = id;
          stack.push(j);
        }
      });
    }
  }
  // Without any open space, every connected area is one room
  if ( !rooms ) {
    for ( let s = 0; s < n; s++ ) {
      if ( (roomOf[s] >= 0) || !nav.isWalkable(s) ) continue;
      const id = rooms++;
      const stack = [s];
      roomOf[s] = id;
      while ( stack.length ) {
        const i = stack.pop();
        neighbors(i, N8, j => {
          if ( roomOf[j] < 0 ) {
            roomOf[j] = id;
            stack.push(j);
          }
        });
      }
    }
  }

  // 2. Share the remaining walkable cells out to the nearest core (multi-source breadth-first)
  let frontier = [];
  for ( let i = 0; i < n; i++ ) if ( roomOf[i] >= 0 ) frontier.push(i);
  while ( frontier.length ) {
    const next = [];
    for ( const i of frontier ) {
      neighbors(i, N4, j => {
        if ( roomOf[j] < 0 ) {
          roomOf[j] = roomOf[i];
          next.push(j);
        }
      });
    }
    frontier = next;
  }

  // 3. Merge tiny rooms into the neighbour they share most boundary with
  const sizes = new Array(rooms).fill(0);
  for ( let i = 0; i < n; i++ ) if ( roomOf[i] >= 0 ) sizes[roomOf[i]]++;
  for ( let pass = 0; pass < 3; pass++ ) {
    let changed = false;
    for ( let id = 0; id < rooms; id++ ) {
      if ( !sizes[id] || (sizes[id] >= minRoom) ) continue;
      const shared = new Map();
      for ( let i = 0; i < n; i++ ) {
        if ( roomOf[i] !== id ) continue;
        neighbors(i, N4, j => {
          const o = roomOf[j];
          if ( (o >= 0) && (o !== id) ) shared.set(o, (shared.get(o) ?? 0) + 1);
        });
      }
      if ( !shared.size ) continue;
      const into = [...shared.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for ( let i = 0; i < n; i++ ) if ( roomOf[i] === id ) roomOf[i] = into;
      sizes[into] += sizes[id];
      sizes[id] = 0;
      changed = true;
    }
    if ( !changed ) break;
  }

  // 4. Renumber, describe rooms
  const remap = new Map();
  for ( let i = 0; i < n; i++ ) {
    const id = roomOf[i];
    if ( id < 0 ) continue;
    if ( !remap.has(id) ) remap.set(id, remap.size);
    roomOf[i] = remap.get(id);
  }
  const list = Array.from({length: remap.size}, (_, id) => ({id, cells: [], neighbors: new Set(), doorways: []}));
  for ( let i = 0; i < n; i++ ) if ( roomOf[i] >= 0 ) list[roomOf[i]].cells.push(i);
  for ( const room of list ) {
    let sx = 0;
    let sy = 0;
    let best = room.cells[0];
    for ( const i of room.cells ) {
      const p = nav.center(i);
      sx += p.x;
      sy += p.y;
      if ( nav.clearance[i] > nav.clearance[best] ) best = i;
    }
    room.area = room.cells.length;
    room.centroid = {x: sx / room.area, y: sy / room.area};
    // The room's "heart": its most open cell (ties broken towards the centroid)
    const maxC = nav.clearance[best];
    let heart = best;
    let hd = Infinity;
    for ( const i of room.cells ) {
      if ( nav.clearance[i] < maxC - 0.5 ) continue;
      const p = nav.center(i);
      const d = Math.hypot(p.x - room.centroid.x, p.y - room.centroid.y);
      if ( d < hd ) {
        hd = d;
        heart = i;
      }
    }
    room.heart = heart;
    room.center = nav.center(heart);
    // Principal axis (for pacing along corridors)
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for ( const i of room.cells ) {
      const p = nav.center(i);
      const dx = p.x - room.centroid.x;
      const dy = p.y - room.centroid.y;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
    xx /= room.area;
    yy /= room.area;
    xy /= room.area;
    const tr = xx + yy;
    const det = (xx * yy) - (xy * xy);
    const l1 = (tr / 2) + Math.sqrt(Math.max(0, ((tr * tr) / 4) - det));
    const l2 = (tr / 2) - Math.sqrt(Math.max(0, ((tr * tr) / 4) - det));
    room.axis = Math.abs(xy) > 1e-9 ? Math.atan2(l1 - xx, xy) : (xx >= yy ? 0 : Math.PI / 2);
    room.elongation = Math.sqrt(l1 / Math.max(l2, 1e-6));
  }

  // 5. Doorways: where two rooms touch
  const pairs = new Map();
  for ( let i = 0; i < n; i++ ) {
    const a = roomOf[i];
    if ( a < 0 ) continue;
    neighbors(i, N4, j => {
      const b = roomOf[j];
      if ( (b < 0) || (b <= a) ) return;
      const key = `${a}:${b}`;
      if ( !pairs.has(key) ) pairs.set(key, {a, b, cells: []});
      pairs.get(key).cells.push(i, j);
    });
  }
  const doorways = [];
  for ( const {a, b, cells} of pairs.values() ) {
    let sx = 0;
    let sy = 0;
    for ( const i of cells ) {
      const p = nav.center(i);
      sx += p.x;
      sy += p.y;
    }
    const mid = {x: sx / cells.length, y: sy / cells.length};
    // Snap to the boundary cell nearest the middle
    let at = cells[0];
    let ad = Infinity;
    for ( const i of cells ) {
      const p = nav.center(i);
      const d = Math.hypot(p.x - mid.x, p.y - mid.y);
      if ( d < ad ) {
        ad = d;
        at = i;
      }
    }
    const door = {a, b, cell: at, point: nav.center(at), width: new Set(cells).size / 2};
    doorways.push(door);
    list[a].neighbors.add(b);
    list[b].neighbors.add(a);
    list[a].doorways.push(door);
    list[b].doorways.push(door);
  }
  for ( const room of list ) room.neighbors = [...room.neighbors];
  return {roomOf, rooms: list, doorways};
}
