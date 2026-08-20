// overpass.js — fetch library data from the Overpass API and normalise it to GeoJSON.

import { overpassEndpoint, OVERPASS_TIMEOUT_MS } from './config.js';

// The public Overpass servers are busy: expensive queries routinely 504 or get
// their connection dropped (which browsers report as a CORS failure). The
// biggest lever is keeping the query cheap — evaluating the US boundary area
// (relation 148838) costs the server ~10-15s alone, so it's avoided entirely:
//
//  - operator:wikidata is globally unique to one operator, so that mode needs
//    no US scoping at all;
//  - operator names are US-scoped with cheap bounding boxes instead of the
//    boundary polygon. Four boxes cover the states + territories (CONUS/AK/HI/
//    PR/VI, the western Aleutians across the antimeridian, GU/MP, AS).
//
// Overpass bbox order is (south, west, north, east).
const US_BBOXES = [
  '(17.5,-180,71.5,-64)',        // CONUS + Alaska + Hawaii + Puerto Rico + USVI
  '(51,170,73,180)',             // western Aleutians (across the antimeridian)
  '(12,140,21,147)',             // Guam + Northern Mariana Islands
  '(-14.7,-171.2,-13.8,-169.2)'  // American Samoa
];

// Build an Overpass QL query selecting libraries for one operator (name or
// wikidata).
export function buildQuery(mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (mode === 'wikidata') {
    return `[out:json][timeout:30];
nwr["operator:wikidata"="${esc}"][amenity=library];
out center tags;`;
  }
  return `[out:json][timeout:30];
(
${US_BBOXES.map(bb => `  nwr["operator"="${esc}"][amenity=library]${bb};`).join('\n')}
);
out center tags;`;
}

// Fetch libraries plus response metadata from the configured endpoint. Throws
// on a bad status, a network/CORS error, or OVERPASS_TIMEOUT_MS elapsing — the
// caller surfaces that rather than silently retrying somewhere else. Returns
// { features, osmBase } — osmBase is the server's data timestamp, worth showing
// because public mirrors can lag OSM by weeks.
export async function fetchLibrariesMeta(mode, value) {
  const body = 'data=' + encodeURIComponent(buildQuery(mode, value));
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
export async function fetchLibraries(mode, value) {
  return (await fetchLibrariesMeta(mode, value)).features;
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
