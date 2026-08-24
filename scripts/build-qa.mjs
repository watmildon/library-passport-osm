#!/usr/bin/env node
// build-qa.mjs — regenerate data/qa-data.json for the Data QA page.
//
// PRIMARY source: an Overpass instance (OVERPASS_URL env var or a gitignored
// .overpass-url file — see overpass-source.mjs). Two queries fetch every US
// library with full tags plus a per-state assignment; collisions are computed
// here in JS. Overpass carries addr:* (absent from Layercake's POI layer), so
// the address flags below only exist on this path.
//
// FALLBACK source (no endpoint configured, or --layercake): OpenStreetMap US's
// Layercake extract via scripts/qa-libraries.sql and the DuckDB CLI (remote
// GeoParquet over HTTP; requires DuckDB on PATH or the DUCKDB env var). No
// addr:* flags — meta.tags records which flags a build actually tracked.
//
// Output, one compact file the QA page loads client-side:
//
//   meta        generated date, source + snapshot date, totals
//   tags        the tag names behind each bit of a library's flags bitmask
//   states      state names (libs reference them by index)
//   systems     { n: name, k?: key, w: wikidata|null, c: count }, sorted by key
//   libs        [sysKey, type, id, name, stateIdx, flags, lon, lat]
//   collisions  likely-typo operator name pairs (small Levenshtein distance)
//   unnamedPairs unnamed libraries with a named library on the same footprint
//   wdOperators operator suggestions read from each library's own wikidata= item
//   wdConflicts libraries whose operator:wikidata disagrees with that item
//
// Flags bitmask: 1 phone, 2 website, 4 opening_hours, 8 operator,
//                16 operator:wikidata, and (Overpass builds only)
//                32 addr:housenumber, 64 addr:street, 128 addr:city,
//                256 addr:postcode.
//
// Usage:  node scripts/build-qa.mjs [--force] [--layercake]

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { layercakeModified, toISODate, committedSourceDate } from './systems-core.mjs';
import { overpassEndpoint, overpassTimestamp, fetchLibraryElements, fetchStateAssignments } from './overpass-source.mjs';
import { country } from '../js/countries.js';
import { indexPls, crosswalk, classify, haversineM } from './pls-match.mjs';
import { suggestTagsForOutlet, isPreciseGeocode, titleCase } from './pls-augment.mjs';
import { findUnnamedPairs, wayRings, pairContained } from './unnamed-pairs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SQL_FILE = join(HERE, 'qa-libraries.sql');
const DUCKDB = process.env.DUCKDB || 'duckdb';
const FORCE = process.argv.includes('--force');
const USE_LAYERCAKE = process.argv.includes('--layercake');
// Per-country build: --country=CA writes data/ca-qa-data.json. Countries
// without an outlets census (see js/countries.js) skip the PLS matching and
// augment stages; everything else works the same.
const countryArg = process.argv.find(a => a.startsWith('--country='));
const COUNTRY = country((countryArg ? countryArg.split('=')[1] : 'US').toUpperCase());
const DEST = join(ROOT, ...COUNTRY.qaFile.split('/'));
const PLS_FILE = COUNTRY.outletsFile ? join(ROOT, ...COUNTRY.outletsFile.split('/')) : null;
const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; QA build)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One entry per bit of a library's flags bitmask (bit = 1 << index); meta.tags
// records the keys so the QA page derives its columns from the data, not from
// hardcoded bit positions. The addr:* entries are only populated (and only
// listed in meta.tags) on the Overpass path — Layercake has no addr columns.
const FLAG_DEFS = [
  { key: 'phone',             has: r => !!r.has_phone },
  { key: 'website',           has: r => !!r.has_website },
  { key: 'opening_hours',     has: r => !!r.has_hours },
  { key: 'operator',          has: r => !!r.operator },
  { key: 'operator:wikidata', has: r => !!r.wikidata },
  { key: 'addr:housenumber',  has: r => !!r.has_housenumber },
  { key: 'addr:street',       has: r => !!r.has_street },
  { key: 'addr:city',         has: r => !!r.has_city },
  { key: 'addr:postcode',     has: r => !!r.has_postcode }
];
const LAYERCAKE_FLAG_COUNT = 5;   // first N FLAG_DEFS the Layercake path can fill

function queryLayercake() {
  const tmp = mkdtempSync(join(tmpdir(), 'libpass-qa-'));
  const libsFile = join(tmp, 'libs.json');
  const collFile = join(tmp, 'collisions.json');
  const sql = readFileSync(SQL_FILE, 'utf8')
    .replaceAll('{{OUT_LIBS}}', libsFile.replace(/\\/g, '/'))
    .replaceAll('{{OUT_COLL}}', collFile.replace(/\\/g, '/'));

  try {
    const res = spawnSync(DUCKDB, [], { input: sql, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (res.error) {
      if (res.error.code === 'ENOENT') {
        throw new Error(`DuckDB CLI not found (tried "${DUCKDB}"). Install it or set the DUCKDB env var.`);
      }
      throw res.error;
    }
    if (res.status !== 0) {
      throw new Error(`DuckDB exited ${res.status}:\n${res.stderr || res.stdout}`);
    }
    return {
      libs: JSON.parse(readFileSync(libsFile, 'utf8')),
      collisions: JSON.parse(readFileSync(collFile, 'utf8'))
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Overpass primary source ----------------------------------------------
//
// Same row shape as the Layercake SQL emits, so everything downstream is
// source-agnostic. Two deltas, both intentional: phone/website presence also
// count the contact:* variants (matching the QA page's live view), and the
// addr:* presence fields exist at all (Layercake's POI layer has no addr
// columns).
async function queryOverpass(endpoint) {
  console.log('Querying Overpass for per-library QA data…');
  const { elements } = await fetchLibraryElements(endpoint, COUNTRY.code);
  console.log(`  ${elements.length} ${COUNTRY.code} libraries; assigning states…`);
  const stateOf = await fetchStateAssignments(endpoint, COUNTRY.code);
  const libs = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const t = el.tags || {};
    libs.push({
      type: el.type,
      id: el.id,
      // name:en preferred: bilingual names ("Bibliothèque X / X Library") read
      // better in the English UI; most libraries only carry `name`.
      name: t['name:en'] ?? t.name ?? null,
      state: stateOf.get(el.type[0] + el.id) ?? null,
      operator: t.operator ?? null,
      wikidata: t['operator:wikidata'] ?? null,
      // The library's OWN item (not its operator's). Overpass-only: Layercake's
      // POI columns don't carry it, so the Wikidata-operator sections below are
      // empty on that path, the same way the addr:* flags are.
      selfWd: t.wikidata ?? null,
      website: t.website ?? t['contact:website'] ?? null,
      has_phone: !!(t.phone || t['contact:phone']),
      has_website: !!(t.website || t['contact:website']),
      has_hours: !!t.opening_hours,
      has_housenumber: !!t['addr:housenumber'],
      has_street: !!t['addr:street'],
      has_city: !!t['addr:city'],
      has_postcode: !!t['addr:postcode'],
      lon, lat
    });
  }
  return { libs, collisions: computeCollisions(libs) };
}

// Levenshtein distance with a cap: bails out (returning cap + 1) as soon as no
// path can come in under the cap. Distances here are tiny (cap 2), so the DP
// stays fast across the ~half-million candidate pairs.
function levenshteinCapped(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Likely-typo operator pairs — a straight port of the second half of
// qa-libraries.sql so both source paths emit identical collision rows:
// case-insensitive Levenshtein ≤ 2 (≤ 1 for names under 12 chars), lengths
// within 1, and pairs where both sides carry a *different* dominant
// operator:wikidata dropped (deliberately distinct systems, not typos).
function computeCollisions(rawLibs) {
  // Per operator name: count, any-wikidata flag, dominant wikidata (most
  // frequent; ties broken by Q-id string order, matching the SQL's ROW_NUMBER).
  const ops = new Map();
  for (const r of rawLibs) {
    if (!r.operator) continue;
    let o = ops.get(r.operator);
    if (!o) { o = { name: r.operator, cnt: 0, has_wd: false, wdVotes: new Map() }; ops.set(r.operator, o); }
    o.cnt++;
    if (r.wikidata) {
      o.has_wd = true;
      o.wdVotes.set(r.wikidata, (o.wdVotes.get(r.wikidata) || 0) + 1);
    }
  }
  const list = [...ops.values()].map(o => ({
    ...o,
    wd: [...o.wdVotes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null
  })).sort((a, b) => (a.name < b.name ? -1 : 1));

  // Bucket by name length so each name only meets candidates within ±1 char.
  const byLen = new Map();
  for (const o of list) {
    if (!byLen.has(o.name.length)) byLen.set(o.name.length, []);
    byLen.get(o.name.length).push(o);
  }

  const out = [];
  for (const a of list) {
    const cap = a.name.length >= 12 ? 2 : 1;
    const al = a.name.toLowerCase();
    for (let len = a.name.length - 1; len <= a.name.length + 1; len++) {
      for (const b of byLen.get(len) || []) {
        if (!(a.name < b.name)) continue;                       // each pair once
        if (a.wd && b.wd && a.wd !== b.wd) continue;            // distinct systems
        const lev = levenshteinCapped(al, b.name.toLowerCase(), cap);
        if (lev > cap) continue;
        out.push({ a: a.name, b: b.name, count_a: a.cnt, count_b: b.cnt,
                   a_has_wd: a.has_wd, b_has_wd: b.has_wd, lev });
      }
    }
  }
  return out;
}

// ---- not:operator / not:operator:wikidata assertions ----------------------
//
// OSM's `not:` prefix records verified negatives: not:operator:wikidata=Q123
// means a mapper confirmed the operator is definitely NOT that item (usually
// after ruling out a tempting-but-wrong match, e.g. a city entity or a
// similarly-named system). These tags aren't in Layercake's POI columns, so
// they're fetched with one tiny Overpass query. They must never be grouped as
// real values, and suggestions must never re-propose a ruled-out item.
// The configured instance (OVERPASS_URL / .overpass-url) is tried first.
const OVERPASS_ENDPOINTS = [
  ...(overpassEndpoint() ? [overpassEndpoint()] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

// Returns { wd: Map(elKey -> Set(QIDs)), op: Map(elKey -> Set(names)) } where
// elKey is `${type[0]}${id}` matching the Layercake rows. Fails soft: on total
// Overpass failure the maps are empty and suggestions are simply unfiltered.
async function fetchNotAssertions() {
  const q = `[out:json][timeout:60];
area(${COUNTRY.areaId})->.us;
(
  nwr[amenity=library]["not:operator:wikidata"](area.us);
  nwr[amenity=library]["not:operator"](area.us);
);
out tags;`;
  const wd = new Map(), op = new Map();
  for (const [i, url] of OVERPASS_ENDPOINTS.entries()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(q)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      for (const el of json.elements || []) {
        const key = el.type[0] + el.id;
        const nwd = el.tags?.['not:operator:wikidata'];
        const nop = el.tags?.['not:operator'];
        if (nwd) wd.set(key, new Set(nwd.split(';').map(s => s.trim()).filter(Boolean)));
        if (nop) op.set(key, new Set(nop.split(';').map(s => s.trim()).filter(Boolean)));
      }
      return { wd, op };
    } catch (e) {
      // By position, never by URL — endpoint 0 may be the private instance.
      console.warn(`  not:-assertion fetch failed on endpoint #${i}: ${e.cause?.code ?? e.message}`);
    }
  }
  console.warn('  proceeding without not:-assertions (all Overpass endpoints failed)');
  return { wd, op };
}

// ---- Wikidata Query Service ------------------------------------------------
//
// One place for the SPARQL plumbing. Every caller here treats Wikidata as
// enrichment, never a gate: on failure we warn, return no rows, and the build
// carries on with one section thinner.
const WDQS = 'https://query.wikidata.org/sparql';
const qidOf = binding => binding.value.split('/').pop();

async function sparqlRows(query, what) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(WDQS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          'User-Agent': USER_AGENT
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return (await res.json()).results.bindings;
    } catch (e) {
      console.warn(`  Wikidata ${what} failed (${e.message})${i < 2 ? ' — retrying…' : ''}`);
      if (i < 2) await sleep(5000 * (i + 1));
    }
  }
  console.warn(`  proceeding without ${what}`);
  return null;
}

// Same, for queries that pin a VALUES list of QIDs: split into batches so one
// oversized query can't time the service out, and merge the rows. A batch that
// fails after its retries is skipped, not fatal.
const WD_BATCH = 250;
async function sparqlBatched(qids, buildQuery, what) {
  const clean = qids.filter(q => /^Q\d+$/.test(q));
  if (!clean.length) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += WD_BATCH) {
    const batch = clean.slice(i, i + WD_BATCH);
    const rows = await sparqlRows(buildQuery(batch.map(q => 'wd:' + q).join(' ')), what);
    if (rows) out.push(...rows);
    if (i + WD_BATCH < clean.length) await sleep(1000);
  }
  return out;
}

// ---- Closed libraries ------------------------------------------------------
//
// PLS lags ~2 years, so a branch that closes after the survey keeps generating
// missing/untagged findings until the next fiscal year drops it. Closure is
// recorded in OPEN DATA, never in this repo (the not:-assertion philosophy),
// and either signal alone suppresses:
//   • Wikidata: the branch item carries P3999 (date of official closure) or
//     P576 (dissolved), anchored by its P625 coordinate. Recording the closure
//     on the item — and pruning the system's P527 branch list, which self-heals
//     the branch-count pane — is the curated route.
//   • OSM: the object was retagged disused:amenity=library / was:amenity=library.
//     (A deleted object needs no signal of its own; the Wikidata route covers it.)
// A PLS outlet within CLOSED_RADIUS_M of either point is counted as closed and
// dropped from the findings; the system row carries the count.
const CLOSED_RADIUS_M = 250;

// Parse WDQS closure rows into points, defensively: closure "dates" in the wild
// include wrong-datatype values (one item carries a URL), and a FUTURE date is
// an announced closure — the branch still operates, so it keeps being flagged
// until the date passes.
export function parseWdClosures(rows, now = new Date()) {
  const out = [];
  for (const r of rows ?? []) {
    const date = r.closed?.value ?? '';
    if (!/^\d{4}/.test(date) || new Date(date) > now) continue;
    const m = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(r.coord?.value ?? '');
    if (!m) continue;
    out.push({ qid: qidOf(r.item), lon: +m[1], lat: +m[2] });
  }
  return out;
}

async function fetchWikidataClosures() {
  const rows = await sparqlRows(`SELECT ?item ?closed ?coord WHERE {
  VALUES ?cls { wd:Q11396180 wd:Q28564 wd:Q856584 }
  ?item wdt:P31 ?cls .
  ?item wdt:P17 wd:${COUNTRY.wikidataQid} .
  { ?item wdt:P3999 ?closed } UNION { ?item wdt:P576 ?closed }
  ?item wdt:P625 ?coord .
}`, 'closure fetch');
  return parseWdClosures(rows);
}

// Former libraries still mapped in OSM under a lifecycle prefix. Fails soft.
async function fetchOsmClosedLibraries() {
  const q = `[out:json][timeout:60];
area(${COUNTRY.areaId})->.us;
(
  nwr["disused:amenity"=library](area.us);
  nwr["was:amenity"=library](area.us);
);
out center;`;
  for (const [i, url] of OVERPASS_ENDPOINTS.entries()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(q)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return ((await res.json()).elements || [])
        .map(el => ({ lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon }))
        .filter(p => p.lat != null);
    } catch (e) {
      console.warn(`  closed-library fetch failed on endpoint #${i}: ${e.cause?.code ?? e.message}`);
    }
  }
  console.warn('  proceeding without OSM lifecycle closures');
  return [];
}

// ---- Unnamed libraries with a named twin -----------------------------------
//
// A common duplicate mapping: the building carries amenity=library with no
// name while a node inside it holds the name – or the reverse. Pair every
// unnamed library with the nearest named one within 150 m (see
// unnamed-pairs.mjs), then verify real containment against the building
// outlines where a way is involved. The name already exists on the other
// object, so these are the quickest naming fixes the QA page can offer.

// Outlines for the ways involved in pairs – one id-list query, a couple
// hundred ways. Fails soft like every other auxiliary fetch: no outlines just
// leaves the pairs proximity-only (dist without the `in` mark).
async function fetchPairWayRings(wayIds) {
  if (!wayIds.length) return new Map();
  const q = `[out:json][timeout:120];\nway(id:${wayIds.join(',')});\nout geom;`;
  for (const [i, url] of OVERPASS_ENDPOINTS.entries()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(q)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return wayRings((await res.json()).elements);
    } catch (e) {
      console.warn(`  pair-outline fetch failed on endpoint #${i}: ${e.cause?.code ?? e.message}`);
    }
  }
  console.warn('  proceeding without building outlines (pairs stay proximity-only)');
  return new Map();
}

// Rows are written in stable osm-key order (the daily diff must not churn when
// a distance wobbles); the QA page sorts contained-first at render time.
async function buildUnnamedPairs(rawLibs, stateIdx) {
  const pairs = findUnnamedPairs(rawLibs);
  if (!pairs.length) return [];
  const wayIds = [...new Set(pairs.flatMap(p =>
    [p.un, p.named].filter(l => l.type[0] === 'w').map(l => l.id)))];
  const rings = await fetchPairWayRings(wayIds);
  const round4 = x => Math.round(x * 1e4) / 1e4;
  return pairs.map(p => ({
    osm: p.un.type[0] + p.un.id,
    st: (p.un.state ? stateIdx.get(p.un.state) : -1) ?? -1,
    lon: round4(p.un.lon),
    lat: round4(p.un.lat),
    match: {
      osm: p.named.type[0] + p.named.id,
      n: p.named.name,
      ...(p.named.operator ? { op: p.named.operator } : {}),
      lon: round4(p.named.lon),
      lat: round4(p.named.lat),
      dist: Math.round(p.dist),
      ...(pairContained(p, rings) ? { in: 1 } : {})
    },
    ...(p.others ? { others: p.others } : {})
  })).sort((a, b) => a.osm.localeCompare(b.osm));
}

// Drop findings that sit on a closure signal; returns how many were dropped.
// Mutates cls.missing / cls.untagged in place. Matched and discrepancy entries
// are left alone — those have a live OSM object, so "closed" is a question for
// the mapper, not this pass.
export function suppressClosedFindings(cls, nearClosure) {
  let closed = 0;
  const keepM = [], keepU = [];
  for (const o of cls.missing) { if (nearClosure(o.lat, o.lon)) closed++; else keepM.push(o); }
  for (const u of cls.untagged) { if (nearClosure(u.p.lat, u.p.lon)) closed++; else keepU.push(u); }
  cls.missing = keepM;
  cls.untagged = keepU;
  return closed;
}

// ---- Wikidata branch counts ----------------------------------------------
//
// Many US library-system items on Wikidata list their branches (P527 "has part"
// entries typed as library branch). Comparing that count against the OSM branch
// count is a completeness hint in both directions: fewer in OSM suggests
// unmapped branches; more suggests duplicates in OSM or a stale Wikidata list.
async function fetchWikidataBranchCounts() {
  const rows = await sparqlRows(`SELECT ?system (COUNT(?branch) AS ?count) WHERE {
  ?system wdt:P31 wd:Q26271642.
  ?system wdt:P17 wd:${COUNTRY.wikidataQid}.
  ?system wdt:P527 ?branch.
  ?branch wdt:P31 wd:Q11396180.
} GROUP BY ?system`, 'branch-count fetch');
  const out = new Map();
  for (const r of rows ?? []) out.set(qidOf(r.system), Number(r.count.value));
  return out;
}

// ---- Wikidata alias names -------------------------------------------------
//
// OSM operator names sometimes differ from the official name PLS uses (e.g.
// operator=NCW Libraries vs PLS "NORTH CENTRAL REGIONAL LIBRARY") — sinking the
// name-similarity crosswalk even though operator:wikidata identifies the system
// exactly. Wikidata's English label + aliases bridge the gap: fetched for every
// confirmed QID and offered as extra name candidates to the crosswalk (the
// spatial gate still confirms every match). Also flags academic institutions
// (instance of a higher-education institution, transitively): PLS is a census
// of PUBLIC libraries, and university systems carry dangerously generic aliases
// (UW–Milwaukee's include plain "Milwaukee") — the crosswalk skips them.
// Returns Map(qid -> { names: [..], academic: bool }); fails soft to empty.
async function fetchWikidataAliases(qids) {
  // Tag values aren't always clean QIDs (semicolon lists, literal names typed
  // into operator:wikidata) — sparqlBatched drops anything malformed, which
  // would otherwise 400 the whole query.
  const rows = await sparqlBatched(qids, values => `SELECT ?item ?name ?academic WHERE {
  VALUES ?item { ${values} }
  { ?item rdfs:label ?name . FILTER(LANG(?name) = "en") }
  UNION
  { ?item skos:altLabel ?name . FILTER(LANG(?name) = "en") }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q38723 } AS ?academic)
}`, 'alias fetch');
  const out = new Map();
  for (const r of rows) {
    const qid = qidOf(r.item);
    if (!out.has(qid)) out.set(qid, { names: [], academic: false });
    const e = out.get(qid);
    e.names.push(r.name.value);
    if (r.academic?.value === 'true') e.academic = true;
  }
  return out;
}

// ---- Wikidata: who operates this branch? ----------------------------------
//
// A library's OWN `wikidata=` item usually names the system it belongs to —
// "Angeles Mesa Branch" (Q4762622) records parent organization = Los Angeles
// Public Library. That single fact drives two checks:
//
//   • branches with no operator tag at all get a sourced suggestion, and
//   • branches whose operator:wikidata disagrees with their item get flagged.
//
// P137 (operator) is the most direct statement but is rarely used; P749 (parent
// organization) and P361 (part of) carry almost all of the signal, so all three
// are read and ranked. Returns Map(branchQid -> [{ prop, q, label }]) ordered
// best-first. Callers must still check the target looks like an operator —
// P361 in particular is also used for buildings, campuses and historic
// districts ("part of Beacon Hill"), which are not operators.
const PARENT_PROPS = { P137: 0, P749: 1, P361: 2 };

async function fetchBranchOperators(qids) {
  const rows = await sparqlBatched(qids, values => `SELECT ?item ?prop ?parent ?parentLabel WHERE {
  VALUES ?item { ${values} }
  VALUES ?prop { wdt:P137 wdt:P749 wdt:P361 }
  ?item ?prop ?parent .
  OPTIONAL { ?parent rdfs:label ?parentLabel . FILTER(LANG(?parentLabel) = "en") }
}`, 'branch-operator fetch');

  const out = new Map();
  for (const r of rows) {
    const item = qidOf(r.item);
    if (!out.has(item)) out.set(item, []);
    out.get(item).push({ prop: qidOf(r.prop), q: qidOf(r.parent), label: r.parentLabel?.value ?? '' });
  }
  for (const cands of out.values()) {
    cands.sort((a, b) => PARENT_PROPS[a.prop] - PARENT_PROPS[b.prop] || (a.q < b.q ? -1 : 1));
  }
  return out;
}

// ---- Wikidata: what KIND of thing is this item? ---------------------------
//
// Two jobs. First, a filter: only an organization can be an operator, so a
// suggestion is only offered when the proposed item is one. Second, an
// explanation: the most common operator:wikidata mistake is tagging the place
// or its government ("San Diego", "City of San Diego") where a specific library
// entity exists ("San Diego Public Library"), and naming that mistake is what
// makes the finding actionable rather than just a disagreement.
//
// Kinds are ordered most- to least-specific; the first match wins, so a library
// network that is also (pedantically) an organization reads as "libnet".
const ENTITY_KINDS = [
  { kind: 'libnet',     root: 'Q26271642' },  // library network
  { kind: 'library',    root: 'Q7075'     },  // library
  { kind: 'university', root: 'Q3918'     },  // university
  { kind: 'school',     root: 'Q3914'     },  // school
  // Place before government: a city is a subclass of both ("charter city" leads
  // to each), and "San Diego" is more usefully described as a place than as a
  // government. A government BODY ("City of San Diego") isn't a settlement, so
  // it still falls through to 'gov'.
  { kind: 'place',      root: 'Q486972'   },  // human settlement
  { kind: 'gov',        root: 'Q7188'     },  // government
  { kind: 'admin',      root: 'Q56061'    },  // administrative territorial entity
  { kind: 'org',        root: 'Q43229'    }   // organization
];
// Only these can operate a library, so only these are ever suggested. The rest
// ('gov', 'place', 'admin', 'other') exist to describe a value that IS tagged —
// a place or its government sitting in operator:wikidata is the mistake this
// pass is looking for, not a suggestion it would ever make.
const OPERATORLIKE = new Set(['libnet', 'library', 'university', 'school', 'org']);

// Returns Map(qid -> { kind, label }). An item we can't classify gets kind
// 'other', which is never suggested and never flagged — silence beats a guess.
//
// Deliberately two cheap queries rather than one obvious `P31/P279*` per item:
// walking the subclass tree for thousands of items times WDQS out, but the same
// items only use a few hundred DISTINCT classes, so the tree is walked once per
// class instead of once per item.
async function fetchEntityKinds(qids) {
  const itemRows = await sparqlBatched(qids, values => `SELECT ?item ?itemLabel ?cls WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }
  OPTIONAL { ?item wdt:P31 ?cls }
}`, 'entity-class fetch');

  const labels = new Map();
  const itemClasses = new Map();   // qid -> Set(class qid)
  for (const r of itemRows) {
    const q = qidOf(r.item);
    if (r.itemLabel) labels.set(q, r.itemLabel.value);
    if (!itemClasses.has(q)) itemClasses.set(q, new Set());
    if (r.cls) itemClasses.get(q).add(qidOf(r.cls));
  }

  const classes = [...new Set([...itemClasses.values()].flatMap(s => [...s]))];
  const classRows = await sparqlBatched(classes, values => `SELECT ?cls ?root WHERE {
  VALUES ?cls { ${values} }
  VALUES ?root { ${ENTITY_KINDS.map(k => 'wd:' + k.root).join(' ')} }
  ?cls wdt:P279* ?root .
}`, 'class-hierarchy fetch');

  const classRoots = new Map();
  for (const r of classRows) {
    const c = qidOf(r.cls);
    if (!classRoots.has(c)) classRoots.set(c, new Set());
    classRoots.get(c).add(qidOf(r.root));
  }

  const out = new Map();
  for (const [q, cs] of itemClasses) {
    const roots = new Set();
    for (const c of cs) for (const root of classRoots.get(c) ?? []) roots.add(root);
    const hit = ENTITY_KINDS.find(k => roots.has(k.root));
    out.set(q, { kind: hit?.kind ?? 'other', label: labels.get(q) ?? '' });
  }
  return out;
}

async function main() {
  // Source selection: the configured Overpass instance is primary; Layercake/
  // DuckDB is the fallback (no endpoint, or --layercake). Either way the
  // source's snapshot timestamp gates the whole rebuild: skip if the committed
  // QA dataset already comes from an equal-or-newer source.
  const endpoint = USE_LAYERCAKE ? null : overpassEndpoint();
  if (!endpoint && COUNTRY.code !== 'US') {
    throw new Error(`The Layercake fallback is US-only (US data extract); a ${COUNTRY.code} build needs a configured Overpass endpoint.`);
  }
  const sourceName = endpoint ? 'Overpass' : 'Layercake';
  const sourceModified = endpoint ? await overpassTimestamp(endpoint) : await layercakeModified();
  const sourceDate = toISODate(sourceModified);
  if (!sourceDate) throw new Error(`Could not read the ${sourceName} data timestamp — aborting.`);

  const committed = committedSourceDate(DEST);
  if (!FORCE && committed && committed >= sourceDate) {
    console.log(`Committed QA data source ${committed} is not older than ${sourceName} ${sourceDate} — nothing to do. (Use --force to override.)`);
    return;
  }

  let rawLibs, rawColl;
  if (endpoint) {
    ({ libs: rawLibs, collisions: rawColl } = await queryOverpass(endpoint));
  } else {
    console.log('Querying Layercake (via DuckDB) for per-library QA data…');
    ({ libs: rawLibs, collisions: rawColl } = queryLayercake());
  }
  console.log(`  ${rawLibs.length} ${COUNTRY.code} libraries, ${rawColl.length} possible name collisions`);

  // The addr:* flags only exist on the Overpass path; meta.tags records which
  // flags this build actually tracked so the QA page derives columns from data.
  const flagDefs = endpoint ? FLAG_DEFS : FLAG_DEFS.slice(0, LAYERCAKE_FLAG_COUNT);

  // Deterministic order: source output order varies between runs (DuckDB's
  // parallel GROUP BY, Overpass's block order), which would rewrite the whole
  // committed file every run even with no data change. Sorting here keeps git
  // diffs limited to real changes.
  rawLibs.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

  console.log('Fetching not:operator assertions from Overpass…');
  const notAssert = await fetchNotAssertions();
  console.log(`  ${notAssert.wd.size} not:operator:wikidata, ${notAssert.op.size} not:operator elements`);

  if (rawLibs.length < COUNTRY.minLibraries) {
    throw new Error(`Only ${rawLibs.length} libraries returned (expected >= ${COUNTRY.minLibraries}) — refusing to write a gutted dataset.`);
  }

  // States, indexed.
  const stateNames = [...new Set(rawLibs.map(r => r.state).filter(Boolean))].sort();
  const stateIdx = new Map(stateNames.map((s, i) => [s, i]));

  // Systems, indexed. Keyed by operator name; wikidata-only libraries get a
  // system keyed (and named) by their Q-id. The system's wikidata is the most
  // frequent non-null Q-id seen alongside that operator name.
  const sysMap = new Map(); // key -> { n, wdVotes: Map, c, libs: [], states: Map }
  const sysKey = r => r.operator ?? (r.wikidata ? `wd:${r.wikidata}` : null);
  for (const r of rawLibs) {
    const key = sysKey(r);
    if (!key) continue;
    let s = sysMap.get(key);
    if (!s) { s = { n: r.operator ?? r.wikidata, wdVotes: new Map(), c: 0, libs: [], states: new Map() }; sysMap.set(key, s); }
    s.c++;
    if (r.wikidata) s.wdVotes.set(r.wikidata, (s.wdVotes.get(r.wikidata) || 0) + 1);
    s.libs.push({ id: r.type[0] + r.id, name: r.name || '', lat: r.lat, lon: r.lon });
    if (r.state) s.states.set(r.state, (s.states.get(r.state) || 0) + 1);
  }
  //
  // Sorted by key, and everything downstream references a system BY KEY rather
  // than by array position. Position is derived data: it used to fall out of
  // first-appearance order over the library rows, so adding `operator=` to a
  // single low-id node moved that system to the front of the array and shifted
  // every index behind it — rewriting tens of thousands of otherwise-unchanged
  // rows in the daily diff. Keys only change when the tag itself changes.
  //
  // `k` is emitted only where the key differs from the display name — i.e. the
  // wikidata-keyed systems, whose name is the bare Q-id.
  const sysKeys = [...sysMap.keys()].sort();
  const systems = sysKeys.map(k => {
    const s = sysMap.get(k);
    const w = [...s.wdVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { n: s.n, ...(k === s.n ? {} : { k }), w, c: s.c };
  });

  // Domain-derived operator:wikidata suggestions for systems that lack one:
  // when a system's libraries share a website domain with wikidata-tagged
  // libraries (possibly under a differently-spelled operator), that Q-id very
  // likely applies to the whole system. Stored as `sw` (suggested wikidata).
  // A system's not:operator:wikidata assertions veto matching suggestions and
  // are surfaced as `nw` (ruled-out Q-ids).
  {
    const domainWd = new Map();   // domain -> Map(qid -> votes)
    const sysDomains = new Map(); // sysKey -> Set(domains)
    const sysNotWd = new Map();   // sysKey -> Set(ruled-out QIDs)
    for (const r of rawLibs) {
      const key = sysKey(r);
      const elNot = notAssert.wd.get(r.type[0] + r.id);
      if (key && elNot) {
        if (!sysNotWd.has(key)) sysNotWd.set(key, new Set());
        for (const q of elNot) sysNotWd.get(key).add(q);
      }
      const d = websiteDomain(r.website);
      if (!d || isGenericHost(d)) continue;
      if (r.wikidata) {
        if (!domainWd.has(d)) domainWd.set(d, new Map());
        const m = domainWd.get(d);
        m.set(r.wikidata, (m.get(r.wikidata) || 0) + 1);
      }
      if (key) {
        if (!sysDomains.has(key)) sysDomains.set(key, new Set());
        sysDomains.get(key).add(d);
      }
    }
    let suggested = 0;
    systems.forEach((s, i) => {
      const ruledOut = sysNotWd.get(sysKeys[i]);
      if (ruledOut?.size) s.nw = [...ruledOut].sort();
      if (s.w) return;
      const doms = sysDomains.get(sysKeys[i]);
      if (!doms) return;
      const votes = new Map();
      for (const d of doms) {
        const m = domainWd.get(d);
        if (m) for (const [q, n] of m) {
          if (ruledOut?.has(q)) continue;   // never re-propose a ruled-out item
          votes.set(q, (votes.get(q) || 0) + n);
        }
      }
      const top = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (top) { s.sw = top[0]; suggested++; }
    });
    console.log(`  ${suggested} wikidata-less systems got a domain-derived suggestion`);
  }

  // Wikidata branch counts, attached as `wb` where a system's Q-id has one.
  // When several of our systems share a Q-id (e.g. a typo'd operator variant
  // alongside the real one), only the principal system — the one with the most
  // branches — gets the count; comparing a 1-branch typo entry against the full
  // Wikidata list would just produce a misleading delta.
  {
    console.log('Fetching Wikidata branch counts…');
    const wdCounts = await fetchWikidataBranchCounts();
    const principal = new Map(); // qid -> system with most branches
    for (const s of systems) {
      if (s.w && wdCounts.has(s.w) && (!principal.has(s.w) || s.c > principal.get(s.w).c)) {
        principal.set(s.w, s);
      }
    }
    for (const s of principal.values()) s.wb = wdCounts.get(s.w);
    console.log(`  ${wdCounts.size} systems have counts on Wikidata; ${principal.size} matched ours`);
  }

  // Compact per-library rows.
  const libs = rawLibs.map(r => {
    let flags = 0;
    flagDefs.forEach((d, i) => { if (d.has(r)) flags |= 1 << i; });
    return [
      sysKey(r),                                // system key, or null when untagged
      r.type[0],                                // n / w / r
      r.id,
      r.name ?? null,
      r.state ? stateIdx.get(r.state) : -1,
      flags,
      // Re-round: DuckDB's ROUND on FLOAT columns leaves float32 artifacts
      // when serialized, bloating the file.
      Math.round(r.lon * 1e4) / 1e4,
      Math.round(r.lat * 1e4) / 1e4
    ];
  });

  // Normalize each pair so `a` is the more numerous side (tie: alphabetical,
  // which the SQL's a < b join already guarantees), then order deterministically
  // (the SQL ORDER BY leaves ties unordered).
  const collisions = rawColl.map(r => {
    const flip = r.count_b > r.count_a;
    return flip
      ? { a: r.b, b: r.a, ca: r.count_b, cb: r.count_a, aw: !!r.b_has_wd, bw: !!r.a_has_wd, lev: r.lev }
      : { a: r.a, b: r.b, ca: r.count_a, cb: r.count_b, aw: !!r.a_has_wd, bw: !!r.b_has_wd, lev: r.lev };
  });
  collisions.sort((x, y) => y.ca - x.ca || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  const ambiguous = findAmbiguousNames(rawLibs, stateIdx);
  console.log(`  ${ambiguous.length} operator names span multiple distinct regions`);

  const domains = findDomainClusters(rawLibs, stateIdx, notAssert);
  console.log(`  ${domains.length} website domains with operator-less libraries`);

  // ---- Unnamed libraries whose name is already mapped right next to them.
  console.log('Pairing unnamed libraries with named twins…');
  const unnamedPairs = await buildUnnamedPairs(rawLibs, stateIdx);
  console.log(`  ${unnamedPairs.length} unnamed libraries have a named library within 150 m` +
    ` (${unnamedPairs.filter(p => p.match.in).length} verified inside/containing a building outline)`);

  // ---- Wikidata labels/aliases for tagged systems: extra crosswalk name
  // candidates when the OSM operator name differs from PLS's official name.
  const wdAliases = await fetchWikidataAliases([...new Set(
    systems.filter(s => s.w).flatMap(s => s.w.split(';').map(q => q.trim())))]);
  console.log(`  ${wdAliases.size} tagged systems have Wikidata labels/aliases`);

  // ---- Wikidata-sourced operators, from each library's own item.
  const wdOps = await buildWikidataOperators(rawLibs, notAssert, systems, sysKeys, stateIdx);

  // ---- Closed-library signals: PLS lags ~2 years, so a branch closed since
  // the survey keeps generating findings unless open data says it's gone.
  console.log('Fetching closed-library signals (Wikidata + OSM lifecycle)…');
  const closures = [...await fetchWikidataClosures(), ...await fetchOsmClosedLibraries()];
  console.log(`  ${closures.length} closed-library points`);

  // ---- IMLS PLS matching: find branches missing / untagged vs the federal census.
  const pls = matchPls(rawLibs, sysMap, sysKeys, systems, stateNames, wdAliases, closures);

  // ---- IMLS PLS augmentation: per-crosswalked-system live tag fetch + suggestions.
  const augment = await buildAugment(pls, systems);

  // ---- operator:wikidata suggestions for the systems still missing one. Runs
  // last because it consolidates every source, including the PLS crosswalk.
  await suggestSystemQids(systems, sysKeys, wdOps.systemVotes, pls);

  const out = {
    meta: {
      // Deliberately generic — never record the (private) Overpass instance URL.
      source: endpoint
        ? `Overpass, ${COUNTRY.code} boundary relation ${COUNTRY.boundaryRelation}`
        : `Layercake (OpenStreetMap US), US boundary relation ${COUNTRY.boundaryRelation}`,
      generated: new Date().toISOString().slice(0, 10),
      country: COUNTRY.code,
      sourceDate,
      sourceModified,
      totalLibraries: libs.length,
      totalSystems: systems.length,
      ...(pls?.meta ? { plsFiscalYear: pls.meta.fiscalYear } : {})
    },
    tags: flagDefs.map(d => d.key),
    states: stateNames,
    systems,
    libs,
    collisions,
    ambiguous,
    domains,
    unnamedPairs,
    wdOperators: wdOps.operators,
    wdConflicts: wdOps.conflicts,
    pls: pls?.results ?? [],
    plsUnmatched: pls?.unmatched ?? [],
    augment
  };

  const json = serializeLinewise(out);
  writeFileSync(DEST, json);
  console.log(`Wrote ${libs.length} libraries, ${systems.length} systems, ${collisions.length} collisions (${Math.round(json.length / 1024)} KB) -> ${DEST}`);
}

// ---- Wikidata-sourced operators -------------------------------------------
//
// Read every library's own `wikidata=` item, resolve the organization it says
// operates it, and split the result two ways:
//
//   operators[] — the library has NO operator tag of any kind, and its item
//                 names one. A sourced, ready-to-apply suggestion. Grouped by
//                 the proposed system so a whole branch network can be worked
//                 in one pass.
//   conflicts[] — the library HAS an operator:wikidata and it disagrees with
//                 what its item says. Grouped by the (tagged → asserted) pair,
//                 because the same mistake is usually repeated across a system.
//   systemVotes — the remaining case: the library has an operator NAME but no
//                 operator:wikidata. Nothing to suggest per-library (the tag it
//                 needs is a system-level one), so each branch item instead casts
//                 a vote for its system's missing Q-id, resolved in
//                 suggestSystemQids() below.
//
// Not every conflict is an error: tagging a consortium where the item names the
// member library (or vice versa) is a real judgement call, and the page presents
// these as questions. The `tk`/`pk` entity kinds are what make them rankable —
// a place or government on the tagged side next to a library network on the
// asserted side is the specific mistake worth surfacing first.
//
// Overpass-only (Layercake has no `wikidata` column); returns empty sections
// there rather than failing.
async function buildWikidataOperators(rawLibs, notAssert, systems, sysKeys, stateIdx) {
  const empty = { operators: [], conflicts: [], systemVotes: new Map() };
  const tagged = rawLibs.filter(r => /^Q\d+$/.test(r.selfWd ?? ''));
  if (!tagged.length) {
    console.log('  no wikidata= tags in this source — skipping Wikidata-operator sections');
    return empty;
  }

  console.log(`Resolving operators from ${tagged.length} libraries' own Wikidata items…`);
  const parents = await fetchBranchOperators([...new Set(tagged.map(r => r.selfWd))]);
  if (!parents.size) return empty;

  // Classify every proposed parent (is it even an organization?) together with
  // every operator:wikidata already tagged on these libraries (so a conflict can
  // say what the tagged value actually is).
  const kinds = await fetchEntityKinds([...new Set([
    ...[...parents.values()].flat().map(c => c.q),
    ...tagged.map(r => r.wikidata).filter(Boolean)
  ])]);

  // The OSM operator name our own data already uses for a Q-id beats the
  // Wikidata label: it is what mappers actually type, so a suggestion built from
  // it matches its neighbours instead of introducing a new spelling.
  const osmNameFor = new Map();
  systems.forEach((s, i) => {
    if (!s.w || sysKeys[i].startsWith('wd:')) return;      // skip Q-id-keyed systems
    for (const q of s.w.split(';').map(x => x.trim())) {
      const prev = osmNameFor.get(q);
      if (!prev || prev.c < s.c) osmNameFor.set(q, { n: s.n, c: s.c });
    }
  });

  // Best parent for a branch item: most-direct property first, and it has to
  // look like something that can operate a library.
  const operatorOf = wd => (parents.get(wd) ?? []).find(c => OPERATORLIKE.has(kinds.get(c.q)?.kind));

  const opGroups = new Map();       // parent qid   -> group
  const conflictGroups = new Map(); // "tagged>parent" -> group
  const systemVotes = new Map();    // sysKey -> Map(qid -> { n, label })
  const row = (r, cand) => ({
    osm: r.type[0] + r.id,
    n: r.name ?? null,
    q: r.selfWd,
    s: r.state ? stateIdx.get(r.state) : -1,
    pr: cand.prop,
    lat: Math.round(r.lat * 1e4) / 1e4,
    lon: Math.round(r.lon * 1e4) / 1e4
  });

  let suggested = 0, conflicting = 0, vetoed = 0;
  for (const r of tagged) {
    const cand = operatorOf(r.selfWd);
    if (!cand) continue;
    const pk = kinds.get(cand.q)?.kind ?? 'other';
    const pn = kinds.get(cand.q)?.label || cand.label || cand.q;

    if (!r.operator && !r.wikidata) {
      // Never re-propose something a mapper explicitly ruled out on this element.
      if (notAssert.wd.get(r.type[0] + r.id)?.has(cand.q)) { vetoed++; continue; }
      let g = opGroups.get(cand.q);
      if (!g) {
        g = { pq: cand.q, pn, pk, po: osmNameFor.get(cand.q)?.n ?? null, libs: [] };
        opGroups.set(cand.q, g);
      }
      g.libs.push(row(r, cand));
      suggested++;
      continue;
    }

    // Operator name but no operator:wikidata — the gap this system needs filling.
    // The tag belongs to the whole system, so the branch votes for it rather than
    // producing a per-library suggestion.
    if (!r.wikidata) {
      if (notAssert.wd.get(r.type[0] + r.id)?.has(cand.q)) { vetoed++; continue; }
      const key = r.operator;
      if (!systemVotes.has(key)) systemVotes.set(key, new Map());
      const votes = systemVotes.get(key);
      votes.set(cand.q, { n: (votes.get(cand.q)?.n ?? 0) + 1, label: pn });
      continue;
    }

    // Only operator:wikidata can be compared item-to-item; an operator name
    // alone says nothing about which Q-id was meant.
    if (r.wikidata === cand.q) continue;
    // A semicolon list that already includes the asserted item is not a conflict.
    if (r.wikidata.split(';').map(x => x.trim()).includes(cand.q)) continue;
    const tk = kinds.get(r.wikidata)?.kind ?? 'other';
    const key = `${r.wikidata}>${cand.q}`;
    let g = conflictGroups.get(key);
    if (!g) {
      g = {
        tw: r.wikidata, tn: kinds.get(r.wikidata)?.label ?? '', tk,
        // `po` as in the suggestions above: the operator name OSM already uses
        // for the asserted item, so a correction can offer the pair of tags
        // mappers actually type rather than only the Q-id.
        pq: cand.q, pn, pk, po: osmNameFor.get(cand.q)?.n ?? null,
        libs: []
      };
      conflictGroups.set(key, g);
    }
    g.libs.push(row(r, cand));
    conflicting++;
  }

  // States each group touches, for the page's state filter.
  const withStates = g => ({
    ...g,
    st: [...new Set(g.libs.map(l => l.s).filter(s => s >= 0))].sort((a, b) => a - b)
  });
  // Key order, like every other section — see the note on pls results.
  const byKey = k => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
  const operators = [...opGroups.values()].map(withStates).sort(byKey('pq'));
  const conflicts = [...conflictGroups.values()].map(withStates)
    .sort((a, b) => (a.tw < b.tw ? -1 : a.tw > b.tw ? 1 : 0) || byKey('pq')(a, b));
  for (const g of [...operators, ...conflicts]) g.libs.sort(byKey('osm'));

  console.log(`  ${suggested} operator-less libraries got a Wikidata-sourced operator ` +
    `(${operators.length} systems)${vetoed ? `, ${vetoed} vetoed by not:operator:wikidata` : ''}`);
  console.log(`  ${conflicting} libraries disagree with their own item's operator (${conflicts.length} distinct pairs)`);
  console.log(`  ${systemVotes.size} wikidata-less systems have a branch item naming their operator`);
  return { operators, conflicts, systemVotes };
}

// ---- operator:wikidata suggestions for systems that lack one --------------
//
// Three independent sources, ranked by how directly each speaks about these
// actual libraries:
//
//   branch — the system's own libraries carry `wikidata=` items that name a
//            parent organization. A statement about these very objects, so it
//            outranks everything else.
//   fscs   — the system crosswalked to an IMLS PLS system, and some Wikidata
//            item carries that Federal-State Cooperative System ID (P6618).
//            An exact federal identifier, but reached via an inferred crosswalk.
//   domain — the pre-existing heuristic: libraries sharing a website domain with
//            wikidata-tagged libraries elsewhere. Weakest, and already computed.
//
// Every source is a suggestion, never an edit: the page marks them for review and
// `not:operator:wikidata` vetoes any that a mapper has already ruled out.
const SUGGEST_SOURCES = ['branch', 'fscs', 'domain'];

// Wikidata items carrying an FSCS ID, keyed by that ID. ~9.2k US library systems
// are catalogued this way. A key held by more than one item is a duplicate-item
// situation (the Orange County Library System / District case) — skipped rather
// than guessed at, since suggesting the wrong twin entrenches the duplicate.
async function fetchItemsByFscs(keys) {
  if (!keys.length) return new Map();
  const out = new Map();     // fscs key -> Map(qid -> label)
  for (let i = 0; i < keys.length; i += WD_BATCH) {
    const batch = keys.slice(i, i + WD_BATCH);
    const rows = await sparqlRows(`
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?itemLabel ?key WHERE {
  VALUES ?key { ${batch.map(k => JSON.stringify(k)).join(' ')} }
  ?item wdt:P6618 ?key .
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }
}`, 'FSCS-identifier fetch');
    for (const r of rows ?? []) {
      const k = r.key.value;
      if (!out.has(k)) out.set(k, new Map());
      out.get(k).set(qidOf(r.item), r.itemLabel?.value ?? '');
    }
    if (i + WD_BATCH < keys.length) await sleep(1000);
  }
  return out;
}

// Fill in `sw` (suggested Q-id), `sn` (its English label) and `ss` (which
// sources proposed it) on every system that has no operator:wikidata. Mutates
// `systems` in place; `sw` may already hold a domain-derived guess, which is
// folded in as the lowest-priority source.
async function suggestSystemQids(systems, sysKeys, systemVotes, pls) {
  // FSCS keys for wikidata-less crosswalked systems. `pls.crosswalks` covers
  // every match, not just the ones with findings.
  const fscsOf = new Map();
  for (const cw of pls?.crosswalks ?? []) fscsOf.set(cw.sysKey, cw.fscskey);
  const wanted = systems
    .map((s, i) => ({ s, key: sysKeys[i] }))
    .filter(({ s }) => !s.w)
    .filter(({ key }) => fscsOf.has(key))
    .map(({ key }) => fscsOf.get(key));
  const byFscs = await fetchItemsByFscs([...new Set(wanted)]);

  const counts = { branch: 0, fscs: 0, domain: 0 };
  let ambiguous = 0, vetoed = 0, suggested = 0;

  systems.forEach((s, i) => {
    if (s.w) return;
    const key = sysKeys[i];
    const ruledOut = new Set(s.nw ?? []);
    const cands = new Map();   // qid -> { sources: Set, label }
    const offer = (qid, source, label) => {
      if (!qid || ruledOut.has(qid)) { if (qid) vetoed++; return; }
      if (!cands.has(qid)) cands.set(qid, { sources: new Set(), label: '' });
      const c = cands.get(qid);
      c.sources.add(source);
      if (label && !c.label) c.label = label;
    };

    // branch: plurality of the system's branch items, ties dropped as unresolved
    const votes = systemVotes.get(key);
    if (votes?.size) {
      const ranked = [...votes].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
      if (ranked.length === 1 || ranked[0][1].n > ranked[1][1].n) {
        offer(ranked[0][0], 'branch', ranked[0][1].label);
      }
    }
    // fscs: exactly one Wikidata item may hold the key
    const fk = fscsOf.get(key);
    const items = fk ? byFscs.get(fk) : null;
    if (items?.size === 1) {
      const [qid, label] = [...items][0];
      offer(qid, 'fscs', label);
    } else if (items && items.size > 1) {
      ambiguous++;
    }
    // domain: whatever the earlier heuristic left on `sw`
    if (s.sw) offer(s.sw, 'domain', '');

    if (!cands.size) { delete s.sw; return; }
    // Rank by the most authoritative source that proposed each candidate, then
    // by how many sources agree.
    const best = [...cands].sort((a, b) => {
      const rank = c => Math.min(...[...c.sources].map(x => SUGGEST_SOURCES.indexOf(x)));
      return rank(a[1]) - rank(b[1]) || b[1].sources.size - a[1].sources.size || (a[0] < b[0] ? -1 : 1);
    })[0];
    const [qid, info] = best;
    s.sw = qid;
    if (info.label) s.sn = info.label;
    s.ss = SUGGEST_SOURCES.filter(x => info.sources.has(x));
    for (const src of s.ss) counts[src]++;
    suggested++;
  });

  // The branch and FSCS paths already carry a label; the domain heuristic has
  // only a Q-id. Backfill so every suggestion reads as a name, not a number.
  const unlabelled = systems.filter(s => !s.w && s.sw && !s.sn).map(s => s.sw);
  if (unlabelled.length) {
    const rows = await sparqlBatched([...new Set(unlabelled)], values => `SELECT ?item ?itemLabel WHERE {
  VALUES ?item { ${values} }
  ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en")
}`, 'suggestion-label fetch');
    const labels = new Map(rows.map(r => [qidOf(r.item), r.itemLabel.value]));
    for (const s of systems) if (!s.w && s.sw && !s.sn && labels.has(s.sw)) s.sn = labels.get(s.sw);
  }

  console.log(`  ${suggested} wikidata-less systems have a suggested operator:wikidata ` +
    `(branch ${counts.branch}, FSCS id ${counts.fscs}, domain ${counts.domain})`);
  if (ambiguous) console.log(`    ${ambiguous} skipped: their FSCS id is held by more than one Wikidata item`);
  if (vetoed) console.log(`    ${vetoed} candidate(s) vetoed by not:operator:wikidata`);
}

// ---- Ambiguous operator names -------------------------------------------
//
// The most valuable operator:wikidata tags are the ones that disambiguate a
// shared name: "Madison Public Library" in Wisconsin and "Madison Public
// Library" in Alabama are different institutions, but selecting by operator=
// alone lumps them together. Detect these by spatially clustering each operator
// name's libraries (single-linkage): branches of one real system are close
// together (or chained), while unrelated same-name systems sit far apart.
//
// The linkage distance is a per-country compromise (COUNTRY.clusterKm): US
// consolidated rural systems have branch spacing well under 60 km (so
// single-linkage keeps them whole), while distinct same-name systems are
// usually in different metros or states, hundreds of km apart. Canada's
// regional systems space branches much further, so its threshold is larger —
// and since one system never spans provinces there (COUNTRY.regionBoundSystems),
// cross-province libraries are never linked at any distance.
const CLUSTER_KM = COUNTRY.clusterKm;

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Single-linkage clustering via union-find. Groups are small (an operator name
// has at most ~100 branches) so the O(n²) pass is negligible.
function clusterByDistance(rows) {
  const parent = rows.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  // A library with no region assigned (boundary gaps) links freely — isolating
  // it would fabricate a split.
  const sameRegion = (a, b) => !a.state || !b.state || a.state === b.state;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (COUNTRY.regionBoundSystems && !sameRegion(rows[i], rows[j])) continue;
      if (haversineKm(rows[i].lat, rows[i].lon, rows[j].lat, rows[j].lon) <= CLUSTER_KM) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

function findAmbiguousNames(rawLibs, stateIdx) {
  const byName = new Map();
  for (const r of rawLibs) {
    if (!r.operator) continue;
    if (!byName.has(r.operator)) byName.set(r.operator, []);
    byName.get(r.operator).push(r);
  }

  const result = [];
  for (const [name, rows] of byName) {
    if (rows.length < 2) continue;
    // Universities legitimately run disjoint campuses; distance clustering
    // reads them as separate systems, so they're just noise here.
    if (/university/i.test(name)) continue;
    // Fully wikidata-tagged groups need no further disambiguation work.
    if (rows.every(r => r.wikidata)) continue;

    const clusters = clusterByDistance(rows);
    if (clusters.length < 2) continue;

    result.push({
      n: name,
      total: rows.length,
      clusters: clusters.map(rowsIn => {
        const states = [...new Set(rowsIn.map(r => r.state ? stateIdx.get(r.state) : -1))].sort((a, b) => a - b);
        const qids = [...new Set(rowsIn.filter(r => r.wikidata).map(r => r.wikidata))];
        const lons = rowsIn.map(r => r.lon), lats = rowsIn.map(r => r.lat);
        return {
          st: states,
          c: rowsIn.length,
          // null = untagged, 'Qxxx' = uniformly tagged, 'mixed' = inconsistent
          wd: qids.length === 0 ? null :
              (qids.length === 1 && rowsIn.every(r => r.wikidata)) ? qids[0] : 'mixed',
          // padded bbox for a region-scoped Overpass query
          bb: [
            Math.round((Math.min(...lons) - 0.5) * 100) / 100,
            Math.round((Math.min(...lats) - 0.5) * 100) / 100,
            Math.round((Math.max(...lons) + 0.5) * 100) / 100,
            Math.round((Math.max(...lats) + 0.5) * 100) / 100
          ]
        };
      }).sort((a, b) => b.c - a.c || (a.st[0] ?? 99) - (b.st[0] ?? 99))
    });
  }
  result.sort((a, b) => b.total - a.total || a.n.localeCompare(b.n));
  return result;
}

// ---- Website domain clusters ---------------------------------------------
//
// A shared website domain is a strong operator fingerprint: it's very unlikely
// two different library systems use the same domain. Group libraries by the
// hostname of their website tag; a domain with operator-less libraries is a
// ready-made work set — and when tagged siblings share the domain, their
// operator / operator:wikidata values are near-certain suggestions for the rest.

// Normalized hostname from a website tag value ('' / unparseable -> null).
function websiteDomain(url) {
  if (!url) return null;
  let u = url.split(';')[0].trim();           // some tags list multiple URLs
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\d*\./, '');
    return h.includes('.') ? h : null;        // require a real dotted hostname
  } catch {
    return null;
  }
}

// Generic hosting platforms where a shared domain does NOT imply a shared
// operator (many unrelated libraries park their pages there).
const GENERIC_HOSTS = [
  'facebook.com', 'sites.google.com', 'google.com',
  'wordpress.com', 'weebly.com', 'wix.com', 'wixsite.com', 'squarespace.com',
  'business.site', 'blogspot.com',
  'youseemore.com'   // library-CMS vendor hosting many unrelated systems
];
const isGenericHost = d => GENERIC_HOSTS.some(g => d === g || d.endsWith('.' + g));

function findDomainClusters(rawLibs, stateIdx, notAssert) {
  const byDomain = new Map();
  for (const r of rawLibs) {
    const d = websiteDomain(r.website);
    if (!d || isGenericHost(d)) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(r);
  }

  const topVote = m => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const result = [];
  for (const [domain, rows] of byDomain) {
    const untagged = rows.filter(r => !r.operator).length;
    // Interesting only when the domain groups multiple libraries and at least
    // one of them has no operator tag.
    if (rows.length < 2 || untagged === 0) continue;

    // not:-assertions from any library in the group veto matching suggestions —
    // a negation on one branch almost certainly applies to the whole domain set.
    const notWd = new Set(), notOp = new Set();
    for (const r of rows) {
      const key = r.type[0] + r.id;
      for (const q of notAssert.wd.get(key) ?? []) notWd.add(q);
      for (const n of notAssert.op.get(key) ?? []) notOp.add(n);
    }
    const opVotes = new Map(), wdVotes = new Map();
    for (const r of rows) {
      if (r.operator && !notOp.has(r.operator)) opVotes.set(r.operator, (opVotes.get(r.operator) || 0) + 1);
      if (r.wikidata && !notWd.has(r.wikidata)) wdVotes.set(r.wikidata, (wdVotes.get(r.wikidata) || 0) + 1);
    }
    const states = [...new Set(rows.map(r => r.state ? stateIdx.get(r.state) : -1))].sort((a, b) => a - b);
    // A real library system essentially never spans 3+ states — a wide spread
    // means a vendor/aggregator platform (e.g. a library-CMS host), where the
    // shared domain implies nothing about the operator.
    if (states.length > 2) continue;

    result.push({
      d: domain,
      total: rows.length,
      untagged,
      op: topVote(opVotes),   // suggested operator from tagged siblings, if any
      wd: topVote(wdVotes),   // suggested operator:wikidata, if any
      st: states
    });
  }
  result.sort((a, b) => b.untagged - a.untagged || b.total - a.total || a.d.localeCompare(b.d));
  return result;
}

// ---- IMLS PLS matching ---------------------------------------------------
//
// Cross-reference each OSM library system against the IMLS Public Libraries
// Survey (a federal census). For each system we can match, classify its PLS
// outlets into: matched (in OSM), untagged (a library exists in OSM nearby but
// isn't tagged with this operator — add the tag), missing (no OSM library there
// — likely needs creating), and discrepancy (matched by name but far from the
// OSM coordinate — verify location). Only systems with >= MIN_LIBS OSM libraries
// are checked, to keep the crosswalk reliable and the output focused. 2 matches
// the unmatched-report floor: a complete, correctly tagged 2-branch system
// (the smallest the report can show) counts as found rather than sitting in
// "not found in OSM" forever.
const MIN_LIBS_FOR_PLS = COUNTRY.matchMinOsmLibs;

// Every system's libraries indexed by its dominant QID, so a crosswalk winner
// can absorb same-QID fragments that never claimed the PLS system themselves
// (below MIN_LIBS_FOR_PLS, or a name the crosswalk couldn't score).
export function buildLibsByQid(sysKeys, sysMap, systems) {
  const byQid = new Map();
  for (let i = 0; i < sysKeys.length; i++) {
    const w = systems[i].w;
    if (!w) continue;
    if (!byQid.has(w)) byQid.set(w, []);
    byQid.get(w).push(...sysMap.get(sysKeys[i]).libs);
  }
  return byQid;
}

// The merged OSM membership for one PLS system's rival claimants: the union
// (deduped by element id) of every rival fragment's libraries plus every
// library under a rival's dominant QID. A distant wrongly-QID'd library is
// harmless here — classify() only matches outlets to nearby libraries — so
// erring toward inclusion only removes false "untagged"/conflict findings.
export function mergeClaimLibs(rivals, sysMap, systems, libsByQid) {
  const byId = new Map();
  for (const r of rivals) {
    for (const l of sysMap.get(r.sysKey).libs) byId.set(l.id, l);
    const w = systems[r.sysIdx].w;
    for (const l of (w && libsByQid.get(w)) || []) byId.set(l.id, l);
  }
  return [...byId.values()];
}

function matchPls(rawLibs, sysMap, sysKeys, systems, stateNames, wdAliases = new Map(), closures = []) {
  if (!PLS_FILE) {
    console.log(`  ${COUNTRY.code} has no outlets census configured — skipping PLS matching.`);
    return null;
  }
  let plsData;
  try {
    plsData = JSON.parse(readFileSync(PLS_FILE, 'utf8'));
  } catch {
    console.warn('  PLS data not found (data/pls-outlets.json) — skipping PLS matching.');
    return null;
  }
  const plsIndex = indexPls(plsData.outlets);

  // Spatial grid over ALL OSM libraries (any operator) for the untagged-vs-missing
  // split: ~0.02° cells (~2km) so a 200m nearest-lookup checks 9 cells.
  const CELL = 0.02;
  const grid = new Map();
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  for (const r of rawLibs) {
    if (r.lat == null) continue;
    const k = cellKey(r.lat, r.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  const nearbyLib = (lat, lon) => {
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    let best = null;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const r of grid.get(`${ci + di}:${cj + dj}`) || []) {
        const d = haversineM(lat, lon, r.lat, r.lon);
        if (d <= 200 && (!best || d < best.dist)) best = { id: r.type[0] + r.id, name: r.name || '', operator: r.operator || '', lat: r.lat, lon: r.lon, dist: Math.round(d) };
      }
    }
    return best;
  };

  // A grid over PLS outlets too, to assign each OSM system its state exactly by
  // nearest PLS outlet (PLS carries a reliable 2-letter state per outlet).
  const plsGrid = new Map();
  for (const o of plsData.outlets) {
    const k = cellKey(o.lat, o.lon);
    if (!plsGrid.has(k)) plsGrid.set(k, []);
    plsGrid.get(k).push(o);
  }
  plsGrid.cell = CELL;

  // Pass 1: every OSM system that plausibly crosswalks to a PLS system, with the
  // classification that proves it. Arbitration between rival claimants happens
  // after the loop — see the note there.
  const claims = [];
  let checked = 0, crosswalked = 0;
  for (let i = 0; i < sysKeys.length; i++) {
    const s = sysMap.get(sysKeys[i]);
    if (s.c < MIN_LIBS_FOR_PLS) continue;
    checked++;
    // Dominant state of this system's OSM libraries (2-letter — but our stateNames
    // are full names; PLS uses abbreviations, so map via the outlets' coordinates
    // instead: try each state the system appears in).
    const osmCoords = s.libs.filter(l => l.lat != null).map(l => ({ lat: l.lat, lon: l.lon }));
    if (!osmCoords.length) continue;
    // State to scope the crosswalk: the modal state of the nearest PLS outlet to
    // each OSM library. Using PLS's own points as reference is exact (no bbox
    // guessing) and cheap via the same spatial grid.
    const st = plsStateForCoords(osmCoords, plsGrid);
    if (!st) continue;
    // Crosswalk on the OSM name plus any Wikidata label/aliases for the
    // system's confirmed QID — PLS often uses an official name OSM doesn't.
    // Academic operators are skipped outright: PLS covers public libraries,
    // and university items' generic aliases invite false matches.
    const aliasInfo = (systems[i].w ?? '').split(';')
      .map(q => wdAliases.get(q.trim())).filter(Boolean);
    if (aliasInfo.some(a => a.academic)) continue;
    const names = [s.n, ...aliasInfo.flatMap(a => a.names)];
    const cw = crosswalk(plsIndex, names, st, osmCoords);
    if (!cw) continue;
    crosswalked++;

    const plsSystem = plsIndex.byKey.get(cw.fscskey);
    const cls = classify(plsSystem.outlets, s.libs, s.n, nearbyLib);
    claims.push({ sysIdx: i, sysKey: sysKeys[i], name: s.n, osmCount: s.c, cw, plsSystem, cls });
  }

  // ---- Arbitration + merge: one PLS system, one OSM membership -------------
  //
  // Systems are crosswalked independently, so several OSM operator spellings can
  // claim the same PLS system — and they do, because that fragmentation is
  // exactly what this dataset is full of: "Orange County Library System" and a
  // 3-library "Orange County" grab-bag both matched Orlando's FL0005, and
  // "Fort Vancouver Regional Libraries", "…Library District" and a
  // wikidata-keyed fragment all matched WA0058.
  //
  // Name similarity can't settle who "owns" the PLS system — normSystem strips
  // `library`, `system`, `county` and `district`, so "Orange County" and
  // "Orange County Library System" both reduce to the single token "orange" and
  // tie at 1.0 — so rank by evidence of actual correspondence: how many of the
  // PLS system's outlets each spelling really matched.
  //
  // Crucially, the rivals are fragments of ONE real-world system, so the winner
  // is classified against the MERGED membership (see mergeClaimLibs): every
  // rival's libraries, plus any system sharing a rival's dominant QID that
  // never got to claim (below MIN_LIBS_FOR_PLS, or an unscorable name).
  // Classifying against only the winning fragment called every other
  // fragment's library "untagged" — e.g. Goldendale, tagged operator=Fort
  // Vancouver Regional Libraries + the right QID, was flagged as a conflict
  // because the wikidata-keyed fragment won WA0058.
  const byFscs = new Map();
  for (const c of claims) {
    if (!byFscs.has(c.cw.fscskey)) byFscs.set(c.cw.fscskey, []);
    byFscs.get(c.cw.fscskey).push(c);
  }
  const libsByQid = buildLibsByQid(sysKeys, sysMap, systems);
  // Closure signals are few (tens of Wikidata items + lifecycle-tagged objects),
  // so a linear scan per finding is plenty.
  const nearClosure = (lat, lon) =>
    closures.some(c => haversineM(lat, lon, c.lat, c.lon) <= CLOSED_RADIUS_M);
  const results = [];
  const crosswalks = [];   // winners only, for the augment pass to reuse
  let folded = 0, closedTotal = 0;
  for (const rivals of byFscs.values()) {
    rivals.sort((a, b) =>
      b.cls.matched - a.cls.matched ||
      b.osmCount - a.osmCount ||
      b.cw.sim - a.cw.sim ||
      (a.sysKey < b.sysKey ? -1 : 1));
    const [win, ...lost] = rivals;
    folded += lost.length;

    const mergedLibs = mergeClaimLibs(rivals, sysMap, systems, libsByQid);

    // Report under a human name when one exists — a wikidata-keyed fragment may
    // hold the most libraries, but "Q5472215" is no name for a system row. The
    // other name-keyed rivals are its spelling variants, carried on the row.
    const disp = rivals.find(r => !r.sysKey.startsWith('wd:')) ?? win;
    const variants = rivals
      .filter(r => r !== disp && !r.sysKey.startsWith('wd:'))
      .map(l => l.name).sort((a, b) => a.localeCompare(b));
    if (lost.length) {
      console.log(`  PLS ${win.cw.fscskey}: "${win.name}" (${win.cls.matched} matched) wins over ` +
        lost.map(l => `"${l.name}" (${l.cls.matched})`).join(', ') +
        ` — classified as "${disp.name}" against ${mergedLibs.length} merged libraries`);
    }

    // Re-classify against the merged membership (skip when nothing merged in).
    const cls = mergedLibs.length > sysMap.get(win.sysKey).libs.length || disp !== win
      ? classify(win.plsSystem.outlets, mergedLibs, disp.name, nearbyLib)
      : win.cls;

    // Outlets sitting on a closure signal are closed, not findings.
    const closedCount = suppressClosedFindings(cls, nearClosure);
    closedTotal += closedCount;

    // Record the crosswalk so buildAugment can fetch this system's live OSM tags
    // and compute augmentation suggestions without re-deriving the match.
    crosswalks.push({ sysIdx: disp.sysIdx, sysKey: disp.sysKey, fscskey: win.cw.fscskey, state: win.plsSystem.state });

    // Only surface systems where PLS reveals something actionable.
    if (cls.untagged.length === 0 && cls.missing.length === 0 && cls.discrepancies.length === 0) continue;

    results.push({
      sysKey: disp.sysKey,
      fscskey: win.cw.fscskey,
      state: win.plsSystem.state,   // 2-letter PLS state, for the state filter
      plsCount: cls.plsCount,
      osmCount: mergedLibs.length,
      matched: cls.matched,
      ...(closedCount ? { closed: closedCount } : {}),
      // Census outlets co-located with an already-matched member (see
      // classify) – carried for the count math, never as a finding.
      ...(cls.shared?.length ? { shared: cls.shared.length } : {}),
      ...(variants.length ? { variants } : {}),
      untagged: cls.untagged.map(u => ({
        name: u.p.name, addr: u.p.addr, city: u.p.city, lat: u.p.lat, lon: u.p.lon,
        osm: u.near.id, osmLat: u.near.lat, osmLon: u.near.lon,
        osmName: u.near.name, osmHasOperator: !!u.near.operator
      })),
      missing: cls.missing.map(o => ({
        name: o.name, addr: o.addr, city: o.city, zip: o.zip, lat: o.lat, lon: o.lon,
        geo: o.geomtype, structchg: o.structchg
      })),
      discrepancies: cls.discrepancies.map(d => ({ name: d.p.name, lat: d.p.lat, lon: d.p.lon, osmId: d.osmId, osmLat: d.osmLat, osmLon: d.osmLon, dist: d.dist }))
    });
  }
  if (folded) console.log(`  ${folded} rival crosswalk claim(s) folded into ${byFscs.size} PLS systems`);
  // Ordered by system key, NOT by severity: file order should change only when
  // the set of findings changes, and a finding count that drifts by one would
  // otherwise shuffle a system halfway across the array. The QA page ranks
  // biggest-opportunity-first at render time.
  results.sort((a, b) => (a.sysKey < b.sysKey ? -1 : a.sysKey > b.sysKey ? 1 : 0));

  // PLS systems that crosswalked to NOTHING in OSM — the catchall for systems
  // the matcher can't see at all: operator tags fragmented across spellings
  // (each fragment below MIN_LIBS_FOR_PLS), operator-less branches, or genuinely
  // unmapped systems. `near` counts outlets that already have SOME OSM library
  // (any operator) within 200m: high near/outlets means the buildings are mapped
  // but the tags need work; zero means unmapped territory. Single-outlet systems
  // are excluded — they're most of PLS (~7.7k) and mostly noise at this scale.
  const crosswalkedKeys = new Set(crosswalks.map(c => c.fscskey));
  const unmatched = [];
  const r3 = x => Math.round(x * 1e3) / 1e3;
  const r5 = x => Math.round(x * 1e5) / 1e5;
  for (const ps of plsIndex.byKey.values()) {
    if (ps.outlets.length < COUNTRY.unmatchedMinOutlets || crosswalkedKeys.has(ps.fscskey)) continue;
    let near = 0;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    // Per-outlet points, so the pages can navigate to each suspected library
    // rather than just naming the system: the PLS name + coordinate, and — when
    // some OSM library (any operator) sits within 200 m — that object's id,
    // name and coordinate, ready for an edit link.
    const pts = [];
    const opCoords = new Map();   // operator spelling -> coords of its libs here
    for (const o of ps.outlets) {
      const nb = nearbyLib(o.lat, o.lon);
      if (nb) near++;
      if (nb?.operator) {
        if (!opCoords.has(nb.operator)) opCoords.set(nb.operator, []);
        opCoords.get(nb.operator).push({ lat: nb.lat, lon: nb.lon });
      }
      if (o.lon < w) w = o.lon; if (o.lon > e) e = o.lon;
      if (o.lat < s) s = o.lat; if (o.lat > n) n = o.lat;
      pts.push({
        n: o.name, lat: r5(o.lat), lon: r5(o.lon),
        ...(nb ? { osm: nb.id, osmName: nb.name, osmLat: r5(nb.lat), osmLon: r5(nb.lon) } : {})
      });
    }
    // Operator spellings already on the matched buildings, each re-scored
    // through the same crosswalk that failed to find this system. One that
    // lands on this very PLS system (m: 1) means the system IS in OSM under
    // its own name – just on fewer than MIN_LIBS_FOR_PLS branches – so the
    // pages present it as "found, tag the remaining branches (operator +
    // operator:wikidata)" rather than as ambiguous.
    const ops = [...opCoords].map(([op, coords]) => {
      const cw = crosswalk(plsIndex, [op], ps.state, coords);
      return cw?.fscskey === ps.fscskey ? { n: op, m: 1 } : { n: op };
    });
    unmatched.push({
      name: ps.name, fscskey: ps.fscskey, state: ps.state,
      outlets: ps.outlets.length, near, pts,
      ...(ops.length ? { ops } : {}),
      // padded outlet bbox [west, south, east, north] for an area-scoped
      // Overpass query (~5km margin so 2-outlet systems still show an area)
      bb: [r3(w - 0.05), r3(s - 0.05), r3(e + 0.05), r3(n + 0.05)]
    });
  }
  unmatched.sort((a, b) => b.outlets - a.outlets || a.name.localeCompare(b.name));

  console.log(`  PLS: ${checked} OSM systems checked, ${crosswalked} claims over ${byFscs.size} PLS systems, ` +
    `${results.length} with findings, ${closedTotal} outlet(s) suppressed as closed, ` +
    `${unmatched.length} multi-outlet PLS systems unmatched`);
  return { meta: plsData.meta, results, crosswalks, plsIndex, unmatched };
}

// ---- IMLS PLS augmentation ------------------------------------------------
//
// For each crosswalked system, fetch its libraries' CURRENT OSM tags (Layercake
// omits addr:*, so we go to Overpass) and turn matched PLS outlets into additive
// tag suggestions — plus create-node suggestions for truly-missing branches. The
// augmentation page delivers these into JOSM review layers.
//
// Cost is bounded: only crosswalked systems are queried (hundreds, not 17k), one
// Overpass request each, with a polite delay and a hard cap. Any Overpass failure
// skips that one system rather than failing the build — augmentation is additive
// to the QA data, never a gate on it.
const AUGMENT_MAX_SYSTEMS = Number(process.env.AUGMENT_MAX_SYSTEMS || 400);
// The polite delay protects the public mirrors; a configured private instance
// needs far less. Both defaults are env-overridable.
const AUGMENT_SLEEP_MS = Number(process.env.AUGMENT_SLEEP_MS || (overpassEndpoint() ? 250 : 1100));

// Full-tag Overpass fetch for one system (by operator:wikidata or operator name),
// US-scoped. Returns [{ id, name, lat, lon, tags }] or null on failure.
async function fetchSystemTags(mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = mode === 'wikidata' ? `["operator:wikidata"="${esc}"]` : `["operator"="${esc}"]`;
  const q = `[out:json][timeout:90];\narea(${COUNTRY.areaId})->.us;\nnwr${sel}[amenity=library](area.us);\nout center tags;`;
  for (const [i, url] of OVERPASS_ENDPOINTS.entries()) {
    try {
      const res = await fetch(url, {
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
      // Endpoint 0 may be the private instance, so identify it by position, never
      // by URL — and keep the error to its code, since node puts the hostname in
      // DNS/TLS error text. See the header note in overpass-source.mjs.
      console.warn(`    augment: endpoint #${i} failed for ${value}: ${e.cause?.code ?? e.message}`);
    }
  }
  return null;
}

async function buildAugment(pls, systems) {
  if (!pls?.crosswalks?.length) return [];
  const { crosswalks, plsIndex } = pls;
  const augment = [];
  let queried = 0, skipped = 0;

  console.log(`Augment: fetching live tags for up to ${Math.min(crosswalks.length, AUGMENT_MAX_SYSTEMS)} crosswalked systems…`);
  for (const cw of crosswalks) {
    if (queried >= AUGMENT_MAX_SYSTEMS) { skipped++; continue; }
    const sys = systems[cw.sysIdx];
    const qid = sys.w || null;                 // confirmed operator:wikidata, if any
    const qidConfirmed = !!sys.w;
    const suggestQid = qid || sys.sw || null;  // fall back to a domain-derived suggestion
    const mode = sys.w ? 'wikidata' : 'operator';
    const value = sys.w || sys.n;

    queried++;
    const osmLibs = await fetchSystemTags(mode, value);
    await sleep(AUGMENT_SLEEP_MS);
    if (!osmLibs) { skipped++; continue; }     // Overpass failed for this system

    const plsSystem = plsIndex.byKey.get(cw.fscskey);
    const cls = classify(plsSystem.outlets, osmLibs, sys.n, null);
    const osmById = new Map(osmLibs.map(o => [o.id, o]));

    const branches = [];

    // Augment EXISTING matched OSM libraries: fill blank tags, flag conflicts.
    // (Missing branches — creating new nodes — are the QA page's job, not this.)
    for (const pair of cls.matchedPairs) {
      const osm = osmById.get(pair.o.id);
      if (!osm) continue;
      const allowAddr = isPreciseGeocode(pair.p);
      const { tags, conflicts } = suggestTagsForOutlet(pair.p, suggestQid, osm.tags, {
        allowAddr, qidConfirmed
      });
      if (Object.keys(tags).length === 0 && conflicts.length === 0) continue;  // nothing to say
      branches.push({
        osm: pair.o.id, lat: osm.lat, lon: osm.lon,
        plsName: titleCase(pair.p.name), dist: pair.dist, tags, conflicts
      });
    }

    if (!branches.length) continue;
    augment.push({
      sysKey: cw.sysKey,
      fscskey: cw.fscskey,
      state: cw.state,
      qid: suggestQid,
      qidConfirmed,
      branches
    });
  }

  // Ordered by system key for a stable diff (see the note on pls results); the
  // augment page already ranks by branch count at render time.
  augment.sort((a, b) => (a.sysKey < b.sysKey ? -1 : a.sysKey > b.sysKey ? 1 : 0));
  const totalBranches = augment.reduce((n, a) => n + a.branches.length, 0);
  console.log(`  Augment: ${queried} systems queried, ${skipped} skipped, ${augment.length} with suggestions (${totalBranches} branches)`);
  return augment;
}

// The 2-letter PLS state code for a system, by modal nearest-PLS-outlet state.
// Exact (uses PLS's own points as reference) and cheap via the grid. Expands the
// search ring until a nearby outlet is found, so rural systems still resolve.
function plsStateForCoords(coords, plsGrid) {
  const CELL = plsGrid.cell;
  const votes = new Map();
  for (const c of coords) {
    const ci = Math.floor(c.lat / CELL), cj = Math.floor(c.lon / CELL);
    let best = null;
    for (let ring = 1; ring <= 8 && !best; ring++) {
      for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring && ring > 1) continue; // only new ring cells
        for (const o of plsGrid.get(`${ci + di}:${cj + dj}`) || []) {
          const d = haversineM(c.lat, c.lon, o.lat, o.lon);
          if (!best || d < best.d) best = { st: o.state, d };
        }
      }
    }
    if (best) votes.set(best.st, (votes.get(best.st) || 0) + 1);
  }
  let winner = null;
  for (const [st, n] of votes) if (!winner || n > winner.n) winner = { st, n };
  return winner?.st ?? null;
}

// One record per line (still valid JSON): daily git diffs then touch only the
// lines that actually changed, instead of rewriting one giant line. Exported so
// augment-state.mjs writes qa-data.json in the exact same reviewable format.
export function serializeLinewise(out) {
  const arr = a => '[\n' + a.map(x => JSON.stringify(x)).join(',\n') + '\n]';
  return '{\n' +
    `"meta": ${JSON.stringify(out.meta)},\n` +
    `"tags": ${JSON.stringify(out.tags)},\n` +
    `"states": ${JSON.stringify(out.states)},\n` +
    `"systems": ${arr(out.systems)},\n` +
    `"libs": ${arr(out.libs)},\n` +
    `"collisions": ${arr(out.collisions)},\n` +
    `"ambiguous": ${arr(out.ambiguous)},\n` +
    `"domains": ${arr(out.domains)},\n` +
    `"unnamedPairs": ${arr(out.unnamedPairs ?? [])},\n` +
    `"wdOperators": ${arr(out.wdOperators ?? [])},\n` +
    `"wdConflicts": ${arr(out.wdConflicts ?? [])},\n` +
    `"pls": ${arr(out.pls)},\n` +
    `"plsUnmatched": ${arr(out.plsUnmatched ?? [])},\n` +
    `"augment": ${arr(out.augment)}\n` +
    '}\n';
}

// Run only when executed directly (not when imported for serializeLinewise).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
