// Tests for street-expand.mjs — run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand } from './street-expand.mjs';

test('expand: trailing street type', () => {
  assert.equal(expand('Main St'), 'Main Street');
  assert.equal(expand('Portz Pkwy'), 'Portz Parkway');
  assert.equal(expand('Wayzata Blvd'), 'Wayzata Boulevard');
});

test('expand: directional prefix and suffix', () => {
  assert.equal(expand('Madison Ave S'), 'Madison Avenue South');
  assert.equal(expand('S Maryland Ave'), 'South Maryland Avenue');
  assert.equal(expand('228th Ave NE'), '228th Avenue Northeast');
});

test('expand: tolerates trailing period on abbrev', () => {
  assert.equal(expand('Main St.'), 'Main Street');
  assert.equal(expand('W. North Ave'), 'West North Avenue');
});

test('expand: leaves "E Street" as-is (E-street guard)', () => {
  assert.equal(expand('E Street'), 'E Street');
});

test('expand: Saint / County Road', () => {
  assert.equal(expand('St Catherine St'), 'Saint Catherine Street');
  assert.equal(expand('CR 12'), 'County Road 12');
});

test('expand: interior article lowercased, first word kept', () => {
  assert.equal(expand('Casa Del Mar'), 'Casa del Mar');
  assert.equal(expand('La Jolla Blvd'), 'La Jolla Boulevard');
});

test('expand: passes through unknown / ambiguous types unchanged', () => {
  assert.equal(expand('Foo Br'), 'Foo Br');   // 'br' intentionally omitted (ambiguous)
  assert.equal(expand(''), '');
});
