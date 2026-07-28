#!/usr/bin/env node
// build-pls.mjs — regenerate data/pls-outlets.json from the IMLS Public
// Libraries Survey (PLS) outlet file: an authoritative federal census of US
// public library locations (public domain). Used by the QA page to find
// branches missing from OSM and untagged branches.
//
// Downloads the FY CSV zip, converts the Windows-1252 CSVs to UTF-8, runs
// pls-outlets.sql via DuckDB (central + branch outlets with coordinates), and
// writes a compact line-per-record JSON.
//
// Requirements: DuckDB CLI on PATH (or DUCKDB env var), Node 18+.
// Usage:  node scripts/build-pls.mjs [--force]
//
// PLS is published annually (~2-year lag). Update PLS_ZIP_URL + PLS_FY when a
// newer fiscal year is released. The build is gated on PLS_FY so a rerun on the
// same release is a no-op unless --force.

import { writeFileSync, readFileSync, mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SQL_FILE = join(HERE, 'pls-outlets.sql');
const DEST = join(ROOT, 'data', 'pls-outlets.json');
const DUCKDB = process.env.DUCKDB || 'duckdb';
const FORCE = process.argv.includes('--force');

// The dataset release this build targets. Bump both when a new FY is published.
const PLS_FY = '2023';
const PLS_ZIP_URL = 'https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip';
const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; PLS build)';

// Windows-1252 -> UTF-8. The IMLS CSVs contain 0x92/0x96 etc. that break UTF-8
// readers; DuckDB only accepts utf-8/latin-1/utf-16, and even latin-1 rejects
// these files, so we transcode ourselves.
function toUtf8(buf) {
  // cp1252 high-range overrides (0x80-0x9F) that differ from latin-1.
  const CP1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178
  };
  let out = '';
  for (const b of buf) out += String.fromCodePoint(b >= 0x80 && b <= 0x9F ? (CP1252[b] || b) : b);
  return Buffer.from(out, 'utf8');
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The sourceDate already committed (its PLS fiscal year), or null.
function committedFY() {
  try { return JSON.parse(readFileSync(DEST, 'utf8')).meta?.fiscalYear ?? null; }
  catch { return null; }
}

function findCsv(files, needle) {
  const f = files.find(n => n.toLowerCase().includes(needle) && n.toLowerCase().endsWith('.csv'));
  if (!f) throw new Error(`Could not find a "${needle}" CSV in the PLS zip (got: ${files.join(', ')})`);
  return f;
}

async function main() {
  if (!FORCE && committedFY() === PLS_FY) {
    console.log(`Committed PLS data is already FY${PLS_FY} — nothing to do. (Use --force to rebuild.)`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'libpass-pls-'));
  try {
    console.log(`Downloading IMLS PLS FY${PLS_FY} CSV zip…`);
    const zipPath = join(tmp, 'pls.zip');
    await download(PLS_ZIP_URL, zipPath);

    // Unzip with the system unzip (available on GitHub runners + git-bash).
    const unzipDir = join(tmp, 'csv');
    const uz = spawnSync('unzip', ['-o', '-j', zipPath, '-d', unzipDir], { encoding: 'utf8' });
    if (uz.status !== 0) throw new Error(`unzip failed: ${uz.stderr || uz.stdout}`);

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(unzipDir);
    const outletCsv = findCsv(files, 'outlet');
    const aeCsv = findCsv(files, '_ae_');

    // Transcode both to UTF-8.
    const outletU8 = join(unzipDir, 'outlet_utf8.csv');
    const aeU8 = join(unzipDir, 'ae_utf8.csv');
    writeFileSync(outletU8, toUtf8(readFileSync(join(unzipDir, outletCsv))));
    writeFileSync(aeU8, toUtf8(readFileSync(join(unzipDir, aeCsv))));

    // Run the extraction SQL.
    const outJson = join(tmp, 'outlets.json');
    const sql = readFileSync(SQL_FILE, 'utf8')
      .replaceAll('{{OUTLET}}', outletU8.replace(/\\/g, '/'))
      .replaceAll('{{AE}}', aeU8.replace(/\\/g, '/'))
      .replaceAll('{{OUT}}', outJson.replace(/\\/g, '/'));

    console.log('Extracting outlets via DuckDB…');
    const res = spawnSync(DUCKDB, [], { input: sql, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (res.error) {
      if (res.error.code === 'ENOENT') throw new Error(`DuckDB CLI not found (tried "${DUCKDB}"). Install it or set DUCKDB.`);
      throw res.error;
    }
    if (res.status !== 0) throw new Error(`DuckDB exited ${res.status}:\n${res.stderr || res.stdout}`);

    const rows = JSON.parse(readFileSync(outJson, 'utf8')).map(r => ({
      id: r.id, fscskey: r.fscskey, system: r.system_name, state: r.state,
      name: r.name, addr: r.addr, city: r.city, zip: r.zip, phone: r.phone,
      type: r.type,
      lat: Math.round(r.lat * 1e5) / 1e5, lon: Math.round(r.lon * 1e5) / 1e5,
      geo: r.geostatus, geomtype: r.geomtype, structchg: r.structchg
    }));
    if (rows.length < 10000) throw new Error(`Only ${rows.length} outlets (expected >= 10000) — refusing to write.`);

    const out = {
      meta: {
        source: `IMLS Public Libraries Survey FY${PLS_FY} outlet file (public domain)`,
        fiscalYear: PLS_FY,
        generated: new Date().toISOString().slice(0, 10),
        totalOutlets: rows.length
      },
      outlets: rows
    };
    const json = '{\n' +
      `"meta": ${JSON.stringify(out.meta)},\n` +
      '"outlets": [\n' + rows.map(r => JSON.stringify(r)).join(',\n') + '\n]\n}\n';
    writeFileSync(DEST, json);
    console.log(`Wrote ${rows.length} outlets (${Math.round(json.length / 1024)} KB) -> ${DEST}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
