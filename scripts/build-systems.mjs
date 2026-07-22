#!/usr/bin/env node
// build-systems.mjs — regenerate data/us-library-systems.json
//
// Extracts every operator= and operator:wikidata= value on amenity=library within
// the US from OpenStreetMap US's Layercake POI extract (a cloud-native GeoParquet
// file), queried directly over HTTP with DuckDB — no full download. Wikidata-only
// operators are enriched with English labels from the Wikidata Query Service.
// Writes a ranked, de-duplicated system list for the onboarding picker.
//
// Requirements:
//   - the DuckDB CLI on PATH (or set DUCKDB=/path/to/duckdb)
//   - Node 18+ (global fetch)
//
// Usage:  node scripts/build-systems.mjs
//
// The heavy lifting (US point-in-polygon filter + aggregation) lives in the
// sibling SQL file, us-library-operators.sql.

import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SQL_FILE = join(HERE, 'us-library-operators.sql');
const DUCKDB = process.env.DUCKDB || 'duckdb';
const WIKIDATA = 'https://query.wikidata.org/sparql';

const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; weekly systems-list build)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Layercake via DuckDB ------------------------------------------------

// Run the DuckDB query and return rows of { operator, wikidata, count }.
// operator / wikidata are null when absent on a given library.
function queryLayercake() {
  const tmp = mkdtempSync(join(tmpdir(), 'libpass-'));
  const outFile = join(tmp, 'systems-raw.json');
  // DuckDB reads paths with forward slashes on every platform.
  const sql = readFileSync(SQL_FILE, 'utf8').replaceAll('{{OUT}}', outFile.replace(/\\/g, '/'));

  try {
    const res = spawnSync(DUCKDB, [], { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) {
      if (res.error.code === 'ENOENT') {
        throw new Error(`DuckDB CLI not found (tried "${DUCKDB}"). Install it or set the DUCKDB env var.`);
      }
      throw res.error;
    }
    if (res.status !== 0) {
      throw new Error(`DuckDB exited ${res.status}:\n${res.stderr || res.stdout}`);
    }
    const rows = JSON.parse(readFileSync(outFile, 'utf8'));
    return rows.map(r => ({
      operator: r.operator ?? null,
      wikidata: r.wikidata ?? null,
      count: Number(r.count)
    }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Wikidata label enrichment ------------------------------------------

async function wikidataLabels(qids) {
  if (!qids.length) return {};
  const values = qids.map(q => 'wd:' + q).join(' ');
  const query = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?label WHERE {
  VALUES ?item { ${values} }
  ?item rdfs:label ?label . FILTER(LANG(?label) = 'en')
}`;

  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(WIKIDATA, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          'User-Agent': USER_AGENT
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error(`Wikidata -> HTTP ${res.status}`);
      const rows = (await res.json()).results.bindings;
      const out = {};
      for (const r of rows) out[r.item.value.split('/').pop()] = r.label.value;
      return out;
    } catch (e) {
      lastErr = e;
      if (i < 4) {
        const wait = 5000 * (i + 1);
        console.warn(`  Wikidata request failed (${e.message}) — retrying in ${wait / 1000}s…`);
        await sleep(wait);
      }
    }
  }
  // Labels are enrichment only — don't fail the whole build if Wikidata is down.
  console.warn(`  Giving up on Wikidata labels: ${lastErr.message}`);
  return {};
}

// ---- Build ---------------------------------------------------------------

async function main() {
  console.log('Querying Layercake (via DuckDB) for US library operators…');
  const rows = queryLayercake();
  console.log(`  ${rows.length} (operator, wikidata) groups`);

  // Aggregate by operator name and by wikidata id.
  const opRows = [];                 // { name, count } — operator-name totals
  const opCount = {};
  const qidCount = {};
  const qidName = {};                // preferred operator= name seen for a qid
  const nameToQid = {};              // operator name -> qid (when co-tagged)

  for (const r of rows) {
    if (r.operator) opCount[r.operator] = (opCount[r.operator] || 0) + r.count;
    if (r.wikidata) {
      qidCount[r.wikidata] = (qidCount[r.wikidata] || 0) + r.count;
      if (r.operator) {
        qidName[r.wikidata] ||= r.operator;
        nameToQid[r.operator] = r.wikidata;
      }
    }
  }
  for (const [name, count] of Object.entries(opCount)) opRows.push({ name, count });
  opRows.sort((a, b) => b.count - a.count);

  const qids = Object.keys(qidCount).filter(q => /^Q\d+$/.test(q));
  console.log(`  ${Object.keys(opCount).length} operator names, ${qids.length} Wikidata operators — fetching labels…`);
  const wdLabel = await wikidataLabels(qids);

  const seen = new Set();
  const systems = [];

  // Wikidata-backed systems first (most robust selector across name variants).
  for (const qid of Object.keys(qidCount)) {
    const name = qidName[qid] || wdLabel[qid] || qid;
    systems.push({ name, mode: 'wikidata', value: qid, count: qidCount[qid] });
    seen.add(name);
  }
  // Operator-name systems with no wikidata counterpart.
  for (const { name, count } of opRows) {
    if (nameToQid[name] || seen.has(name)) continue;
    systems.push({ name, mode: 'operator', value: name, count });
    seen.add(name);
  }

  systems.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const out = {
    meta: {
      source: 'OpenStreetMap US Layercake POI extract (data.openstreetmap.us), US boundary relation 148838, enriched with Wikidata labels',
      generated: new Date().toISOString().slice(0, 10),
      boundary: 'United States (OSM relation 148838)',
      totalSystems: systems.length
    },
    systems
  };
  const dest = join(ROOT, 'data', 'us-library-systems.json');
  // One system per line (still valid JSON) so weekly git diffs touch only the
  // lines that actually changed, instead of rewriting one giant line.
  const json = '{\n' +
    `"meta": ${JSON.stringify(out.meta)},\n` +
    '"systems": [\n' +
    systems.map(s => JSON.stringify(s)).join(',\n') +
    '\n]\n}\n';
  writeFileSync(dest, json);
  console.log(`Wrote ${systems.length} systems -> ${dest}`);
}

main().catch(e => { console.error(e); process.exit(1); });
