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

// ---- Big-city open-data branch layers (OGL-family, authoritative coords) ---
//
// Each city's open-data portal publishes its library system's branches with
// coordinates — a straight ingest, no geocoding. Bookmobiles/virtual services
// are filtered out; the matcher only wants physical buildings.

// Toronto Public Library — open.toronto.ca "Library Branch General Information".
const TPL_GEOJSON = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/f5aa9b07-da35-45e6-b31f-d6790eb9bd9b/resource/5f4950b4-c727-4e54-8d0d-972e198268d6/download/tpl-branch-general-information-4326.geojson';

async function fetchToronto() {
  const res = await fetch(TPL_GEOJSON, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Toronto GeoJSON -> HTTP ${res.status}`);
  const feats = (await res.json()).features || [];
  const outlets = [];
  for (const f of feats) {
    const p = f.properties || {};
    if (String(p.PhysicalBranch) !== '1') continue;   // bookmobiles, Answerline, staff units
    const c = f.geometry?.coordinates;
    const [lon, lat] = f.geometry?.type === 'MultiPoint' ? (c?.[0] ?? []) : (c ?? []);
    if (lat == null || !p.BranchCode) continue;
    outlets.push({
      id: `ON-TPL-${p.BranchCode}`,
      fscskey: 'ON-TPL',
      system: 'Toronto Public Library',
      state: 'ON',
      name: p.BranchName || p.BranchCode,
      addr: (p.Address || '').split(',')[0].trim(),   // "1515 Albion Road, Toronto, ON, M9V 1B2"
      city: 'Toronto',
      zip: p.PostalCode || '',
      phone: p.Telephone || '',
      website: p.Website || '',
      type: 'BR',
      lat: r5(lat), lon: r5(lon),
      geo: 'E', geomtype: 'POINTADDRESS'
    });
  }
  if (outlets.length < 80) throw new Error(`Toronto returned only ${outlets.length} physical branches (expected ~100) — refusing a gutted ingest.`);
  return { outlets, source: 'City of Toronto open data — Library Branch General Information', license: 'Open Government Licence - Toronto' };
}

// Ottawa Public Library — open.ottawa.ca "Ottawa Public Library Locations 2024".
const OPL_QUERY = 'https://services.arcgis.com/G6F8XLCl5KtAlZ2G/arcgis/rest/services/Ottawa_Public_Library_Locations_2024/FeatureServer/0/query?where=1%3D1&outFields=Name,Street_Address,City,Postal_Code&f=geojson';

async function fetchOttawa() {
  const res = await fetch(OPL_QUERY, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Ottawa FeatureServer -> HTTP ${res.status}`);
  const feats = (await res.json()).features || [];
  const outlets = [];
  for (const f of feats) {
    const p = f.properties || {};
    if (!p.Name || /bookmobile|mobile library/i.test(p.Name)) continue;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lat == null) continue;
    outlets.push({
      id: `ON-OPL-${slug(p.Name)}`,
      fscskey: 'ON-OPL',
      system: 'Ottawa Public Library',
      state: 'ON',
      name: p.Name,
      addr: p.Street_Address || '',
      city: p.City || 'Ottawa',
      zip: p.Postal_Code || '',
      phone: '',
      website: '',
      type: 'BR',
      lat: r5(lat), lon: r5(lon),
      geo: 'E', geomtype: 'POINTADDRESS'
    });
  }
  if (outlets.length < 25) throw new Error(`Ottawa returned only ${outlets.length} locations (expected ~33) — refusing a gutted ingest.`);
  return { outlets, source: 'City of Ottawa open data — Ottawa Public Library Locations 2024', license: 'City of Ottawa Open Data Licence 2.0 (OGL-family)' };
}

// Hamilton Public Library — open.hamilton.ca "Libraries". The layer may still
// carry a since-closed branch (e.g. Greensville); the closure-suppression pass
// (Wikidata P3999/P576 + OSM lifecycle tags) is the mechanism for those.
const HPL_QUERY = 'https://services.arcgis.com/rYz782eMbySr2srL/arcgis/rest/services/Libraries/FeatureServer/1/query?where=1%3D1&outFields=NAME,ADDRESS,COMMUNITY&f=geojson';

async function fetchHamilton() {
  const res = await fetch(HPL_QUERY, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Hamilton FeatureServer -> HTTP ${res.status}`);
  const feats = (await res.json()).features || [];
  const outlets = [];
  for (const f of feats) {
    const p = f.properties || {};
    if (!p.NAME || /bookmobile|mobile library/i.test(p.NAME)) continue;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lat == null) continue;
    outlets.push({
      id: `ON-HPL-${slug(p.NAME)}`,
      fscskey: 'ON-HPL',
      system: 'Hamilton Public Library',
      state: 'ON',
      name: p.NAME,
      addr: p.ADDRESS || '',
      city: p.COMMUNITY || 'Hamilton',
      zip: '',
      phone: '',
      website: '',
      type: 'BR',
      lat: r5(lat), lon: r5(lon),
      geo: 'E', geomtype: 'POINTADDRESS'
    });
  }
  if (outlets.length < 18) throw new Error(`Hamilton returned only ${outlets.length} locations (expected ~23) — refusing a gutted ingest.`);
  return { outlets, source: 'City of Hamilton open data — Libraries', license: 'City of Hamilton Open Data Licence (OGL-family)' };
}

// Winnipeg Public Library — data.winnipeg.ca "Library" (Socrata).
const WPL_URL = 'https://data.winnipeg.ca/resource/bt47-pkkm.json?$limit=100';

async function fetchWinnipeg() {
  const res = await fetch(WPL_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Winnipeg Socrata -> HTTP ${res.status}`);
  const rows = await res.json();
  const outlets = [];
  for (const r of rows) {
    if (!r.name || /bookmobile|mobile library/i.test(r.name)) continue;
    const [lon, lat] = r.point?.coordinates ?? [];
    if (lat == null || !r.complex_id) continue;
    outlets.push({
      id: `MB-WPL-${r.complex_id}`,
      fscskey: 'MB-WPL',
      system: 'Winnipeg Public Library',
      state: 'MB',
      name: r.name,
      addr: r.address || '',
      city: 'Winnipeg',
      zip: '',
      phone: '',
      website: r.website?.url || '',
      type: 'BR',
      lat: r5(lat), lon: r5(lon),
      geo: 'E', geomtype: 'POINTADDRESS'
    });
  }
  if (outlets.length < 15) throw new Error(`Winnipeg returned only ${outlets.length} branches (expected ~20) — refusing a gutted ingest.`);
  return { outlets, source: 'City of Winnipeg open data — Library', license: 'Open Government Licence - Winnipeg' };
}

// ---- NS: archived branches dataset (committed snapshot) --------------------
//
// Nova Scotia's "Public Library Branches and Contact Information" Socrata
// dataset was retired from data.novascotia.ca in 2026 with no replacement; the
// committed snapshot is the Wayback Machine's Sept-2024 GeoJSON capture (data
// version 2023-05, published under the NS Open Government Licence). Each
// region's HQ row carries the system's full name; only Branch rows become
// outlets (HQ rows are admin offices).
const NS_SNAPSHOT = join(ROOT, 'data', 'sources', 'ns-library-branches-2024.geojson');

function fetchNS() {
  const feats = JSON.parse(readFileSync(NS_SNAPSHOT, 'utf8')).features || [];
  const systemName = new Map();   // region_id -> full system name, from HQ rows
  for (const f of feats) {
    const p = f.properties || {};
    if (p.type === 'HQ' && p.region_id) systemName.set(p.region_id, p.name.replace(/\s*\(HQ\)$/, ''));
  }
  const outlets = [];
  for (const f of feats) {
    const p = f.properties || {};
    if (p.type !== 'Branch' || !f.geometry || !p.loc_id) continue;
    const [lon, lat] = f.geometry.coordinates;
    outlets.push({
      id: `NS-${p.loc_id}`,
      fscskey: `NS-${p.region_id}`,
      system: systemName.get(p.region_id) || p.region_id,
      state: 'NS',
      name: p.name,
      addr: p.address1 || '',
      city: p.city || '',
      zip: p.postal || '',
      phone: p.phone || '',
      website: p.link?.url?.replace(/^http:\/\/web\.archive\.org\/web\/\d+\//, '') || '',
      type: 'BR',
      lat: r5(lat), lon: r5(lon),
      geo: 'E', geomtype: 'POINTADDRESS'
    });
  }
  if (outlets.length < 60) throw new Error(`NS snapshot yielded only ${outlets.length} branches (expected ~79) — file damaged?`);
  return { outlets, source: 'Nova Scotia open data — Public Library Branches (Wayback capture 2024-09 of the retired dataset, data 2023-05)', license: 'Nova Scotia Open Government Licence' };
}

async function main() {
  console.log('Fetching BC service points (BC Geographic Warehouse WFS)…');
  const bc = await fetchBC();
  const bcSystems = new Set(bc.outlets.map(o => o.fscskey));
  console.log(`  BC: ${bc.outlets.length} outlets across ${bcSystems.size} systems, data as of ${bc.asOf}`);

  console.log('Fetching ON single-outlet systems (Annual Survey of Public Libraries)…');
  const on = await fetchON();

  console.log('Fetching city branch layers (Toronto, Ottawa, Hamilton, Winnipeg)…');
  const tpl = await fetchToronto();
  console.log(`  Toronto: ${tpl.outlets.length} branches`);
  const opl = await fetchOttawa();
  console.log(`  Ottawa: ${opl.outlets.length} branches`);
  const hpl = await fetchHamilton();
  console.log(`  Hamilton: ${hpl.outlets.length} branches`);
  const wpl = await fetchWinnipeg();
  console.log(`  Winnipeg: ${wpl.outlets.length} branches`);

  console.log('Loading NS archived branches snapshot…');
  const ns = fetchNS();
  const nsSystems = new Set(ns.outlets.map(o => o.fscskey));
  console.log(`  NS: ${ns.outlets.length} branches across ${nsSystems.size} systems`);

  // One sourceDate for the file: the newest live-feed asOf date (static survey
  // releases contribute no date — their bump comes from pinning a new release).
  const sourceDate = bc.asOf || new Date().toISOString().slice(0, 10);
  const committed = committedSourceDate(DEST);
  if (!FORCE && committed && committed >= sourceDate) {
    console.log(`  committed data source ${committed} is not older than ${sourceDate} — skipping write (use --force to override).`);
    return;
  }

  const outlets = [
    ...bc.outlets, ...on.outlets,
    ...tpl.outlets, ...opl.outlets, ...hpl.outlets,
    ...wpl.outlets, ...ns.outlets
  ].sort((a, b) => a.id.localeCompare(b.id));
  const src = x => ({ source: x.source, license: x.license, outlets: x.outlets.length });
  const meta = {
    source: 'Canadian provincial open data (per-province sources in meta.provinces)',
    generated: new Date().toISOString().slice(0, 10),
    sourceDate,
    provinces: {
      BC: { source: bc.source, license: bc.license, asOf: bc.asOf, outlets: bc.outlets.length, systems: bcSystems.size },
      ON: {
        outlets: on.outlets.length + tpl.outlets.length + opl.outlets.length + hpl.outlets.length,
        sources: [
          { ...src(on), year: on.year },
          src(tpl), src(opl), src(hpl)
        ]
      },
      MB: src(wpl),
      NS: { ...src(ns), systems: nsSystems.size }
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
