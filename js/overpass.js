// overpass.js — fetch library data from the Overpass API and normalise it to GeoJSON.

import { overpassEndpoints } from './config.js';

// Overpass area id for the United States boundary (OSM relation 148838).
// Overpass derives area ids from relations by adding 3600000000.
const US_AREA_ID = 3600148838;

// Build an Overpass QL query selecting libraries for one operator (name or
// wikidata), constrained to the United States so common operator names or
// Wikidata IDs reused abroad don't pull in foreign libraries.
export function buildQuery(mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const selector = mode === 'wikidata'
    ? `["operator:wikidata"="${esc}"]`
    : `["operator"="${esc}"]`;
  return `[out:json][timeout:60];
area(${US_AREA_ID})->.us;
(
  nwr${selector}[amenity=library](area.us);
);
out center tags;`;
}

// Fetch libraries, trying mirrors in order if the first fails.
export async function fetchLibraries(mode, value) {
  const body = 'data=' + encodeURIComponent(buildQuery(mode, value));
  let lastErr;
  for (const url of overpassEndpoints()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!res.ok) { lastErr = new Error('Overpass returned ' + res.status); continue; }
      const json = await res.json();
      return elementsToFeatures(json.elements || []);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
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
        name: tags.name || tags['name:en'] || 'Unnamed library',
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
