// completeness.js — assess whether a library has the OSM tags we care about.
// Used by the "Missing OSM data" filter and the popup's tag breakdown.

// The tags we consider a "complete" library entry. Each has a label (for the
// popup) and a getter that returns the present value, or '' if missing.
export const TRACKED_TAGS = [
  { key: 'operator',          label: 'operator',          get: p => p.operator },
  { key: 'operator:wikidata', label: 'operator:wikidata', get: p => p.operatorWikidata },
  { key: 'opening_hours',     label: 'opening_hours',     get: p => p.opening_hours },
  { key: 'phone',             label: 'phone',             get: p => p.phone },
  { key: 'website',           label: 'website',           get: p => p.website },
  { key: 'addr:housenumber',  label: 'addr:housenumber',  get: p => p.housenumber },
  { key: 'addr:street',       label: 'addr:street',       get: p => p.street },
  { key: 'addr:city',         label: 'addr:city',         get: p => p.city },
  { key: 'addr:postcode',     label: 'addr:postcode',     get: p => p.postcode }
];

// Split tracked tags into present / missing for a feature's properties.
export function tagBreakdown(props) {
  const present = [], missing = [];
  for (const t of TRACKED_TAGS) {
    const val = t.get(props);
    if (val) present.push({ ...t, value: val });
    else missing.push(t);
  }
  return { present, missing };
}

// A library is "complete" when no tracked tag is missing.
export function isComplete(props) {
  return TRACKED_TAGS.every(t => !!t.get(props));
}
