// Tests for pls-augment.mjs — run with `node --test` (npm run test:augment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  titleCase, phoneE164, splitAddress, suggestTagsForOutlet, isPreciseGeocode
} from './pls-augment.mjs';

test('titleCase: ALL-CAPS PLS names', () => {
  assert.equal(titleCase('SAMMAMISH LIBRARY'), 'Sammamish Library');
  assert.equal(titleCase('SOUTH EUCLID/LYNDHURST BRANCH LIBRARY'), 'South Euclid/Lyndhurst Branch Library');
  assert.equal(titleCase('LIBRARY OF THE FUTURE'), 'Library of the Future');
  assert.equal(titleCase('BRANCH III'), 'Branch III');            // roman numeral
  assert.equal(titleCase('228TH AVENUE NE'), '228th Avenue NE');  // directional kept upper
});

test('phoneE164: formats 10 digits, drops sentinels', () => {
  assert.equal(phoneE164('7037315072'), '+1 703-731-5072');
  assert.equal(phoneE164('4258368793'), '+1 425-836-8793');
  assert.equal(phoneE164('-3'), null);      // temporarily closed
  assert.equal(phoneE164('-4'), null);      // not applicable
  assert.equal(phoneE164(''), null);
  assert.equal(phoneE164(null), null);
  assert.equal(phoneE164('12345'), null);   // wrong length
  assert.equal(phoneE164('123456789012'), null);
});

test('splitAddress: clean house number + street, expanded to OSM style', () => {
  // Directional suffix expands; the ordinal-with-directional street survives.
  assert.deepEqual(splitAddress('825 228TH AVENUE NE'),
    { housenumber: '825', street: '228th Avenue Northeast' });
  assert.deepEqual(splitAddress('7100 NICOLLET AVENUE SOUTH'),
    { housenumber: '7100', street: 'Nicollet Avenue South' });
  // "BLVD WEST" -> "Boulevard West"; unit-letter house number preserved.
  assert.deepEqual(splitAddress('1865A WAYZATA BLVD WEST'),
    { housenumber: '1865A', street: 'Wayzata Boulevard West' });
});

test('splitAddress: peels a trailing unit/suite into addr:unit', () => {
  assert.deepEqual(splitAddress('1115 SOUTHCENTER MALL #384'),
    { housenumber: '1115', street: 'Southcenter Mall', unit: '384' });
  assert.deepEqual(splitAddress('100 MAIN ST STE 5'),
    { housenumber: '100', street: 'Main Street', unit: '5' });
  // Comma-separated suite must not leak a trailing comma into the street.
  assert.deepEqual(splitAddress('319 MAIN ST., SUITE 100'),
    { housenumber: '319', street: 'Main Street', unit: '100' });
  // Plural "SUITES" with a non-numeric unit token ("ABC") — the real WA leak.
  assert.deepEqual(splitAddress('3411 169TH PLACE NE SUITES ABC'),
    { housenumber: '3411', street: '169th Place Northeast', unit: 'ABC' });
});

test('splitAddress: strips a trailing comma even without a unit', () => {
  assert.deepEqual(splitAddress('611 VAN WHITE MEMORIAL BLVD.,'),
    { housenumber: '611', street: 'Van White Memorial Boulevard' });
});

test('splitAddress: Queens-style grid house number', () => {
  assert.deepEqual(splitAddress('41-17 MAIN STREET'),
    { housenumber: '41-17', street: 'Main Street' });
});

test('splitAddress: refuses ambiguous / non-street', () => {
  assert.equal(splitAddress('P.O. BOX 340'), null);
  assert.equal(splitAddress('PO BOX 12'), null);
  assert.equal(splitAddress('ONE LIBRARY LANE'), null);   // spelled-out number
  assert.equal(splitAddress(''), null);
  assert.equal(splitAddress(null), null);
  // Leading ordinal street with no house number must NOT be mis-split.
  assert.equal(splitAddress('12TH AVENUE NORTH'), null);
});

test('suggestTagsForOutlet: fills blanks, leaves matching values alone', () => {
  const outlet = { name: 'SOLON BRANCH LIBRARY', addr: '34125 PORTZ PKWY', city: 'SOLON', zip: '44139', phone: '4402480777', geo: 'E', geomtype: 'POINTADDRESS' };
  const osm = { name: 'Solon Branch Library', 'addr:city': 'Solon' }; // name matches, city matches
  const { tags, conflicts } = suggestTagsForOutlet(outlet, 'Q5197076', osm, { allowAddr: true });
  assert.equal(tags.name, undefined);          // OSM name equals PLS name — no fill, no conflict
  assert.equal(tags['addr:city'], undefined);  // matches
  assert.equal(conflicts.length, 0);
  assert.equal(tags['operator:wikidata'], 'Q5197076');
  assert.equal(tags['addr:housenumber'], '34125');
  assert.equal(tags['addr:street'], 'Portz Parkway');  // Pkwy expanded to OSM style
  assert.equal(tags['addr:postcode'], '44139');
  assert.equal(tags.phone, '+1 440-248-0777');
});

test('suggestTagsForOutlet: flags a conflict when OSM has a different phone/addr', () => {
  const outlet = { name: 'MAIN LIBRARY', phone: '4025551234', addr: '100 OAK ST', geo: 'E', geomtype: 'POINTADDRESS' };
  const osm = { name: 'Downtown Library', phone: '+1 402-999-0000', 'addr:street': 'Elm Avenue' };
  const { tags, conflicts } = suggestTagsForOutlet(outlet, null, osm, { allowAddr: true });
  assert.equal(tags.phone, undefined);         // differs → not a fill
  const byKey = Object.fromEntries(conflicts.map(c => [c.key, c]));
  assert.deepEqual(byKey.phone, { key: 'phone', osm: '+1 402-999-0000', pls: '+1 402-555-1234' });
  assert.deepEqual(byKey['addr:street'], { key: 'addr:street', osm: 'Elm Avenue', pls: 'Oak Street' });
});

test('suggestTagsForOutlet: name is fill-only — a different OSM name is NOT a conflict', () => {
  // OSM operator-prefixed name vs PLS bare name: stylistic, must not be flagged.
  const outlet = { name: 'DELRIDGE BRANCH LIBRARY' };
  const osm = { name: 'The Seattle Public Library - Delridge Branch' };
  const { tags, conflicts } = suggestTagsForOutlet(outlet, null, osm);
  assert.equal(tags.name, undefined);          // OSM already named — no fill
  assert.equal(conflicts.some(c => c.key === 'name'), false);  // and no conflict
});

test('suggestTagsForOutlet: phone match under contact:phone is neither fill nor conflict', () => {
  const outlet = { name: 'X', phone: '4402480777' };
  const { tags, conflicts } = suggestTagsForOutlet(outlet, null, { 'contact:phone': '+1 440-248-0777' });
  assert.equal(tags.phone, undefined);
  assert.equal(conflicts.length, 0);           // same number, just under contact:phone
});

test('suggestTagsForOutlet: unconfirmed QID is withheld (no fill, no conflict)', () => {
  const outlet = { name: 'X', phone: '-4' };
  const { tags, conflicts } = suggestTagsForOutlet(outlet, 'Q123', {}, { qidConfirmed: false });
  assert.equal(tags['operator:wikidata'], undefined);
  assert.equal(conflicts.length, 0);
});

test('suggestTagsForOutlet: OSM ZIP+4 over a matching PLS ZIP5 is neither fill nor conflict', () => {
  const outlet = { name: 'X', addr: '', city: '', zip: '36064', phone: '-4' };
  const osm = { 'addr:postcode': '36064-2292' };
  const { tags, conflicts } = suggestTagsForOutlet(outlet, null, osm, { allowAddr: true });
  assert.equal(tags['addr:postcode'], undefined);   // key present — never a fill
  assert.equal(conflicts.length, 0);                // ZIP+4 is more precise, not different
});

test('suggestTagsForOutlet: a genuinely different postcode still conflicts', () => {
  const outlet = { name: 'X', addr: '', city: '', zip: '36064', phone: '-4' };
  const osm = { 'addr:postcode': '36066-2292' };
  const { conflicts } = suggestTagsForOutlet(outlet, null, osm, { allowAddr: true });
  assert.deepEqual(conflicts, [{ key: 'addr:postcode', osm: '36066-2292', pls: '36064' }]);
});

test('suggestTagsForOutlet: allowAddr=false withholds all addr:*', () => {
  const outlet = { name: 'X', addr: '100 MAIN ST', city: 'Y', zip: '12345', phone: '-4' };
  const { tags } = suggestTagsForOutlet(outlet, null, {}, { allowAddr: false });
  assert.equal(tags['addr:housenumber'], undefined);
  assert.equal(tags['addr:city'], undefined);
  assert.equal(tags['addr:postcode'], undefined);
});

test('isPreciseGeocode: only precise geomtypes on an E match', () => {
  assert.equal(isPreciseGeocode({ geo: 'E', geomtype: 'PointAddress' }), true);
  assert.equal(isPreciseGeocode({ geo: 'E', geomtype: 'STREETADDRESS' }), true);
  assert.equal(isPreciseGeocode({ geo: 'E', geomtype: 'POSTAL' }), false);
  assert.equal(isPreciseGeocode({ geo: 'T', geomtype: 'PointAddress' }), false);
});
