#!/usr/bin/env node
// augment-state.mjs — generate IMLS PLS augmentation data for one or more states
// and inject it into data/qa-data.json's `augment[]`, for testing/previewing the
// augmentation page without a full national build.
//
// Unlike build-qa.mjs (which reads OSM from Layercake via DuckDB), this derives
// each state's systems straight from the committed qa-data.json `libs`/`systems`
// (no DuckDB needed) and fetches current tags from a dev Overpass instance —
// resolved like refresh-systems.mjs: OVERPASS_URL env, else a .overpass-url file.
//
// It reuses the exact production suggestion logic (pls-match + pls-augment), so
// the emitted shape matches what the full build produces.
//
// Usage:
//   node scripts/augment-state.mjs WA              # one state
//   node scripts/augment-state.mjs WA OR CA        # several
//   node scripts/augment-state.mjs --all           # every state (long-running)
//   OVERPASS_URL=https://my-overpass/api/interpreter node scripts/augment-state.mjs WA
//
// Notes:
//   • ACCUMULATES into augment[]: systems for the requested states are merged
//     into whatever's already committed (matched by sysKey, so re-running a state
//     refreshes just its systems). Pass --replace to start from an empty augment[]
//     (drops states you don't list this run). Everything outside augment[] is
//     preserved. Re-runnable.
//   • States are 2-letter PLS/USPS codes (WA, MN, …). qa-data.json stores full
//     state NAMES, so we map via a small lookup.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexPls, classify } from './pls-match.mjs';
import { suggestTagsForOutlet, isPreciseGeocode, titleCase } from './pls-augment.mjs';
import { serializeLinewise } from './build-qa.mjs';
import { overpassEndpoint } from './overpass-source.mjs';
import { country } from '../js/countries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QA_FILE = join(ROOT, 'data', 'qa-data.json');
const PLS_FILE = join(ROOT, 'data', 'pls-outlets.json');
const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; state augment)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLEEP_MS = Number(process.env.AUGMENT_SLEEP_MS || 800);

// 2-letter code -> full state name (matches qa-data.json `states`). Only the
// states we might scope to are needed, but the full list keeps it reusable.
const STATE_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

const MIN_LIBS_FOR_PLS = 3;   // same threshold as build-qa.mjs's PLS matching

// Fetch a system's libraries with FULL current tags from the dev Overpass,
// US-scoped. Returns [{ id, name, lat, lon, tags }] or null on failure.
async function fetchSystemTags(endpoint, mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = mode === 'wikidata' ? `["operator:wikidata"="${esc}"]` : `["operator"="${esc}"]`;
  const q = `[out:json][timeout:90];\narea(${country('US').areaId})->.us;\nnwr${sel}[amenity=library](area.us);\nout center tags;`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: 'data=' + encodeURIComponent(q)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    return (json.elements || []).map(e => {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null || lon == null) return null;
      return { id: e.type[0] + e.id, name: e.tags?.name || '', lat, lon, tags: e.tags || {} };
    }).filter(Boolean);
  } catch (e) {
    console.warn(`  overpass failed for ${value}: ${e.message}`);
    return null;
  }
}

// Build augment entries for ONE state. Returns { entries, crosswalked, queried,
// skipped }. Pure of file I/O — the driver handles accumulation + writing.
async function augmentState(code, ctx) {
  const { qa, plsIndex, plsData, endpoint, crosswalk } = ctx;
  const stateName = STATE_NAME[code];
  const stateIdx = qa.states.indexOf(stateName);
  if (stateIdx < 0) {
    console.warn(`  ! "${stateName}" not present in qa-data.json states — skipping.`);
    return { entries: [], crosswalked: 0, queried: 0, skipped: 0 };
  }

  // Library-row accessors: [sysKey, type, id, name, stateIdx, flags, lon, lat].
  const L = { sys: 0, name: 3, state: 4, lon: 6, lat: 7 };

  // Systems that have libraries in this state, with their OSM coords (from the
  // committed extract) so we can crosswalk to PLS exactly like build-qa does.
  const sysByKey = new Map(qa.systems.map(s => [s.k ?? s.n, s]));
  const bySys = new Map();       // sysKey -> [{ lat, lon }]
  for (const l of qa.libs) {
    if (l[L.state] !== stateIdx) continue;
    const key = l[L.sys];
    if (key == null || !sysByKey.has(key)) continue;   // libraries with no operator/wikidata key
    if (!bySys.has(key)) bySys.set(key, []);
    bySys.get(key).push({ lat: l[L.lat], lon: l[L.lon] });
  }
  const candidates = [...bySys.entries()].filter(([, coords]) => coords.length >= MIN_LIBS_FOR_PLS);
  console.log(`\n${code} (${stateName}): ${bySys.size} systems here, ${candidates.length} crosswalk candidates.`);

  const entries = [];
  let queried = 0, crosswalked = 0, skipped = 0;

  for (const [sysKey, osmCoords] of candidates) {
    const sys = sysByKey.get(sysKey);
    const cw = crosswalk(plsIndex, sys.n, code, osmCoords);
    if (!cw) continue;
    crosswalked++;

    const qid = sys.w || null;
    const qidConfirmed = !!sys.w;
    const suggestQid = qid || sys.sw || null;
    const mode = sys.w ? 'wikidata' : 'operator';
    const value = sys.w || sys.n;

    queried++;
    const osmLibs = await fetchSystemTags(endpoint, mode, value);
    await sleep(SLEEP_MS);
    if (!osmLibs) { skipped++; continue; }

    const plsSystem = plsIndex.byKey.get(cw.fscskey);
    const cls = classify(plsSystem.outlets, osmLibs, sys.n, null);
    const osmById = new Map(osmLibs.map(o => [o.id, o]));

    // Augment existing matched OSM libraries only (fill blanks + flag conflicts);
    // creating missing branches is the QA page's job.
    const branches = [];
    for (const pair of cls.matchedPairs) {
      const osm = osmById.get(pair.o.id);
      if (!osm) continue;
      const { tags, conflicts } = suggestTagsForOutlet(pair.p, suggestQid, osm.tags, {
        allowAddr: isPreciseGeocode(pair.p), qidConfirmed
      });
      if (Object.keys(tags).length === 0 && conflicts.length === 0) continue;
      branches.push({
        osm: pair.o.id, lat: osm.lat, lon: osm.lon,
        plsName: titleCase(pair.p.name), dist: pair.dist, tags, conflicts
      });
    }

    if (!branches.length) continue;
    entries.push({ sysKey, fscskey: cw.fscskey, state: plsSystem.state, qid: suggestQid, qidConfirmed, branches });
    console.log(`  ✓ ${sys.n}: ${branches.length} suggestions`);
  }

  console.log(`  ${code}: ${crosswalked} crosswalked, ${queried} queried, ${skipped} skipped, ${entries.length} with findings.`);
  return { entries, crosswalked, queried, skipped };
}

async function main() {
  const raw = process.argv.slice(2);
  const replace = raw.includes('--replace');
  const wantsAll = raw.includes('--all');
  const codes = wantsAll
    ? Object.keys(STATE_NAME)
    : raw.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

  if (!codes.length) {
    console.error('Usage: node scripts/augment-state.mjs <STATE...> | --all  [--replace]');
    console.error('  e.g. node scripts/augment-state.mjs WA OR CA');
    process.exit(1);
  }
  const bad = codes.filter(c => !STATE_NAME[c]);
  if (bad.length) { console.error(`Unknown state code(s): ${bad.join(', ')}`); process.exit(1); }

  const endpoint = overpassEndpoint({ required: true });
  const qa = JSON.parse(readFileSync(QA_FILE, 'utf8'));
  const plsData = JSON.parse(readFileSync(PLS_FILE, 'utf8'));
  const plsIndex = indexPls(plsData.outlets);
  const { crosswalk } = await import('./pls-match.mjs');
  const ctx = { qa, plsIndex, plsData, endpoint, crosswalk };

  // Never print the endpoint — it may be a private (secret) instance URL.
  console.log(`Augmenting ${codes.length} state(s): ${codes.join(', ')}${replace ? '  (--replace: dropping existing augment[])' : ''}`);

  // Start from committed augment[] (accumulate) unless --replace. Keyed by sysKey
  // so re-running a state refreshes just its systems, and states not touched this
  // run are preserved. (A key survives a full rebuild; an array index would not.)
  const bySysKey = new Map();
  if (!replace) for (const a of (qa.augment || [])) bySysKey.set(a.sysKey, a);

  let totCrosswalked = 0, totQueried = 0, totSkipped = 0;
  for (const code of codes) {
    // Drop this state's previous entries first, so a system that no longer has
    // findings doesn't linger from an earlier run.
    for (const [k, v] of bySysKey) if (v.state === code) bySysKey.delete(k);
    const { entries, crosswalked, queried, skipped } = await augmentState(code, ctx);
    for (const e of entries) bySysKey.set(e.sysKey, e);
    totCrosswalked += crosswalked; totQueried += queried; totSkipped += skipped;
  }

  // Same key order the full build writes, so the two paths produce comparable files.
  const augment = [...bySysKey.values()]
    .sort((a, b) => (a.sysKey < b.sysKey ? -1 : a.sysKey > b.sysKey ? 1 : 0));
  const totalBranches = augment.reduce((n, a) => n + a.branches.length, 0);
  const states = [...new Set(augment.map(a => a.state))].sort();

  qa.augment = augment;
  if (!qa.meta.plsFiscalYear && plsData.meta?.fiscalYear) qa.meta.plsFiscalYear = plsData.meta.fiscalYear;
  // Same one-record-per-line format as the full build, so diffs stay reviewable.
  writeFileSync(QA_FILE, serializeLinewise(qa));

  console.log(`\n──────────`);
  console.log(`Ran ${codes.length} state(s): ${totCrosswalked} crosswalked, ${totQueried} queried, ${totSkipped} skipped.`);
  console.log(`augment[] now: ${augment.length} systems across ${states.length} state(s) [${states.join(', ')}], ${totalBranches} branches -> ${QA_FILE}`);
  console.log('Reload augment.html to test. (Re-run build:qa to regenerate the real dataset.)');
}

main().catch(e => { console.error(e); process.exit(1); });
