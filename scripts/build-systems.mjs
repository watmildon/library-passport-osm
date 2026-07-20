#!/usr/bin/env node
// build-systems.mjs — regenerate data/us-library-systems.json
//
// Pulls every operator= and operator:wikidata= value on amenity=library within
// the US (OSM boundary relation 148838) from QLever's osm-planet SPARQL endpoint,
// enriches Wikidata-only entries with English labels from the Wikidata Query
// Service, and writes a ranked, de-duplicated system list for the onboarding picker.
//
// Usage:  node scripts/build-systems.mjs
//
// No dependencies — uses global fetch (Node 18+). Run from the repo root.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QLEVER = 'https://qlever.dev/api/osm-planet';
const WIKIDATA = 'https://query.wikidata.org/sparql';
const US_RELATION = 'osmrel:148838';

const OPS_QUERY = `
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT ?operator (COUNT(?lib) AS ?count) WHERE {
  ${US_RELATION} ogc:sfContains ?lib .
  ?lib osmkey:amenity "library" .
  ?lib osmkey:operator ?operator .
}
GROUP BY ?operator ORDER BY DESC(?count)`;

const WD_QUERY = `
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT ?wd ?operator (COUNT(?lib) AS ?count) WHERE {
  ${US_RELATION} ogc:sfContains ?lib .
  ?lib osmkey:amenity "library" .
  ?lib osmkey:operator:wikidata ?wd .
  OPTIONAL { ?lib osmkey:operator ?operator . }
}
GROUP BY ?wd ?operator ORDER BY DESC(?count)`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// POST a SPARQL query, retrying a few times on transient failures so the weekly
// GitHub Action doesn't fail on a momentary endpoint hiccup.
async function sparql(endpoint, query, ua, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          ...(ua ? { 'User-Agent': ua } : {})
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      return (await res.json()).results.bindings;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const wait = 2000 * (i + 1);
        console.warn(`  request failed (${e.message}) — retrying in ${wait / 1000}s…`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// Fetch English labels for a set of Q-ids from the Wikidata Query Service.
async function wikidataLabels(qids) {
  if (!qids.length) return {};
  const values = qids.map(q => 'wd:' + q).join(' ');
  const query = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?label WHERE {
  VALUES ?item { ${values} }
  ?item rdfs:label ?label . FILTER(LANG(?label) = 'en')
}`;
  const rows = await sparql(WIKIDATA, query, 'library-passport-osm/1.0 (build-systems)');
  const out = {};
  for (const r of rows) out[r.item.value.split('/').pop()] = r.label.value;
  return out;
}

async function main() {
  console.log('Querying QLever for US library operators…');
  const ops = await sparql(QLEVER, OPS_QUERY);
  console.log(`  ${ops.length} distinct operator names`);

  console.log('Querying QLever for US operator:wikidata…');
  const wds = await sparql(QLEVER, WD_QUERY);

  const qids = [...new Set(wds.map(x => x.wd.value))].filter(q => /^Q\d+$/.test(q));
  console.log(`  ${qids.length} distinct Wikidata operators — fetching labels…`);
  const wdLabel = await wikidataLabels(qids);

  // operator-name -> qid, so we can prefer the wikidata selector where both exist.
  const nameToQid = {};
  const qidCount = {};
  const qidName = {};
  for (const x of wds) {
    const qid = x.wd.value, c = +x.count.value;
    qidCount[qid] = (qidCount[qid] || 0) + c;
    if (x.operator) { nameToQid[x.operator.value] = qid; qidName[qid] ||= x.operator.value; }
  }

  const seen = new Set();
  const systems = [];

  // Wikidata-backed systems first (most robust selector across name variants).
  for (const qid of Object.keys(qidCount)) {
    const name = qidName[qid] || wdLabel[qid] || qid;
    systems.push({ name, mode: 'wikidata', value: qid, count: qidCount[qid] });
    seen.add(name);
  }
  // Operator-name systems with no wikidata counterpart.
  for (const x of ops) {
    const name = x.operator.value;
    if (nameToQid[name] || seen.has(name)) continue;
    systems.push({ name, mode: 'operator', value: name, count: +x.count.value });
    seen.add(name);
  }

  systems.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const out = {
    meta: {
      source: 'QLever osm-planet SPARQL (US boundary relation 148838), enriched with Wikidata labels',
      generated: new Date().toISOString().slice(0, 10),
      boundary: 'United States (OSM relation 148838)',
      totalSystems: systems.length
    },
    systems
  };
  const dest = join(ROOT, 'data', 'us-library-systems.json');
  writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${systems.length} systems -> ${dest}`);
}

main().catch(e => { console.error(e); process.exit(1); });
