#!/usr/bin/env node
// freshness-gate.mjs — decide whether the daily data refresh has anything to do.
//
// The one place that answers the two questions the update-systems workflow used
// to ask in shell: is the Overpass instance up, and is any committed data file
// older than the snapshot it is currently serving? Doing it here instead of in
// the workflow means the gate resolves the endpoint, queries it, and reports a
// failure through exactly the same code as the build scripts it gates — so a
// diagnosis only has to be written once (see overpass-source.mjs), and the two
// can't drift.
//
// The tracked files are derived from js/countries.js: each country's
// systemsFile and qaFile. Adding a country therefore extends the gate for free.
// Outlet censuses (pls-outlets.json, ca-library-outlets.json) are deliberately
// NOT tracked — they follow their sources' own annual/provincial release
// cadence, not OSM's minutely one, and their build scripts self-gate on it.
//
// A missing or unreachable instance is a hard failure: better a red X than a
// silent skip that looks like "no changes today" for a week.
//
// In GitHub Actions it writes `run=yes|no` to $GITHUB_OUTPUT, appends a data
// source note to $GITHUB_STEP_SUMMARY, and emits ::error:: annotations. Outside
// Actions those are no-ops and it just prints the report, so it doubles as the
// local "is my instance healthy and is my checkout stale?" check.
//
// Usage:  node scripts/freshness-gate.mjs [--force]
// Exit:   0 decision made (run=yes|no) · 1 no endpoint configured, or the
//         instance did not answer with a usable timestamp.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpassEndpoint, overpassTimestamp } from './overpass-source.mjs';
import { committedSourceDate, toISODate, ROOT } from './systems-core.mjs';
import { COUNTRIES } from '../js/countries.js';

const FORCE = process.argv.includes('--force');

// ---- GitHub Actions plumbing (no-ops when run locally) ---------------------

const inActions = !!process.env.GITHUB_ACTIONS;

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function addSummary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

// Fail loudly and stop. Workflow annotations are single-line, so newlines are
// escaped the way Actions expects rather than silently truncating the message.
function fail(message, detail) {
  const full = detail ? `${message} ${detail}` : message;
  console.error(inActions ? `::error::${full.replace(/\r?\n/g, '%0A')}` : `ERROR: ${full}`);
  addSummary('### Data source');
  addSummary(`**Refresh aborted.** ${full}`);
  process.exit(1);
}

// ---- What the gate watches ------------------------------------------------

const tracked = Object.values(COUNTRIES).flatMap(c => [
  { label: `${c.code} systems`, file: c.systemsFile },
  { label: `${c.code} QA`, file: c.qaFile }
]).filter(f => f.file);

async function main() {
  // Never print the endpoint or its host — in CI it comes from a secret, and
  // GitHub only masks the exact secret string in logs.
  const endpoint = overpassEndpoint();
  if (!endpoint) {
    fail('No Overpass endpoint configured.',
      'In CI this comes from the OVERPASS_PRIMARY_URL repository secret (exposed to the job as OVERPASS_URL); locally, put the URL in a gitignored .overpass-url file in the repo root.');
  }

  // Catch a mistyped or mangled secret here rather than letting it surface as a
  // connection failure — a rotated URL pasted without its scheme, or with a
  // stray newline, is a config problem, not an outage. The URL itself stays
  // unprinted; only the shape of the mistake is reported.
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`scheme is "${u.protocol}"`);
  } catch (e) {
    fail('The configured Overpass endpoint is not a usable http(s) URL.',
      `${e.message}. Check OVERPASS_PRIMARY_URL (or .overpass-url) for a missing scheme, a stray newline, or surrounding quotes; it should look like https://host/api/interpreter.`);
  }

  let timestamp;
  try {
    timestamp = await overpassTimestamp(endpoint);
  } catch (e) {
    // OverpassError messages already name the failure mode, and are already
    // redacted; anything else gets reported as-is.
    fail('Refusing to rebuild — the data source is unavailable.', e.message);
  }
  const liveDate = toISODate(timestamp);
  if (!liveDate) {
    fail('The Overpass instance answered, but with no usable data timestamp.',
      `Expected osm3s.timestamp_osm_base, got ${timestamp ? `"${timestamp}"` : 'nothing'} — is the endpoint really an Overpass interpreter, and is its replication running?`);
  }

  console.log(`Overpass snapshot: ${timestamp} (data date ${liveDate})`);
  addSummary('### Data source');
  addSummary(`Private Overpass instance — data timestamp: ${timestamp}`);

  // Read every tracked file's committed snapshot date. A file with no readable
  // sourceDate (never built, or hand-edited) counts as stale: rebuilding it is
  // always the safe answer.
  const width = Math.max(...tracked.map(t => t.label.length));
  const state = tracked.map(t => {
    const committed = committedSourceDate(join(ROOT, ...t.file.split('/')));
    return { ...t, committed, stale: !committed || committed < liveDate };
  });

  console.log('Committed sourceDate:');
  for (const s of state) {
    console.log(`  ${s.label.padEnd(width)}  ${(s.committed ?? 'none').padEnd(10)}  ${s.stale ? 'stale' : 'current'}  ${s.file}`);
  }

  const stale = state.filter(s => s.stale);
  let run;
  if (FORCE) {
    run = true;
    console.log('Forced rebuild requested — running regardless of freshness.');
    addSummary(`Forced rebuild requested (committed data was ${stale.length ? `${stale.length} file(s) behind` : 'already current'}).`);
  } else if (stale.length) {
    run = true;
    console.log(`Rebuild needed: ${stale.length} of ${state.length} files are older than the snapshot (${stale.map(s => s.label).join(', ')}).`);
  } else {
    run = false;
    console.log('Committed data is not older than the Overpass snapshot — skipping rebuild.');
    addSummary(`Up to date (every committed sourceDate >= ${liveDate}).`);
  }

  setOutput('run', run ? 'yes' : 'no');
  setOutput('sourceDate', liveDate);
}

// Anything that gets past the handled cases still exits through fail(), so a
// gate crash is an annotated failure rather than a bare stack trace in the log.
main().catch(e => fail('The freshness gate crashed.', e?.stack || String(e)));
