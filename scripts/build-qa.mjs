#!/usr/bin/env node
// build-qa.mjs — regenerate data/qa-data.json for the Data QA page.
//
// Runs scripts/qa-libraries.sql against OpenStreetMap US's Layercake extract
// (via the DuckDB CLI, remote GeoParquet over HTTP) and normalizes the result
// into one compact file the QA page loads client-side:
//
//   meta        generated date, Layercake freshness, totals
//   tags        the tag names behind each bit of a library's flags bitmask
//   states      state names (libs reference them by index)
//   systems     { n: name, w: wikidata|null, c: count } (libs reference by index)
//   libs        [sysIdx, type, id, name, stateIdx, flags, lon, lat]
//   collisions  likely-typo operator name pairs (computed in SQL via levenshtein)
//
// Flags bitmask: 1 phone, 2 website, 4 opening_hours, 8 operator,
//                16 operator:wikidata. Only tags the app itself uses are
//                tracked (addresses would be too, but they're absent from
//                Layercake's POI layer — the QA page's live view covers them).
//
// Requirements: DuckDB CLI on PATH (or DUCKDB env var), Node 18+.
// Usage:  node scripts/build-qa.mjs

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { layercakeModified, toISODate, committedSourceDate } from './systems-core.mjs';
import { indexPls, crosswalk, classify, haversineM } from './pls-match.mjs';
import { suggestTagsForOutlet, isPreciseGeocode, titleCase } from './pls-augment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SQL_FILE = join(HERE, 'qa-libraries.sql');
const DEST = join(ROOT, 'data', 'qa-data.json');
const PLS_FILE = join(ROOT, 'data', 'pls-outlets.json');
const DUCKDB = process.env.DUCKDB || 'duckdb';
const FORCE = process.argv.includes('--force');
const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; weekly QA build)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Bit positions must match the `tags` array written to meta below.
const FLAG_BITS = ['phone', 'website', 'opening_hours', 'operator', 'operator:wikidata'];

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

// ---- not:operator / not:operator:wikidata assertions ----------------------
//
// OSM's `not:` prefix records verified negatives: not:operator:wikidata=Q123
// means a mapper confirmed the operator is definitely NOT that item (usually
// after ruling out a tempting-but-wrong match, e.g. a city entity or a
// similarly-named system). These tags aren't in Layercake's POI columns, so
// they're fetched with one tiny Overpass query. They must never be grouped as
// real values, and suggestions must never re-propose a ruled-out item.
// A custom instance (OVERPASS_URL env var) is tried first when set.
const OVERPASS_ENDPOINTS = [
  ...(process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

// Returns { wd: Map(elKey -> Set(QIDs)), op: Map(elKey -> Set(names)) } where
// elKey is `${type[0]}${id}` matching the Layercake rows. Fails soft: on total
// Overpass failure the maps are empty and suggestions are simply unfiltered.
async function fetchNotAssertions() {
  const q = `[out:json][timeout:60];
area(3600148838)->.us;
(
  nwr[amenity=library]["not:operator:wikidata"](area.us);
  nwr[amenity=library]["not:operator"](area.us);
);
out tags;`;
  const wd = new Map(), op = new Map();
  for (const url of OVERPASS_ENDPOINTS) {
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
      console.warn(`  not:-assertion fetch failed on ${url}: ${e.message}`);
    }
  }
  console.warn('  proceeding without not:-assertions (all Overpass endpoints failed)');
  return { wd, op };
}

// ---- Wikidata branch counts ----------------------------------------------
//
// Many US library-system items on Wikidata list their branches (P527 "has part"
// entries typed as library branch). Comparing that count against the OSM branch
// count is a completeness hint in both directions: fewer in OSM suggests
// unmapped branches; more suggests duplicates in OSM or a stale Wikidata list.
async function fetchWikidataBranchCounts() {
  const query = `SELECT ?system (COUNT(?branch) AS ?count) WHERE {
  ?system wdt:P31 wd:Q26271642.
  ?system wdt:P17 wd:Q30.
  ?system wdt:P527 ?branch.
  ?branch wdt:P31 wd:Q11396180.
} GROUP BY ?system`;

  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          'User-Agent': USER_AGENT
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = (await res.json()).results.bindings;
      const out = new Map();
      for (const r of rows) out.set(r.system.value.split('/').pop(), Number(r.count.value));
      return out;
    } catch (e) {
      console.warn(`  Wikidata branch-count fetch failed (${e.message})${i < 2 ? ' — retrying…' : ''}`);
      if (i < 2) await sleep(5000 * (i + 1));
    }
  }
  console.warn('  proceeding without Wikidata branch counts');
  return new Map();
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
  // into operator:wikidata) — a malformed value in VALUES 400s the whole query.
  qids = qids.filter(q => /^Q\d+$/.test(q));
  if (!qids.length) return new Map();
  const query = `SELECT ?item ?name ?academic WHERE {
  VALUES ?item { ${qids.map(q => 'wd:' + q).join(' ')} }
  { ?item rdfs:label ?name . FILTER(LANG(?name) = "en") }
  UNION
  { ?item skos:altLabel ?name . FILTER(LANG(?name) = "en") }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q38723 } AS ?academic)
}`;

  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          'User-Agent': USER_AGENT
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = (await res.json()).results.bindings;
      const out = new Map();
      for (const r of rows) {
        const qid = r.item.value.split('/').pop();
        if (!out.has(qid)) out.set(qid, { names: [], academic: false });
        const e = out.get(qid);
        e.names.push(r.name.value);
        if (r.academic?.value === 'true') e.academic = true;
      }
      return out;
    } catch (e) {
      console.warn(`  Wikidata alias fetch failed (${e.message})${i < 2 ? ' — retrying…' : ''}`);
      if (i < 2) await sleep(5000 * (i + 1));
    }
  }
  console.warn('  proceeding without Wikidata aliases');
  return new Map();
}

async function main() {
  // Layercake's snapshot timestamp gates the whole rebuild: skip if the committed
  // QA dataset already comes from an equal-or-newer source.
  const sourceModified = await layercakeModified();
  const sourceDate = toISODate(sourceModified);
  if (!sourceDate) throw new Error('Could not read Layercake Last-Modified — aborting.');

  const committed = committedSourceDate(DEST);
  if (!FORCE && committed && committed >= sourceDate) {
    console.log(`Committed QA data source ${committed} is not older than Layercake ${sourceDate} — nothing to do. (Use --force to override.)`);
    return;
  }

  console.log('Querying Layercake (via DuckDB) for per-library QA data…');
  const { libs: rawLibs, collisions: rawColl } = queryLayercake();
  console.log(`  ${rawLibs.length} US libraries, ${rawColl.length} possible name collisions`);

  // Deterministic order: DuckDB's parallel GROUP BY output order varies between
  // runs, which would rewrite the whole committed file every week even with no
  // data change. Sorting here keeps weekly git diffs limited to real changes.
  rawLibs.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

  console.log('Fetching not:operator assertions from Overpass…');
  const notAssert = await fetchNotAssertions();
  console.log(`  ${notAssert.wd.size} not:operator:wikidata, ${notAssert.op.size} not:operator elements`);

  if (rawLibs.length < 10000) {
    throw new Error(`Only ${rawLibs.length} libraries returned (expected >= 10000) — refusing to write a gutted dataset.`);
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
  const sysKeys = [...sysMap.keys()];
  const sysIdx = new Map(sysKeys.map((k, i) => [k, i]));
  const systems = sysKeys.map(k => {
    const s = sysMap.get(k);
    const w = [...s.wdVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { n: s.n, w, c: s.c };
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
    if (r.has_phone) flags |= 1;
    if (r.has_website) flags |= 2;
    if (r.has_hours) flags |= 4;
    if (r.operator) flags |= 8;
    if (r.wikidata) flags |= 16;
    return [
      sysIdx.get(sysKey(r)) ?? -1,
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

  // ---- Wikidata labels/aliases for tagged systems: extra crosswalk name
  // candidates when the OSM operator name differs from PLS's official name.
  const wdAliases = await fetchWikidataAliases([...new Set(
    systems.filter(s => s.w).flatMap(s => s.w.split(';').map(q => q.trim())))]);
  console.log(`  ${wdAliases.size} tagged systems have Wikidata labels/aliases`);

  // ---- IMLS PLS matching: find branches missing / untagged vs the federal census.
  const pls = matchPls(rawLibs, sysMap, sysKeys, sysIdx, systems, stateNames, wdAliases);

  // ---- IMLS PLS augmentation: per-crosswalked-system live tag fetch + suggestions.
  const augment = await buildAugment(pls, systems);

  const out = {
    meta: {
      source: 'Layercake (OpenStreetMap US), US boundary relation 148838',
      generated: new Date().toISOString().slice(0, 10),
      sourceDate,
      layercakeModified: sourceModified,
      totalLibraries: libs.length,
      totalSystems: systems.length,
      ...(pls?.meta ? { plsFiscalYear: pls.meta.fiscalYear } : {})
    },
    tags: FLAG_BITS,
    states: stateNames,
    systems,
    libs,
    collisions,
    ambiguous,
    domains,
    pls: pls?.results ?? [],
    plsUnmatched: pls?.unmatched ?? [],
    augment
  };

  const dest = join(ROOT, 'data', 'qa-data.json');
  const json = serializeLinewise(out);
  writeFileSync(dest, json);
  console.log(`Wrote ${libs.length} libraries, ${systems.length} systems, ${collisions.length} collisions (${Math.round(json.length / 1024)} KB) -> ${dest}`);
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
// CLUSTER_KM is a compromise: consolidated rural systems have branch spacing
// well under 60 km (so single-linkage keeps them whole), while distinct
// same-name systems are usually in different metros or states, hundreds of
// km apart.
const CLUSTER_KM = 120;

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
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
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
const MIN_LIBS_FOR_PLS = 2;

function matchPls(rawLibs, sysMap, sysKeys, sysIdx, systems, stateNames, wdAliases = new Map()) {
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

  const results = [];
  const crosswalks = [];   // every crosswalked system, for the augment pass to reuse
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
    // Record the crosswalk so buildAugment can fetch this system's live OSM tags
    // and compute augmentation suggestions without re-deriving the match.
    crosswalks.push({ sysIdx: i, sysKey: sysKeys[i], fscskey: cw.fscskey, state: plsSystem.state });

    const cls = classify(plsSystem.outlets, s.libs, s.n, nearbyLib);
    // Only surface systems where PLS reveals something actionable.
    if (cls.untagged.length === 0 && cls.missing.length === 0 && cls.discrepancies.length === 0) continue;

    results.push({
      sysIdx: i,
      fscskey: cw.fscskey,
      state: plsSystem.state,   // 2-letter PLS state, for the state filter
      plsCount: cls.plsCount,
      osmCount: s.c,
      matched: cls.matched,
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
  // Biggest opportunities first.
  results.sort((a, b) => (b.missing.length + b.untagged.length) - (a.missing.length + a.untagged.length));

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
  for (const ps of plsIndex.byKey.values()) {
    if (ps.outlets.length < 2 || crosswalkedKeys.has(ps.fscskey)) continue;
    let near = 0;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const o of ps.outlets) {
      if (nearbyLib(o.lat, o.lon)) near++;
      if (o.lon < w) w = o.lon; if (o.lon > e) e = o.lon;
      if (o.lat < s) s = o.lat; if (o.lat > n) n = o.lat;
    }
    unmatched.push({
      name: ps.name, fscskey: ps.fscskey, state: ps.state,
      outlets: ps.outlets.length, near,
      // padded outlet bbox [west, south, east, north] for an area-scoped
      // Overpass query (~5km margin so 2-outlet systems still show an area)
      bb: [r3(w - 0.05), r3(s - 0.05), r3(e + 0.05), r3(n + 0.05)]
    });
  }
  unmatched.sort((a, b) => b.outlets - a.outlets || a.name.localeCompare(b.name));

  console.log(`  PLS: ${checked} systems checked, ${crosswalked} crosswalked, ${results.length} with findings, ${unmatched.length} multi-outlet PLS systems unmatched`);
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
const AUGMENT_SLEEP_MS = Number(process.env.AUGMENT_SLEEP_MS || 1100);

// Full-tag Overpass fetch for one system (by operator:wikidata or operator name),
// US-scoped. Returns [{ id, name, lat, lon, tags }] or null on failure.
async function fetchSystemTags(mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = mode === 'wikidata' ? `["operator:wikidata"="${esc}"]` : `["operator"="${esc}"]`;
  const q = `[out:json][timeout:90];\narea(3600148838)->.us;\nnwr${sel}[amenity=library](area.us);\nout center tags;`;
  for (const url of OVERPASS_ENDPOINTS) {
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
      console.warn(`    augment: overpass ${url} failed for ${value}: ${e.message}`);
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
      sysIdx: cw.sysIdx,
      fscskey: cw.fscskey,
      state: cw.state,
      qid: suggestQid,
      qidConfirmed,
      branches
    });
  }

  // Biggest opportunities first.
  augment.sort((a, b) => b.branches.length - a.branches.length);
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

// One record per line (still valid JSON): weekly git diffs then touch only the
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
    `"pls": ${arr(out.pls)},\n` +
    `"plsUnmatched": ${arr(out.plsUnmatched ?? [])},\n` +
    `"augment": ${arr(out.augment)}\n` +
    '}\n';
}

// Run only when executed directly (not when imported for serializeLinewise).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
