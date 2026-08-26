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
// FAILOVER: when the primary instance is down, the gate walks the endpoint
// chain (primary secret → OVERPASS_SECONDARY_URL secret → public Overpass
// servers, see overpass-source.mjs) and pins the first tier that answers via
// the OVERPASS_TIER env var ($GITHUB_ENV), so every later build step uses the
// same endpoint without re-probing a dead host. Any tier but primary is a
// DEGRADED refresh – the build scripts skip the expensive enrichment stages –
// and the gate says so loudly in the log, the job summary and its outputs.
//
// The refresh only becomes a hard failure when NO tier answers: better a red X
// than a silent skip that looks like "no changes today" for a week.
//
// In GitHub Actions it writes `run=yes|no`, `tier` and `degraded=yes|no` to
// $GITHUB_OUTPUT, appends a data source note to $GITHUB_STEP_SUMMARY, and
// emits ::error::/::warning:: annotations. Outside Actions those are no-ops
// and it just prints the report, so it doubles as the local "is my instance
// healthy and is my checkout stale?" check.
//
// Usage:  node scripts/freshness-gate.mjs [--force] [--tier=auto|primary|secondary|public]
//         (--tier pins the chain to exactly one tier; default auto walks it)
// Exit:   0 decision made (run=yes|no) · 1 no endpoint answered with a usable
//         timestamp.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpassCandidates, resolveOverpass, describeTier } from './overpass-source.mjs';
import { committedSourceDate, toISODate, ROOT } from './systems-core.mjs';
import { COUNTRIES } from '../js/countries.js';

const FORCE = process.argv.includes('--force');
const tierArg = process.argv.find(a => a.startsWith('--tier='));
const START_TIER = (tierArg ? tierArg.split('=')[1] : 'auto').trim().toLowerCase();
if (!['auto', 'primary', 'secondary', 'public'].includes(START_TIER)) {
  console.error(`Unknown --tier value "${START_TIER}" — expected auto, primary, secondary or public.`);
  process.exit(1);
}

// ---- GitHub Actions plumbing (no-ops when run locally) ---------------------

const inActions = !!process.env.GITHUB_ACTIONS;

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// Pin an env var for every LATER step of the job ($GITHUB_ENV is a file, never
// a log — writing a URL here does not print it).
function setEnv(key, value) {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
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
  // Never print an endpoint or its host — the primary and secondary come from
  // secrets, and GitHub only masks the exact secret string in logs. Tiers are
  // identified by name only.
  if (!overpassCandidates(START_TIER).length) {
    fail(`No ${START_TIER} Overpass endpoint configured.`,
      'In CI the primary comes from the OVERPASS_PRIMARY_URL repository secret (exposed to the job as OVERPASS_URL) and the secondary from OVERPASS_SECONDARY_URL; locally, put the URL in a gitignored .overpass-url / .overpass-secondary-url file in the repo root.');
  }

  // Walk the failover chain: first tier that answers with a usable data
  // timestamp wins. Failure messages come pre-redacted from overpass-source.
  const res = await resolveOverpass(START_TIER);
  for (const f of res.failures) {
    const line = `${f.tier} endpoint unavailable: ${f.message}`;
    console.warn(inActions ? `::warning::${line.replace(/\r?\n/g, '%0A')}` : `WARNING: ${line}`);
  }
  if (!res.tier) {
    fail('Refusing to rebuild — no Overpass endpoint answered.',
      res.failures.map(f => `[${f.tier}] ${f.message}`).join(' · '));
  }

  const timestamp = res.timestamp;
  const liveDate = toISODate(timestamp);
  if (!liveDate) {
    fail('The Overpass endpoint answered, but its data timestamp did not parse.',
      `Got "${timestamp}" — expected an ISO osm3s.timestamp_osm_base.`);
  }
  const degraded = res.tier !== 'primary';

  // Pin the winning tier for every later build step. For the public tier the
  // winning server is pinned too (the first public server may be the one that
  // just failed); it is not a secret, unlike the other tiers' URLs.
  setEnv('OVERPASS_TIER', res.tier);
  if (res.tier === 'public') setEnv('OVERPASS_PUBLIC_URL', res.url);

  console.log(`Overpass snapshot via ${describeTier(res.tier)}: ${timestamp} (data date ${liveDate})`);
  addSummary('### Data source');
  if (degraded) {
    const note = `DEGRADED refresh — the primary Overpass instance is unavailable, using ${describeTier(res.tier)}. ` +
      'Expensive enrichment stages (augment live-tag fetches, unnamed-pair outlines) are skipped and carried forward from the last full refresh.';
    console.warn(inActions ? `::warning::${note}` : `WARNING: ${note}`);
    addSummary(`**${note}**`);
    addSummary(`Data timestamp: ${timestamp}`);
  } else {
    addSummary(`Private Overpass instance — data timestamp: ${timestamp}`);
  }

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
  setOutput('tier', res.tier);
  setOutput('degraded', degraded ? 'yes' : 'no');
}

// Anything that gets past the handled cases still exits through fail(), so a
// gate crash is an annotated failure rather than a bare stack trace in the log.
main().catch(e => fail('The freshness gate crashed.', e?.stack || String(e)));
