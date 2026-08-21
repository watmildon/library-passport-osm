// systems-core.mjs — shared pipeline for the per-country systems files
// (data/us-library-systems.json, data/ca-library-systems.json).
//
// Both build paths — build-systems.mjs (Layercake/DuckDB) and refresh-systems.mjs
// (dev Overpass) — produce the same `{ operator, wikidata, count }` rows and hand
// them here. This module does the aggregation, Wikidata label enrichment, ranking,
// and byte-stable serialization so the two paths yield identical output shape.

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { country } from '../js/countries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

// Absolute path of a country's systems file (data/us-library-systems.json,
// data/ca-library-systems.json, …).
export function systemsPath(countryCode = 'US') {
  return join(ROOT, ...country(countryCode).systemsFile.split('/'));
}

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

// Normalize any date-ish string (an HTTP date, an ISO timestamp, YYYY-MM-DD) to a
// comparable YYYY-MM-DD, or null if it can't be parsed.
export function toISODate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// The sourceDate already committed to a data file (YYYY-MM-DD), or null. Reads
// meta.sourceDate, falling back to a parseable meta.sourceModified for files
// written before sourceDate existed.
export function committedSourceDate(file = systemsPath('US')) {
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta || {};
    return meta.sourceDate || toISODate(meta.sourceModified) || null;
  } catch {
    return null;
  }
}

// Labels for a set of Q-ids from the Wikidata Query Service. English preferred,
// French as a fallback — many Quebec library systems carry only a French label.
export async function wikidataLabels(qids) {
  if (!qids.length) return {};
  const values = qids.map(q => 'wd:' + q).join(' ');
  const query = `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item ?label ?lang WHERE {
  VALUES ?item { ${values} }
  ?item rdfs:label ?label . BIND(LANG(?label) AS ?lang) FILTER(?lang IN ('en','fr'))
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
      for (const r of rows) {
        const qid = r.item.value.split('/').pop();
        if (r.lang?.value === 'en' || !(qid in out)) out[qid] = r.label.value;
      }
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

// Aggregate rows, enrich, rank, and write a country's systems file
// (data/us-library-systems.json, data/ca-library-systems.json, …).
// `rows`: Array<{ operator: string|null, wikidata: string|null, count: number }>
// `country`: 2-letter country code from js/countries.js (default US).
// `source`: provenance string stored in meta.source (a generic name is fine).
// `sourceDate`: REQUIRED. The snapshot date of the source data (YYYY-MM-DD) —
//   Layercake's Last-Modified, Overpass's timestamp_osm_base, etc. Writers must
//   always supply one so any writer can tell whether it has newer data.
// `sourceModified`: optional human-readable form of the same (e.g. the raw HTTP
//   Last-Modified string), kept in meta for display.
// `force`: write even if the committed data has an equal-or-newer sourceDate.
//
// Returns the systems count on write, or null when skipped because the committed
// data is already at least as fresh (nothing to contribute).
export async function writeSystems(rows, { country: countryCode = 'US', source, sourceDate, sourceModified, force = false }) {
  const c = country(countryCode);
  const dest = systemsPath(c.code);
  const incoming = toISODate(sourceDate);
  if (!incoming) throw new Error(`writeSystems: a valid sourceDate is required (got ${JSON.stringify(sourceDate)})`);

  // Freshness gate: don't overwrite data built from an equal-or-newer source.
  const committed = committedSourceDate(dest);
  if (!force && committed && committed >= incoming) {
    console.log(`  committed data source ${committed} is not older than ${incoming} — skipping write (use force to override).`);
    return null;
  }

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
    generated: new Date().toISOString().slice(0, 10),
    sourceDate: incoming,
    ...(sourceModified ? { sourceModified } : {}),
    boundary: `${c.name} (OSM relation ${c.boundaryRelation})`,
    totalSystems: systems.length
  };
  // One system per line (still valid JSON) so daily git diffs touch only the
  // lines that actually changed, instead of rewriting one giant line.
  const json = '{\n' +
    `"meta": ${JSON.stringify(meta)},\n` +
    '"systems": [\n' +
    systems.map(s => JSON.stringify(s)).join(',\n') +
    '\n]\n}\n';
  writeFileSync(dest, json);
  console.log(`Wrote ${systems.length} systems -> ${dest}`);
  return systems.length;
}
