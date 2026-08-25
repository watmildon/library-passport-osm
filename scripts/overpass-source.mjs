// overpass-source.mjs — shared Overpass access for the data pipeline.
//
// The pipeline's primary data source is a private Overpass instance (minutely
// OSM replication, no rate limits). Its URL is a secret and must never land in
// git or in CI logs, so:
//   - the endpoint is resolved from the OVERPASS_URL env var (in CI, populated
//     from the OVERPASS_PRIMARY_URL repository secret) or a gitignored
//     .overpass-url file in the repo root;
//   - nothing in this module ever prints the URL or its host. GitHub Actions
//     only masks the exact secret string, so even logging the hostname would
//     leak it.
//
// When no endpoint is configured, callers fall back to their Layercake/DuckDB
// path (see scripts/README.md).
//
// Every request goes through overpassQuery, so the failure diagnosis it
// produces (see "Failure reporting" below) is the same whether a query came
// from a build script or from the daily workflow's freshness gate.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { country } from '../js/countries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const DEFAULT_USER_AGENT = process.env.USER_AGENT ||
  'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm; data build)';

// The configured Overpass endpoint: OVERPASS_URL env var, else .overpass-url in
// the repo root, else null. With { required: true }, exits with guidance instead
// of returning null.
export function overpassEndpoint({ required = false } = {}) {
  if (process.env.OVERPASS_URL?.trim()) return process.env.OVERPASS_URL.trim();
  const f = join(ROOT, '.overpass-url');
  if (existsSync(f)) {
    const url = readFileSync(f, 'utf8').trim();
    if (url) return url;
  }
  if (required) {
    console.error('No Overpass endpoint configured. Set OVERPASS_URL or create a');
    console.error('.overpass-url file in the repo root (it is gitignored).');
    process.exit(1);
  }
  return null;
}

// ---- Failure reporting -----------------------------------------------------
//
// Diagnosing a failed refresh from a CI log means knowing WHICH way the
// instance failed. A 502 from the proxy (backend dead), a refused connection
// (nothing listening), a DNS miss (host gone), a 429 (rate limited) and a
// socket timeout (query accepted, never answered) all read as "it didn't work"
// but need completely different fixes — so every failure below says which one
// it was, how long it took to fail, and what the server said. The elapsed time
// matters as much as the code: a 0.2s failure is an instant rejection, a 300s
// one is a query that was actually attempted.
//
// Nothing here may print the endpoint. Overpass error pages echo the request
// and proxy pages sometimes name their upstream, so every string that can reach
// a log goes through redact() first.

// Replace the endpoint — and its bare origin/host, which a proxy page may print
// on its own — with a placeholder.
function redact(text, endpoint) {
  if (!text) return '';
  const secrets = new Set([endpoint]);
  try {
    const u = new URL(endpoint);
    secrets.add(u.origin);
    secrets.add(u.host);
    secrets.add(u.hostname);
  } catch { /* not a parseable URL; stripping the literal string is all we can do */ }
  let out = String(text);
  // Longest first, so stripping the host doesn't leave fragments of the origin.
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('<overpass>');
  }
  return out;
}

// Keyed by the code fetch reports; the text says what the code implies for this
// pipeline rather than restating the code itself.
const NETWORK_CAUSES = {
  ENOTFOUND:        'the host does not resolve (DNS record gone?)',
  EAI_AGAIN:        'DNS lookup timed out (resolver trouble, or the host is gone)',
  ECONNREFUSED:     'nothing is listening on that port (the instance is down, not just its backend)',
  ECONNRESET:       'the connection was reset mid-request',
  EHOSTUNREACH:     'the host is unreachable (routing or firewall)',
  ETIMEDOUT:        'the connection attempt timed out before the server accepted it',
  CERT_HAS_EXPIRED: 'the TLS certificate has expired',
  UND_ERR_SOCKET:   'the socket closed before the response completed'
};

function explainStatus(status) {
  if (status === 429) return 'rate limited (too many queries in flight)';
  if (status === 504) return 'gateway timeout: the query outlived the proxy, not the server';
  if (status === 502 || status === 503) return 'the proxy is up but the Overpass backend is not answering (the instance likely needs a restart)';
  if (status === 404) return 'not found: does the endpoint end in /api/interpreter?';
  if (status === 401 || status === 403) return 'the instance rejected the request (auth, or an IP allowlist that no longer covers the runner?)';
  if (status >= 500) return 'server-side failure';
  if (status >= 400) return 'the instance rejected the query';
  return 'unexpected status';
}

// Whatever the server said, made safe and short enough for one log line.
// Overpass reports its own errors as JSON with a `remark`; proxies answer with
// an HTML page. Both are worth quoting, neither is worth quoting in full.
function readableBody(raw, endpoint) {
  if (!raw?.trim()) return '';
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    if (j.remark) msg = j.remark;
  } catch { /* not JSON — fall through and strip tags */ }
  msg = msg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!msg) return '';
  return redact(msg.length > 200 ? msg.slice(0, 200) + '…' : msg, endpoint);
}

// Thrown by overpassQuery for every failure mode. `kind` lets a caller decide
// whether a retry could help ('network'/'timeout'/5xx) without re-parsing the
// message; `message` is already safe to print.
export class OverpassError extends Error {
  constructor(message, { kind, status = null, elapsedMs = null } = {}) {
    super(`Overpass: ${message}`);
    this.name = 'OverpassError';
    this.kind = kind;            // 'network' | 'timeout' | 'http' | 'malformed'
    this.status = status;
    this.elapsedMs = elapsedMs;
  }
}

// POST one Overpass QL query, returning parsed JSON. `maxSeconds` should be at
// least the query's own [timeout:] so the server, not the socket, decides.
// Every failure arrives as an OverpassError carrying a specific diagnosis.
export async function overpassQuery(endpoint, query, { maxSeconds = 360, userAgent = DEFAULT_USER_AGENT } = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const took = () => `${(elapsed() / 1000).toFixed(1)}s`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(maxSeconds * 1000)
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new OverpassError(
        `no response within the ${maxSeconds}s client limit (gave up after ${took()})`,
        { kind: 'timeout', elapsedMs: elapsed() });
    }
    // fetch wraps the real failure in `cause`; with Happy Eyeballs that cause
    // can itself be an AggregateError over the addresses it tried.
    const code = e.cause?.code || e.cause?.errors?.[0]?.code || e.code || null;
    const why = NETWORK_CAUSES[code] || redact(e.cause?.message || e.message, endpoint) || 'connection failed';
    throw new OverpassError(
      `could not connect after ${took()}${code ? ` (${code})` : ''} — ${why}`,
      { kind: 'network', elapsedMs: elapsed() });
  }

  if (!res.ok) {
    let body = '';
    try { body = readableBody(await res.text(), endpoint); } catch { /* body unreadable; the status is the story */ }
    throw new OverpassError(
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} after ${took()} — ${explainStatus(res.status)}` +
      (body ? `; server said: ${body}` : '; the response body was empty'),
      { kind: 'http', status: res.status, elapsedMs: elapsed() });
  }

  // Read as text and parse here rather than res.json(): a truncated or HTML
  // response is a distinct failure worth naming, and res.json() consumes the
  // body so there'd be nothing left to quote.
  let raw;
  try {
    raw = await res.text();
  } catch (e) {
    throw new OverpassError(
      `the response body was cut off after ${took()} (${e.cause?.code || e.name}) — the instance died mid-answer?`,
      { kind: 'network', status: res.status, elapsedMs: elapsed() });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new OverpassError(
      `HTTP ${res.status} after ${took()} but the body is not JSON ` +
      `(${raw.length} bytes, content-type ${res.headers.get('content-type') || 'unset'})` +
      (readableBody(raw, endpoint) ? ` — ${readableBody(raw, endpoint)}` : ''),
      { kind: 'malformed', status: res.status, elapsedMs: elapsed() });
  }
}

// The instance's data timestamp (osm3s.timestamp_osm_base, ISO UTC), via the
// cheapest possible query.
export async function overpassTimestamp(endpoint) {
  const json = await overpassQuery(endpoint, '[out:json][timeout:60];out count;', { maxSeconds: 90 });
  return json.osm3s?.timestamp_osm_base || null;
}

// Every library in a country with full tags and a point coordinate (`out
// center` gives ways/relations their centroid). Returns { elements, timestamp }.
// US: ~19k elements / ~9 MB / ~2 minutes as of 2026-08.
export async function fetchLibraryElements(endpoint, countryCode = 'US') {
  const c = country(countryCode);
  const q = `[out:json][timeout:300];
area(${c.areaId})->.us;
nwr[amenity=library](area.us);
out center tags;`;
  const json = await overpassQuery(endpoint, q, { maxSeconds: 330 });
  return { elements: json.elements || [], timestamp: json.osm3s?.timestamp_osm_base || null };
}

// State/province assignment for every library in a country:
// Map('n123'|'w456'|'r789' -> region name, e.g. "Washington" or "Ontario").
// One foreach query over the admin_level=4 areas that carry the country's
// ISO3166-2 prefix (US: 50 states + DC + PR/GU/AS/VI/MP; CA: 13 provinces and
// territories); each iteration emits the region area as a marker, then the ids
// of the libraries inside it. A borderline library contained by two region
// polygons keeps the alphabetically-first name, mirroring the Layercake SQL's
// min(state). US: ~2.5 minutes as of 2026-08.
export async function fetchStateAssignments(endpoint, countryCode = 'US') {
  const c = country(countryCode);
  const q = `[out:json][timeout:480];
area[boundary=administrative][admin_level=4]["ISO3166-2"~"^${c.iso3166Prefix}"]->.states;
foreach.states->.st(
  .st out;
  nwr[amenity=library](area.st);
  out ids;
);`;
  const json = await overpassQuery(endpoint, q, { maxSeconds: 520 });
  const byEl = new Map();
  let state = null;
  for (const el of json.elements || []) {
    // Prefer name:en — bilingual regions carry dual/multiscript `name` values
    // ("New Brunswick / Nouveau-Brunswick", "ᓄᓇᕗᑦ Nunavut") that are a mess to
    // display and to key abbreviation maps on. All US states and Canadian
    // provinces carry name:en as of 2026-08.
    if (el.type === 'area') { state = el.tags?.['name:en'] || el.tags?.name || null; continue; }
    if (!state) continue;
    const key = el.type[0] + el.id;
    const prev = byEl.get(key);
    if (!prev || state < prev) byEl.set(key, state);
  }
  return byEl;
}
