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

test('classify: a second outlet at a matched member is shared, not a conflict', () => {
  // The Driggs case (ID0106): PLS lists the branch and its makerspace as two
  // outlets at one address; OSM maps one object ("Driggs Branch and
  // Makerspace") tagged with the right operator. The leftover outlet must not
  // become an untagged/conflict finding against its own system's member.
  const branch = { id: 'ID-1', name: 'Valley of the Tetons District - Driggs Branch', lat: 43.724, lon: -111.11103 };
  const maker = { id: 'ID-2', name: 'Valley of the Tetons District - Makerspace', lat: 43.724, lon: -111.11101 };
  const lib = { id: 'n14093677707', name: 'Driggs Branch and Makerspace', lat: 43.7239343, lon: -111.110774 };
  const nearby = () => ({ id: 'n14093677707', name: lib.name, operator: 'Valley of the Tetons Library', lat: lib.lat, lon: lib.lon, dist: 25 });
  const cls = classify([branch, maker], [lib], 'Valley of the Tetons Library', nearby);
  assert.equal(cls.matched, 1);
  assert.equal(cls.shared.length, 1);
  assert.equal(cls.untagged.length, 0);
  assert.equal(cls.missing.length, 0);
});

test('classify: a leftover outlet near a NON-member library still reports untagged', () => {
  const a = { id: 'X-1', name: 'Central Library', lat: 45.0, lon: -77.0 };
  const lib = { id: 'n1', name: 'Central Library', lat: 45.00005, lon: -77.0 };
  const other = { id: 'w9', name: 'Some Other Library', operator: 'Someone Else', lat: 45.05, lon: -77.0, dist: 150 };
  const b = { id: 'X-2', name: 'North Branch', lat: 45.05, lon: -77.0 };
  const cls = classify([a, b], [lib], 'Central Library', (lat) => (lat === b.lat ? other : null));
  assert.equal(cls.matched, 1);
  assert.equal(cls.shared.length, 0);
  assert.equal(cls.untagged.length, 1);
});
