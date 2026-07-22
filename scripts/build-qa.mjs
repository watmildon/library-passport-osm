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
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SQL_FILE = join(HERE, 'qa-libraries.sql');
const DUCKDB = process.env.DUCKDB || 'duckdb';
const POIS_URL = 'https://data.openstreetmap.us/layercake/pois.parquet';

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

// Layercake's POI extract freshness, for the page's "data as of" note.
async function layercakeModified() {
  try {
    const res = await fetch(POIS_URL, { method: 'HEAD' });
    return res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('Querying Layercake (via DuckDB) for per-library QA data…');
  const { libs: rawLibs, collisions: rawColl } = queryLayercake();
  console.log(`  ${rawLibs.length} US libraries, ${rawColl.length} possible name collisions`);

  // Deterministic order: DuckDB's parallel GROUP BY output order varies between
  // runs, which would rewrite the whole committed file every week even with no
  // data change. Sorting here keeps weekly git diffs limited to real changes.
  rawLibs.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

  if (rawLibs.length < 10000) {
    throw new Error(`Only ${rawLibs.length} libraries returned (expected >= 10000) — refusing to write a gutted dataset.`);
  }

  // States, indexed.
  const stateNames = [...new Set(rawLibs.map(r => r.state).filter(Boolean))].sort();
  const stateIdx = new Map(stateNames.map((s, i) => [s, i]));

  // Systems, indexed. Keyed by operator name; wikidata-only libraries get a
  // system keyed (and named) by their Q-id. The system's wikidata is the most
  // frequent non-null Q-id seen alongside that operator name.
  const sysMap = new Map(); // key -> { n, wdVotes: Map, c }
  const sysKey = r => r.operator ?? (r.wikidata ? `wd:${r.wikidata}` : null);
  for (const r of rawLibs) {
    const key = sysKey(r);
    if (!key) continue;
    let s = sysMap.get(key);
    if (!s) { s = { n: r.operator ?? r.wikidata, wdVotes: new Map(), c: 0 }; sysMap.set(key, s); }
    s.c++;
    if (r.wikidata) s.wdVotes.set(r.wikidata, (s.wdVotes.get(r.wikidata) || 0) + 1);
  }
  const sysKeys = [...sysMap.keys()];
  const sysIdx = new Map(sysKeys.map((k, i) => [k, i]));
  const systems = sysKeys.map(k => {
    const s = sysMap.get(k);
    const w = [...s.wdVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { n: s.n, w, c: s.c };
  });

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

  const out = {
    meta: {
      source: 'OpenStreetMap US Layercake POI extract (data.openstreetmap.us), US boundary relation 148838',
      generated: new Date().toISOString().slice(0, 10),
      layercakeModified: await layercakeModified(),
      totalLibraries: libs.length,
      totalSystems: systems.length
    },
    tags: FLAG_BITS,
    states: stateNames,
    systems,
    libs,
    collisions,
    ambiguous
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

// One record per line (still valid JSON): weekly git diffs then touch only the
// lines that actually changed, instead of rewriting one giant line.
function serializeLinewise(out) {
  const arr = a => '[\n' + a.map(x => JSON.stringify(x)).join(',\n') + '\n]';
  return '{\n' +
    `"meta": ${JSON.stringify(out.meta)},\n` +
    `"tags": ${JSON.stringify(out.tags)},\n` +
    `"states": ${JSON.stringify(out.states)},\n` +
    `"systems": ${arr(out.systems)},\n` +
    `"libs": ${arr(out.libs)},\n` +
    `"collisions": ${arr(out.collisions)},\n` +
    `"ambiguous": ${arr(out.ambiguous)}\n` +
    '}\n';
}

main().catch(e => { console.error(e); process.exit(1); });
