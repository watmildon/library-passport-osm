// systems-core.mjs — shared pipeline for data/us-library-systems.json.
//
// Both build paths — build-systems.mjs (Layercake/DuckDB) and refresh-systems.mjs
// (dev Overpass) — produce the same `{ operator, wikidata, count }` rows and hand
// them here. This module does the aggregation, Wikidata label enrichment, ranking,
// and byte-stable serialization so the two paths yield identical output shape.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const DEST = join(ROOT, 'data', 'us-library-systems.json');

export const USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; systems-list build)';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const LAYERCAKE_POIS_URL = 'https://data.openstreetmap.us/layercake/pois.parquet';

// The Layercake POI extract's Last-Modified header (its snapshot timestamp), or
// null if unavailable. HEAD request — no download.
export async function layercakeModified() {
  try {
    const res = await fetch(LAYERCAKE_POIS_URL, { method: 'HEAD' });
    return res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

// English labels for a set of Q-ids from the Wikidata Query Service.
export async function wikidataLabels(qids) {
  if (!qids.length) return {};
  const values = qids.map(q => 'wd:' + q).join(' ');
  const query = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?label WHERE {
  VALUES ?item { ${values} }
  ?item rdfs:label ?label . FILTER(LANG(?label) = 'en')
}`;

  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
          'User-Agent': USER_AGENT
        },
        body: 'query=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error(`Wikidata -> HTTP ${res.status}`);
      const rows = (await res.json()).results.bindings;
      const out = {};
      for (const r of rows) out[r.item.value.split('/').pop()] = r.label.value;
      return out;
    } catch (e) {
      lastErr = e;
      if (i < 4) {
        const wait = 5000 * (i + 1);
        console.warn(`  Wikidata request failed (${e.message}) — retrying in ${wait / 1000}s…`);
        await sleep(wait);
      }
    }
  }
  // Labels are enrichment only — don't fail the whole build if Wikidata is down.
  console.warn(`  Giving up on Wikidata labels: ${lastErr.message}`);
  return {};
}

// Aggregate rows, enrich, rank, and write data/us-library-systems.json.
// `rows`: Array<{ operator: string|null, wikidata: string|null, count: number }>
// `source`: provenance string stored in meta.source.
// `date`: YYYY-MM-DD stamped into meta.generated (when this build ran).
// `sourceModified`: optional upstream snapshot timestamp (e.g. Layercake's
//   Last-Modified header), stamped into meta.sourceModified so a later run can
//   tell whether the upstream data actually changed. Omitted when not known.
export async function writeSystems(rows, { source, date, sourceModified }) {
  const opCount = {};
  const qidCount = {};
  const qidName = {};    // preferred operator= name seen for a qid
  const nameToQid = {};  // operator name -> qid (when co-tagged)

  for (const r of rows) {
    if (r.operator) opCount[r.operator] = (opCount[r.operator] || 0) + r.count;
    if (r.wikidata) {
      qidCount[r.wikidata] = (qidCount[r.wikidata] || 0) + r.count;
      if (r.operator) {
        qidName[r.wikidata] ||= r.operator;
        nameToQid[r.operator] = r.wikidata;
      }
    }
  }
  const opRows = Object.entries(opCount).map(([name, count]) => ({ name, count }));
  opRows.sort((a, b) => b.count - a.count);

  const qids = Object.keys(qidCount).filter(q => /^Q\d+$/.test(q));
  console.log(`  ${Object.keys(opCount).length} operator names, ${qids.length} Wikidata operators — fetching labels…`);
  const wdLabel = await wikidataLabels(qids);

  const seen = new Set();
  const systems = [];

  // Wikidata-backed systems first (most robust selector across name variants).
  for (const qid of Object.keys(qidCount)) {
    const name = qidName[qid] || wdLabel[qid] || qid;
    systems.push({ name, mode: 'wikidata', value: qid, count: qidCount[qid] });
    seen.add(name);
  }
  // Operator-name systems with no wikidata counterpart.
  for (const { name, count } of opRows) {
    if (nameToQid[name] || seen.has(name)) continue;
    systems.push({ name, mode: 'operator', value: name, count });
    seen.add(name);
  }

  systems.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const meta = {
    source,
    generated: date,
    ...(sourceModified ? { sourceModified } : {}),
    boundary: 'United States (OSM relation 148838)',
    totalSystems: systems.length
  };
  // One system per line (still valid JSON) so weekly git diffs touch only the
  // lines that actually changed, instead of rewriting one giant line.
  const json = '{\n' +
    `"meta": ${JSON.stringify(meta)},\n` +
    '"systems": [\n' +
    systems.map(s => JSON.stringify(s)).join(',\n') +
    '\n]\n}\n';
  writeFileSync(DEST, json);
  console.log(`Wrote ${systems.length} systems -> ${DEST}`);
  return systems.length;
}
