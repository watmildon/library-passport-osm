// qa-map.js — map-first QA page: every actionable issue from the daily
// qa-data.json rendered as a pin, filterable by issue type, so mappers can zoom
// to their own area and work through what's nearby. Issue types:
//
//   unnamed    a library with no name tag at all                (libs[])
//   missing    PLS lists a branch, no OSM library within 200 m  (pls[].missing)
//   opconflict operator signals disagree — the existing tag
//              conflicts with the PLS match, or operator:wikidata
//              contradicts the library's own Wikidata item — a
//              person has to judge             (pls[].untagged, wdConflicts[])
//   operator   no operator tag, with a high-probability
//              suggestion from the PLS crosswalk or the
//              library's own Wikidata item     (pls[].untagged, wdOperators[])
//   gaps       libraries missing basic tags (phone, website,
//              hours, address…) from the flags bitmask          (libs[])
//   unmatched  a whole multi-outlet PLS system the crosswalk
//              couldn't find, with NO operator tags on any
//              matched building — additive work                 (plsUnmatched[])
//   sysmixed   same, but matched buildings already carry OTHER
//              operator tags — cooperative membership, renames,
//              or fragmented spellings; a person judges         (plsUnmatched[])
//
// PLS tag fills and location discrepancies are deliberately NOT map layers —
// the Augment page and the QA dashboard's PLS section own those workflows.
//
// The map view and active filters live in the URL hash so local views are
// shareable (#map=z/lat/lon&t=missing,operator&g=phone,website).

import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/+esm';
import { MAP_STYLE, OVERPASS_TIMEOUT_MS } from './config.js';
import { JOSM, bboxAround, josmSend, fetchTagsBatch, webEditObjectUrl, webEditAtUrl } from './josm.js';
import { country } from './countries.js';

// Active country: ?country=CA loads the Canadian QA dataset. An unknown code
// falls back to the default (US) rather than breaking the page.
const COUNTRY = (() => {
  try { return country(new URL(location.href).searchParams.get('country')?.toUpperCase()); }
  catch { return country(); }
})();

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Title-case an ALL-CAPS name (PLS ships names uppercase) — same rules as qa.js.
const TC_SMALL = new Set(['of', 'the', 'and', 'at', 'in', 'on', 'for', 'to', 'a', 'an', 'by']);
const TC_KEEP_UPPER = new Set(['NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W', 'US', 'USA']);
function titleCase(s) {
  if (!s) return s;
  const words = s.toLowerCase().split(/\s+/);
  return words.map((w, i) => {
    const up = w.toUpperCase();
    if (TC_KEEP_UPPER.has(up)) return up;
    if (/^[ivxlcdm]+$/i.test(w) && w.length > 1) return up;
    if (i > 0 && TC_SMALL.has(w)) return w;
    return w.replace(/(^|[-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  }).join(' ');
}

const fmt = n => n.toLocaleString();

// ---------------- Issue types ----------------
// Array order is also click/list priority (topmost pin type wins a click).
// `on` is the default; the URL hash overrides it.
// CENSUS names the country's outlet census in hints (IMLS PLS for the US,
// provincial open data for Canada).
const CENSUS = COUNTRY.census;
const TYPES = [
  { id: 'unnamed',  label: 'Unnamed',          color: '#a98307', on: true,
    hint: 'A library with no name tag at all – needs a person to find the real name (system branch list, website, imagery, or a visit)' },
  { id: 'missing',  label: 'Missing',          color: '#d1434f', on: true,
    hint: `${CENSUS.name} lists a branch here but OSM has no library within 200 m – likely needs creating` },
  { id: 'opconflict', label: 'Operator conflict', color: '#c23a94', on: true,
    hint: `Signals disagree – the existing operator tag conflicts with the ${CENSUS.short} match, or operator:wikidata contradicts the library’s own Wikidata item. Needs a person to judge` },
  { id: 'operator', label: 'Add operator', color: '#e8872e', on: true,
    hint: `No operator tag, with a high-probability suggestion – from the ${CENSUS.name} crosswalk or the library’s own Wikidata item` },
  { id: 'gaps',     label: 'Incomplete Tags',  color: '#2f8f85', on: false,
    hint: 'Libraries missing everyday tags – choose which tags below' },
  { id: 'unmatched', label: 'System not in OSM', color: '#8c5a3c', on: false,
    hint: `A multi-outlet ${CENSUS.short} system with NO operator tags on any of its branches – unmapped, or purely additive tagging work` },
  { id: 'sysmixed', label: 'System ambiguous', color: '#5a7d9a', on: false,
    hint: `A multi-outlet ${CENSUS.short} system whose branches already carry OTHER operator tags – a federated cooperative, a rename, or fragmented spellings. Needs a person to judge` }
];
const TYPE_BY_ID = new Map(TYPES.map(t => [t.id, t]));
const priority = id => TYPES.findIndex(t => t.id === id);

// Wikidata vocabulary, mirrored from qa.js: the property a parent claim came
// from, and human labels for the entity kinds build-qa.mjs classifies.
const WD_PROP = { P137: 'operator', P749: 'parent organization', P361: 'part of' };
const WD_KIND = {
  libnet: 'library network', library: 'library', university: 'university',
  school: 'school', gov: 'government', place: 'place',
  admin: 'administrative area', org: 'organization', other: 'unclassified'
};

// Tag-gap sub-filters (gaps type). `address` = housenumber AND street present.
const GAP_TAGS = [
  { id: 'phone', label: 'phone' },
  { id: 'website', label: 'website' },
  { id: 'opening_hours', label: 'hours' },
  { id: 'address', label: 'address' },
  { id: 'operator', label: 'operator' },
  { id: 'operator:wikidata', label: 'wikidata' }
];
const GAP_DEFAULT = new Set(['phone', 'website', 'opening_hours']);

// ---------------- State ----------------
const state = {
  data: null,
  issues: {},            // type id -> [issue]
  active: new Set(TYPES.filter(t => t.on).map(t => t.id)),
  gapTags: new Set(GAP_DEFAULT),
  tagBits: {},           // tag key -> flags bit (from data.tags)
  map: null,
  popup: null,
  editor: 'id',
  collapsed: false
};

// ---------------- Editor links (shared behavior with qa.js) ----------------
const EDITOR_KEY = 'libpass:editor';
try { state.editor = localStorage.getItem(EDITOR_KEY) || 'id'; } catch { /* default */ }

const geoUri = (lat, lon) => `geo:${lat},${lon}`;
const OSM_TYPE = { n: 'node', w: 'way', r: 'relation' };

// Link to edit an existing object (osmKey like "w994967608"), per chosen editor.
function editObject(osmKey, lat, lon) {
  const t = OSM_TYPE[osmKey[0]], id = osmKey.slice(1);
  if (state.editor === 'geo') return lat == null ? `https://www.openstreetmap.org/${t}/${id}` : geoUri(lat, lon);
  if (state.editor === 'josm') {
    if (lat == null) return `${JOSM}/import?url=https://www.openstreetmap.org/api/0.6/${t}/${id}/full`;
    const b = bboxAround(lat, lon);
    return `${JOSM}/load_and_zoom?left=${b.left}&right=${b.right}&top=${b.top}&bottom=${b.bottom}&select=${osmKey}`;
  }
  return webEditObjectUrl(state.editor, t, id, lat, lon);
}

// Link to edit at a coordinate (creating a new node / surveying a location).
function editAt(lat, lon) {
  if (state.editor === 'geo') return geoUri(lat, lon);
  if (state.editor === 'josm') {
    const b = bboxAround(lat, lon);
    return `${JOSM}/load_and_zoom?left=${b.left}&right=${b.right}&top=${b.top}&bottom=${b.bottom}`;
  }
  return webEditAtUrl(state.editor, lat, lon);
}

// Overpass Turbo: ALL libraries in a bbox, regardless of tags — for surveying an
// area where operator tags can't be trusted. bb is [west, south, east, north].
function turboLibsBboxUrl(bb) {
  const q = `[out:json][timeout:60];\nnwr[amenity=library](${bb[1]},${bb[0]},${bb[3]},${bb[2]});\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

const wdLink = qid =>
  `<a href="https://www.wikidata.org/wiki/${escapeHtml(qid)}" target="_blank" rel="noopener">${escapeHtml(qid)}</a>`;

// ---------------- Toast ----------------
let toastTimer = null;
function toast(msg, isError = false) {
  let el = $('#qa-toast');
  if (!el) { el = document.createElement('div'); el.id = 'qa-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'qa-toast show' + (isError ? ' qa-toast-error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'qa-toast'; }, isError ? 4000 : 1800);
}

// ---------------- Build issue lists from qa-data.json ----------------
function sysInfo(sysIdx) {
  const s = state.data.systems[sysIdx];
  if (!s) return { sysName: '', qid: null, qidConfirmed: false };
  return { sysName: s.n, qid: s.w || s.sw || null, qidConfirmed: !!s.w };
}

function buildIssues() {
  const d = state.data;

  // The file references systems by stable string KEY (the operator name, or
  // "wd:Q…") rather than array position — resolve keys to indices once,
  // mirroring qa.js's resolveSystemKeys(). Older data already ships numbers.
  const byKey = new Map(d.systems.map((s, i) => [s.k ?? s.n, i]));
  for (const l of d.libs) l[0] = typeof l[0] === 'number' ? l[0] : (byKey.get(l[0]) ?? -1);
  for (const p of d.pls || []) p.sysIdx ??= byKey.get(p.sysKey) ?? -1;

  const issues = { missing: [], operator: [], opconflict: [], unnamed: [], unmatched: [], sysmixed: [], gaps: [] };

  // Wikidata-sourced operator additions: the library's own wikidata= item names
  // the system that runs it, and OSM has no operator tag — a sourced suggestion.
  // Added before the PLS pass so a library found by both gets one pin (the
  // per-object Wikidata evidence wins).
  const seenAdd = new Set();
  for (const g of d.wdOperators || []) {
    for (const l of g.libs) {
      seenAdd.add(l.osm);
      issues.operator.push({
        type: 'operator', kind: 'wd', lon: l.lon, lat: l.lat,
        name: l.n || '(unnamed library)', osm: l.osm,
        ownQ: l.q, prop: WD_PROP[l.pr] || l.pr,
        opName: g.po, parentQ: g.pq, parentName: g.pn,
        sysName: g.po || g.pn
      });
    }
  }

  // Conflicting Wikidata signals: operator:wikidata points at one item while
  // the library's own item names another (often a place or a government rather
  // than the library system).
  for (const g of d.wdConflicts || []) {
    for (const l of g.libs) {
      issues.opconflict.push({
        type: 'opconflict', kind: 'wdc', lon: l.lon, lat: l.lat,
        name: l.n || '(unnamed library)', osm: l.osm,
        ownQ: l.q, prop: WD_PROP[l.pr] || l.pr,
        taggedQ: g.tw, taggedName: g.tn, taggedKind: g.tk,
        parentQ: g.pq, parentName: g.pn
      });
    }
  }

  // Unnamed libraries — no name tag at all. High-value fixes that need a
  // person: the real name comes from the system's branch list, the website,
  // imagery, or a visit.
  for (const l of d.libs) {
    const [sysIdx, type, id, name, , flags, lon, lat] = l;
    if (name) continue;
    issues.unnamed.push({
      type: 'unnamed', lon, lat, osm: type + id, flags,
      name: '(unnamed library)', sysName: d.systems[sysIdx]?.n ?? ''
    });
  }

  for (const p of d.pls || []) {
    const sys = sysInfo(p.sysIdx);
    for (const m of p.missing) issues.missing.push({
      type: 'missing', lon: m.lon, lat: m.lat,
      name: titleCase(m.name), addr: titleCase(m.addr), city: titleCase(m.city),
      state: p.state, ...sys
    });
    for (const u of p.untagged) {
      const base = {
        lon: u.osmLon ?? u.lon, lat: u.osmLat ?? u.lat,
        name: u.osmName || titleCase(u.name), plsName: titleCase(u.name),
        osm: u.osm || null, state: p.state, ...sys
      };
      // An existing-but-different operator is a conflict for a person to judge;
      // no operator at all is a straight addition.
      if (u.osmHasOperator) issues.opconflict.push({ type: 'opconflict', kind: 'pls', ...base });
      else if (!seenAdd.has(u.osm)) issues.operator.push({ type: 'operator', kind: 'pls', ...base });
    }
    // (PLS location discrepancies are deliberately NOT a map layer — the QA
    // dashboard's PLS section lists the few there are.)
  }

  // Unmatched PLS systems split into two kinds of work: when any matched
  // building already carries an operator identity (its libs row resolved to a
  // system), a person has to JUDGE — cooperative membership, a rename, or
  // fragmented spellings. When none does, the work is purely additive.
  const libSys = new Map(d.libs.map(l => [l[1] + l[2], l[0]]));
  for (const u of d.plsUnmatched || []) {
    // Pin at the outlet bbox centre; older data may only carry a centroid.
    const lon = u.bb ? (u.bb[0] + u.bb[2]) / 2 : u.lon;
    const lat = u.bb ? (u.bb[1] + u.bb[3]) / 2 : u.lat;
    if (lon == null || lat == null) continue;
    const pts = u.pts || [];   // per-outlet points (older data predates them)
    const ops = [...new Set(pts.map(p => p.osm && libSys.get(p.osm)).filter(i => i != null && i >= 0))]
      .map(i => d.systems[i].n);
    const type = ops.length ? 'sysmixed' : 'unmatched';
    issues[type].push({
      type, lon, lat,
      name: titleCase(u.name), state: u.state, outlets: u.outlets, near: u.near,
      bb: u.bb || null, fscskey: u.fscskey, pts, ops
    });
  }

  state.issues = issues;
  rebuildGaps();
}

// The gaps list depends on which tags are selected, so it's rebuilt on change.
// A library qualifies when ANY selected tag is missing.
function rebuildGaps() {
  const d = state.data;
  const bit = k => state.tagBits[k] ?? 0;
  const addrMask = bit('addr:housenumber') | bit('addr:street');
  const checks = [...state.gapTags].map(id =>
    id === 'address'
      ? (addrMask ? (f => (f & addrMask) !== addrMask) : null)
      : (bit(id) ? (f => !(f & bit(id))) : null)
  ).filter(Boolean);

  const out = [];
  if (checks.length) {
    for (const l of d.libs) {
      const [sysIdx, type, id, name, , flags, lon, lat] = l;
      const missing = [];
      for (const g of GAP_TAGS) {
        if (!state.gapTags.has(g.id)) continue;
        if (g.id === 'address' ? (addrMask && (flags & addrMask) !== addrMask)
                               : (state.tagBits[g.id] && !(flags & state.tagBits[g.id]))) {
          missing.push(g.label);
        }
      }
      if (!missing.length) continue;
      out.push({
        type: 'gaps', lon, lat,
        name: name || '(unnamed library)', osm: type + id, missing, flags,
        // sysIdx is null (older builds: -1) when the library has no system.
        sysName: d.systems[sysIdx]?.n ?? ''
      });
    }
  }
  state.issues.gaps = out;
}

// ---------------- GeoJSON sources ----------------
const srcId = t => `qm-${t}`;
const layerId = t => `qm-${t}-pins`;

function typeFC(t) {
  return {
    type: 'FeatureCollection',
    features: state.issues[t].map((it, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
      properties: { i }
    }))
  };
}

function syncSource(t) {
  const src = state.map?.getSource(srcId(t));
  if (src) src.setData(typeFC(t));
}

function applyVisibility() {
  for (const t of TYPES) {
    const on = state.active.has(t.id);
    if (state.map?.getLayer(layerId(t.id))) {
      state.map.setLayoutProperty(layerId(t.id), 'visibility', on ? 'visible' : 'none');
    }
  }
}

// ---------------- Map ----------------
function initMap(view, sourceDateLabel) {
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: view ? [view.lon, view.lat] : COUNTRY.mapCenter,
    zoom: view ? view.z : COUNTRY.mapZoom,
    // The issue data's snapshot date lives with the other data credits.
    attributionControl: sourceDateLabel
      ? { customAttribution: `Issue data as of ${sourceDateLabel}` }
      : undefined
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  const geolocate = new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 11 } });
  state.map.addControl(geolocate, 'bottom-right');
  $('#qm-locate').addEventListener('click', () => geolocate.trigger());

  state.map.on('load', () => {
    // Bottom-to-top: later-added layers draw on top; TYPES[0] should win, so add
    // in reverse priority order.
    for (const t of [...TYPES].reverse()) {
      state.map.addSource(srcId(t.id), { type: 'geojson', data: typeFC(t.id) });
      state.map.addLayer({
        id: layerId(t.id),
        type: 'circle',
        source: srcId(t.id),
        paint: (t.id === 'unmatched' || t.id === 'sysmixed') ? {
          // Hollow pin: a whole system's area, not one building.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 9],
          'circle-color': t.color,
          'circle-opacity': 0.15,
          'circle-stroke-width': 2,
          'circle-stroke-color': t.color
        } : t.id === 'gaps' ? {
          // The big layer (up to ~17k pins): small and quiet under the rest.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 9, 4.5, 13, 7],
          'circle-color': t.color,
          'circle-opacity': 0.75,
          'circle-stroke-width': ['step', ['zoom'], 0, 9, 1.5],
          'circle-stroke-color': '#ffffff'
        } : {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 9, 6, 13, 9],
          'circle-color': t.color,
          'circle-opacity': 0.9,
          'circle-stroke-width': ['step', ['zoom'], 0.5, 7, 1.5],
          'circle-stroke-color': '#ffffff'
        }
      });
    }

    // Highlight rectangle for an unmatched system's outlet bbox.
    state.map.addSource('qm-bbox', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    state.map.addLayer({
      id: 'qm-bbox-line',
      type: 'line',
      source: 'qm-bbox',
      paint: { 'line-color': TYPE_BY_ID.get('unmatched').color, 'line-width': 2, 'line-dasharray': [2, 2] }
    });
    // …and its individual suspected outlets, shown while the popup is open:
    // gold = an OSM building likely already there (fix tags), red = not found
    // (likely create).
    state.map.addSource('qm-syspts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    state.map.addLayer({
      id: 'qm-syspts-pins',
      type: 'circle',
      source: 'qm-syspts',
      paint: {
        'circle-radius': 6,
        'circle-color': ['case', ['get', 'inOsm'], '#9a7d00', '#d1434f'],
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff'
      }
    });

    applyVisibility();

    // One click handler across all pin layers; highest-priority type wins.
    state.map.on('click', e => {
      const layers = TYPES.map(t => layerId(t.id)).filter(id => state.map.getLayer(id));
      const feats = state.map.queryRenderedFeatures(e.point, { layers });
      if (!feats.length) return;
      feats.sort((a, b) => priority(a.layer.id.slice(3, -5)) - priority(b.layer.id.slice(3, -5)));
      const type = feats[0].layer.id.slice(3, -5); // qm-<type>-pins
      openIssue(type, feats[0].properties.i);
    });
    for (const t of TYPES) {
      state.map.on('mouseenter', layerId(t.id), () => state.map.getCanvas().style.cursor = 'pointer');
      state.map.on('mouseleave', layerId(t.id), () => state.map.getCanvas().style.cursor = '');
    }

    state.map.on('moveend', () => { renderList(); writeHash(); });
    renderList();
  });
}

function setBboxHighlight(bb) {
  const src = state.map.getSource('qm-bbox');
  if (!src) return;
  src.setData(!bb ? { type: 'FeatureCollection', features: [] } : {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]
    },
    properties: {}
  });
}

// Show/clear the selected unmatched system's outlet points. Pins sit on the OSM
// object when one was found (that's where the edit happens), else the PLS spot.
function setSysPts(pts) {
  const src = state.map.getSource('qm-syspts');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: (pts || []).map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.osmLon ?? p.lon, p.osmLat ?? p.lat] },
      properties: { inOsm: !!p.osm }
    }))
  });
}

// ---------------- Popups ----------------
// Chip block plus a copy button that writes the tags as key=value lines —
// pasteable straight into JOSM's/iD's tag text views. Manually selecting the
// chips copies them run-together (inline spans carry no separators), which is
// exactly what the button avoids.
const tagLines = tags => Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('\n');
function tagChips(tags) {
  return `<div class="aug-chips">${Object.entries(tags).map(([k, v]) =>
    `<span class="aug-chip"><code>${escapeHtml(k)}</code>=${escapeHtml(v)}</span>`).join('')}<button
    class="qm-copy-tags" data-tags="${escapeHtml(tagLines(tags))}"
    title="Copy as key=value lines">⧉ Copy</button></div>`;
}

function qidRow(it) {
  if (!it.qid) return '';
  return `<div class="r"><span class="k">wd</span><span>${it.qidConfirmed
    ? `operator:wikidata = ${wdLink(it.qid)}`
    : `operator:wikidata ≈ ${wdLink(it.qid)} <span class="qa-badge qa-badge-mixed" title="Suggested via a shared website domain – verify before applying">verify</span>`}</span></div>`;
}

const editLink = (href, label) =>
  `<a class="qm-act" href="${href}" target="_blank" rel="noopener">${label}</a>`;

function popupHtml(type, it) {
  const head = (badge) => `
    <div class="pop-head">
      <p class="nm">${escapeHtml(it.name)}</p>
      ${it.sysName ? `<div class="op">${escapeHtml(it.sysName)}</div>` : ''}
      ${badge ? `<div style="margin-top:6px">${badge}</div>` : ''}
    </div>`;

  if (type === 'missing') {
    const tags = { amenity: 'library', name: it.name };
    if (it.sysName && !/^Q\d+$/.test(it.sysName)) tags.operator = it.sysName;
    if (it.qid && it.qidConfirmed) tags['operator:wikidata'] = it.qid;
    return head('<span class="qm-badge" style="--c:#d1434f">missing from OSM</span>') + `
      <div class="pop-body">
        ${it.addr || it.city ? `<div class="r"><span class="k">📍</span><span>${escapeHtml([it.addr, it.city].filter(Boolean).join(', '))}</span></div>` : ''}
        ${qidRow(it)}
        <div class="qa-note" style="margin:8px 0 0">Suggested starter tags – verify on the ground or from the library's website:</div>
        ${tagChips(tags)}
        <div class="qm-actions">${editLink(editAt(it.lat, it.lon), '✏️ Create here')}</div>
      </div>`;
  }

  if (type === 'operator') {
    const sug = {};
    let source;
    if (it.kind === 'wd') {
      // The library's own wikidata item names the system: a sourced suggestion.
      // Prefer the operator spelling OSM mappers already use (po); the item's
      // label is the fallback, flagged so the spelling gets checked.
      if (it.opName || it.parentName) sug.operator = it.opName || it.parentName;
      sug['operator:wikidata'] = it.parentQ;
      source = `<div class="r"><span class="k">src</span><span>Its own item ${wdLink(it.ownQ)}
        says ${escapeHtml(it.prop)}: ${escapeHtml(it.parentName || it.parentQ)}${it.opName ? '' :
        ' <span class="qa-badge qa-badge-mixed" title="Name from the Wikidata label – no OSM system carries this item yet; check the spelling mappers use">verify name</span>'}</span></div>`;
    } else {
      if (it.sysName && !/^Q\d+$/.test(it.sysName)) sug.operator = it.sysName;
      if (it.qid && it.qidConfirmed) sug['operator:wikidata'] = it.qid;
      source = (it.plsName && it.plsName !== it.name
        ? `<div class="r"><span class="k">${escapeHtml(CENSUS.short)}</span><span>${escapeHtml(it.plsName)}</span></div>` : '') + qidRow(it);
    }
    return head('<span class="qm-badge" style="--c:#e8872e">no operator tag</span>') + `
      <div class="pop-body">
        ${source}
        ${Object.keys(sug).length ? `<div class="qa-note" style="margin:8px 0 0">Suggested:</div>${tagChips(sug)}` : ''}
        <div class="qm-actions">${it.osm ? editLink(editObject(it.osm, it.lat, it.lon), '✏️ Add tags') : editLink(editAt(it.lat, it.lon), '✏️ Edit here')}</div>
      </div>`;
  }

  if (type === 'opconflict') {
    const body = it.kind === 'wdc'
      ? `<div class="r"><span class="k">now</span><span>operator:wikidata = ${wdLink(it.taggedQ)}
          ${escapeHtml(it.taggedName || '')}
          <span class="qa-badge qa-badge-miss">${escapeHtml(WD_KIND[it.taggedKind] || it.taggedKind || '')}</span></span></div>
         <div class="r"><span class="k">item</span><span>But its own item ${wdLink(it.ownQ)} says
          ${escapeHtml(it.prop)}: ${escapeHtml(it.parentName || '')} ${wdLink(it.parentQ)}</span></div>`
      : `<div class="r"><span class="k">⚠</span><span>OSM already has a different operator tag,
          but the ${escapeHtml(CENSUS.short)} matches this library to “${escapeHtml(it.sysName)}”. Check which is right.</span></div>` + qidRow(it);
    return head('<span class="qm-badge" style="--c:#c23a94">conflicting signals</span>') + `
      <div class="pop-body">
        ${body}
        <div id="qm-opcard">${opCardHtml(null, 'loading…')}</div>
        <div class="qm-actions">${editLink(editObject(it.osm, it.lat, it.lon), '✏️ Review')}</div>
      </div>`;
  }

  if (type === 'unmatched' || type === 'sysmixed') {
    const note = type === 'sysmixed'
      ? `Branches already carry operator tags – <b>${it.ops.slice(0, 3).map(escapeHtml).join('</b>, <b>')}</b>${it.ops.length > 3 ? ` +${it.ops.length - 3} more` : ''} – likely a federated cooperative, a rename, or fragmented spellings. Judge which tagging is right before changing anything.`
      : it.near
        ? 'Buildings are likely mapped but none carries an operator tag – straightforward additive tagging.'
        : 'No outlet has an OSM library within 200 m – likely unmapped territory.';
    return head(it.near
      ? `<span class="qm-badge" style="--c:#9a7d00">${it.near}/${it.outlets} buildings likely in OSM</span>`
      : '<span class="qm-badge" style="--c:#d1434f">0 outlets found in OSM</span>') + `
      <div class="pop-body">
        <div class="r"><span class="k">📍</span><span>${escapeHtml(it.state)} · ${it.outlets} ${escapeHtml(CENSUS.short)} outlets · <span class="pls-geo">${escapeHtml(it.fscskey)}</span></span></div>
        <div class="qa-note" style="margin:8px 0 0">${note}</div>
        ${it.pts.length ? `<div class="qm-outlet-list">${it.pts.map((p, i) => `
          <div class="qm-outlet" data-i="${i}" title="Click to zoom here">
            <span class="qm-dot" style="--c:${p.osm ? '#9a7d00' : '#d1434f'}"></span>
            <span class="qm-outlet-n">${escapeHtml(titleCase(p.n))}</span>
            <span class="qm-outlet-m">${p.osm ? `<span title="Nearby OSM object: ${escapeHtml(p.osmName || '(unnamed)')}">in OSM</span>` : 'not found'}</span>
            <a class="qa-icon-link" target="_blank" rel="noopener"
               title="${p.osm ? 'Fix tags in editor' : 'Create in editor'}"
               href="${p.osm ? editObject(p.osm, p.osmLat, p.osmLon) : editAt(p.lat, p.lon)}">✏️</a>
          </div>${p.osm ? `<div class="qm-outlet-tags" data-osm="${p.osm}">…</div>` : ''}`).join('')}</div>` : ''}
        <div class="qm-actions">
          <button class="qm-act-btn" id="qm-zoom-bbox">🔍 Zoom to area</button>
          ${it.bb ? `<a class="qm-act" href="${turboLibsBboxUrl(it.bb)}" target="_blank" rel="noopener">All libraries here (Turbo)</a>` : ''}
        </div>
      </div>`;
  }

  if (type === 'unnamed') {
    return head('<span class="qm-badge" style="--c:#a98307">no name tag</span>') + `
      <div class="pop-body">
        <div class="qa-note" style="margin:6px 0 0">Find the official name –
          ${it.sysName ? 'the system’s branch list, the library’s website,' : 'the library’s website'}
          or imagery – then add <code>name</code>.</div>
        <div id="qm-tagcard">${tagCardHtml(snapshotTagRows(it), 'checking live…')}</div>
        <div class="qm-actions">${editLink(editObject(it.osm, it.lat, it.lon), '✏️ Edit')}</div>
      </div>`;
  }

  // gaps — the same tag-breakdown card as the main map's "Missing OSM data"
  // popup, rendered from the daily snapshot's flags immediately and upgraded
  // with live values from Overpass once they arrive (fillLiveTagCard).
  // The badge counts ALL tracked tags (matching the card), not just the ones
  // selected in the gaps filter — it.missing drives the list row instead.
  const nMiss = snapshotTagRows(it).filter(r => !r.present).length;
  return head(`<span class="qm-badge" style="--c:#2f8f85">${nMiss} tag${nMiss === 1 ? '' : 's'} missing</span>`) + `
    <div class="pop-body">
      <div id="qm-tagcard">${tagCardHtml(snapshotTagRows(it), 'checking live…')}</div>
      <div class="qm-actions">${editLink(editObject(it.osm, it.lat, it.lon), '✏️ Edit')}</div>
    </div>`;
}

// ---------------- Tag-breakdown card (shared visual with the main map) ------
// The daily snapshot only knows tag PRESENCE (the flags bitmask); values come
// from a live single-object Overpass fetch when the popup opens.
const LIVE_TAG_GET = {
  // The build counts contact:* variants as present — mirror that here.
  phone: t => t.phone || t['contact:phone'],
  website: t => t.website || t['contact:website']
};

function snapshotTagRows(it) {
  return (state.data.tags || []).map(key => ({
    key, present: !!(it.flags & (state.tagBits[key] || 0)), value: null
  }));
}

function tagCardHtml(rows, note) {
  const missing = rows.filter(r => !r.present);
  const present = rows.filter(r => r.present);
  const missingHtml = missing.map(r =>
    `<div class="tag-row tag-missing"><span class="tag-k">${escapeHtml(r.key)}</span><span class="tag-v">— missing</span></div>`).join('');
  const presentHtml = present.map(r =>
    `<div class="tag-row tag-present"><span class="tag-k">${escapeHtml(r.key)}</span><span class="tag-v">${r.value != null ? escapeHtml(r.value) : '✓'}</span></div>`).join('');
  return `
    <div class="tags-block">
      <div class="tags-title">OSM tags ${missing.length
        ? `· <span class="tags-count">${missing.length} missing</span>`
        : '· <span class="tags-complete">complete</span>'}${note ? ` <span class="qm-tagcard-note">· ${escapeHtml(note)}</span>` : ''}</div>
      ${missingHtml}${presentHtml}
    </div>`;
}

// One object's current tags, read straight from the OSM API — authoritative,
// CORS-enabled, no replication lag. We always know the exact object id, and
// single-object reads are exactly what the API is for (bulk reads stay on
// Overpass). Returns null on failure — e.g. a 410 for a since-deleted object.
async function fetchOsmTags(osmKey) {
  try {
    const t = OSM_TYPE[osmKey[0]];
    const res = await fetch(`https://api.openstreetmap.org/api/0.6/${t}/${osmKey.slice(1)}.json`, {
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.json()).elements?.[0]?.tags ?? {};
  } catch {
    return null;
  }
}

// The operator-related tags currently on a conflict object — the judgment
// should start from what's actually tagged, so these load live when the popup
// opens. Q-ids in *wikidata values link out.
const OP_KEY_RE = /^(not:)?operator(:|$)|^wikidata$|^brand(:|$)/;

function opCardHtml(tags, note) {
  let rows = '';
  if (tags) {
    const keys = Object.keys(tags).filter(k => OP_KEY_RE.test(k)).sort();
    rows = keys.map(k => {
      const html = /wikidata$/.test(k)
        ? tags[k].split(';').map(q => q.trim())
            .map(q => /^Q\d+$/.test(q) ? wdLink(q) : escapeHtml(q)).join('; ')
        : escapeHtml(tags[k]);
      return `<div class="tag-row tag-present"><span class="tag-k">${escapeHtml(k)}</span><span class="tag-v">${html}</span></div>`;
    }).join('') ||
      '<div class="tag-row tag-missing"><span class="tag-k">operator</span><span class="tag-v">— none tagged</span></div>';
  }
  return `<div class="tags-block">
    <div class="tags-title">Current operator tags${note ? ` <span class="qm-tagcard-note">· ${escapeHtml(note)}</span>` : ''}</div>
    ${rows}
  </div>`;
}

// Inline operator-tag summary for one matched outlet in the unmatched-system
// popup. "No operator tags" is the load-bearing case — it confirms WHY the
// crosswalk couldn't see this system.
function opTagsInline(tags) {
  if (!tags) return '<span class="qm-outlet-tags-none">tags unavailable</span>';
  const keys = Object.keys(tags).filter(k => OP_KEY_RE.test(k)).sort();
  if (!keys.length) return '<span class="qm-outlet-tags-none">no operator tags</span>';
  return keys.map(k => {
    const v = /wikidata$/.test(k)
      ? tags[k].split(';').map(q => q.trim())
          .map(q => /^Q\d+$/.test(q) ? wdLink(q) : escapeHtml(q)).join('; ')
      : escapeHtml(tags[k]);
    return `<span class="qm-otag"><code>${escapeHtml(k)}</code>=${v}</span>`;
  }).join(' ');
}

// Lazily annotate an unmatched system's matched outlets with their current
// operator tags — one OSM API multi-fetch per element type, on popup open.
async function fillOutletTags(it, popup) {
  const keys = it.pts.filter(p => p.osm).map(p => p.osm);
  if (!keys.length) return;
  let tagsByKey = null;
  try { tagsByKey = await fetchTagsBatch(keys); } catch { /* leave unavailable */ }
  if (state.popup !== popup || !popup.isOpen()) return;
  popup.getElement()?.querySelectorAll('.qm-outlet-tags').forEach(div => {
    div.innerHTML = opTagsInline(tagsByKey?.get(div.dataset.osm) ?? null);
  });
}

async function fillOpCard(it, popup) {
  const tags = await fetchOsmTags(it.osm);
  if (state.popup !== popup || !popup.isOpen()) return;
  const card = popup.getElement()?.querySelector('#qm-opcard');
  if (!card) return;
  card.innerHTML = opCardHtml(tags, tags ? '' : 'unavailable – object may have changed');
}

// Upgrade the snapshot card with the object's CURRENT tags — real values, and
// presence that may already be better than the daily snapshot. Fails soft back
// to the snapshot view.
async function fillLiveTagCard(it, popup) {
  const tags = await fetchOsmTags(it.osm);

  // The user may have closed this popup or opened another while we fetched.
  if (state.popup !== popup || !popup.isOpen()) return;
  const card = popup.getElement()?.querySelector('#qm-tagcard');
  if (!card) return;

  const rows = tags
    ? (state.data.tags || []).map(key => {
        const v = (LIVE_TAG_GET[key] || (tg => tg[key]))(tags);
        return { key, present: !!v, value: v || null };
      })
    : snapshotTagRows(it);
  card.innerHTML = tagCardHtml(rows, tags ? 'live' : 'daily snapshot – live check failed');
}

function openIssue(type, i, opts = {}) {
  const it = state.issues[type]?.[i];
  if (!it) return;

  const isSys = type === 'unmatched' || type === 'sysmixed';
  if (opts.fly) {
    if (isSys && it.bb) {
      state.map.fitBounds([[it.bb[0], it.bb[1]], [it.bb[2], it.bb[3]]], { padding: 60, duration: 700 });
    } else {
      state.map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(state.map.getZoom(), 14), duration: 700 });
    }
  }

  if (state.popup) state.popup.remove();
  setBboxHighlight(isSys ? it.bb : null);
  setSysPts(isSys ? it.pts : null);

  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
    .setLngLat([it.lon, it.lat])
    .setHTML(`<div class="pop qm-pop">${popupHtml(type, it)}</div>`)
    .addTo(state.map);
  state.popup.on('close', () => { setBboxHighlight(null); setSysPts(null); });

  const el = state.popup.getElement();
  el.querySelectorAll('.qm-copy-tags').forEach(b => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.tags);
      b.textContent = 'Copied ✓';
    } catch {
      // Clipboard needs a secure context; leave the lines in the tooltip.
      b.title = b.dataset.tags;
      b.textContent = 'select from tooltip';
    }
    setTimeout(() => { b.textContent = '⧉ Copy'; }, 1600);
  }));
  el.querySelector('#qm-zoom-bbox')?.addEventListener('click', () => {
    if (it.bb) state.map.fitBounds([[it.bb[0], it.bb[1]], [it.bb[2], it.bb[3]]], { padding: 60, duration: 700 });
  });
  // Outlet rows zoom to the suspected library (the edit link inside still works).
  el.querySelectorAll('.qm-outlet').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const p = it.pts[+row.dataset.i];
    if (p) state.map.flyTo({ center: [p.osmLon ?? p.lon, p.osmLat ?? p.lat], zoom: 16, duration: 700 });
  }));
  if (type === 'gaps' || type === 'unnamed') fillLiveTagCard(it, state.popup);
  if (type === 'opconflict') fillOpCard(it, state.popup);
  if (isSys) fillOutletTags(it, state.popup);
}

// ---------------- Filter chips ----------------
function renderChips() {
  $('#qm-chips').innerHTML = TYPES.map(t => `
    <div class="chip qm-chip ${state.active.has(t.id) ? 'active' : ''}" data-type="${t.id}" title="${escapeHtml(t.hint)}">
      <span class="qm-dot" style="--c:${t.color}"></span>${escapeHtml(t.label)}
      <span class="qm-chip-n">${fmt(state.issues[t.id].length)}</span>
    </div>`).join('');
  $('#qm-chips').querySelectorAll('.qm-chip').forEach(chip => chip.addEventListener('click', () => {
    const id = chip.dataset.type;
    if (state.active.has(id)) state.active.delete(id); else state.active.add(id);
    if (id === 'gaps') $('#qm-gaptags').hidden = !state.active.has('gaps');
    renderChips();
    applyVisibility();
    renderList();
    writeHash();
  }));
  $('#qm-gaptags').hidden = !state.active.has('gaps');
}

function renderGapTagChips() {
  $('#qm-gaptags').innerHTML =
    '<span class="qm-gaptags-label">missing:</span>' + GAP_TAGS.map(g => `
    <div class="chip qm-chip qm-chip-sm ${state.gapTags.has(g.id) ? 'active' : ''}" data-tag="${g.id}">${escapeHtml(g.label)}</div>`).join('');
  $('#qm-gaptags').querySelectorAll('[data-tag]').forEach(chip => chip.addEventListener('click', () => {
    const id = chip.dataset.tag;
    if (state.gapTags.has(id)) state.gapTags.delete(id); else state.gapTags.add(id);
    rebuildGaps();
    syncSource('gaps');
    renderGapTagChips();
    renderChips();
    renderList();
    writeHash();
  }));
}

// ---------------- In-view work list ----------------
const LIST_MAX = 150;

function renderList() {
  const el = $('#qm-list');
  if (!state.map) return;
  const b = state.map.getBounds();
  const rows = [];
  for (const t of TYPES) {
    if (!state.active.has(t.id)) continue;
    const list = state.issues[t.id];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.lon >= b.getWest() && it.lon <= b.getEast() && it.lat >= b.getSouth() && it.lat <= b.getNorth()) {
        rows.push({ t, i, it });
      }
    }
  }
  $('#qm-count').textContent = fmt(rows.length);

  if (!rows.length) {
    el.innerHTML = '<div class="list-empty">No issues of the selected types in view.<br>Zoom out, pan, or enable more types above.</div>';
    return;
  }
  rows.sort((a, b2) => priority(a.t.id) - priority(b2.t.id) || a.it.name.localeCompare(b2.it.name));
  const shown = rows.slice(0, LIST_MAX);

  const detail = ({ t, it }) => {
    if (t.id === 'missing') return [it.city, it.state, 'create'].filter(Boolean).join(' · ');
    if (t.id === 'operator') return it.sysName ? `add operator → ${it.sysName}` : 'add operator tag';
    if (t.id === 'opconflict') return it.kind === 'wdc'
      ? `tagged “${it.taggedName || it.taggedQ}”, item says “${it.parentName || it.parentQ}”`
      : `operator differs from ${CENSUS.short} match “${it.sysName}”`;
    if (t.id === 'unnamed') return [it.sysName, 'needs a name'].filter(Boolean).join(' · ');
    if (t.id === 'unmatched') return `${it.state} · ${it.outlets} outlets · ${it.near}/${it.outlets} in OSM`;
    if (t.id === 'sysmixed') return `${it.state} · tagged as ${it.ops.slice(0, 2).join(', ')}${it.ops.length > 2 ? ` +${it.ops.length - 2}` : ''}`;
    return 'missing ' + it.missing.join(', ');
  };

  el.innerHTML = shown.map(r => `
    <div class="lib-item qm-item" data-type="${r.t.id}" data-i="${r.i}">
      <span class="qm-dot qm-dot-lg" style="--c:${r.t.color}"></span>
      <div class="info">
        <div class="nm">${escapeHtml(r.it.name)}</div>
        <div class="meta">${escapeHtml(detail(r))}</div>
      </div>
    </div>`).join('') +
    (rows.length > LIST_MAX ? `<div class="list-empty">…and ${fmt(rows.length - LIST_MAX)} more – zoom in to narrow the list.</div>` : '');

  el.querySelectorAll('.qm-item').forEach(item => item.addEventListener('click', () => {
    openIssue(item.dataset.type, +item.dataset.i, { fly: true });
  }));
}

// ---------------- URL hash (shareable view + filters) ----------------
function readHash() {
  const out = { view: null };
  for (const part of location.hash.slice(1).split('&')) {
    const [k, v] = part.split('=');
    if (k === 'map' && v) {
      const [z, lat, lon] = v.split('/').map(Number);
      if ([z, lat, lon].every(Number.isFinite)) out.view = { z, lat, lon };
    }
    if (k === 't' && v != null) {
      const ids = new Set(v.split(',').filter(id => TYPES.some(t => t.id === id)));
      out.types = ids;
    }
    if (k === 'g' && v) {
      out.gaps = new Set(v.split(',').filter(id => GAP_TAGS.some(g => g.id === id)));
    }
  }
  return out;
}

function writeHash() {
  if (!state.map) return;
  const c = state.map.getCenter();
  const z = state.map.getZoom();
  const parts = [`map=${z.toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`];
  parts.push('t=' + [...state.active].join(','));
  if (state.active.has('gaps')) parts.push('g=' + [...state.gapTags].join(','));
  history.replaceState(null, '', '#' + parts.join('&'));
}

// ---------------- Editor picker ----------------
function setupEditorPicker() {
  const sel = $('#qm-editor-select');
  const hint = $('#qm-editor-hint');
  const showHint = () => {
    hint.textContent = state.editor === 'josm'
      ? 'JOSM must be running with Remote Control enabled.'
      : state.editor === 'geo'
        ? 'Opens your device\'s map app – mostly useful on mobile.'
        : '';
  };
  sel.value = state.editor;
  showHint();
  sel.addEventListener('change', () => {
    state.editor = sel.value;
    try { localStorage.setItem(EDITOR_KEY, state.editor); } catch { /* ignore */ }
    showHint();
    if (state.popup) state.popup.remove(); // stale editor links
  });

  // Any link pointing at the JOSM host fires in the background instead of a tab.
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.href.startsWith(JOSM)) {
      e.preventDefault();
      josmSend(a.href).then(ok => toast(ok
        ? 'Sent to JOSM'
        : 'JOSM didn’t respond – is it running with Remote Control enabled?', !ok));
    }
  });
}

// ---------------- Preferences pane (behind the gear) ----------------
function setupPrefs() {
  const btn = $('#qm-prefs-btn');
  const pane = $('#qm-prefs');
  btn.addEventListener('click', () => {
    pane.hidden = !pane.hidden;
    btn.setAttribute('aria-expanded', String(!pane.hidden));
  });
}

// ---------------- Panel collapse (small screens) ----------------
function setupCollapse() {
  const btn = $('#qm-collapse');
  btn.addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    document.getElementById('qm-panel').classList.toggle('collapsed', state.collapsed);
    btn.textContent = state.collapsed ? '▸' : '▾';
    btn.setAttribute('aria-expanded', String(!state.collapsed));
  });
}

// ---------------- Boot ----------------
async function boot() {
  setupEditorPicker();
  setupPrefs();
  setupCollapse();

  // Country toggle: mark the active country and carry the current view/filter
  // hash across the switch, so toggling keeps you looking at the same area.
  document.querySelectorAll('#country-toggle a[data-country]').forEach(a => {
    a.classList.toggle('active', a.dataset.country === COUNTRY.code);
    a.addEventListener('click', () => {
      if (location.hash) a.href = a.getAttribute('href').split('#')[0] + location.hash;
    });
  });

  // Keep the dashboard link on the same country; the Augment page is backed by
  // the US-only PLS census, so hide it elsewhere.
  if (COUNTRY.code !== 'US') {
    const dash = document.querySelector('a[href="./qa.html"]');
    if (dash) dash.href = `./qa.html?country=${COUNTRY.code}`;
    const aug = document.querySelector('a[href="./augment.html"]');
    if (aug) aug.style.display = 'none';
  }

  let data;
  try {
    const res = await fetch('./' + COUNTRY.qaFile);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#loading').classList.remove('show');
    $('#qm-list').innerHTML =
      `<div class="list-empty">Could not load QA data (${escapeHtml(e.message)}). Reload to retry.</div>`;
    return;
  }
  state.data = data;
  (data.tags || []).forEach((k, i) => { state.tagBits[k] = 1 << i; });

  const hash = readHash();
  if (hash.types) state.active = hash.types;
  if (hash.gaps) state.gapTags = hash.gaps;

  buildIssues();

  const m = data.meta;
  const src = m.sourceModified || m.layercakeModified;

  renderChips();
  renderGapTagChips();
  initMap(hash.view, src ? new Date(src).toLocaleDateString() : m.generated);
  $('#loading').classList.remove('show');
}

boot();
