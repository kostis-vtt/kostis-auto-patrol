// Patrol planning: pick a sensible routine for each NPC from the shape of the place it stands in, lay out its
// waypoints, route every leg around walls, and turn the result into an animator animation. Pure (the caller
// passes the nav grid, the rooms and, optionally, a curve sampler for the final wall check).

export const STRATEGIES = {
  auto: {label: "Automatic", icon: "fa-solid fa-wand-magic-sparkles", color: "#ffffff"},
  rounds: {label: "Rounds (visit nearby rooms)", icon: "fa-solid fa-route", color: "#3fa7ff"},
  perimeter: {label: "Walk the room's edge", icon: "fa-solid fa-draw-polygon", color: "#3ddc84"},
  pace: {label: "Pace back and forth", icon: "fa-solid fa-arrows-left-right", color: "#f78c40"},
  guard: {label: "Guard post (stand watch)", icon: "fa-solid fa-shield-halved", color: "#ff5d6c"},
  wander: {label: "Wander nearby", icon: "fa-solid fa-shoe-prints", color: "#c56cf0"},
  stationary: {label: "Stay put, look around", icon: "fa-solid fa-eye", color: "#e6e6e6"}
};

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

/** A stable seed from a string (token id). */
export function seedOf(str) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < str.length; i++ ) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Choose a routine from the NPC's surroundings.
 * @param {object} ctx       {nav, rooms, roomOf, cellsPerSquare}
 * @param {{x:number, y:number}} at
 */
export function chooseStrategy(ctx, at) {
  const {nav, rooms, roomOf, cellsPerSquare: cps} = ctx;
  const cell = nav.nearestWalkable(at.x, at.y);
  if ( cell < 0 ) return "stationary";
  const room = rooms[roomOf[cell]];
  if ( !room ) return "stationary";
  const area = room.area / (cps * cps);
  const square = nav.cell * cps;
  const nearDoor = room.doorways.some(d => dist(d.point, at) <= 1.5 * square);
  if ( area < 4 ) return "stationary";
  if ( (room.elongation > 2.6) && (area < 60) ) return "pace";
  if ( nearDoor ) return "guard";
  if ( room.neighbors.length && (area < 80) ) return "rounds";
  if ( area >= 20 ) return "perimeter";
  return "wander";
}

/**
 * Lay out the waypoints of a routine. Every routine starts and ends where the NPC stands, so it never has to
 * cut across the map to reach its route.
 * @returns {{strategy:string, waypoints:{x:number,y:number,wait:number}[], facing:object}}
 */
export function planWaypoints(ctx, at, strategy="auto", {seed=1, wanderRadius=5}={}) {
  const {nav, rooms, roomOf, cellsPerSquare: cps} = ctx;
  const rand = mulberry32(seed);
  const between = (a, b) => a + ((b - a) * rand());
  const square = nav.cell * cps;
  if ( strategy === "auto" ) strategy = chooseStrategy(ctx, at);
  const startCell = nav.nearestWalkable(at.x, at.y);
  const start = startCell >= 0 ? nav.center(startCell) : {x: at.x, y: at.y};
  const room = startCell >= 0 ? rooms[roomOf[startCell]] : null;
  const wp = [{...start, wait: 0}];
  const facing = {mode: "path", smoothing: 0.6};

  switch ( strategy ) {
    case "guard":
    case "stationary": {
      // Stand and watch: a long look-around at the post
      wp[0].wait = Math.round(between(6000, 10000));
      return {strategy, waypoints: wp, facing: {mode: "keep", swayAmp: strategy === "guard" ? 70 : 45, swayFreq: 0.08 + (rand() * 0.05)}};
    }
    case "pace": {
      if ( !room ) break;
      const dir = {x: Math.cos(room.axis), y: Math.sin(room.axis)};
      const endAlong = sign => {
        let last = room.center;
        for ( let s = 0.5; s < 40; s += 0.25 ) {
          const p = {x: room.center.x + (dir.x * sign * s * square), y: room.center.y + (dir.y * sign * s * square)};
          const c = nav.cellAt(p.x, p.y);
          if ( (c < 0) || (roomOf[c] !== room.id) || (nav.clearance[c] < 1) ) break;
          last = p;
        }
        // Stop a little short of the far end
        return {x: room.center.x + ((last.x - room.center.x) * 0.85), y: room.center.y + ((last.y - room.center.y) * 0.85)};
      };
      wp.push({...endAlong(1), wait: Math.round(between(1500, 3000))});
      wp.push({...endAlong(-1), wait: Math.round(between(1500, 3000))});
      break;
    }
    case "rounds": {
      if ( !room ) break;
      wp.push({...room.center, wait: Math.round(between(1500, 3500))});
      const others = room.neighbors.map(id => rooms[id]).sort((p, q) => dist(p.center, room.center) - dist(q.center, room.center));
      for ( const other of others.slice(0, 2) ) wp.push({...other.center, wait: Math.round(between(1500, 3500))});
      break;
    }
    case "perimeter": {
      if ( !room ) break;
      const maxC = nav.clearance[room.heart];
      const target = Math.min(1.5 * cps, Math.max(1, maxC * 0.55));
      const sectors = 10;
      const best = new Array(sectors).fill(null);
      for ( const i of room.cells ) {
        const c = nav.clearance[i];
        if ( Math.abs(c - target) > 0.9 ) continue;
        const p = nav.center(i);
        const a = Math.atan2(p.y - room.center.y, p.x - room.center.x);
        const k = Math.min(sectors - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * sectors));
        const score = Math.abs(c - target) - (dist(p, room.center) / (square * 50));
        if ( !best[k] || (score < best[k].score) ) best[k] = {p, score, a};
      }
      const ring = best.filter(Boolean);
      if ( ring.length < 3 ) break;
      // Start the loop from the sector nearest the NPC
      const a0 = Math.atan2(start.y - room.center.y, start.x - room.center.x);
      ring.sort((p, q) => p.a - q.a);
      let first = 0;
      let fd = Infinity;
      ring.forEach((r, i) => {
        const d = Math.abs(Math.atan2(Math.sin(r.a - a0), Math.cos(r.a - a0)));
        if ( d < fd ) {
          fd = d;
          first = i;
        }
      });
      for ( let i = 0; i < ring.length; i++ ) {
        const r = ring[(first + i) % ring.length];
        wp.push({...r.p, wait: rand() < 0.3 ? Math.round(between(800, 2000)) : 0});
      }
      break;
    }
    case "wander":
    default: {
      strategy = "wander";
      const reach = startCell >= 0 ? nav.reachable(startCell) : null;
      const picks = [];
      const want = 4 + Math.floor(rand() * 3);
      for ( let tries = 0; (tries < 400) && (picks.length < want); tries++ ) {
        const a = rand() * Math.PI * 2;
        const r = (0.3 + (0.7 * rand())) * wanderRadius * square;
        const c = nav.cellAt(start.x + (Math.cos(a) * r), start.y + (Math.sin(a) * r));
        if ( (c < 0) || !reach?.[c] || (nav.clearance[c] < 1.5) ) continue;
        const p = nav.center(c);
        if ( picks.some(q => dist(p, q) < square) ) continue;
        picks.push(p);
      }
      // Visit them in a sensible order (nearest next)
      let cur = start;
      while ( picks.length ) {
        picks.sort((p, q) => dist(p, cur) - dist(q, cur));
        cur = picks.shift();
        wp.push({...cur, wait: Math.round(between(800, 3000))});
      }
    }
  }
  return {strategy, waypoints: wp, facing};
}

/**
 * Route every leg of a closed tour around walls.
 * @returns {{points:{x:number,y:number}[], wait:number}[]}  One leg per waypoint, ending at it
 */
export function routeLegs(nav, waypoints) {
  if ( waypoints.length < 2 ) return [];
  const legs = [];
  const tour = [...waypoints, waypoints[0]];
  let from = tour[0];
  for ( let i = 1; i < tour.length; i++ ) {
    const to = tour[i];
    const pts = nav.route(from, to);
    if ( !pts?.length ) continue;
    // Start and end on the waypoints themselves wherever no wall is in the way
    nav.joinEnds(pts, from, to);
    if ( pts.length < 2 ) continue;
    legs.push({points: pts, wait: i === tour.length - 1 ? waypoints[0].wait : to.wait});
    from = to;
  }
  return legs;
}

/**
 * Animator data for a patrol.
 * @param {object} plan          From planWaypoints
 * @param {object[]} legs        From routeLegs
 * @param {object} options
 * @param {(shape: object) => {x:number,y:number}[]} [options.sample]   Samples a path shape the way the animator draws it
 * @param {import("./nav.js").NavGrid} [options.nav]                     For the curve check
 */
export function patrolAnimation(plan, legs, {name, tokens=[], speed=1, smooth=0.5, stagger=0, sample, nav, grid=100}={}) {
  const color = STRATEGIES[plan.strategy]?.color ?? "#3ddc84";
  const steps = [];
  if ( !legs.length ) {
    // Standing watch: a single stop that repeats
    const p = plan.waypoints[0];
    steps.push({shape: {type: "point", x: p.x, y: p.y}, wait: Math.max(1000, p.wait)});
  }
  for ( const leg of legs ) {
    const nodes = leg.points.map((p, i) => ({x: p.x, y: p.y, smooth: (i === 0) || (i === leg.points.length - 1) ? 0 : smooth}));
    const shape = {type: "path", closed: false, nodes};
    // Curves may cut a corner the straight route went around: sharpen those corners until the curve is clear
    if ( sample && nav ) {
      for ( let attempt = 0; attempt < nodes.length; attempt++ ) {
        const pts = sample(shape);
        let bad = -1;
        for ( let k = 1; k < pts.length; k++ ) {
          if ( !nav.lineClear(pts[k - 1], pts[k], {margin: 0}) ) {
            bad = k;
            break;
          }
        }
        if ( bad < 0 ) break;
        // The node nearest the problem becomes a sharp corner
        const q = pts[bad];
        let ni = -1;
        let nd = Infinity;
        nodes.forEach((n, i) => {
          if ( !n.smooth ) return;
          const d = Math.hypot(n.x - q.x, n.y - q.y);
          if ( d < nd ) {
            nd = d;
            ni = i;
          }
        });
        if ( ni < 0 ) break;
        nodes[ni].smooth = 0;
      }
    }
    steps.push({shape, wait: leg.wait});
  }
  return {
    name,
    color,
    steps,
    tokens,
    motion: {speed, speedUnit: "grid", loop: "loop", loopCount: 0, easeIn: 300, easeOut: 300, anchor: "absolute",
      approach: "travel", finish: "stay"},
    // Facing smoothing is a distance along the path, in pixels (plans give it in squares)
    facing: {art: "down", ...plan.facing, ...(plan.facing?.smoothing ? {smoothing: plan.facing.smoothing * grid} : {})},
    stagger: stagger ? {mode: "delay", delay: stagger} : {mode: "none"}
  };
}

/** Group NPCs that stand together (within `radius` px) into squads that share one route. */
export function squads(points, radius) {
  const groups = [];
  const used = new Set();
  points.forEach((p, i) => {
    if ( used.has(i) ) return;
    const g = [i];
    used.add(i);
    for ( let k = 0; k < g.length; k++ ) {
      points.forEach((q, j) => {
        if ( used.has(j) ) return;
        if ( dist(points[g[k]], q) <= radius ) {
          used.add(j);
          g.push(j);
        }
      });
    }
    groups.push(g);
  });
  return groups;
}
