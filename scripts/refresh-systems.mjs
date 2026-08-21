#!/usr/bin/env node
// refresh-systems.mjs — regenerate a country's systems file (default
// data/us-library-systems.json; --country=CA for data/ca-library-systems.json)
// from Overpass. This is the PRIMARY systems-list build, run daily by the
// update-systems workflow against the private instance; build-systems.mjs
// (Layercake/DuckDB) is the manual fallback — US only, since Layercake is a
// US-extract.
//
// It shares all aggregation / labelling / output with the Layercake path
// (systems-core.mjs), so the file shape is identical — only the data source and
// its provenance differ.
//
// The Overpass endpoint resolution (OVERPASS_URL env var, else a gitignored
// .overpass-url file) lives in overpass-source.mjs; in CI the env var is
// populated from the OVERPASS_PRIMARY_URL repository secret.
//
// Freshness gate: the committed file records the snapshot date it was built
// from. This script asks Overpass for its data timestamp and only regenerates
// when Overpass is newer, so an accidental rerun won't clobber a fresher
// commit or churn the file for no reason. Pass --force to skip the gate.
//
// Usage:
//   node scripts/refresh-systems.mjs                # gated, US
//   node scripts/refresh-systems.mjs --force         # ignore the freshness gate
//   node scripts/refresh-systems.mjs --country=CA    # another country from js/countries.js
//   OVERPASS_URL=https://my-overpass/api/interpreter node scripts/refresh-systems.mjs

import { writeSystems, USER_AGENT, committedSourceDate, toISODate, systemsPath } from './systems-core.mjs';
import { overpassEndpoint, overpassQuery, overpassTimestamp } from './overpass-source.mjs';
import { country } from '../js/countries.js';

const FORCE = process.argv.includes('--force');
const countryArg = process.argv.find(a => a.startsWith('--country='));
const COUNTRY = country((countryArg ? countryArg.split('=')[1] : 'US').toUpperCase());

async function main() {
  const endpoint = overpassEndpoint({ required: true });
  // Never print the endpoint or its host — in CI it comes from a secret, and
  // GitHub only masks the exact secret string in logs.
  console.log('Using the configured Overpass endpoint.');

  // 1) Freshness gate — compare Overpass's data timestamp to the committed file
  //    before doing the big query. (writeSystems enforces the same gate again.)
  // timestamp_osm_base is UTC (e.g. 2026-07-23T02:00:00Z); toISODate keeps it UTC.
  const overpassDate = toISODate(await overpassTimestamp(endpoint));
  if (!overpassDate) throw new Error('Could not read Overpass data timestamp — aborting.');
  const committed = committedSourceDate(systemsPath(COUNTRY.code));
  console.log(`  ${COUNTRY.code}: committed data source: ${committed ?? '(none)'} · Overpass data: ${overpassDate}`);

  if (!FORCE && committed && committed >= overpassDate) {
    console.log('Committed data is not older than Overpass — nothing to do. (Use --force to override.)');
    return;
  }

  // 2) Fetch all the country's libraries and aggregate operator / operator:wikidata.
  console.log(`Querying Overpass for ${COUNTRY.code} libraries…`);
  const query = `[out:json][timeout:180];
area(${COUNTRY.areaId})->.us;
nwr[amenity=library](area.us);
out tags;`;
  const json = await overpassQuery(endpoint, query, { maxSeconds: 210, userAgent: USER_AGENT });
  const elements = json.elements || [];
  console.log(`  ${elements.length} ${COUNTRY.code} libraries`);

  if (elements.length < COUNTRY.minLibraries) {
    throw new Error(`Only ${elements.length} libraries returned (expected >= ${COUNTRY.minLibraries}) — refusing to write a gutted list.`);
  }

  // Group into { operator, wikidata, count } rows like the Layercake SQL emits.
  const groups = new Map();
  for (const el of elements) {
    const t = el.tags || {};
    const key = (t.operator ?? '\u0000') + '\u0001' + (t['operator:wikidata'] ?? '\u0000');
    let g = groups.get(key);
    if (!g) {
      g = { operator: t.operator ?? null, wikidata: t['operator:wikidata'] ?? null, count: 0 };
      groups.set(key, g);
    }
    g.count++;
  }
  const rows = [...groups.values()].filter(r => r.operator || r.wikidata);

  await writeSystems(rows, {
    country: COUNTRY.code,
    // Deliberately generic — never record the (private) Overpass instance URL.
    source: `Overpass, ${COUNTRY.code} boundary relation ${COUNTRY.boundaryRelation}, enriched with Wikidata labels`,
    sourceDate: overpassDate,
    force: FORCE
  });
}

main().catch(e => { console.error(e); process.exit(1); });
