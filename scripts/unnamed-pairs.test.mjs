// unnamed-pairs.test.mjs – pairing unnamed libraries with a named twin, and
// the containment check that upgrades "close by" to "inside the building".
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnnamedPairs, wayRings, pointInRing, pairContained } from './unnamed-pairs.mjs';

// ~0.0001° ≈ 11 m; a tight building-and-node pair.
const unWay = { type: 'way', id: 1, name: null, lat: 45.0000, lon: -77.0000 };
const namedNode = { type: 'node', id: 2, name: 'Springfield Public Library', lat: 45.0001, lon: -77.0001 };

test('findUnnamedPairs: unnamed way pairs with the named node on top of it', () => {
  const pairs = findUnnamedPairs([unWay, namedNode]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].un, unWay);
  assert.equal(pairs[0].named, namedNode);
  assert.ok(pairs[0].dist < 25);
  assert.equal(pairs[0].others, 0);
});

test('findUnnamedPairs: named libraries beyond the radius are not twins', () => {
  const far = { type: 'node', id: 3, name: 'Far Library', lat: 45.01, lon: -77.0 }; // ~1.1 km
  assert.equal(findUnnamedPairs([unWay, far]).length, 0);
});

test('findUnnamedPairs: keeps the nearest name and counts the others', () => {
  const nearer = { type: 'node', id: 4, name: 'Main Library', lat: 45.00005, lon: -77.0 };
  const pairs = findUnnamedPairs([unWay, namedNode, nearer]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].named, nearer);
  assert.equal(pairs[0].others, 1);
});

test('findUnnamedPairs: two unnamed libraries never pair with each other', () => {
  const unNode = { type: 'node', id: 5, name: null, lat: 45.0001, lon: -77.0 };
  assert.equal(findUnnamedPairs([unWay, unNode]).length, 0);
});

// A ~30 m square around (-77, 45), closed.
const SQUARE = [
  [-77.0002, 44.9998], [-76.9998, 44.9998],
  [-76.9998, 45.0002], [-77.0002, 45.0002],
  [-77.0002, 44.9998]
];

test('pointInRing: inside and outside the square', () => {
  assert.equal(pointInRing(-77.0, 45.0, SQUARE), true);
  assert.equal(pointInRing(-77.001, 45.0, SQUARE), false);
});

test('wayRings: keeps closed ways, drops open ones', () => {
  const geom = SQUARE.map(([lon, lat]) => ({ lon, lat }));
  const rings = wayRings([
    { type: 'way', id: 1, geometry: geom },
    { type: 'way', id: 9, geometry: geom.slice(0, -1) },   // open
    { type: 'node', id: 2 }
  ]);
  assert.deepEqual([...rings.keys()], ['w1']);
});

test('pairContained: named node inside the unnamed building outline', () => {
  const rings = new Map([['w1', SQUARE]]);
  assert.equal(pairContained({ un: unWay, named: namedNode }, rings), true);
  // Same pair, no ring fetched – stays proximity-only.
  assert.equal(pairContained({ un: unWay, named: namedNode }, new Map()), false);
});

test('pairContained: the reverse direction (unnamed node in a named building)', () => {
  const namedWay = { type: 'way', id: 7, name: 'Central Library', lat: 45.0, lon: -77.0 };
  const unNode = { type: 'node', id: 8, name: null, lat: 45.0001, lon: -77.0001 };
  const rings = new Map([['w7', SQUARE]]);
  assert.equal(pairContained({ un: unNode, named: namedWay }, rings), true);
});

test('pairContained: a nearby-but-outside node is not contained', () => {
  const outside = { type: 'node', id: 9, name: 'Annex Library', lat: 45.0004, lon: -77.0 }; // ~45 m, outside
  const rings = new Map([['w1', SQUARE]]);
  assert.equal(pairContained({ un: unWay, named: outside }, rings), false);
});
