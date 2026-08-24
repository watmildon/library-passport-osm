// unnamed-pairs.mjs – pair unnamed libraries with a named library mapped on
// the same spot. The common duplicate-mapping pattern is a building carrying
// amenity=library with no name while a node inside it holds the name (or the
// reverse); either way the name already exists on the other object, so these
// are the quickest naming fixes there are.
//
// Pure functions only – build-qa.mjs does the Overpass geometry fetch and
// feeds the resulting rings back in for real containment checks.

import { haversineM } from './pls-match.mjs';

// Candidate radius between an unnamed library and its named twin. Distances
// are centroid-to-centroid, so a named node inside a large building can sit
// well away from the building's center – 150 m keeps those while the
// containment check (and the page showing the distance) sorts out the rest.
export const PAIR_RADIUS_M = 150;

// For every unnamed library, the nearest NAMED library within radiusM:
// [{ un, named, dist, others }] where `others` counts additional named
// libraries in the same circle – a multi-library building (university main
// library plus reading rooms), where copying the nearest name blindly would
// be wrong.
export function findUnnamedPairs(rawLibs, radiusM = PAIR_RADIUS_M) {
  // ~500 m cells: a 3×3 neighbourhood always covers the 150 m radius, even at
  // northern latitudes where longitude cells narrow (~280 m at 60°N).
  const CELL = 0.005;
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const grid = new Map();
  for (const r of rawLibs) {
    if (!r.name || r.lat == null) continue;
    const k = cellKey(r.lat, r.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }

  const pairs = [];
  for (const un of rawLibs) {
    if (un.name || un.lat == null) continue;
    const ci = Math.floor(un.lat / CELL), cj = Math.floor(un.lon / CELL);
    let best = null, others = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const nm of grid.get(`${ci + di}:${cj + dj}`) || []) {
        const dist = haversineM(un.lat, un.lon, nm.lat, nm.lon);
        if (dist > radiusM) continue;
        if (!best || dist < best.dist) {
          if (best) others++;
          best = { named: nm, dist };
        } else {
          others++;
        }
      }
    }
    if (best) pairs.push({ un, named: best.named, dist: best.dist, others });
  }
  return pairs;
}

// Parse Overpass `out geom` way elements into closed rings, keyed 'w<id>'.
// Rings are [[lon, lat], …]. Open ways are dropped – a building outline is
// always closed, and no ring simply means no containment claim.
export function wayRings(elements) {
  const rings = new Map();
  for (const el of elements || []) {
    if (el.type !== 'way') continue;
    const pts = (el.geometry || []).filter(Boolean).map(g => [g.lon, g.lat]);
    if (pts.length >= 4 &&
        pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      rings.set('w' + el.id, pts);
    }
  }
  return rings;
}

// Ray-cast point-in-polygon against one closed ring of [lon, lat] pairs.
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// True when the pair is a verified containment: one side is a way whose ring
// holds the other side's point (for a way that point is its centroid, which is
// inside for any building-shaped outline). Pairs involving no way – or ways
// whose rings weren't fetched – stay proximity-only.
export function pairContained(pair, rings) {
  const holds = (wayLib, ptLib) => {
    if (wayLib.type[0] !== 'w') return false;
    const ring = rings.get('w' + wayLib.id);
    return !!ring && pointInRing(ptLib.lon, ptLib.lat, ring);
  };
  return holds(pair.un, pair.named) || holds(pair.named, pair.un);
}
