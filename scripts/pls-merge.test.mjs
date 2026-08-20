// pls-merge.test.mjs — the crosswalk merge: rival fragments of one real-world
// system are classified against their merged membership, not just the winning
// fragment's libraries. Run: npm run test:pls

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibsByQid, mergeClaimLibs } from './build-qa.mjs';
import { classify } from './pls-match.mjs';

const lib = (id, lat, lon, name) => ({ id, name, lat, lon });

// Mirrors the Fort Vancouver shape: one real system fragmented into two
// operator spellings, a wikidata-keyed remainder (libraries tagged with the
// QID but no operator name), and a sub-threshold fragment that never claims.
function fixture() {
  const sysKeys = [
    'Fort Vancouver Regional Libraries',
    'Fort Vancouver Regional Library District',
    'wd:Q1',
    'FVRL'
  ];
  const sysMap = new Map([
    [sysKeys[0], { n: sysKeys[0], c: 2, libs: [
      lib('w1', 45.8202, -120.8244, 'Goldendale Community Library'),
      lib('w2', 45.63, -122.60, 'Vancouver Community Library')
    ] }],
    [sysKeys[1], { n: sysKeys[1], c: 2, libs: [
      lib('n3', 45.61, -122.67, 'Vancouver Mall Library'),
      lib('n4', 45.78, -122.55, 'Battle Ground Community Library')
    ] }],
    [sysKeys[2], { n: 'Q1', c: 2, libs: [
      lib('n5', 45.86, -122.80, 'Ridgefield Community Library'),
      lib('n6', 45.72, -121.48, 'White Salmon Valley Community Library')
    ] }],
    // Sub-threshold (c < MIN_LIBS_FOR_PLS): never crosswalks, but shares the QID.
    [sysKeys[3], { n: 'FVRL', c: 1, libs: [
      lib('n7', 45.67, -122.55, 'Cascade Park Community Library')
    ] }]
  ]);
  const systems = [
    { n: sysKeys[0], w: 'Q1', c: 2 },
    { n: sysKeys[1], w: 'Q1', c: 2 },
    { n: 'Q1', w: 'Q1', c: 2 },
    { n: 'FVRL', w: 'Q1', c: 1 }
  ];
  return { sysKeys, sysMap, systems };
}

test('buildLibsByQid groups every fragment’s libraries under the shared QID', () => {
  const { sysKeys, sysMap, systems } = fixture();
  const byQid = buildLibsByQid(sysKeys, sysMap, systems);
  assert.deepEqual([...byQid.keys()], ['Q1']);
  assert.equal(byQid.get('Q1').length, 7);
});

test('mergeClaimLibs unions rivals plus same-QID fragments, deduped', () => {
  const { sysKeys, sysMap, systems } = fixture();
  const byQid = buildLibsByQid(sysKeys, sysMap, systems);
  // Only the wd: fragment and one spelling claimed; the merge must still pull
  // in the other spelling and the sub-threshold fragment via the shared QID.
  const rivals = [
    { sysIdx: 2, sysKey: 'wd:Q1' },
    { sysIdx: 0, sysKey: sysKeys[0] }
  ];
  const merged = mergeClaimLibs(rivals, sysMap, systems, byQid);
  assert.deepEqual(merged.map(l => l.id).sort(), ['n3', 'n4', 'n5', 'n6', 'n7', 'w1', 'w2']);
});

test('a QID-less rival contributes only its own libraries', () => {
  const { sysKeys, sysMap, systems } = fixture();
  systems[0].w = null;
  const byQid = buildLibsByQid(sysKeys, sysMap, systems);
  const merged = mergeClaimLibs([{ sysIdx: 0, sysKey: sysKeys[0] }], sysMap, systems, byQid);
  assert.deepEqual(merged.map(l => l.id).sort(), ['w1', 'w2']);
});

// The Goldendale regression, at the classify level: an outlet next to a sibling
// fragment's library must come out MATCHED under the merged membership, where
// the winning fragment alone read it as untagged (= a conflict on the QA map).
test('merged membership turns a sibling fragment’s library from untagged into matched', () => {
  const { sysKeys, sysMap, systems } = fixture();
  const outlets = [
    { id: 'P1', name: 'GOLDENDALE COMMUNITY LIBRARY', lat: 45.8203, lon: -120.8245 }
  ];
  // Any-operator spatial lookup finds the (differently-fragmented) OSM object.
  const nearbyLibs = () => ({
    id: 'w1', name: 'Goldendale Community Library',
    operator: 'Fort Vancouver Regional Libraries', lat: 45.8202, lon: -120.8244, dist: 15
  });

  const winnerOnly = classify(outlets, sysMap.get('wd:Q1').libs, 'Q1', nearbyLibs);
  assert.equal(winnerOnly.matched, 0);
  assert.equal(winnerOnly.untagged.length, 1);            // the old false conflict
  assert.equal(!!winnerOnly.untagged[0].near.operator, true);

  const byQid = buildLibsByQid(sysKeys, sysMap, systems);
  const merged = mergeClaimLibs([{ sysIdx: 2, sysKey: 'wd:Q1' }], sysMap, systems, byQid);
  const withMerge = classify(outlets, merged, 'Fort Vancouver Regional Libraries', nearbyLibs);
  assert.equal(withMerge.matched, 1);
  assert.equal(withMerge.untagged.length, 0);
  assert.equal(withMerge.missing.length, 0);
});
