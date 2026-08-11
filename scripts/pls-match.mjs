// pls-match.mjs — match IMLS PLS outlets to OSM libraries per library system.
//
// Two stages:
//   1. crosswalk: map each OSM system (operator name/wikidata) to a PLS FSCSKEY,
//      by name similarity within the same state.
//   2. classify: for each matched system, sort its PLS outlets into
//      matched / untagged-in-OSM / truly-missing / location-discrepancy, using
//      spatial + operator-aware name matching (see the KCLS/LAPL prototype).
//
// Consumed by build-qa.mjs; pure functions, no I/O.

export function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// System-name normalization for the crosswalk (drop generic words + punctuation).
function normSystem(s) {
  return (s || '').toLowerCase()
    .replace(/[.,'@&-]/g, ' ')
    .replace(/\b(library|libraries|system|public|the|of|county|district|regional|free|memorial)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokenSet(s) { return new Set(s.split(' ').filter(Boolean)); }
// symmetric Jaccard for system names
function systemSim(a, b) {
  const ta = tokenSet(normSystem(a)), tb = tokenSet(normSystem(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Outlet-name normalization, aware of the operator (OSM often bakes it into the
// name, e.g. "Palisades Branch Los Angeles Public Library").
function normOutlet(name, operatorTokens) {
  let t = ' ' + (name || '').toLowerCase().replace(/[.,'@&-]/g, ' ') + ' ';
  for (const w of operatorTokens) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  return t.replace(/\b(library|libraries|branch|regional|memorial|public|the|of|at|express|connection|jr|sr|system)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// asymmetric: fraction of the smaller token set covered by the larger
function outletSim(a, b, opTokens) {
  const ta = tokenSet(normOutlet(a, opTokens)), tb = tokenSet(normOutlet(b, opTokens));
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let inter = 0; for (const t of small) if (big.has(t)) inter++;
  return inter / small.size;
}

// Build FSCSKEY -> [outlets] and a state-indexed list of PLS systems.
export function indexPls(outlets) {
  const byKey = new Map();          // fscskey -> { name, state, outlets: [] }
  for (const o of outlets) {
    let s = byKey.get(o.fscskey);
    if (!s) { s = { fscskey: o.fscskey, name: o.system, state: o.state, outlets: [] }; byKey.set(o.fscskey, s); }
    s.outlets.push(o);
  }
  const byState = new Map();        // state -> [system]
  for (const s of byKey.values()) {
    if (!byState.has(s.state)) byState.set(s.state, []);
    byState.get(s.state).push(s);
  }
  return { byKey, byState };
}

// Spatial agreement (m) between a PLS system's outlets and a set of OSM library
// coordinates: the SMALLER of the two directional median nearest-neighbor
// distances. Small = these are the same system. Each direction alone has a
// blind spot that rejects true matches:
//   outlets → OSM: penalizes incomplete OSM mapping — exactly the systems the
//     missing-branch report exists to find (Timberland Regional: 14 of 29
//     outlets mapped pushed this median to 5.7km, past the gate);
//   OSM → outlets: penalizes OSM operator tags that span more than the PLS
//     system (federated members tagged with the central system, e.g. Onondaga).
// Either direction agreeing means the systems overlap; ranking candidates by
// the same value still lets the true system beat a nearby same-name one
// (East vs West Baton Rouge), since the true one agrees at ~tens of meters.
function spatialAgreement(plsOutlets, osmCoords) {
  if (!osmCoords.length || !plsOutlets.length) return Infinity;
  const medianNearest = (from, to) => {
    const dists = from.map(a => {
      let min = Infinity;
      for (const b of to) { const d = haversineM(a.lat, a.lon, b.lat, b.lon); if (d < min) min = d; }
      return min;
    }).sort((x, y) => x - y);
    return dists[Math.floor(dists.length / 2)];
  };
  return Math.min(medianNearest(plsOutlets, osmCoords), medianNearest(osmCoords, plsOutlets));
}

// Match an OSM system to a PLS FSCSKEY. Name similarity proposes candidates; a
// spatial check confirms — a PLS system whose outlets sit near the OSM system's
// libraries is the right one even when names are worded differently, and a high
// name score on a geographically distant system is rejected. Returns
// { fscskey, plsName, sim, spatialM } or null.
//
// osmSystemName: one name or an array of candidate names — the OSM operator
//   name plus any Wikidata label/aliases (PLS often uses an official name OSM
//   doesn't, e.g. "NCW Libraries" vs "North Central Regional Library"); a PLS
//   candidate scores on its best-matching name.
// osmCoords: this OSM system's library coordinates [{lat,lon}] (for confirmation).
export function crosswalk(plsIndex, osmSystemName, stateAbbr, osmCoords, opts = {}) {
  const { minSim = 0.55, maxSpatialM = 3000 } = opts;
  const names = Array.isArray(osmSystemName) ? osmSystemName : [osmSystemName];
  const candidates = plsIndex.byState.get(stateAbbr) || [];
  const scored = candidates
    .map(c => ({ c, sim: Math.max(...names.map(n => systemSim(n, c.name))) }))
    .filter(x => x.sim >= minSim)
    .sort((a, b) => b.sim - a.sim);
  if (!scored.length) return null;

  // Among name-plausible candidates, pick the one that is spatially closest to
  // the OSM libraries (and within maxSpatialM). This disambiguates ties like
  // "New York Public Library" vs "New York Mills Public Library".
  let best = null;
  for (const { c, sim } of scored) {
    const spatialM = spatialAgreement(c.outlets, osmCoords);
    if (spatialM <= maxSpatialM && (!best || spatialM < best.spatialM)) {
      best = { fscskey: c.fscskey, plsName: c.name, sim, spatialM: Math.round(spatialM) };
    }
  }
  return best;
}

// Classify one system's PLS outlets against its OSM libraries.
// osmLibs: [{ id, name, lat, lon }]  (this system's tagged libraries)
// nearbyLibs(lat,lon) -> nearest OSM library of ANY operator within 200m, or null
//   ({ name, operator, opwd, dist }); used to split "missing" into untagged vs new.
export function classify(plsOutlets, osmLibs, operatorName, nearbyLibs) {
  const opTokens = (operatorName || '').toLowerCase().split(/\s+/).filter(Boolean);
  const usedP = new Set(), usedO = new Set();
  const matched = [], discrepancies = [];

  // candidate pairs within 1km
  const cands = [];
  for (const p of plsOutlets) for (const o of osmLibs) {
    if (o.lat == null) continue;
    const dist = haversineM(p.lat, p.lon, o.lat, o.lon);
    if (dist > 1000) continue;
    cands.push({ p, o, dist, sim: outletSim(p.name, o.name, opTokens) });
  }
  // pass 1: spatial (close, or nearish + name)
  cands.sort((x, y) => x.dist - y.dist);
  for (const c of cands) {
    if (usedP.has(c.p.id) || usedO.has(c.o.id)) continue;
    if (c.dist <= 250 || (c.dist <= 1000 && c.sim >= 0.5)) { usedP.add(c.p.id); usedO.add(c.o.id); matched.push(c); }
  }
  // pass 2: name-rescue among leftovers (relocated / stale coords)
  const leftP = plsOutlets.filter(p => !usedP.has(p.id));
  const leftO = osmLibs.filter(o => o.lat != null && !usedO.has(o.id));
  const namePairs = [];
  for (const p of leftP) for (const o of leftO) {
    const sim = outletSim(p.name, o.name, opTokens);
    if (sim >= 0.6) namePairs.push({ p, o, dist: haversineM(p.lat, p.lon, o.lat, o.lon), sim });
  }
  namePairs.sort((a, b) => b.sim - a.sim || a.dist - b.dist);
  for (const c of namePairs) {
    if (usedP.has(c.p.id) || usedO.has(c.o.id)) continue;
    usedP.add(c.p.id); usedO.add(c.o.id);
    discrepancies.push({ p: c.p, osmId: c.o.id, osmLat: c.o.lat, osmLon: c.o.lon, dist: Math.round(c.dist) });
  }

  // remaining PLS outlets: split untagged (exists in OSM, any operator) vs missing
  const untagged = [], missing = [];
  for (const p of plsOutlets) {
    if (usedP.has(p.id)) continue;
    const near = nearbyLibs ? nearbyLibs(p.lat, p.lon) : null;
    if (near) untagged.push({ p, near });
    else missing.push(p);
  }

  return {
    plsCount: plsOutlets.length,
    matched: matched.length,
    matchedPairs: matched.map(c => ({ p: c.p, o: c.o, dist: Math.round(c.dist) })), // PLS outlet ↔ its OSM library
    untagged,      // [{ p, near }]
    missing,       // [ outlet ]
    discrepancies  // [{ p, osmId, dist }]
  };
}
