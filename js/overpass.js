// overpass.js — fetch library data from the Overpass API and normalise it to GeoJSON.

import { overpassEndpoint, OVERPASS_TIMEOUT_MS } from './config.js';
import { country } from './countries.js';

// The public Overpass servers are busy: expensive queries routinely 504 or get
// their connection dropped (which browsers report as a CORS failure). The
// biggest lever is keeping the query cheap — evaluating a country's boundary
// area (e.g. US relation 148838) costs the server ~10-15s alone, so it's
// avoided entirely:
//
//  - operator:wikidata is globally unique to one operator, so that mode needs
//    no country scoping at all;
//  - operator names are country-scoped with cheap bounding boxes instead of
//    the boundary polygon (per-country boxes live in countries.js).

// Build an Overpass QL query selecting libraries for one operator (name or
// wikidata) in one country (default US).
export function buildQuery(mode, value, countryCode) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (mode === 'wikidata') {
    return `[out:json][timeout:30];
nwr["operator:wikidata"="${esc}"][amenity=library];
out center tags;`;
  }
  const bboxes = country(countryCode).bboxes;
  return `[out:json][timeout:30];
(
${bboxes.map(bb => `  nwr["operator"="${esc}"][amenity=library]${bb};`).join('\n')}
);
out center tags;`;
}

// Fetch libraries plus response metadata from the configured endpoint. Throws
// on a bad status, a network/CORS error, or OVERPASS_TIMEOUT_MS elapsing — the
// caller surfaces that rather than silently retrying somewhere else. Returns
// { features, osmBase } — osmBase is the server's data timestamp, worth showing
// because public mirrors can lag OSM by weeks.
export async function fetchLibrariesMeta(mode, value, countryCode) {
  const body = 'data=' + encodeURIComponent(buildQuery(mode, value, countryCode));
  const res = await fetch(overpassEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('Overpass returned ' + res.status);
  const json = await res.json();
  return {
    features: elementsToFeatures(json.elements || []),
    osmBase: json.osm3s?.timestamp_osm_base || null
  };
}

// Back-compat wrapper: just the features.
export async function fetchLibraries(mode, value, countryCode) {
  return (await fetchLibrariesMeta(mode, value, countryCode)).features;
}

// Convert Overpass elements (node / way / relation) into GeoJSON point features.
export function elementsToFeatures(elements) {
  const feats = [];
  for (const el of elements) {
    let lon, lat;
    if (el.type === 'node') { lon = el.lon; lat = el.lat; }
    else if (el.center) { lon = el.center.lon; lat = el.center.lat; }
    else continue; // no geometry we can place
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;

    const tags = el.tags || {};
    const id = el.type[0] + el.id; // n123 / w456 / r789 — unique across types

    feats.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id,
        name: tags['name:en'] || tags.name || 'Unnamed library',
        operator: tags.operator || '',
        operatorWikidata: tags['operator:wikidata'] || '',
        opening_hours: tags.opening_hours || '',
        website: tags.website || tags['contact:website'] || '',
        phone: tags.phone || tags['contact:phone'] || '',
        housenumber: tags['addr:housenumber'] || '',
        street: tags['addr:street'] || '',
        addr: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
        city: tags['addr:city'] || '',
        postcode: tags['addr:postcode'] || '',
        osmType: el.type,
        osmId: el.id
      }
    });
  }
  feats.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return feats;
}
