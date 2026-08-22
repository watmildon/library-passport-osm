#!/usr/bin/env node
// build-ca-outlets.mjs — assemble data/ca-library-outlets.json, the Canadian
// counterpart of data/pls-outlets.json (Canada has no federal IMLS-PLS
// equivalent; public library data is provincial).
//
// Provinces are ingested from their own open-data sources, and only provinces
// with authoritative per-branch coordinates are included:
//
//   BC — BC Geographic Warehouse layer
//        WHSE_IMAGERY_AND_BASE_MAPS.GSR_PUBLIC_LIBRARY_LOCS_SV (the Geographic
//        Sites Registry's public-library service points, maintained by the
//        Ministry of Education - Libraries; ~250 points, refreshed continuously).
//        Fetched as GeoJSON over WFS. Licence: Open Government Licence – BC.
//
//   ON — the Annual Survey of Public Libraries (data.ontario.ca, OGL-Ontario).
//        System-level rows with street addresses but no coordinates or branch
//        addresses, so only SINGLE-outlet systems are ingested (E3.1+E3.2+E3.3
//        service points = 1 — the system's address IS its one branch; that is
//        174 of 359 systems, most of small-town Ontario). Addresses are
//        geocoded ONCE via OpenCage into a committed cache
//        (data/ca-geocode-cache.json), so reruns make no API calls. Only
//        building- or road-precision geocodes become outlets — a town-centroid
//        point would fabricate false "missing branch" findings.
//        Multi-branch systems (Toronto, Ottawa, …) are excluded until a
//        branch-level source exists.
//
//   QC/AB/NS — blocked on data: Quebec's survey carries no addresses, Alberta
//        publishes a PDF directory, Nova Scotia retired its branches dataset.
//
// The OpenCage key is a secret: resolved from the OPENCAGE_KEY env var or the
// gitignored .opencage-key file, and never printed. Without a key, cached
// geocodes still work; only uncached addresses are skipped (with a count).
//
// The output shape mirrors data/pls-outlets.json so pls-match.mjs and
// build-qa.mjs consume it unchanged. Two field-semantics notes:
//   • `fscskey` holds a stable synthetic system key ("BC-<system-slug>",
//     "ON-<library number>"), not a US FSCS id — the matcher only ever uses it
//     as an opaque grouping key.
//   • `geo`/`geomtype` mark coordinate precision the way isPreciseGeocode()
//     expects: registry points and building-level geocodes are
//     'E'/'POINTADDRESS' (addr:* suggestions allowed), road-level geocodes are
//     'E'/'STREETADDRESS'.
//
// Usage:
//   node scripts/build-ca-outlets.mjs           # gated on data freshness
//   node scripts/build-ca-outlets.mjs --force    # ignore the gate

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, committedSourceDate, toISODate, sleep } from './systems-core.mjs';

const DEST = join(ROOT, 'data', 'ca-library-outlets.json');
const FORCE = process.argv.includes('--force');
const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; CA outlets build)';

const r5 = x => Math.round(x * 1e5) / 1e5;

// Stable ASCII slug for system keys: accents folded, non-alphanumerics dashed.
function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---- BC: Geographic Sites Registry service points --------------------------
const BC_WFS = 'https://openmaps.gov.bc.ca/geo/pub/ows' +
  '?service=WFS&version=2.0.0&request=GetFeature' +
  '&typeName=pub:WHSE_IMAGERY_AND_BASE_MAPS.GSR_PUBLIC_LIBRARY_LOCS_SV' +
  '&outputFormat=json&count=10000&srsName=EPSG:4326';

async function fetchBC() {
  const res = await fetch(BC_WFS, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`BC WFS -> HTTP ${res.status}`);
  const json = await res.json();
  const feats = json.features || [];
  if (feats.length < 100) {
    throw new Error(`BC WFS returned only ${feats.length} service points (expected ~250) — refusing a gutted ingest.`);
  }

  let asOf = null;
  const outlets = [];
  for (const f of feats) {
    const p = f.properties || {};
    const lat = p.LATITUDE ?? f.geometry?.coordinates?.[1];
    const lon = p.LONGITUDE ?? f.geometry?.coordinates?.[0];
    if (lat == null || lon == null || !p.LIBRARY_SYSTEM_NAME) continue;
    const updated = toISODate(p.DATE_UPDATED);
    if (updated && (!asOf || updated > asOf)) asOf = updated;
    outlets.push({
      id: `BC-${p.SERVICE_POINT_ID}`,
      fscskey: `BC-${slug(p.LIBRARY_SYSTEM_NAME)}`,
      system: p.LIBRARY_SYSTEM_NAME,
      state: 'BC',
      name: p.SERVICE_POINT_NAME || p.LIBRARY_SYSTEM_NAME,
      addr: p.STREET_ADDRESS || '',
      city: p.LOCALITY || '',
      zip: p.POSTAL_CODE || '',
      phone: '',                                  // the registry carries none
      website: p.WEBSITE_URL || '',
      type: p.SERVICE_POINT_NAME === p.LIBRARY_SYSTEM_NAME ? 'CE' : 'BR',
      lat: r5(lat),
      lon: r5(lon),
      geo: 'E',
      geomtype: 'POINTADDRESS'
    });
  }
  return {
    outlets,
    asOf,
    source: 'BC Geographic Warehouse GSR_PUBLIC_LIBRARY_LOCS_SV (WFS)',
    license: 'Open Government Licence - British Columbia'
  };
}

// ---- OpenCage geocoding (one-time, cached) ---------------------------------
const CACHE_FILE = join(ROOT, 'data', 'ca-geocode-cache.json');

function opencageKey() {
  if (process.env.OPENCAGE_KEY?.trim()) return process.env.OPENCAGE_KEY.trim();
  const f = join(ROOT, '.opencage-key');
  if (existsSync(f)) {
    const k = readFileSync(f, 'utf8').trim();
    if (k) return k;
  }
  return null;
}

function loadGeocodeCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

// Geocode every query not already cached (1.1 s apart — the free-tier rate
// limit) and persist the cache after each answer so an interrupted run keeps
// what it paid for. A query with no acceptable result is cached as null so it
// is never retried against the API.
async function geocodeAll(queries) {
  const cache = loadGeocodeCache();
  const missing = queries.filter(q => !(q in cache));
  if (missing.length) {
    const key = opencageKey();
    if (!key) {
      console.warn(`  ${missing.length} address(es) not in the geocode cache and no OpenCage key configured (OPENCAGE_KEY env or .opencage-key file) — skipping them.`);
      return cache;
    }
    console.log(`  geocoding ${missing.length} uncached address(es) via OpenCage…`);
    const save = () => writeFileSync(CACHE_FILE,
      JSON.stringify(Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
    for (const [i, q] of missing.entries()) {
      const url = 'https://api.opencagedata.com/geocode/v1/json' +
        `?q=${encodeURIComponent(q)}&key=${key}&countrycode=ca&limit=1&no_annotations=1`;
      try {
        const res = await fetch(url);
        if (res.status === 402 || res.status === 401 || res.status === 403) {
          console.warn(`  OpenCage refused (HTTP ${res.status}) — stopping geocoding; cached results are kept.`);
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const hit = (await res.json()).results?.[0];
        cache[q] = hit ? {
          lat: r5(hit.geometry.lat),
          lon: r5(hit.geometry.lng),
          conf: hit.confidence ?? 0,
          type: hit.components?._type || ''
        } : null;
      } catch (e) {
        // Transient failure: leave the query uncached so a later run retries.
        console.warn(`  geocode failed for one address: ${e.message}`);
        await sleep(2000);
        continue;
      }
      save();
      if ((i + 1) % 25 === 0) console.log(`    ${i + 1}/${missing.length}…`);
      if (i < missing.length - 1) await sleep(1100);
    }
    save();
  }
  return cache;
}

// Precision gate: only point-level geocodes become outlets. The classifier
// calls an outlet with no OSM library within 200 m "missing", so an area
// centroid (postal code, town, …) would fabricate findings. OpenCage's _type
// names what it snapped to: 'building' is a rooftop/address point, and POI
// types ('library', 'school', 'townhall', …) mean it matched a mapped feature
// at that address — those are the best coordinates of all.
const AREA_TYPES = new Set([
  'postcode', 'neighbourhood', 'suburb', 'hamlet', 'village', 'town', 'city',
  'municipality', 'county', 'district', 'state', 'region', 'island', 'unknown'
]);
function geomtypeFor(g) {
  if (!g || g.conf < 9 || !g.type || AREA_TYPES.has(g.type)) return null;
  return g.type === 'road' ? 'STREETADDRESS' : 'POINTADDRESS';
}

// ---- ON: Annual Survey of Public Libraries (single-outlet systems) ---------
//
// Pinned to the newest CSV release (2024 is XLSX-only). When a new CSV year is
// published, update ON_CSV_URL / ON_YEAR — the survey's library numbers are
// stable, so outlet ids carry over.
const ON_CSV_URL = 'https://data.ontario.ca/dataset/363fff31-6a07-41eb-9922-e9b64192b08b/resource/751b0de6-9dcf-46aa-a19b-69a62e222617/download/ontario_public_library_statistics_open_data_2023.csv';
const ON_YEAR = '2023';
// Rows that operate a library. "Contracting" entries are municipalities buying
// service from a neighbour — their address is a municipal office, not a branch.
const ON_TYPES = new Set([
  'Public or Union Library',
  'First Nations Library',
  'LSB Library',
  'County, County co-operative or Regional Municipality Library'
]);

// Minimal CSV parser (quoted fields, embedded commas/newlines, BOM).
function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (f !== '' || row.length) { row.push(f); rows.push(row); row = []; f = ''; }
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function fetchON() {
  const res = await fetch(ON_CSV_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Ontario ASPL CSV -> HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const H = rows[0];
  const col = re => H.findIndex(h => re.test(h));
  const iName = col(/^Library Full Name/), iNum = col(/^Library Number/),
        iType = col(/^A1\.4/), iStreet = col(/^A1\.9/), iCity = col(/^A1\.10/),
        iPostal = col(/^A1\.12/), iWeb = col(/^A1\.13/),
        iMain = col(/^E3\.1\.SPC/), iBr12 = col(/^E3\.2\.SPC/), iBrU = col(/^E3\.3\.SPC/);
  if ([iName, iNum, iType, iStreet, iMain].some(i => i < 0)) {
    throw new Error('Ontario ASPL CSV columns changed — update the header patterns in fetchON().');
  }
  const num = x => { const v = parseFloat(String(x).replace(/,/g, '')); return Number.isFinite(v) ? v : 0; };

  // Single-outlet library operators with a street address.
  const singles = [];
  let skippedType = 0, skippedMulti = 0, skippedNoAddr = 0;
  for (const r of rows.slice(1)) {
    if (!r[iName]) continue;
    if (!ON_TYPES.has((r[iType] || '').trim())) { skippedType++; continue; }
    const sp = num(r[iMain]) + num(r[iBr12]) + num(r[iBrU]);
    if (sp !== 1) { if (sp > 1) skippedMulti++; continue; }
    const street = (r[iStreet] || '').trim();
    if (!street) { skippedNoAddr++; continue; }
    singles.push({
      name: r[iName].trim(), libNum: r[iNum].trim(),
      street, city: (r[iCity] || '').trim(), postal: (r[iPostal] || '').trim(),
      website: (r[iWeb] || '').trim()
    });
  }
  console.log(`  ON: ${singles.length} single-outlet systems (skipped: ${skippedMulti} multi-branch, ${skippedType} contracting/other, ${skippedNoAddr} without a street address)`);

  const queryOf = s => [s.street, s.city, 'Ontario', s.postal, 'Canada'].filter(Boolean).join(', ');
  const cache = await geocodeAll(singles.map(queryOf));

  const outlets = [];
  let unGeocoded = 0, imprecise = 0;
  for (const s of singles) {
    const g = cache[queryOf(s)];
    if (g === undefined) { unGeocoded++; continue; }
    const geomtype = geomtypeFor(g);
    if (!geomtype) { imprecise++; continue; }
    outlets.push({
      id: `ON-${s.libNum}`,
      fscskey: `ON-${s.libNum}`,
      system: s.name,
      state: 'ON',
      name: s.name,
      addr: s.street,
      city: s.city,
      zip: s.postal,
      phone: '',
      website: s.website,
      type: 'CE',
      lat: g.lat,
      lon: g.lon,
      geo: 'E',
      geomtype
    });
  }
  console.log(`  ON: ${outlets.length} outlets kept (${imprecise} below road precision, ${unGeocoded} not geocoded)`);
  return {
    outlets,
    asOf: null,   // a static survey release, not a live feed
    source: `Ontario Annual Survey of Public Libraries ${ON_YEAR} (data.ontario.ca), single-outlet systems, OpenCage-geocoded`,
    license: 'Open Government Licence - Ontario',
    year: ON_YEAR
  };
}

async function main() {
  console.log('Fetching BC service points (BC Geographic Warehouse WFS)…');
  const bc = await fetchBC();
  const bcSystems = new Set(bc.outlets.map(o => o.fscskey));
  console.log(`  BC: ${bc.outlets.length} outlets across ${bcSystems.size} systems, data as of ${bc.asOf}`);

  console.log('Fetching ON single-outlet systems (Annual Survey of Public Libraries)…');
  const on = await fetchON();

  // One sourceDate for the file: the newest live-feed asOf date (static survey
  // releases contribute no date — their bump comes from pinning a new release).
  const sourceDate = bc.asOf || new Date().toISOString().slice(0, 10);
  const committed = committedSourceDate(DEST);
  if (!FORCE && committed && committed >= sourceDate) {
    console.log(`  committed data source ${committed} is not older than ${sourceDate} — skipping write (use --force to override).`);
    return;
  }

  const outlets = [...bc.outlets, ...on.outlets].sort((a, b) => a.id.localeCompare(b.id));
  const meta = {
    source: 'Canadian provincial open data (per-province sources in meta.provinces)',
    generated: new Date().toISOString().slice(0, 10),
    sourceDate,
    provinces: {
      BC: { source: bc.source, license: bc.license, asOf: bc.asOf, outlets: bc.outlets.length, systems: bcSystems.size },
      ON: { source: on.source, license: on.license, year: on.year, outlets: on.outlets.length, systems: on.outlets.length }
    },
    totalOutlets: outlets.length
  };
  // One outlet per line (still valid JSON) so daily diffs touch only changed rows.
  const json = '{\n' +
    `"meta": ${JSON.stringify(meta)},\n` +
    '"outlets": [\n' +
    outlets.map(o => JSON.stringify(o)).join(',\n') +
    '\n]\n}\n';
  writeFileSync(DEST, json);
  console.log(`Wrote ${outlets.length} outlets (${Math.round(json.length / 1024)} KB) -> ${DEST}`);
}

main().catch(e => { console.error(e); process.exit(1); });
