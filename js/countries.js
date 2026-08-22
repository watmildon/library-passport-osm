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
    // The country's own Wikidata item (P17 pin for country-scoped queries).
    wikidataQid: 'Q30',
    systemsFile: 'data/us-library-systems.json',
    qaFile: 'data/qa-data.json',
    // National per-outlet census backing the PLS matching/augment stages.
    // Countries without one skip those stages (the QA build handles that).
    outletsFile: 'data/pls-outlets.json',
    // Default QA-map view when the URL carries none.
    mapCenter: [-98, 40],
    mapZoom: 4,
    // Ambiguous-operator clustering (QA "shared operators" pane): max
    // single-linkage distance between branches of one system, and whether one
    // system's branches may span state/province borders.
    clusterKm: 120,
    regionBoundSystems: false,
    // Full region name (as OSM spells the admin_level=4 boundary) -> postal
    // abbreviation, for compact display in the QA filters.
    regionAbbr: {
      Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
      Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
      Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
      Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
      Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
      Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
      'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
      'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
      Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
      'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
      Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
      Wyoming: 'WY', 'Puerto Rico': 'PR', Guam: 'GU', 'American Samoa': 'AS',
      'United States Virgin Islands': 'VI', 'Northern Mariana Islands': 'MP'
    },
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
    wikidataQid: 'Q16',
    systemsFile: 'data/ca-library-systems.json',
    qaFile: 'data/ca-qa-data.json',
    // No national per-outlet census (nothing like IMLS PLS exists federally);
    // a province-assembled outlets file is planned — see the repo docs.
    outletsFile: null,
    mapCenter: [-96, 55],
    mapZoom: 3.5,
    // Canadian regional/provincial systems legitimately space branches far
    // apart (sparse north), and public library systems are creatures of
    // provincial law — one system never crosses a provincial border. So: a
    // generous in-province linkage distance, and never link across provinces.
    clusterKm: 300,
    regionBoundSystems: true,
    // Canada Post abbreviations. Keys cover both English and the bilingual /
    // French spellings OSM uses for some boundary names.
    regionAbbr: {
      Alberta: 'AB', 'British Columbia': 'BC', 'Colombie-Britannique': 'BC',
      Manitoba: 'MB', 'New Brunswick': 'NB', 'Nouveau-Brunswick': 'NB',
      'New Brunswick / Nouveau-Brunswick': 'NB',
      'Newfoundland and Labrador': 'NL', 'Terre-Neuve-et-Labrador': 'NL',
      'Northwest Territories': 'NT', 'Territoires du Nord-Ouest': 'NT',
      'Nova Scotia': 'NS', 'Nouvelle-Écosse': 'NS',
      Nunavut: 'NU', 'ᓄᓇᕗᑦ Nunavut': 'NU', Ontario: 'ON',
      'Prince Edward Island': 'PE', 'Île-du-Prince-Édouard': 'PE',
      Quebec: 'QC', 'Québec': 'QC',
      Saskatchewan: 'SK', Yukon: 'YT'
    },
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
