// pls-classify.test.mjs — classify()'s outlet matching, especially the
// same-name fallback for single-outlet systems (outlet named like the system
// strips to nothing against the operator tokens, which used to silently
// disable name matching for exactly the pairs where it is most certain).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './pls-match.mjs';

test('classify: outlet named like its system matches a nearish same-name library', () => {
  // ~420 m apart (the real Petawawa case: a geocoded address vs the mapped
  // building) — beyond the 250 m spatial gate, inside the 1 km name-rescue
  // window. The generic-strip fallback must carry the match.
  const outlet = { id: 'ON-L0288', name: 'Petawawa', lat: 45.89395, lon: -77.25991 };
  const lib = { id: 'n1', name: 'Petawawa Public Library', lat: 45.89404, lon: -77.26535 };
  const cls = classify([outlet], [lib], 'Petawawa Public Library', () => null);
  assert.equal(cls.matched, 1);
  assert.equal(cls.missing.length, 0);
});

test('classify: a distant same-name outlet becomes a discrepancy, not a match', () => {
  const outlet = { id: 'X-1', name: 'Springfield', lat: 45.0, lon: -77.0 };
  const lib = { id: 'n2', name: 'Springfield Public Library', lat: 45.1, lon: -77.0 }; // ~11 km
  const cls = classify([outlet], [lib], 'Springfield Public Library', () => null);
  assert.equal(cls.matched, 0);
  assert.equal(cls.discrepancies.length, 1);
});
