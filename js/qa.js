// qa.js — Data QA page: loads the weekly qa-data.json and renders
// completion stats, wikidata gaps, likely typos, and a per-system explorer.
// The explorer's "Load live details" fetches one system from Overpass to show
// the full tag set (including addresses, absent from the weekly extract).

import { searchSystems } from './systems.js';
import { fetchLibraries } from './overpass.js';
import { TRACKED_TAGS } from './completeness.js';
import { JOSM, bboxAround, josmSend, webEditObjectUrl, webEditAtUrl } from './josm.js';

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Title-case an ALL-CAPS name (PLS ships names uppercase). Lowercases short
// joining words except when first, preserves roman numerals and short
// directionals/abbreviations that read better capitalized.
const TC_SMALL = new Set(['of', 'the', 'and', 'at', 'in', 'on', 'for', 'to', 'a', 'an', 'by']);
const TC_KEEP_UPPER = new Set(['NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W', 'US', 'USA']);
function titleCase(s) {
  if (!s) return s;
  const words = s.toLowerCase().split(/\s+/);
  return words.map((w, i) => {
    const up = w.toUpperCase();
    if (TC_KEEP_UPPER.has(up)) return up;
    if (/^[ivxlcdm]+$/i.test(w) && w.length > 1) return up;      // roman numerals
    if (i > 0 && TC_SMALL.has(w)) return w;                       // small joining words
    // Capitalize after hyphens/slashes too: "algona-pacific" -> "Algona-Pacific"
    return w.replace(/(^|[-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  }).join(' ');
}

// Column meaning of each bit in a library row's flags (matches build-qa.mjs).
// Only the tags the app itself uses are tracked.
const TAG_DEFS = [
  { bit: 8,  key: 'operator' },
  { bit: 16, key: 'operator:wikidata' },
  { bit: 1,  key: 'phone' },
  { bit: 2,  key: 'website' },
  { bit: 4,  key: 'opening_hours' }
];

// Library row accessors ([sysIdx, type, id, name, stateIdx, flags, lon, lat]).
const L = { sys: 0, type: 1, id: 2, name: 3, state: 4, flags: 5, lon: 6, lat: 7 };

const OSM_TYPE = { n: 'node', w: 'way', r: 'relation' };
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;
const fmt = n => n.toLocaleString();

// ---------------- Editor links (iD / Rapid / JOSM) ----------------
// The user's choice is remembered in localStorage. iD and Rapid are web editors
// (open in a new tab); JOSM uses its remote-control HTTP endpoint on localhost,
// which requires JOSM running with Remote Control enabled.
const EDITOR_KEY = 'libpass:editor';
let currentEditor = (() => { try { return localStorage.getItem(EDITOR_KEY) || 'id'; } catch { return 'id'; } })();
function setEditor(e) { currentEditor = e; try { localStorage.setItem(EDITOR_KEY, e); } catch {} }

// Link to edit an existing object (node/way/relation). lat/lon optional but
// needed for JOSM (to build a bbox to load and select within). JOSM/web builders
// live in ./josm.js; this picks per the user's editor choice.
function editObject(type, id, lat, lon) {
  const t = OSM_TYPE[type] || type; // accept 'n'/'node'
  if (currentEditor === 'josm') {
    if (lat == null) return `${JOSM}/import?url=https://www.openstreetmap.org/api/0.6/${t}/${id}/full`;
    const b = bboxAround(lat, lon);
    return `${JOSM}/load_and_zoom?left=${b.left}&right=${b.right}&top=${b.top}&bottom=${b.bottom}&select=${t[0]}${id}`;
  }
  return webEditObjectUrl(currentEditor, t, id, lat, lon);
}

// Link to edit at a coordinate (for creating a new node / checking a location).
function editAt(lat, lon) {
  if (currentEditor === 'josm') {
    const b = bboxAround(lat, lon);
    return `${JOSM}/load_and_zoom?left=${b.left}&right=${b.right}&top=${b.top}&bottom=${b.bottom}`;
  }
  return webEditAtUrl(currentEditor, lat, lon);
}

// Send a JOSM remote-control command in the background (no new tab), toasting
// the dispatched/refused result. See ./josm.js for the CORS caveat.
async function josmRemote(url) {
  if (await josmSend(url)) toast('Sent to JOSM');
  else toast('JOSM didn’t respond – is it running with Remote Control enabled?', true);
}

// A brief status toast (bottom-center).
let toastTimer = null;
function toast(msg, isError = false) {
  let el = $('#qa-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qa-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'qa-toast show' + (isError ? ' qa-toast-error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'qa-toast'; }, isError ? 4000 : 1800);
}

// Wire up the header editor <select>: restore the saved choice, show a JOSM note,
// re-render link-bearing sections on change, and intercept JOSM links so they
// fire in the background instead of opening a tab.
function setupEditorPicker() {
  const sel = $('#editor-select');
  const hint = $('#editor-hint');
  const showHint = () => {
    hint.textContent = currentEditor === 'josm'
      ? 'JOSM must be running with Remote Control enabled.'
      : '';
  };
  sel.value = currentEditor;
  showHint();
  sel.addEventListener('change', () => {
    setEditor(sel.value);
    showHint();
    renderPls();
    if (currentSys >= 0) showSystem(currentSys);  // re-render the explorer table
  });

  // Delegated: any edit link pointing at the JOSM host is sent in the background.
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.href.startsWith(JOSM)) {
      e.preventDefault();
      josmRemote(a.href);
    }
  });
}

// Compact icon links using the services' own logos.
// Overpass Turbo's mark (from its favicon), recolored to inherit the link color.
const TURBO_ICON = '<svg class="qa-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">' +
  '<path d="M 15,8 A 7,7 0 1 1 1,8 7,7 0 1 1 15,8 z" stroke-width="1.5"/>' +
  '<path d="m 1,6 c 0,0 4.5,3 7,3 2.5,0 7,-3 7,-3" stroke-width="1.5"/>' +
  '<path d="M 8,15 8,9" stroke-width="2"/>' +
  '<path d="M 13,7.5 3,7.5" stroke-width="0.5"/></svg>';

// The Wikidata barcode logo, in its own brand colors.
const WIKIDATA_ICON = '<svg class="qa-icon qa-icon-wd" viewBox="0 0 1050 590" aria-hidden="true">' +
  '<path d="m 120,545 h 30 V 45 H 120 V 545 z m 60,0 h 90 V 45 H 180 V 545 z M 300,45 V 545 h 90 V 45 h -90 z" fill="#900"/>' +
  '<path d="m 840,545 h 30 V 45 H 840 V 545 z M 900,45 V 545 h 30 V 45 H 900 z M 420,545 h 30 V 45 H 420 V 545 z M 480,45 V 545 h 30 V 45 h -30 z" fill="#396"/>' +
  '<path d="m 540,545 h 90 V 45 h -90 V 545 z m 120,0 h 30 V 45 H 660 V 545 z M 720,45 V 545 h 90 V 45 H 720 z" fill="#069"/></svg>';

function turboLink(url) {
  return `<a class="qa-icon-link" href="${url}" target="_blank" rel="noopener" title="Open in Overpass Turbo" aria-label="Open in Overpass Turbo">${TURBO_ICON}</a>`;
}
function wdSearchLink(term) {
  return `<a class="qa-icon-link" href="https://www.wikidata.org/w/index.php?search=${encodeURIComponent(term)}" target="_blank" rel="noopener" title="Search Wikidata" aria-label="Search Wikidata">${WIKIDATA_ICON}</a>`;
}

// Overpass Turbo link showing a system's US libraries (auto-runs the query).
function turboUrl(mode, value) {
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sel = mode === 'wikidata' ? `["operator:wikidata"="${esc}"]` : `["operator"="${esc}"]`;
  const q = `[out:json][timeout:60];\narea(3600148838)->.us;\nnwr${sel}[amenity=library](area.us);\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

// Sections are <details>; make sure a section is open before jumping to it.
function openSection(id) {
  const el = document.getElementById(id);
  if (el && el.tagName === 'DETAILS') el.open = true;
}
window.addEventListener('hashchange', () => openSection(location.hash.slice(1)));

let data = null;          // qa-data.json
let searchable = [];      // systems mapped for searchSystems()
let currentSys = -1;      // selected system index in explorer

// ---------------- Load & boot ----------------
async function boot() {
  try {
    const res = await fetch('./data/qa-data.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#qa-meta').textContent = 'Could not load QA data (' + e.message + ').';
    return;
  }

  const m = data.meta;
  $('#qa-meta').textContent =
    `${fmt(m.totalLibraries)} US libraries · ${fmt(m.totalSystems)} systems · data as of ` +
    `${m.layercakeModified ? new Date(m.layercakeModified).toLocaleDateString() : m.generated} (updated weekly)`;

  searchable = data.systems.map((s, i) => ({
    name: s.n,
    value: s.w || s.n,
    mode: s.w ? 'wikidata' : 'operator',
    count: s.c,
    idx: i
  }));

  // PLS findings, indexed by system for the branch-count column.
  plsBySys = new Map((data.pls || []).map(p => [p.sysIdx, p]));

  renderTiles();
  renderUsMeters();
  renderStateTable();
  renderWikidataGaps();
  renderAmbiguous();
  renderDomains();
  renderPls();
  renderPlsUnmatched();
  renderBranchCounts();
  renderCollisions();
  setupExplorer();

  $('#wd-filter').addEventListener('input', e => {
    wdFilter = e.target.value;
    renderWikidataGaps();
  });
  $('#dom-filter').addEventListener('input', e => {
    domFilter = e.target.value;
    renderDomains();
  });
  $('#pls-filter').addEventListener('input', e => {
    plsFilter = e.target.value;
    plsExpanded = false;
    renderPls();
  });
  setupPlsStateFilter();
  $('#plsu-filter').addEventListener('input', e => {
    plsuFilter = e.target.value;
    plsuExpanded = false;
    renderPlsUnmatched();
  });
  setupPlsuStateFilter();
  setupEditorPicker();
  openSection(location.hash.slice(1));
}

// ---------------- Overview ----------------
function tile(label, value, hint, href) {
  const inner = `<div class="qa-tile-label">${escapeHtml(label)}</div>
    <div class="qa-tile-value">${value}</div>`;
  return href
    ? `<a class="qa-tile qa-tile-link" href="${href}" ${hint ? `title="${escapeHtml(hint)}"` : ''}>${inner}</a>`
    : `<div class="qa-tile" ${hint ? `title="${escapeHtml(hint)}"` : ''}>${inner}</div>`;
}

function renderTiles() {
  const total = data.libs.length;
  const withOp = data.libs.filter(l => l[L.flags] & 8).length;
  const withWd = data.libs.filter(l => l[L.flags] & 16).length;
  const plsMissing = (data.pls || []).reduce((n, p) => n + p.missing.length, 0);
  const plsUntagged = (data.pls || []).reduce((n, p) => n + p.untagged.length, 0);
  $('#tiles').innerHTML =
    tile('US libraries', fmt(total)) +
    tile('Library systems', fmt(data.systems.length)) +
    tile('Have an operator', pct(withOp, total) + '%', `${fmt(withOp)} of ${fmt(total)}`) +
    tile('Have operator:wikidata', pct(withWd, total) + '%', `${fmt(withWd)} of ${fmt(total)}`) +
    (data.pls && data.pls.length ? (
      tile('Branches missing from OSM', `<span class="qa-delta-miss">${fmt(plsMissing)}</span>`,
        'IMLS PLS branches with no OSM library nearby – likely need creating', '#pls') +
      tile('Branches untagged in OSM', `<span class="pls-untagged-n">${fmt(plsUntagged)}</span>`,
        'IMLS PLS branches present in OSM but missing the operator tag', '#pls')
    ) : '');
}

function meterRow(label, n, d) {
  const p = pct(n, d);
  return `<div class="qa-meter-row" title="${fmt(n)} of ${fmt(d)} (${p}%)">
    <span class="qa-meter-label"><code>${escapeHtml(label)}</code></span>
    <div class="qa-meter"><div style="width:${p}%"></div></div>
    <span class="qa-meter-val">${p}%</span>
  </div>`;
}

function renderUsMeters() {
  const total = data.libs.length;
  $('#us-meters').innerHTML = TAG_DEFS.map(t =>
    meterRow(t.key, data.libs.filter(l => l[L.flags] & t.bit).length, total)
  ).join('');
}

// ---------------- By-state table ----------------
let stateSort = { col: 'libs', dir: -1 };

function stateRows() {
  const rows = data.states.map((name, i) => {
    const libs = data.libs.filter(l => l[L.state] === i);
    const row = { name, libs: libs.length };
    for (const t of TAG_DEFS) row[t.key] = pct(libs.filter(l => l[L.flags] & t.bit).length, libs.length);
    return row;
  });
  const { col, dir } = stateSort;
  rows.sort((a, b) => (col === 'name'
    ? a.name.localeCompare(b.name) * dir
    : (a[col] - b[col]) * dir || a.name.localeCompare(b.name)));
  return rows;
}

const STATE_COLS = [
  { id: 'name', label: 'State' },
  { id: 'libs', label: 'Libraries' },
  { id: 'operator', label: 'operator' },
  { id: 'operator:wikidata', label: 'wikidata' },
  { id: 'phone', label: 'phone' },
  { id: 'website', label: 'website' },
  { id: 'opening_hours', label: 'hours' }
];

function renderStateTable() {
  const rows = stateRows();
  const arrow = c => stateSort.col === c ? (stateSort.dir === -1 ? ' ▾' : ' ▴') : '';
  $('#state-table').innerHTML = `
    <thead><tr>${STATE_COLS.map(c =>
      `<th data-col="${c.id}" class="${c.id === 'name' ? '' : 'num'}">${escapeHtml(c.label)}${arrow(c.id)}</th>`).join('')}
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${fmt(r.libs)}</td>
      ${STATE_COLS.slice(2).map(c => `<td class="num">${r[c.id]}%</td>`).join('')}
    </tr>`).join('')}</tbody>`;

  $('#state-table').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (stateSort.col === col) stateSort.dir *= -1;
    else stateSort = { col, dir: col === 'name' ? 1 : -1 };
    renderStateTable();
  }));
}

// ---------------- Wikidata gaps ----------------
const WD_PREVIEW = 30;
let wdExpanded = false;
let wdFilter = '';
let wdSort = { col: 'c', dir: -1 };

const WD_COLS = [
  { id: 'n',  label: 'System' },
  { id: 'c',  label: 'Branches', num: true },
  { id: 'sw', label: 'Suggested' }
];

function renderWikidataGaps() {
  const term = wdFilter.trim().toLowerCase();
  const { col, dir } = wdSort;
  const gaps = data.systems
    .map((s, i) => ({ ...s, idx: i }))
    .filter(s => !s.w)
    .filter(s => !term || s.n.toLowerCase().includes(term))
    .sort((a, b) => {
      let cmp;
      if (col === 'n') cmp = a.n.localeCompare(b.n);
      else if (col === 'c') cmp = a.c - b.c;
      else {
        const score = s => s.sw ? 2 : (s.nw ? 1 : 0);          // suggested > ruled-out > none
        cmp = score(a) - score(b);
      }
      return cmp * dir || b.c - a.c || a.n.localeCompare(b.n); // stable tiebreak
    });

  const arrow = c => wdSort.col === c ? (wdSort.dir === -1 ? ' ▾' : ' ▴') : '';
  const shown = wdExpanded ? gaps : gaps.slice(0, WD_PREVIEW);
  $('#wd-table').innerHTML = `
    <thead><tr>${WD_COLS.map(c =>
      `<th data-col="${c.id}" class="${c.num ? 'num' : ''}">${escapeHtml(c.label)}${arrow(c.id)}</th>`).join('')}<th>Actions</th>
    </tr></thead>
    <tbody>${shown.length ? shown.map(s => `<tr>
      <td>${escapeHtml(s.n)}</td>
      <td class="num">${fmt(s.c)}</td>
      <td>${s.sw
        ? `<span class="qa-badge qa-badge-mixed" title="Suggested via a shared website domain with wikidata-tagged libraries – verify before applying"><a href="https://www.wikidata.org/wiki/${escapeHtml(s.sw)}" target="_blank" rel="noopener">${escapeHtml(s.sw)}</a> ?</span>`
        : ''}${(s.nw || []).map(q =>
          `<span class="qa-badge qa-badge-not" title="Mappers ruled this item out (not:operator:wikidata) – no need to re-research it"><a href="https://www.wikidata.org/wiki/${escapeHtml(q)}" target="_blank" rel="noopener">not ${escapeHtml(q)}</a></span>`).join(' ')}</td>
      <td class="qa-actions">
        ${wdSearchLink(s.n)}
        ${turboLink(turboUrl('operator', s.n))}
        <button class="qa-link-btn" data-sys="${s.idx}">Explore →</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="4" class="qa-note" style="padding:14px 10px">No systems match.</td></tr>'}</tbody>`;

  const more = $('#wd-more');
  more.hidden = wdExpanded || gaps.length <= WD_PREVIEW;
  more.textContent = `Show all ${fmt(gaps.length)} systems`;
  more.onclick = () => { wdExpanded = true; renderWikidataGaps(); };

  $('#wd-table').querySelectorAll('th[data-col]').forEach(th => th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (wdSort.col === col) wdSort.dir *= -1;
    else wdSort = { col, dir: col === 'n' ? 1 : -1 }; // names ascend, counts/suggestions descend
    renderWikidataGaps();
  }));

  bindExploreButtons($('#wd-table'));
}

function bindExploreButtons(root) {
  root.querySelectorAll('[data-sys]').forEach(b => b.addEventListener('click', () => {
    showSystem(+b.dataset.sys);
    openSection('explorer');
    document.getElementById('explorer').scrollIntoView({ behavior: 'smooth' });
  }));
}

// Turbo link for ALL libraries in a bbox, regardless of tags — for surveying an
// area where operator tags can't be trusted (the unmatched-PLS pane).
// bb is [west, south, east, north]; Overpass bbox order is (s,w,n,e).
function turboLibsBboxUrl(bb) {
  const q = `[out:json][timeout:60];\nnwr[amenity=library](${bb[1]},${bb[0]},${bb[3]},${bb[2]});\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

// ---------------- Ambiguous names (shared across regions) ----------------
// Turbo link scoped to one geographic cluster of an operator name.
// bb is [west, south, east, north]; Overpass bbox order is (s,w,n,e).
function turboBboxUrl(name, bb) {
  const esc = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const q = `[out:json][timeout:60];\nnwr["operator"="${esc}"][amenity=library](${bb[1]},${bb[0]},${bb[3]},${bb[2]});\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

function renderAmbiguous() {
  const list = $('#ambiguous-list');
  if (!data.ambiguous || !data.ambiguous.length) {
    list.innerHTML = '<p class="qa-note">No shared-operator groups detected. 🎉</p>';
    return;
  }
  const sysByName = new Map(data.systems.map((s, i) => [s.n, i]));

  list.innerHTML = data.ambiguous.map(a => {
    const clusters = a.clusters.map(c => {
      const stateNames = c.st.map(i => data.states[i] ?? 'Unknown');
      const wdBadge = c.wd === null
        ? '<span class="qa-badge qa-badge-miss">needs wikidata</span>'
        : c.wd === 'mixed'
          ? '<span class="qa-badge qa-badge-mixed">partially tagged</span>'
          : `<span class="qa-badge qa-badge-wd"><a href="https://www.wikidata.org/wiki/${escapeHtml(c.wd)}" target="_blank" rel="noopener">${escapeHtml(c.wd)}</a> ✓</span>`;
      return `<div class="qa-amb-cluster">
        <span class="qa-amb-where">📍 ${escapeHtml(stateNames.join(' / '))}</span>
        <span class="qa-amb-count">${c.c} ${c.c === 1 ? 'branch' : 'branches'}</span>
        ${wdBadge}
        <span class="qa-actions">
          ${c.wd === null || c.wd === 'mixed'
            ? wdSearchLink(a.n + ' ' + (stateNames[0] || '')) : ''}
          ${turboLink(turboBboxUrl(a.n, c.bb))}
        </span>
      </div>`;
    }).join('');

    const sysIdx = sysByName.get(a.n);
    return `<div class="qa-amb">
      <div class="qa-amb-head">
        <span class="qa-coll-name">${escapeHtml(a.n)}</span>
        <span class="qa-coll-meta">${a.clusters.length} distinct regions · ${fmt(a.total)} branches
          ${sysIdx !== undefined ? `<button class="qa-link-btn" data-sys="${sysIdx}">Explore →</button>` : ''}
        </span>
      </div>
      ${clusters}
    </div>`;
  }).join('');

  bindExploreButtons(list);
}

// ---------------- Missing & untagged branches (IMLS PLS) ----------------
let plsBySys = new Map();
const PLS_PREVIEW = 20;
let plsExpanded = false;
let plsFilter = '';
let plsState = '';

// Populate the state <select> with the states that actually have PLS findings.
function setupPlsStateFilter() {
  const sel = $('#pls-state');
  if (!sel || !data.pls) return;
  const states = [...new Set(data.pls.map(p => p.state).filter(Boolean))].sort();
  sel.insertAdjacentHTML('beforeend',
    states.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
  sel.addEventListener('change', () => { plsState = sel.value; plsExpanded = false; renderPls(); });
}

function renderPls() {
  const list = $('#pls-list');
  if (!data.pls || !data.pls.length) {
    list.innerHTML = '<p class="qa-note">No PLS findings (dataset unavailable, or every matched system is complete). 🎉</p>';
    $('#pls-more').hidden = true;
    return;
  }
  const term = plsFilter.trim().toLowerCase();
  const rows = data.pls
    .map(p => ({ p, name: data.systems[p.sysIdx]?.n || '' }))
    .filter(x => !plsState || x.p.state === plsState)
    .filter(x => !term || x.name.toLowerCase().includes(term));

  if (!rows.length) {
    list.innerHTML = '<p class="qa-note">No systems match.</p>';
    $('#pls-more').hidden = true;
    return;
  }

  const shown = plsExpanded ? rows : rows.slice(0, PLS_PREVIEW);
  list.innerHTML = shown.map(({ p, name }) => {
    const sys = data.systems[p.sysIdx];
    // Every row is: name | detail | meta | action — so columns line up across
    // the three row types regardless of what each has to show.
    const row = (cls, name, detail, meta, href, title) => `
      <div class="pls-row ${cls}">
        <span class="pls-name">${escapeHtml(name)}</span>
        <span class="pls-detail">${detail}</span>
        <span class="pls-meta">${meta}</span>
        <a class="qa-icon-link" href="${href}" target="_blank" rel="noopener" title="${title}">✏️</a>
      </div>`;
    // Rows with a matched OSM object link to that object; only truly-missing
    // branches fall back to the (approximate) PLS coordinate. Older qa-data.json
    // lacks the OSM ref on untagged rows — keep the coordinate fallback for it.
    const editRef = (osm, lat, lon, fbLat, fbLon) =>
      osm ? editObject(osm[0], osm.slice(1), lat, lon) : editAt(fbLat, fbLon);
    const missing = p.missing.map(m => row('pls-missing', titleCase(m.name),
      escapeHtml([titleCase(m.addr), titleCase(m.city)].filter(Boolean).join(', ')),
      `<span class="pls-geo" title="IMLS geocode precision">${escapeHtml(m.geo || '')}</span>`,
      editAt(m.lat, m.lon), 'Create in OSM editor')).join('');
    const untagged = p.untagged.map(u => row('pls-untagged', titleCase(u.name),
      `↳ OSM: “${escapeHtml(u.osmName)}”`,
      u.osmHasOperator ? '<span class="qa-badge qa-badge-mixed">wrong operator?</span>' : '<span class="qa-badge qa-badge-miss">no operator tag</span>',
      editRef(u.osm, u.osmLat, u.osmLon, u.lat, u.lon), 'Fix tags in OSM editor')).join('');
    const disc = p.discrepancies.map(dd => row('pls-disc', titleCase(dd.name),
      `OSM coordinate is ~${fmt(dd.dist)}m from the PLS location – verify`,
      '', editRef(dd.osmId, dd.osmLat, dd.osmLon, dd.lat, dd.lon), 'Check location in OSM editor')).join('');

    // Show the system's operator:wikidata so it's handy to copy when tagging the
    // untagged/missing branches below. Confirmed (.w) is a solid badge; a
    // domain-derived suggestion (.sw) is shown as an unconfirmed hint.
    const qidNote = sys.w
      ? `<span class="pls-qid" title="operator:wikidata for this system – apply to the branches below">operator:wikidata = <a href="https://www.wikidata.org/wiki/${escapeHtml(sys.w)}" target="_blank" rel="noopener">${escapeHtml(sys.w)}</a></span>`
      : sys.sw
        ? `<span class="pls-qid pls-qid-suggested" title="Suggested via a shared website domain – verify before applying">operator:wikidata ≈ <a href="https://www.wikidata.org/wiki/${escapeHtml(sys.sw)}" target="_blank" rel="noopener">${escapeHtml(sys.sw)}</a> ?</span>`
        : '';

    return `<div class="pls-sys">
      <div class="pls-sys-head">
        <span class="qa-coll-name">${escapeHtml(name)}</span>
        <span class="qa-coll-meta">PLS ${fmt(p.plsCount)} · OSM ${fmt(p.osmCount)} ·
          ${p.missing.length ? `<b class="qa-delta-miss">${p.missing.length} missing</b>` : ''}
          ${p.missing.length && p.untagged.length ? ' · ' : ''}
          ${p.untagged.length ? `<b class="pls-untagged-n">${p.untagged.length} untagged</b>` : ''}
          <button class="qa-link-btn" data-sys="${p.sysIdx}">Explore →</button></span>
      </div>
      ${qidNote ? `<div class="pls-qid-row">${qidNote}</div>` : ''}
      ${missing}${untagged}${disc}
    </div>`;
  }).join('');

  const more = $('#pls-more');
  more.hidden = plsExpanded || rows.length <= PLS_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} systems`;
  more.onclick = () => { plsExpanded = true; renderPls(); };
  bindExploreButtons(list);
}

// ---------------- PLS systems with no OSM match ----------------
// The catchall for systems the crosswalk can't see: fragmented / missing
// operator tags, or genuinely unmapped systems. Data is precomputed by
// build-qa.mjs (multi-outlet PLS systems only).
const PLSU_PREVIEW = 30;
let plsuExpanded = false;
let plsuFilter = '';
let plsuState = '';

function setupPlsuStateFilter() {
  const sel = $('#plsu-state');
  if (!sel || !data.plsUnmatched?.length) return;
  const states = [...new Set(data.plsUnmatched.map(u => u.state).filter(Boolean))].sort();
  sel.insertAdjacentHTML('beforeend',
    states.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
  sel.addEventListener('change', () => { plsuState = sel.value; plsuExpanded = false; renderPlsUnmatched(); });
}

function renderPlsUnmatched() {
  const list = $('#plsu-list');
  if (!list) return;
  if (!data.plsUnmatched || !data.plsUnmatched.length) {
    list.innerHTML = '<p class="qa-note">No unmatched PLS systems (dataset predates this report, or every multi-outlet system crosswalked). Regenerated weekly.</p>';
    $('#plsu-more').hidden = true;
    return;
  }
  const term = plsuFilter.trim().toLowerCase();
  const rows = data.plsUnmatched
    .filter(u => !plsuState || u.state === plsuState)
    .filter(u => !term || u.name.toLowerCase().includes(term));

  if (!rows.length) {
    list.innerHTML = '<p class="qa-note">No systems match.</p>';
    $('#plsu-more').hidden = true;
    return;
  }

  const shown = plsuExpanded ? rows : rows.slice(0, PLSU_PREVIEW);
  list.innerHTML = shown.map(u => {
    const badge = u.near
      ? `<span class="qa-badge qa-badge-mixed" title="Outlets with some OSM library within 200 m – the buildings are likely mapped but operator tags are missing or inconsistent">${u.near}/${u.outlets} in OSM</span>`
      : `<span class="qa-badge qa-badge-miss" title="No outlet has an OSM library within 200 m – likely unmapped">0 in OSM</span>`;
    // ALL libraries in the outlets' bbox, unfiltered by operator — the point is
    // to eyeball what's there when the operator tags are broken or absent.
    // Older qa-data has a centroid instead of a bbox; keep the map fallback.
    const link = u.bb
      ? turboLink(turboLibsBboxUrl(u.bb))
      : `<a class="qa-icon-link" href="https://www.openstreetmap.org/#map=10/${u.lat}/${u.lon}" target="_blank" rel="noopener" title="View this system's area on OSM">🔍</a>`;
    return `<div class="pls-row">
      <span class="pls-name">${escapeHtml(titleCase(u.name))}</span>
      <span class="pls-detail">${escapeHtml(u.state)} · ${u.outlets} outlets · PLS ${escapeHtml(u.fscskey)}</span>
      <span class="pls-meta">${badge}</span>
      ${link}
    </div>`;
  }).join('');

  const more = $('#plsu-more');
  more.hidden = plsuExpanded || rows.length <= PLSU_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} systems`;
  more.onclick = () => { plsuExpanded = true; renderPlsUnmatched(); };
}

// ---------------- Branch counts vs Wikidata ----------------
const BR_PREVIEW = 30;
let brExpanded = false;
let brSort = { col: 'delta', dir: -1 };

const BR_COLS = [
  { id: 'n',     label: 'System' },
  { id: 'c',     label: 'OSM', num: true },
  { id: 'wb',    label: 'Wikidata', num: true },
  { id: 'pls',   label: 'PLS', num: true },
  { id: 'delta', label: 'Δ', num: true }
];

function renderBranchCounts() {
  const { col, dir } = brSort;
  // PLS branch count per system (matched + untagged + missing = its true count).
  const plsCountOf = i => { const p = plsBySys.get(i); return p ? p.plsCount : null; };
  const rows = data.systems
    .map((s, i) => ({ ...s, idx: i, delta: s.c - (s.wb ?? 0), pls: plsCountOf(i) }))
    .filter(s => s.wb != null || s.pls != null)   // show if either external source has a count
    .sort((a, b) => {
      let cmp;
      if (col === 'n') cmp = a.n.localeCompare(b.n);
      else if (col === 'delta') cmp = Math.abs(a.delta) - Math.abs(b.delta);
      else cmp = (a[col] ?? -1) - (b[col] ?? -1);
      return cmp * dir || Math.abs(b.delta) - Math.abs(a.delta) || a.n.localeCompare(b.n);
    });

  const arrow = c => brSort.col === c ? (brSort.dir === -1 ? ' ▾' : ' ▴') : '';
  const shown = brExpanded ? rows : rows.slice(0, BR_PREVIEW);
  $('#br-table').innerHTML = `
    <thead><tr>${BR_COLS.map(c =>
      `<th data-col="${c.id}" class="${c.num ? 'num' : ''}">${escapeHtml(c.label)}${arrow(c.id)}</th>`).join('')}<th>Actions</th>
    </tr></thead>
    <tbody>${shown.map(s => {
      const hasWb = s.wb != null;
      const d = s.delta;
      const deltaCell = !hasWb ? '<span class="qa-no" title="no Wikidata branch list">—</span>'
        : d === 0
          ? '<span class="qa-yes" title="OSM and Wikidata agree">✓</span>'
          : `<span class="${d < 0 ? 'qa-delta-miss' : 'qa-delta-extra'}" title="${d < 0
              ? Math.abs(d) + ' branch(es) on Wikidata not found in OSM – possibly unmapped'
              : d + ' more branch(es) in OSM than Wikidata lists – duplicates, non-branches, or stale Wikidata'}">${d > 0 ? '+' + d : d}</span>`;
      // PLS cell: colored when it exceeds OSM (undermapped) — the actionable case.
      const plsCell = s.pls == null ? '<span class="qa-no">—</span>'
        : s.pls > s.c ? `<span class="qa-delta-miss" title="${s.pls - s.c} more in PLS than OSM has tagged">${fmt(s.pls)}</span>`
        : fmt(s.pls);
      return `<tr>
        <td>${escapeHtml(s.n)}</td>
        <td class="num">${fmt(s.c)}</td>
        <td class="num">${hasWb ? `<a href="https://www.wikidata.org/wiki/${escapeHtml(s.w)}" target="_blank" rel="noopener">${fmt(s.wb)}</a>` : '<span class="qa-no">—</span>'}</td>
        <td class="num">${plsCell}</td>
        <td class="num">${deltaCell}</td>
        <td class="qa-actions">
          ${turboLink(turboUrl(s.w ? 'wikidata' : 'operator', s.w || s.n))}
          <button class="qa-link-btn" data-sys="${s.idx}">Explore →</button>
        </td>
      </tr>`;
    }).join('')}</tbody>`;

  const more = $('#br-more');
  more.hidden = brExpanded || rows.length <= BR_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} systems`;
  more.onclick = () => { brExpanded = true; renderBranchCounts(); };

  $('#br-table').querySelectorAll('th[data-col]').forEach(th => th.addEventListener('click', () => {
    const c = th.dataset.col;
    if (brSort.col === c) brSort.dir *= -1;
    else brSort = { col: c, dir: c === 'n' ? 1 : -1 };
    renderBranchCounts();
  }));

  bindExploreButtons($('#br-table'));
}

// ---------------- Website domain clusters ----------------
// Turbo link for all US libraries whose website matches a domain. The domain is
// used as a plain regex — an unescaped "." matches the literal dot anyway, and
// avoiding backslashes sidesteps Overpass QL string-escaping pitfalls. The regex
// filter comes LAST: regex matching is expensive for Overpass, so the cheap
// amenity filter narrows the set first.
function turboDomainUrl(domain) {
  const q = `[out:json][timeout:60];\narea(3600148838)->.us;\nnwr[amenity=library]["website"~"${domain}",i](area.us);\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

const DOM_PREVIEW = 30;
let domExpanded = false;
let domFilter = '';

function renderDomains() {
  const term = domFilter.trim().toLowerCase();
  const rows = (data.domains || [])
    .filter(x => !term || x.d.toLowerCase().includes(term) || (x.op || '').toLowerCase().includes(term));

  const shown = domExpanded ? rows : rows.slice(0, DOM_PREVIEW);
  $('#dom-table').innerHTML = `
    <thead><tr><th>Domain</th><th>State</th><th class="num">Libraries</th><th class="num">Missing operator</th><th>Suggested operator</th><th>Actions</th></tr></thead>
    <tbody>${shown.length ? shown.map(x => {
      const states = x.st.map(i => data.states[i] ?? 'Unknown').join(' / ');
      const suggestion = x.op
        ? `${escapeHtml(x.op)}${x.wd ? ` <span class="qa-badge qa-badge-wd"><a href="https://www.wikidata.org/wiki/${escapeHtml(x.wd)}" target="_blank" rel="noopener">${escapeHtml(x.wd)}</a> ✓</span>` : ''}`
        : '<span class="qa-badge qa-badge-miss">unknown – research once, tag all</span>';
      return `<tr>
        <td><a href="https://${escapeHtml(x.d)}" target="_blank" rel="noopener">${escapeHtml(x.d)}</a></td>
        <td>${escapeHtml(states)}</td>
        <td class="num">${fmt(x.total)}</td>
        <td class="num">${fmt(x.untagged)}</td>
        <td>${suggestion}</td>
        <td class="qa-actions">${turboLink(turboDomainUrl(x.d))}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="qa-note" style="padding:14px 10px">No domains match.</td></tr>'}</tbody>`;

  const more = $('#dom-more');
  more.hidden = domExpanded || rows.length <= DOM_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} domains`;
  more.onclick = () => { domExpanded = true; renderDomains(); };
}

// ---------------- Collisions ----------------
function renderCollisions() {
  if (!data.collisions.length) {
    $('#collisions').innerHTML = '<p class="qa-note">No likely collisions found. 🎉</p>';
    return;
  }
  const sysByName = new Map(data.systems.map((s, i) => [s.n, i]));
  $('#collisions').innerHTML = data.collisions.map(c => {
    // Heuristic hint: same name different case, or a 1-branch outlier next to an
    // established system, or only one side having wikidata → likely fix direction.
    // `a` is always the more numerous side (normalized at build time).
    let hint = '';
    if (c.lev === 0) hint = 'Same name, different capitalization – almost certainly a typo.';
    // Only claim a direction for single-edit differences: at distance 2 the pair
    // may be two genuinely different systems.
    else if (c.lev === 1 && c.ca >= 5 * c.cb && c.cb <= 2) hint = `Likely typo of “${escapeHtml(c.a)}”.`;
    else if (c.aw !== c.bw) hint = `Only one side has operator:wikidata – if these are the same system, align the other.`;
    const side = (name, cnt, hasWd) => {
      // Direct link to the tagged operator:wikidata item, when there is one.
      const wd = hasWd ? data.systems[sysByName.get(name)]?.w : null;
      return `
      <div class="qa-coll-side">
        <span class="qa-coll-name">${escapeHtml(name)}</span>
        <span class="qa-coll-meta">${fmt(cnt)} ${cnt === 1 ? 'branch' : 'branches'}
          ${wd ? `<span class="qa-badge qa-badge-wd" title="operator:wikidata"><a href="https://www.wikidata.org/wiki/${escapeHtml(wd)}" target="_blank" rel="noopener">${escapeHtml(wd)}</a> ✓</span>` : ''}
          ${turboLink(turboUrl('operator', name))}
          ${sysByName.has(name) ? `<button class="qa-link-btn" data-sys="${sysByName.get(name)}">Explore →</button>` : ''}
        </span>
      </div>`;
    };
    return `<div class="qa-coll">
      ${side(c.a, c.ca, c.aw)}
      <div class="qa-coll-vs">vs</div>
      ${side(c.b, c.cb, c.bw)}
      ${hint ? `<div class="qa-coll-hint">${hint}</div>` : ''}
    </div>`;
  }).join('');
  bindExploreButtons($('#collisions'));
}

// ---------------- System explorer ----------------
function setupExplorer() {
  const input = $('#qa-search');
  const box = $('#qa-suggest');
  let results = [];
  let active = -1;

  const close = () => { box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); active = -1; };

  const render = () => {
    if (!results.length) { box.innerHTML = ''; close(); return; }
    box.innerHTML = results.map((s, i) => `
      <div class="suggest-item ${i === active ? 'active' : ''}" role="option" data-i="${i}">
        <span class="si-name">${escapeHtml(s.name)}</span>
        <span class="si-meta">${s.mode === 'wikidata' ? escapeHtml(s.value) + ' · ' : ''}${s.count} 📚</span>
      </div>`).join('');
    box.classList.add('show');
    input.setAttribute('aria-expanded', 'true');
    box.querySelectorAll('.suggest-item').forEach(el =>
      el.addEventListener('mousedown', e => { e.preventDefault(); choose(results[+el.dataset.i]); }));
  };

  const choose = s => { input.value = s.name; close(); showSystem(s.idx); };

  input.addEventListener('input', () => {
    results = searchSystems(searchable, input.value);
    active = -1;
    render();
  });
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('show')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[Math.max(active, 0)] || results[0]); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

const CHECK = '<span class="qa-yes" title="present">✓</span>';
const CROSS = '<span class="qa-no" title="missing">✗</span>';

function showSystem(idx) {
  currentSys = idx;
  const s = data.systems[idx];
  const libs = data.libs.filter(l => l[L.sys] === idx);

  $('#system-view').hidden = false;
  $('#qa-search').value = s.n;
  $('#sys-name').textContent = s.n;
  const notBadges = (s.nw || []).map(q =>
    `<span class="qa-badge qa-badge-not" title="Mappers ruled this item out (not:operator:wikidata)"><a href="https://www.wikidata.org/wiki/${escapeHtml(q)}" target="_blank" rel="noopener">not ${escapeHtml(q)}</a></span>`).join(' ');
  const conflict = s.w && (s.nw || []).includes(s.w)
    ? ' <span class="qa-badge qa-badge-miss" title="Some libraries tag this item as operator:wikidata while others rule it out with not:operator:wikidata – mappers disagree; worth resolving">⚠ conflicting tags</span>'
    : '';
  const wbNote = s.wb != null
    ? (s.wb === s.c
        ? ` · <span class="qa-yes" title="Wikidata lists the same number of branches">Wikidata: ${fmt(s.wb)} ✓</span>`
        : ` · <span class="qa-badge qa-badge-mixed" title="Wikidata's branch list (P527) disagrees with the OSM count – unmapped branches, duplicates, or a stale list">Wikidata: ${fmt(s.wb)} branches</span>`)
    : '';
  $('#sys-meta').innerHTML =
    `${fmt(s.c)} branches` +
    (s.w ? ` · <a href="https://www.wikidata.org/wiki/${escapeHtml(s.w)}" target="_blank" rel="noopener">${escapeHtml(s.w)}</a>` :
           ' · <span class="qa-badge qa-badge-miss">no operator:wikidata</span>') +
    wbNote +
    (notBadges ? ` · ${notBadges}` : '') + conflict +
    ` · ${turboLink(turboUrl(s.w ? 'wikidata' : 'operator', s.w || s.n))}`;

  $('#sys-meters').innerHTML = TAG_DEFS.map(t =>
    meterRow(t.key, libs.filter(l => l[L.flags] & t.bit).length, libs.length)
  ).join('');

  $('#live-note').textContent = '';
  $('#btn-live').disabled = false;

  // Weekly-snapshot table.
  $('#sys-table').innerHTML = `
    <thead><tr><th>Library</th><th>State</th>
      ${TAG_DEFS.map(t => `<th class="num"><code>${escapeHtml(t.key.replace('operator:wikidata', 'wikidata'))}</code></th>`).join('')}
      <th></th></tr></thead>
    <tbody>${libs.map(l => `<tr>
      <td>${escapeHtml(l[L.name] || '(unnamed)')}</td>
      <td>${escapeHtml(data.states[l[L.state]] || '')}</td>
      ${TAG_DEFS.map(t => `<td class="num">${(l[L.flags] & t.bit) ? CHECK : CROSS}</td>`).join('')}
      <td><a href="${editObject(l[L.type], l[L.id], l[L.lat], l[L.lon])}" target="_blank" rel="noopener">edit ↗</a></td>
    </tr>`).join('')}</tbody>`;
}

// Live details: fetch this system from Overpass and show the full tracked-tag
// set (including addr:*), replacing the weekly table.
async function loadLive() {
  if (currentSys < 0) return;
  const s = data.systems[currentSys];
  const btn = $('#btn-live');
  btn.disabled = true;
  $('#live-note').textContent = 'Fetching live data from Overpass…';

  try {
    const feats = await fetchLibraries(s.w ? 'wikidata' : 'operator', s.w || s.n);
    if (!feats.length) throw new Error('no results');
    $('#live-note').textContent =
      `Live from Overpass just now – ${feats.length} libraries, all ${TRACKED_TAGS.length} tracked tags.`;
    $('#sys-table').innerHTML = `
      <thead><tr><th>Library</th><th>City</th>
        ${TRACKED_TAGS.map(t => `<th class="num"><code>${escapeHtml(t.label)}</code></th>`).join('')}
        <th></th></tr></thead>
      <tbody>${feats.map(f => {
        const p = f.properties;
        const [lon, lat] = f.geometry?.coordinates || [];
        return `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.city || '')}</td>
          ${TRACKED_TAGS.map(t => `<td class="num">${t.get(p) ? CHECK : CROSS}</td>`).join('')}
          <td><a href="${editObject(p.osmType, p.osmId, lat, lon)}" target="_blank" rel="noopener">edit ↗</a></td>
        </tr>`;
      }).join('')}</tbody>`;
  } catch (e) {
    $('#live-note').textContent = 'Could not fetch live data (' + e.message + '). Try again shortly.';
    btn.disabled = false;
  }
}

$('#btn-live').addEventListener('click', loadLive);

boot();
