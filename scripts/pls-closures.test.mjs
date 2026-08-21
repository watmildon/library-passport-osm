// pls-closures.test.mjs — closed-branch suppression: Wikidata closure parsing
// and the missing/untagged filter. Run: npm run test:pls

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWdClosures, suppressClosedFindings } from './build-qa.mjs';

const NOW = new Date('2026-08-20T00:00:00Z');

const row = (qid, closed, coord) => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  closed: { value: closed },
  ...(coord ? { coord: { value: coord } } : {})
});

test('parseWdClosures keeps past-dated items with coordinates', () => {
  const out = parseWdClosures([
    row('Q7559983', '2026-07-31T00:00:00Z', 'Point(-71.0995 42.3876)')
  ], NOW);
  assert.deepEqual(out, [{ qid: 'Q7559983', lon: -71.0995, lat: 42.3876 }]);
});

test('parseWdClosures drops malformed dates, future dates, and missing coords', () => {
  const out = parseWdClosures([
    row('Q1', 'http://www.example.com', 'Point(-71 42)'),      // wrong-datatype "date" (seen in the wild)
    row('Q2', '2027-01-01T00:00:00Z', 'Point(-71 42)'),        // announced, not yet closed
    row('Q3', '2020-01-01T00:00:00Z'),                          // no P625
    row('Q4', '2020-01-01T00:00:00Z', 'not-wkt')                // unparseable coordinate
  ], NOW);
  assert.deepEqual(out, []);
});

test('suppressClosedFindings drops findings on a closure point and counts them', () => {
  const cls = {
    matched: 3,
    missing: [
      { id: 'P1', lat: 42.3876, lon: -71.0995 },   // on the closure
      { id: 'P2', lat: 45.0, lon: -120.0 }          // far away
    ],
    untagged: [
      { p: { id: 'P3', lat: 42.3878, lon: -71.0993 }, near: { id: 'w9' } }, // ~30 m away
      { p: { id: 'P4', lat: 40.0, lon: -100.0 }, near: { id: 'w8' } }
    ],
    discrepancies: []
  };
  const closure = { lat: 42.3876, lon: -71.0995 };
  const near = (lat, lon) =>
    Math.abs(lat - closure.lat) < 0.002 && Math.abs(lon - closure.lon) < 0.002;

  const closed = suppressClosedFindings(cls, near);
  assert.equal(closed, 2);
  assert.deepEqual(cls.missing.map(o => o.id), ['P2']);
  assert.deepEqual(cls.untagged.map(u => u.p.id), ['P4']);
  assert.equal(cls.matched, 3);   // untouched
});

test('suppressClosedFindings is a no-op with no closure signals', () => {
  const cls = { missing: [{ id: 'P1', lat: 1, lon: 1 }], untagged: [], discrepancies: [] };
  assert.equal(suppressClosedFindings(cls, () => false), 0);
  assert.equal(cls.missing.length, 1);
});
