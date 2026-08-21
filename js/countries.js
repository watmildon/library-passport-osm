// countries.js — per-country configuration, shared by the site (browser ES
// module) and the data pipeline (Node imports it from scripts/). Plain data
// only: no platform APIs, so it loads identically in both.
//
// Adding a country means adding an entry here, generating its systems file
// (node scripts/refresh-systems.mjs --country=XX), and wiring any UI that
// should offer it.

export const COUNTRIES = {
  US: {
    code: 'US',
    name: 'United States',
    // OSM boundary relation and its Overpass area id (relation + 3600000000).
    boundaryRelation: 148838,
    areaId: 3600148838,
    // ISO3166-2 prefix carried by admin_level=4 boundaries (states/provinces).
    iso3166Prefix: 'US-',
    systemsFile: 'data/us-library-systems.json',
    // Cheap bounding boxes for operator-name Overpass queries — evaluating the
    // boundary polygon costs public servers ~10-15s, so runtime queries use
    // boxes instead. Overpass bbox order is (south, west, north, east).
    // Four boxes: CONUS/AK/HI/PR/USVI, western Aleutians (across the
    // antimeridian), Guam + Northern Marianas, American Samoa.
    bboxes: [
      '(17.5,-180,71.5,-64)',
      '(51,170,73,180)',
      '(12,140,21,147)',
      '(-14.7,-171.2,-13.8,-169.2)'
    ],
    // Refuse to write a systems file when fewer libraries than this come back —
    // a gutted Overpass response, not a real shrink.
    minLibraries: 10000
  },
  CA: {
    code: 'CA',
    name: 'Canada',
    boundaryRelation: 1428125,
    areaId: 3601428125,
    iso3166Prefix: 'CA-',
    systemsFile: 'data/ca-library-systems.json',
    // One box covers all of Canada (Middle Island to Cape Columbia, the Yukon
    // border to Cape Spear) — no antimeridian or overseas-territory splits.
    bboxes: [
      '(41.6,-141.1,83.2,-52.5)'
    ],
    minLibraries: 1000
  }
};

export const DEFAULT_COUNTRY = 'US';

// The config for a country code, defaulting to the US. Throws on an unknown
// code rather than silently falling back — a typo should fail loudly.
export function country(code) {
  const c = COUNTRIES[code || DEFAULT_COUNTRY];
  if (!c) throw new Error(`Unknown country code: ${code}`);
  return c;
}
