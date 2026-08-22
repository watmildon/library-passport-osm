// overpass-source.mjs — shared Overpass access for the data pipeline.
//
// The pipeline's primary data source is a private Overpass instance (minutely
// OSM replication, no rate limits). Its URL is a secret and must never land in
// git or in CI logs, so:
//   - the endpoint is resolved from the OVERPASS_URL env var (in CI, populated
//     from the OVERPASS_PRIMARY_URL repository secret) or a gitignored
//     .overpass-url file in the repo root;
//   - nothing in this module ever prints the URL or its host. GitHub Actions
//     only masks the exact secret string, so even logging the hostname would
//     leak it.
//
// When no endpoint is configured, callers fall back to their Layercake/DuckDB
// path (see scripts/README.md).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { country } from '../js/countries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const DEFAULT_USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; data build)';

// The configured Overpass endpoint: OVERPASS_URL env var, else .overpass-url in
// the repo root, else null. With { required: true }, exits with guidance instead
// of returning null.
export function overpassEndpoint({ required = false } = {}) {
  if (process.env.OVERPASS_URL?.trim()) return process.env.OVERPASS_URL.trim();
  const f = join(ROOT, '.overpass-url');
  if (existsSync(f)) {
    const url = readFileSync(f, 'utf8').trim();
    if (url) return url;
  }
  if (required) {
    console.error('No Overpass endpoint configured. Set OVERPASS_URL or create a');
    console.error('.overpass-url file in the repo root (it is gitignored).');
    process.exit(1);
  }
  return null;
}

// POST one Overpass QL query, returning parsed JSON. `maxSeconds` should be at
// least the query's own [timeout:] so the server, not the socket, decides.
export async function overpassQuery(endpoint, query, { maxSeconds = 360, userAgent = DEFAULT_USER_AGENT } = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(maxSeconds * 1000)
  });
  if (!res.ok) throw new Error(`Overpass -> HTTP ${res.status}`);
  return res.json();
}

// The instance's data timestamp (osm3s.timestamp_osm_base, ISO UTC), via the
// cheapest possible query.
export async function overpassTimestamp(endpoint) {
  const json = await overpassQuery(endpoint, '[out:json][timeout:60];out count;', { maxSeconds: 90 });
  return json.osm3s?.timestamp_osm_base || null;
}

// Every library in a country with full tags and a point coordinate (`out
// center` gives ways/relations their centroid). Returns { elements, timestamp }.
// US: ~19k elements / ~9 MB / ~2 minutes as of 2026-08.
export async function fetchLibraryElements(endpoint, countryCode = 'US') {
  const c = country(countryCode);
  const q = `[out:json][timeout:300];
area(${c.areaId})->.us;
nwr[amenity=library](area.us);
out center tags;`;
  const json = await overpassQuery(endpoint, q, { maxSeconds: 330 });
  return { elements: json.elements || [], timestamp: json.osm3s?.timestamp_osm_base || null };
}

// State/province assignment for every library in a country:
// Map('n123'|'w456'|'r789' -> region name, e.g. "Washington" or "Ontario").
// One foreach query over the admin_level=4 areas that carry the country's
// ISO3166-2 prefix (US: 50 states + DC + PR/GU/AS/VI/MP; CA: 13 provinces and
// territories); each iteration emits the region area as a marker, then the ids
// of the libraries inside it. A borderline library contained by two region
// polygons keeps the alphabetically-first name, mirroring the Layercake SQL's
// min(state). US: ~2.5 minutes as of 2026-08.
export async function fetchStateAssignments(endpoint, countryCode = 'US') {
  const c = country(countryCode);
  const q = `[out:json][timeout:480];
area[boundary=administrative][admin_level=4]["ISO3166-2"~"^${c.iso3166Prefix}"]->.states;
foreach.states->.st(
  .st out;
  nwr[amenity=library](area.st);
  out ids;
);`;
  const json = await overpassQuery(endpoint, q, { maxSeconds: 520 });
  const byEl = new Map();
  let state = null;
  for (const el of json.elements || []) {
    // Prefer name:en — bilingual regions carry dual/multiscript `name` values
    // ("New Brunswick / Nouveau-Brunswick", "ᓄᓇᕗᑦ Nunavut") that are a mess to
    // display and to key abbreviation maps on. All US states and Canadian
    // provinces carry name:en as of 2026-08.
    if (el.type === 'area') { state = el.tags?.['name:en'] || el.tags?.name || null; continue; }
    if (!state) continue;
    const key = el.type[0] + el.id;
    const prev = byEl.get(key);
    if (!prev || state < prev) byEl.set(key, state);
  }
  return byEl;
}
