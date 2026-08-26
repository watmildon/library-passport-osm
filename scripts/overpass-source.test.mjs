// overpass-source.test.mjs — the failover-tier plumbing: candidate ordering,
// tier pinning, endpoint selection and secret redaction. Pure env-var logic,
// no network. Run: npm run test:overpass
//
// Every test sets BOTH secret env vars explicitly — the functions fall back to
// gitignored .overpass-url / .overpass-secondary-url files in the repo root,
// which may or may not exist on the machine running the tests.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  overpassCandidates, activeTier, degradedMode, describeTier,
  overpassEndpoint, redact, PUBLIC_OVERPASS_URLS
} from './overpass-source.mjs';

const PRIMARY = 'https://primary.example.com/api/interpreter';
const SECONDARY = 'https://secondary.example.net/some-key-123/api/interpreter';

const VARS = ['OVERPASS_URL', 'OVERPASS_SECONDARY_URL', 'OVERPASS_TIER', 'OVERPASS_PUBLIC_URL'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]));
  process.env.OVERPASS_URL = PRIMARY;
  process.env.OVERPASS_SECONDARY_URL = SECONDARY;
  delete process.env.OVERPASS_TIER;
  delete process.env.OVERPASS_PUBLIC_URL;
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

test('candidates walk primary, secondary, then the public servers', () => {
  const c = overpassCandidates('auto');
  assert.deepEqual(c.map(x => x.tier), ['primary', 'secondary', 'public', 'public']);
  assert.equal(c[0].url, PRIMARY);
  assert.equal(c[1].url, SECONDARY);
  assert.deepEqual(c.slice(2).map(x => x.url), PUBLIC_OVERPASS_URLS);
});

test('an unconfigured secondary drops out of the chain', (t) => {
  // The env var is cleared here, but the gitignored file fallback would still
  // configure a secondary on a machine that has one — skip there.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(join(root, '.overpass-secondary-url'))) return t.skip('.overpass-secondary-url exists locally');
  process.env.OVERPASS_SECONDARY_URL = '';
  assert.deepEqual(overpassCandidates('auto').map(x => x.tier), ['primary', 'public', 'public']);
});

test('a pinned startTier restricts the chain to exactly that tier', () => {
  assert.deepEqual(overpassCandidates('secondary').map(x => x.url), [SECONDARY]);
  assert.deepEqual(overpassCandidates('public').map(x => x.url), PUBLIC_OVERPASS_URLS);
  assert.deepEqual(overpassCandidates('primary').map(x => x.url), [PRIMARY]);
});

test('tier defaults to primary; the OVERPASS_TIER pin engages degraded mode', () => {
  assert.equal(activeTier(), 'primary');
  assert.equal(degradedMode(), false);
  process.env.OVERPASS_TIER = 'secondary';
  assert.equal(activeTier(), 'secondary');
  assert.equal(degradedMode(), true);
  process.env.OVERPASS_TIER = 'Public';   // normalized
  assert.equal(activeTier(), 'public');
  assert.equal(degradedMode(), true);
});

test('overpassEndpoint follows the active tier', () => {
  assert.equal(overpassEndpoint(), PRIMARY);
  process.env.OVERPASS_TIER = 'secondary';
  assert.equal(overpassEndpoint(), SECONDARY);
  process.env.OVERPASS_TIER = 'public';
  assert.equal(overpassEndpoint(), PUBLIC_OVERPASS_URLS[0]);
  // The gate pins the public server that actually answered its probe.
  process.env.OVERPASS_PUBLIC_URL = PUBLIC_OVERPASS_URLS[1];
  assert.equal(overpassEndpoint(), PUBLIC_OVERPASS_URLS[1]);
});

test('describeTier names tiers without URLs or hosts', () => {
  assert.equal(describeTier('primary'), 'the primary Overpass endpoint');
  assert.equal(describeTier('secondary'), 'the secondary Overpass endpoint');
  assert.equal(describeTier('public'), 'a public Overpass server');
  for (const t of ['primary', 'secondary', 'public']) {
    assert.ok(!describeTier(t).includes('example'));
  }
});

test('redact strips every configured secret endpoint, not just the one passed', () => {
  const msg = `proxy at ${PRIMARY} failed; upstream ${new URL(SECONDARY).host} said no; also secondary.example.net alone`;
  const out = redact(msg, PRIMARY);
  assert.ok(!out.includes('primary.example.com'), out);
  assert.ok(!out.includes('secondary.example.net'), out);
  assert.ok(!out.includes('some-key-123'), out);
  assert.ok(out.includes('<overpass>'));
});

test('redact handles an unparseable endpoint by stripping the literal string', () => {
  const out = redact('server not-a-url said hi', 'not-a-url');
  assert.equal(out, 'server <overpass> said hi');
});
