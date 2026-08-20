// qa-map.js — map-first QA page: every actionable issue from the daily
// qa-data.json rendered as a pin, filterable by issue type, so mappers can zoom
// to their own area and work through what's nearby. Issue types:
//
//   missing    PLS lists a branch, no OSM library within 200 m  (pls[].missing)
//   operator   an OSM library is there but the operator tag is
//              absent or disagrees                              (pls[].untagged)
//   augment    PLS has values for blank tags — ready to apply   (augment[].branches)
//   loc        name matched but coordinates are far apart       (pls[].discrepancies)
//   unmatched  a whole multi-outlet PLS system the crosswalk
//              couldn't find in OSM (bbox centroid pin)         (plsUnmatched[])
//   gaps       libraries missing basic tags (phone, website,
//              hours, address…) from the flags bitmask          (libs[])
//
// The map view and active filters live in the URL hash so local views are
// shareable (#map=z/lat/lon&t=missing,operator&g=phone,website).

import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/+esm';
import { MAP_STYLE, overpassEndpoints } from './config.js';
import { JOSM, bboxAround, josmSend, buildOsmXml, loadData, webEditObjectUrl, webEditAtUrl } from './josm.js';

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
const TYPES = [
  { id: 'missing',  label: 'Missing library',  color: '#d1434f', on: true,
    hint: 'IMLS PLS lists a branch here but OSM has no library within 200 m – likely needs creating' },
  { id: 'operator', label: 'Operator tag fix', color: '#e8872e', on: true,
    hint: 'An OSM library is here but its operator tag is missing or disagrees with PLS' },
  { id: 'augment',  label: 'Tag fills ready',  color: '#6f4bd8', on: true,
    hint: 'PLS has values for tags this library lacks – review and apply' },
  { id: 'loc',      label: 'Location check',   color: '#c23a94', on: true,
    hint: 'Name matched but the OSM and PLS coordinates are far apart – verify which is right' },
  { id: 'unmatched', label: 'System not in OSM', color: '#8c5a3c', on: false,
    hint: 'A multi-outlet PLS system the crosswalk found no OSM operator for – fragmented tags or unmapped' },
  { id: 'gaps',     label: 'Basic tag gaps',   color: '#2f8f85', on: false,
    hint: 'Libraries missing everyday tags – choose which tags below' }
];
const TYPE_BY_ID = new Map(TYPES.map(t => [t.id, t]));
const priority = id => TYPES.findIndex(t => t.id === id);

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
  if (!s) return { name: '', qid: null, qidConfirmed: false };
  return { name: s.n, qid: s.w || s.sw || null, qidConfirmed: !!s.w };
}

function buildIssues() {
  const d = state.data;
  const issues = { missing: [], operator: [], augment: [], loc: [], unmatched: [], gaps: [] };

  for (const p of d.pls || []) {
    const sys = sysInfo(p.sysIdx);
    for (const m of p.missing) issues.missing.push({
      type: 'missing', lon: m.lon, lat: m.lat,
      name: titleCase(m.name), addr: titleCase(m.addr), city: titleCase(m.city),
      geo: m.geo || '', state: p.state, ...sys
    });
    for (const u of p.untagged) issues.operator.push({
      type: 'operator', lon: u.osmLon ?? u.lon, lat: u.osmLat ?? u.lat,
      name: u.osmName || titleCase(u.name), plsName: titleCase(u.name),
      osm: u.osm || null, wrong: !!u.osmHasOperator, state: p.state, ...sys
    });
    for (const dd of p.discrepancies) issues.loc.push({
      type: 'loc', lon: dd.osmLon ?? dd.lon, lat: dd.osmLat ?? dd.lat,
      name: titleCase(dd.name), osm: dd.osmId || null,
      plsLat: dd.lat, plsLon: dd.lon, dist: dd.dist, state: p.state, ...sys
    });
  }

  for (const a of d.augment || []) {
    const sys = sysInfo(a.sysIdx);
    for (const b of a.branches) issues.augment.push({
      type: 'augment', lon: b.lon, lat: b.lat,
      name: b.plsName, osm: b.osm, tags: b.tags || {}, conflicts: b.conflicts || [],
      qid: a.qid || sys.qid, qidConfirmed: a.qidConfirmed ?? sys.qidConfirmed,
      state: a.state, sysName: sys.name
    });
  }

  for (const u of d.plsUnmatched || []) {
    // Pin at the outlet bbox centre; older data may only carry a centroid.
    const lon = u.bb ? (u.bb[0] + u.bb[2]) / 2 : u.lon;
    const lat = u.bb ? (u.bb[1] + u.bb[3]) / 2 : u.lat;
    if (lon == null || lat == null) continue;
    issues.unmatched.push({
      type: 'unmatched', lon, lat,
      name: titleCase(u.name), state: u.state, outlets: u.outlets, near: u.near,
      bb: u.bb || null, fscskey: u.fscskey
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
        name: name || '(unnamed library)', osm: type + id, missing,
        sysName: sysIdx >= 0 ? d.systems[sysIdx].n : ''
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
function initMap(view) {
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: view ? [view.lon, view.lat] : [-98, 40],
    zoom: view ? view.z : 4
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
        paint: t.id === 'unmatched' ? {
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

// ---------------- Popups ----------------
function tagChips(tags) {
  return `<div class="aug-chips">${Object.entries(tags).map(([k, v]) =>
    `<span class="aug-chip"><code>${escapeHtml(k)}</code>=${escapeHtml(v)}</span>`).join('')}</div>`;
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
        <div class="r"><span class="k">geocode</span><span class="pls-geo" title="IMLS geocode precision – the pin may sit on the parcel or street, not the door">${escapeHtml(it.geo)}</span></div>
        ${qidRow(it)}
        <div class="qa-note" style="margin:8px 0 0">Suggested starter tags – verify on the ground or from the library's website:</div>
        ${tagChips(tags)}
        <div class="qm-actions">${editLink(editAt(it.lat, it.lon), '✏️ Create here')}</div>
      </div>`;
  }

  if (type === 'operator') {
    const sug = {};
    if (it.sysName && !/^Q\d+$/.test(it.sysName)) sug.operator = it.sysName;
    if (it.qid && it.qidConfirmed) sug['operator:wikidata'] = it.qid;
    return head(it.wrong
      ? '<span class="qm-badge" style="--c:#9a7d00">wrong operator?</span>'
      : '<span class="qm-badge" style="--c:#e8872e">no operator tag</span>') + `
      <div class="pop-body">
        ${it.plsName && it.plsName !== it.name ? `<div class="r"><span class="k">PLS</span><span>${escapeHtml(it.plsName)}</span></div>` : ''}
        ${qidRow(it)}
        ${Object.keys(sug).length ? `<div class="qa-note" style="margin:8px 0 0">Suggested:</div>${tagChips(sug)}` : ''}
        <div class="qm-actions">${it.osm ? editLink(editObject(it.osm, it.lat, it.lon), '✏️ Fix tags') : editLink(editAt(it.lat, it.lon), '✏️ Edit here')}</div>
      </div>`;
  }

  if (type === 'augment') {
    const n = Object.keys(it.tags).length;
    const conflicts = it.conflicts.length ? `
      <div class="aug-conflicts">
        <span class="aug-conflict-label">⚠ Conflicts – resolve by hand, never auto-applied</span>
        ${it.conflicts.map(c => `<div class="aug-conflict-row"><code>${escapeHtml(c.key)}</code>
          <span class="aug-cf-osm">OSM: ${escapeHtml(c.osm)}</span>
          <span class="aug-cf-pls">PLS: ${escapeHtml(c.pls)}</span></div>`).join('')}
      </div>` : '';
    return head(n
      ? `<span class="qm-badge" style="--c:#6f4bd8">${n} fill${n === 1 ? '' : 's'} ready</span>`
      : `<span class="qm-badge" style="--c:#9a7d00">${it.conflicts.length} conflict${it.conflicts.length === 1 ? '' : 's'} to review</span>`) + `
      <div class="pop-body">
        ${n ? tagChips(it.tags) : ''}
        ${conflicts}
        <div class="qm-actions">
          ${n ? `<button class="qm-act-btn" id="qm-send-josm">⬆ Send fills to JOSM</button>` : ''}
          ${editLink(editObject(it.osm, it.lat, it.lon), '✏️ Edit')}
          <a class="qm-act" href="./augment.html" target="_blank" rel="noopener" title="The Augment page batches all of a system's fills into one JOSM review layer">whole system →</a>
        </div>
      </div>`;
  }

  if (type === 'loc') {
    return head('<span class="qm-badge" style="--c:#c23a94">location check</span>') + `
      <div class="pop-body">
        <div class="r"><span class="k">⚑</span><span>The OSM object is ~${fmt(it.dist)} m from the PLS coordinate – verify which is right.</span></div>
        <div class="qm-actions">
          ${it.osm ? editLink(editObject(it.osm, it.lat, it.lon), '✏️ OSM object') : ''}
          ${editLink(editAt(it.plsLat, it.plsLon), '📍 PLS spot')}
        </div>
      </div>`;
  }

  if (type === 'unmatched') {
    return head(it.near
      ? `<span class="qm-badge" style="--c:#9a7d00">${it.near}/${it.outlets} buildings likely in OSM</span>`
      : '<span class="qm-badge" style="--c:#d1434f">0 outlets found in OSM</span>') + `
      <div class="pop-body">
        <div class="r"><span class="k">📍</span><span>${escapeHtml(it.state)} · ${it.outlets} PLS outlets · <span class="pls-geo">${escapeHtml(it.fscskey)}</span></span></div>
        <div class="qa-note" style="margin:8px 0 0">${it.near
          ? 'Buildings are likely mapped but operator tags are missing or inconsistent across this system.'
          : 'No outlet has an OSM library within 200 m – likely unmapped territory.'}</div>
        <div class="qm-actions">
          <button class="qm-act-btn" id="qm-zoom-bbox">🔍 Zoom to area</button>
          ${it.bb ? `<a class="qm-act" href="${turboLibsBboxUrl(it.bb)}" target="_blank" rel="noopener">All libraries here (Turbo)</a>` : ''}
        </div>
      </div>`;
  }

  // gaps
  return head(`<span class="qm-badge" style="--c:#2f8f85">${it.missing.length} tag${it.missing.length === 1 ? '' : 's'} missing</span>`) + `
    <div class="pop-body">
      <div class="aug-chips">${it.missing.map(m => `<span class="aug-chip">${escapeHtml(m)}</span>`).join('')}</div>
      <div class="qm-actions">${editLink(editObject(it.osm, it.lat, it.lon), '✏️ Edit')}</div>
    </div>`;
}

function openIssue(type, i, opts = {}) {
  const it = state.issues[type]?.[i];
  if (!it) return;

  if (opts.fly) {
    if (type === 'unmatched' && it.bb) {
      state.map.fitBounds([[it.bb[0], it.bb[1]], [it.bb[2], it.bb[3]]], { padding: 60, duration: 700 });
    } else {
      state.map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(state.map.getZoom(), 14), duration: 700 });
    }
  }

  if (state.popup) state.popup.remove();
  setBboxHighlight(type === 'unmatched' ? it.bb : null);

  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
    .setLngLat([it.lon, it.lat])
    .setHTML(`<div class="pop qm-pop">${popupHtml(type, it)}</div>`)
    .addTo(state.map);
  state.popup.on('close', () => setBboxHighlight(null));

  const el = state.popup.getElement();
  el.querySelector('#qm-zoom-bbox')?.addEventListener('click', () => {
    if (it.bb) state.map.fitBounds([[it.bb[0], it.bb[1]], [it.bb[2], it.bb[3]]], { padding: 60, duration: 700 });
  });
  el.querySelector('#qm-send-josm')?.addEventListener('click', ev => sendFillsToJosm(it, ev.currentTarget));
}

// Send one branch's fill-blank tags to JOSM as a review layer (same load_data
// flow as the Augment page, scoped to a single object). Conflicts never go.
async function sendFillsToJosm(it, btn) {
  btn.disabled = true;
  toast('Reading the current object from Overpass…');
  let skipped = null;
  try {
    const xml = await buildOsmXml(
      [{ osm: it.osm, tags: it.tags }], [],
      { overpassEndpoints: overpassEndpoints(), onSkip: (_b, why) => { skipped = why; } }
    );
    if (skipped) throw new Error(skipped);
    const ok = await loadData(xml, `PLS augment · ${it.sysName || it.name}`);
    if (ok) toast('Sent to JOSM – review the new layer, then upload from JOSM.');
    else toast('JOSM didn’t respond – is it running with Remote Control enabled?', true);
  } catch (e) {
    toast('Could not prepare the JOSM layer (' + e.message + ').', true);
  }
  btn.disabled = false;
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
    if (t.id === 'operator') return it.wrong ? 'wrong operator?' : 'add operator tag';
    if (t.id === 'augment') return [
      Object.keys(it.tags).join(', '),
      it.conflicts.length ? `${it.conflicts.length} conflict${it.conflicts.length === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' · ');
    if (t.id === 'loc') return `~${fmt(it.dist)} m from PLS location`;
    if (t.id === 'unmatched') return `${it.state} · ${it.outlets} outlets · ${it.near}/${it.outlets} in OSM`;
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
  setupCollapse();

  let data;
  try {
    const res = await fetch('./data/qa-data.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#loading').classList.remove('show');
    $('#qm-meta').textContent = 'Could not load QA data (' + e.message + ').';
    $('#qm-list').innerHTML = '<div class="list-empty">QA data unavailable.</div>';
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
  const total = TYPES.reduce((n, t) => t.id === 'gaps' ? n : n + state.issues[t.id].length, 0);
  $('#qm-meta').textContent =
    `${fmt(total)} PLS-sourced issues · data as of ${src ? new Date(src).toLocaleDateString() : m.generated} (updated daily)`;

  renderChips();
  renderGapTagChips();
  initMap(hash.view);
  $('#loading').classList.remove('show');
}

boot();
