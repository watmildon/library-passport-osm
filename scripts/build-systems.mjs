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

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeSystems, layercakeModified, toISODate, committedSourceDate } from './systems-core.mjs';

const FORCE = process.argv.includes('--force');

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_FILE = join(HERE, 'us-library-operators.sql');
const DUCKDB = process.env.DUCKDB || 'duckdb';

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

// ---- Build ---------------------------------------------------------------

async function main() {
  // Layercake's snapshot timestamp gates the whole (expensive) rebuild: skip if
  // our committed data already comes from an equal-or-newer source.
  const sourceModified = await layercakeModified();
  const sourceDate = toISODate(sourceModified);
  if (!sourceDate) throw new Error('Could not read Layercake Last-Modified — aborting.');

  const committed = committedSourceDate();
  if (!FORCE && committed && committed >= sourceDate) {
    console.log(`Committed data source ${committed} is not older than Layercake ${sourceDate} — nothing to do. (Use --force to override.)`);
    return;
  }

  console.log('Querying Layercake (via DuckDB) for US library operators…');
  const rows = queryLayercake();
  console.log(`  ${rows.length} (operator, wikidata) groups`);

  await writeSystems(rows, {
    source: 'Layercake (OpenStreetMap US), US boundary relation 148838, enriched with Wikidata labels',
    sourceDate,
    sourceModified,
    force: FORCE
  });
}

main().catch(e => { console.error(e); process.exit(1); });
