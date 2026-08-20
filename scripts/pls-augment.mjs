// pls-augment.mjs — turn matched IMLS PLS outlets into concrete, additive OSM
// tag suggestions for the augmentation page. Pure functions, no I/O.

import { expand } from './street-expand.mjs';
//
// Design rules (deliberately conservative — PLS lags ~2 years and is a mapper
// assist, never an automated overwrite):
//   • Additive only: only ever suggest a tag the OSM element is MISSING. Never
//     propose changing an existing value — that's a conflict a human resolves.
//   • Address split only when unambiguous (a clean leading house number + street).
//   • addr:* only when the PLS geocode is precise (caller gates on geostatus /
//     geomtype); phone sentinels (-3 / -4) are dropped.

// ---- Title-casing PLS ALL-CAPS names / street names ----------------------
// (Kept here so build + page share one implementation; mirrors qa.js's copy.)
const TC_SMALL = new Set(['of', 'the', 'and', 'at', 'in', 'on', 'for', 'to', 'a', 'an', 'by']);
const TC_KEEP_UPPER = new Set(['NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W', 'US', 'USA']);
export function titleCase(s) {
  if (!s) return s;
  const words = String(s).toLowerCase().split(/\s+/);
  return words.map((w, i) => {
    const up = w.toUpperCase();
    if (TC_KEEP_UPPER.has(up)) return up;
    if (/^[ivxlcdm]+$/i.test(w) && w.length > 1) return up;      // roman numerals
    if (i > 0 && TC_SMALL.has(w)) return w;                       // small joining words
    return w.replace(/(^|[-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  }).join(' ');
}

// ---- Phone -----------------------------------------------------------------
// PLS PHONE is 10 raw digits ("7037315072"); sentinels -3 (temporarily closed)
// / -4 (N/A) mean no number. Returns "+1 XXX-XXX-XXXX" or null.
export function phoneE164(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s.startsWith('-')) return null;      // sentinel / blank
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 10) return null;               // only trust exactly 10 digits
  return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ---- Address split ---------------------------------------------------------
// Conservative US street-address splitter. Only splits when the value begins
// with a clean house number: digits, optionally with a single trailing unit
// letter (e.g. "825", "1865A"), or a simple hyphenated grid number common in
// Queens ("41-17"). Anything else — PO boxes, "ONE LIBRARY LANE", ranges like
// "101-105 STE 5", "HWY 12" with no number — returns null (no addr suggestion).
//
// Returns { housenumber, street, unit? } with a title-cased street, or null.
const PO_BOX_RE = /\bP\.?\s*O\.?\s*BOX\b|\bPOST\s+OFFICE\s+BOX\b/i;
// A trailing unit designator to peel off the street into addr:unit, so it never
// pollutes addr:street (e.g. "SOUTHCENTER MALL #384", "MAIN ST STE 5",
// "169TH PL NE SUITES ABC"). The designator word may be plural (SUITE/SUITES) and
// the unit token may be numeric or alphanumeric ("100", "ABC", "A-1").
const UNIT_RE = /[,\s]\s*(?:#\s*([\w-]+)|(?:STE|SUITES?|UNITS?|APT|RM|ROOM|BLDG|FL|FLOOR)\.?\s+([\w-]+))\s*$/i;

export function splitAddress(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (PO_BOX_RE.test(s)) return null;                  // not a street address

  // Peel a trailing unit/suite designator off first, keeping it for addr:unit.
  // A comma often separates it ("MAIN ST., SUITE 100") — drop that too.
  let unit = null;
  const um = s.match(UNIT_RE);
  if (um) { unit = (um[1] || um[2]).toUpperCase(); s = s.slice(0, um.index).replace(/[,\s]+$/, '').trim(); }

  // House number = a leading token that is PURE digits (with an optional grid
  // hyphen "41-17" or a single trailing unit letter "1865A"). It must be
  // followed by at least one more token (the street). Rejecting an ordinal
  // house token (12TH, 1ST) is what keeps "12TH AVENUE NORTH" — a street with
  // no house number — from being mis-split: there the leading token is "12TH",
  // not a bare number.
  const m = s.match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(\S.*)$/);
  if (!m) return null;
  if (/^\d+(TH|ST|ND|RD)$/i.test(m[1])) return null;   // ordinal ⇒ not a house number

  const housenumber = m[1].toUpperCase();              // "1865A" not "1865a"
  // Title-case, then expand abbreviations to OSM style ("Ave S" -> "Avenue South").
  const street = expand(titleCase(m[2].replace(/[,\s]+$/, ''))); // drop any trailing comma
  if (!street) return null;
  return unit ? { housenumber, street, unit } : { housenumber, street };
}

// Normalize a value for conflict comparison, so trivial formatting differences
// (case, spacing, punctuation) don't read as conflicts. Phones compare on digits.
// Postcodes compare on the 5-digit base: PLS only ships ZIP5, so an OSM ZIP+4
// with the same base is MORE precise, not different.
function normForCompare(key, v) {
  const s = String(v).trim();
  if (key === 'phone') return s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); // last 10 digits
  if (key === 'addr:postcode') {
    const m = s.match(/^(\d{5})(?:-\d{4})?$/);
    if (m) return m[1];
  }
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// ---- Per-outlet suggestion -------------------------------------------------
// Given a PLS outlet, its system QID, and the CURRENT tags of the matched OSM
// element, compare each PLS-derived value against OSM and sort it into:
//   • tags      — OSM LACKS this key: an additive fill (safe to send).
//   • conflicts — OSM HAS a DIFFERENT value: [{ key, osm, pls }] for the mapper
//                 to review (never auto-sent — PLS lags ~2 years).
// A PLS value equal to OSM's (after light normalization) is neither.
//
// `opts.allowAddr` gates the addr:* group on geocode precision (the caller
// decides from geostatus/geomtype). This is for augmenting EXISTING objects
// only — creating missing branches lives on the QA page.
export function suggestTagsForOutlet(outlet, qid, osmTags = {}, opts = {}) {
  const { allowAddr = false, qidConfirmed = true } = opts;
  const tags = {};
  const conflicts = [];
  const raw = k => {
    const v = osmTags[k];
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  };

  // Consider one candidate PLS tag: fill if absent, conflict if OSM differs.
  // `presentKeys` lets a value count as "present" under any of several OSM keys
  // (e.g. phone vs contact:phone); the conflict is reported against the first.
  // `flagConflict=false` means fill-when-blank only, never report a difference —
  // used for `name`, where OSM's value is a curated, differently-styled string
  // (e.g. "Seattle Public Library - X Branch" vs PLS "X Branch Library") and a
  // "conflict" would be almost pure noise.
  const consider = (key, plsVal, { presentKeys = [key], flagConflict = true } = {}) => {
    if (plsVal == null || plsVal === '') return;
    const existingKey = presentKeys.find(k => raw(k) != null);
    if (!existingKey) { tags[key] = plsVal; return; }              // fill blank
    if (!flagConflict) return;
    const osmVal = raw(existingKey);
    if (normForCompare(key, osmVal) !== normForCompare(key, plsVal)) {
      conflicts.push({ key: existingKey, osm: osmVal, pls: plsVal });
    }
  };

  // operator:wikidata — only with a confirmed QID (a domain-derived guess never
  // conflicts against a real tag).
  if (qid && qidConfirmed) consider('operator:wikidata', qid);

  // phone — OSM may store it as phone or contact:phone.
  consider('phone', phoneE164(outlet.phone), { presentKeys: ['phone', 'contact:phone'] });

  // name — fill when OSM has none; never flag a "conflict" (stylistic noise).
  consider('name', titleCase(outlet.name), { flagConflict: false });

  // addr:* — only when the PLS geocode is precise (allowAddr).
  if (allowAddr) {
    const split = splitAddress(outlet.addr);
    if (split) {
      consider('addr:housenumber', split.housenumber);
      consider('addr:street', split.street);
      if (split.unit) consider('addr:unit', split.unit);
    }
    if (outlet.city) consider('addr:city', titleCase(outlet.city));
    const zip = (outlet.zip || '').trim();
    if (/^\d{5}$/.test(zip)) consider('addr:postcode', zip);
  }

  return { tags, conflicts };
}

// PLS geomtypes precise enough to trust addr:* against.
// (A ZIP/locality/street-interpolated match is NOT good enough for addresses.)
const PRECISE_GEOMTYPES = new Set(['POINTADDRESS', 'SUBADDRESS', 'STREETADDRESS']);
export function isPreciseGeocode(outlet) {
  return outlet.geo === 'E' && PRECISE_GEOMTYPES.has(String(outlet.geomtype || '').toUpperCase());
}
