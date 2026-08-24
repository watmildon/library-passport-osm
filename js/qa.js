// qa.js — Data QA page: loads the daily qa-data.json and renders
// completion stats, wikidata gaps, likely typos, and a per-system explorer.
// The explorer's "Load live details" fetches one system from Overpass to show
// the current tag values (the snapshot only carries presence flags).

import { searchSystems } from './systems.js';
import { fetchLibrariesMeta } from './overpass.js';
import { TRACKED_TAGS } from './completeness.js';
import { JOSM, bboxAround, josmSend, buildOsmXml, loadData, webEditObjectUrl, webEditAtUrl } from './josm.js';
import { setupOverpassPicker, withBusy } from './controls.js';
import { country } from './countries.js';

// Active country: ?country=CA loads the Canadian QA dataset. An unknown code
// falls back to the default (US) rather than breaking the page.
const COUNTRY = (() => {
  try { return country(new URL(location.href).searchParams.get('country')?.toUpperCase()); }
  catch { return country(); }
})();
const QA_AREA_ID = COUNTRY.areaId;
// How this country's outlet census is named in labels/tooltips.
const CENSUS = COUNTRY.census;

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

// Column meaning of each bit in a library row's flags. The authoritative list
// is the data's own meta.tags (bit = 1 << index) — derived in boot() so the
// page renders whatever the build tracked (Overpass builds add addr:* flags;
// older Layercake builds only have the first five). This literal is just the
// fallback for data predating meta.tags.
let TAG_DEFS = [
  { bit: 8,  key: 'operator' },
  { bit: 16, key: 'operator:wikidata' },
  { bit: 1,  key: 'phone' },
  { bit: 2,  key: 'website' },
  { bit: 4,  key: 'opening_hours' }
];
let ADDR_MASK = 0;   // addr:housenumber|addr:street bits, when the data has them

// Stable display order for derived tag defs.
const TAG_ORDER = ['operator', 'operator:wikidata', 'phone', 'website', 'opening_hours',
                   'addr:housenumber', 'addr:street', 'addr:city', 'addr:postcode'];
function deriveTagDefs(tags) {
  if (!Array.isArray(tags) || !tags.length) return;
  TAG_DEFS = tags.map((key, i) => ({ bit: 1 << i, key }))
    .sort((a, b) => {
      const ai = TAG_ORDER.indexOf(a.key), bi = TAG_ORDER.indexOf(b.key);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  const hn = TAG_DEFS.find(t => t.key === 'addr:housenumber');
  const st = TAG_DEFS.find(t => t.key === 'addr:street');
  ADDR_MASK = hn && st ? (hn.bit | st.bit) : 0;
}

// Compact column label for a tag key.
const tagLabel = k => k === 'operator:wikidata' ? 'wikidata' : k.replace(/^addr:/, '');

// Library row accessors. Column 0 is a system KEY in the file and a system INDEX
// in memory — resolveSystemKeys() swaps it at load; see the note there.
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

// geo: URI (RFC 5870) for the OS-registered map app. Kept parameterless — zoom
// hints are an Android extension not every handler accepts.
const geoUri = (lat, lon) => `geo:${lat},${lon}`;

// Link to edit an existing object (node/way/relation). lat/lon optional but
// needed for JOSM (to build a bbox to load and select within). JOSM/web builders
// live in ./josm.js; this picks per the user's editor choice.
function editObject(type, id, lat, lon) {
  const t = OSM_TYPE[type] || type; // accept 'n'/'node'
  if (currentEditor === 'geo') {
    // geo: can't reference an OSM object, only its centroid; without a
    // coordinate, fall back to the object's osm.org page.
    return lat == null ? `https://www.openstreetmap.org/${t}/${id}` : geoUri(lat, lon);
  }
  if (currentEditor === 'josm') {
    if (lat == null) return `${JOSM}/import?url=https://www.openstreetmap.org/api/0.6/${t}/${id}/full`;
    const b = bboxAround(lat, lon);
    return `${JOSM}/load_and_zoom?left=${b.left}&right=${b.right}&top=${b.top}&bottom=${b.bottom}&select=${t[0]}${id}`;
  }
  return webEditObjectUrl(currentEditor, t, id, lat, lon);
}

// Link to edit at a coordinate (for creating a new node / checking a location).
function editAt(lat, lon) {
  if (currentEditor === 'geo') return geoUri(lat, lon);
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
      : currentEditor === 'geo'
        ? 'Opens your device\'s map app (or Vespucci/OsmAnd) – mostly useful on mobile.'
        : '';
  };
  sel.value = currentEditor;
  showHint();
  sel.addEventListener('change', () => {
    setEditor(sel.value);
    showHint();
    // Every section holding edit links has to be rebuilt for the new editor.
    renderPls();
    renderUnnamedPairs();
    renderWdOperators();
    renderWdConflicts();
    renderCollisions();
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
  const q = `[out:json][timeout:60];\narea(${QA_AREA_ID})->.us;\nnwr${sel}[amenity=library](area.us);\nout center tags;`;
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

// Header country toggle: plain links that reload the page with ?country=.
// Also points the map-view link at the same country.
function setupCountryToggle() {
  document.querySelectorAll('#country-toggle a[data-country]').forEach(a => {
    a.classList.toggle('active', a.dataset.country === COUNTRY.code);
  });
  if (COUNTRY.code !== 'US') {
    const map = document.querySelector('a[href="./qa-map.html"]');
    if (map) map.href = `./qa-map.html?country=${COUNTRY.code}`;
  }
}

// Hide the PLS-backed panes and their nav links when the dataset carries no
// outlet-census findings — the case for countries without a PLS equivalent.
function hidePlsSections() {
  for (const id of ['pls', 'pls-unmatched']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  document.querySelectorAll('.qa-nav a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === '#pls' || href === '#pls-unmatched' || href.endsWith('augment.html')) a.hidden = true;
  });
}

// The census panes' static copy describes the US IMLS PLS; countries whose
// outlet data is assembled from provincial sources get their own wording here.
// (The Augment link stays hidden — that page is still US-only.)
function localizeCensusSections() {
  // The Augment page is still US-only — hide its nav link.
  document.querySelectorAll('.qa-nav a').forEach(a => {
    if ((a.getAttribute('href') || '').endsWith('augment.html')) a.hidden = true;
  });
  const pls = document.getElementById('pls');
  if (pls) {
    const h2 = pls.querySelector('summary h2');
    if (h2) h2.textContent = 'Missing & untagged branches (provincial data)';
    const notes = pls.querySelectorAll('.qa-note');
    if (notes[0]) notes[0].innerHTML =
      'Cross-referenced against provincial open data – currently BC’s ' +
      '<a href="https://catalogue.data.gov.bc.ca/dataset/3d2318d4-8f5d-4208-88f5-995420d7c58f" target="_blank" rel="noopener">Geographic Sites Registry of public-library service points</a> ' +
      'and the single-location systems from Ontario’s ' +
      '<a href="https://data.ontario.ca/dataset/ontario-public-library-statistics" target="_blank" rel="noopener">Annual Survey of Public Libraries</a> ' +
      '(geocoded addresses); other provinces will join as their datasets allow. ' +
      'For systems that match, the census reveals branches that are <strong>missing from OSM entirely</strong> ' +
      '(create them) or <strong>present but not tagged with the operator</strong> (add the tag). ' +
      '<em>Verify on the ground or against imagery before adding.</em>';
    if (notes[1]) notes[1].hidden = true;   // the Augment cross-link (US-only)
  }
  const plsu = document.getElementById('pls-unmatched');
  if (plsu) {
    const h2 = plsu.querySelector('summary h2');
    if (h2) h2.textContent = 'Provincial systems not found in OSM';
    const note = plsu.querySelector('.qa-note');
    if (note) note.innerHTML =
      'Multi-outlet library systems from the provincial registries that matched <strong>no OSM ' +
      'system</strong> – usually because their branches’ <code>operator</code> tags are missing or split ' +
      'across inconsistent spellings, or the branches aren’t mapped at all. <em>“in OSM”</em> counts ' +
      'outlets with <em>some</em> library mapped within 200 m, whatever its tags: a high count means the ' +
      'buildings exist and the operator tags need fixing; zero means likely unmapped territory. A green ' +
      '<span class="qa-badge qa-badge-wd">operator found – tag the rest</span> badge means at least one ' +
      'branch already carries this system’s operator – copy it to the remaining branches and add ' +
      '<code>operator:wikidata</code> to every branch to make the system unambiguous.';
  }
}

// ---------------- Load & boot ----------------
async function boot() {
  setupCountryToggle();
  try {
    const res = await fetch('./' + COUNTRY.qaFile);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#qa-meta').textContent = 'Could not load QA data (' + e.message + ').';
    return;
  }

  deriveTagDefs(data.tags);
  resolveSystemKeys();

  const m = data.meta;
  const src = m.sourceModified || m.layercakeModified;
  $('#qa-meta').textContent =
    `${fmt(m.totalLibraries)} ${COUNTRY.code} libraries · ${fmt(m.totalSystems)} systems · data as of ` +
    `${src ? new Date(src).toLocaleDateString() : m.generated} (updated daily)`;

  // Countries without an outlets census have no PLS sections to show; countries
  // with a non-PLS census get their own section copy.
  if (!data.pls?.length && !data.plsUnmatched?.length) hidePlsSections();
  else if (COUNTRY.code !== 'US') localizeCensusSections();

  // Data older than the section (or a country with no pairs) – hide the pane.
  if (!data.unnamedPairs?.length) {
    const el = document.getElementById('unnamed');
    if (el) el.hidden = true;
    document.querySelectorAll('.qa-nav a').forEach(a => {
      if (a.getAttribute('href') === '#unnamed') a.hidden = true;
    });
  }

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
  renderUnnamedPairs();
  renderWdOperators();
  renderWdConflicts();
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
  $('#un-filter').addEventListener('input', e => {
    unFilter = e.target.value;
    unExpanded = false;
    renderUnnamedPairs();
  });
  setupUnStateFilter();
  $('#wdop-filter').addEventListener('input', e => {
    wdopFilter = e.target.value;
    wdopExpanded = false;
    renderWdOperators();
  });
  $('#wdc-filter').addEventListener('input', e => {
    wdcFilter = e.target.value;
    wdcExpanded = false;
    renderWdConflicts();
  });
  $('#pls-filter').addEventListener('input', e => {
    plsFilter = e.target.value;
    plsExpanded = false;
    renderPls();
  });
  setupPlsStateFilter();
  setupWdStateFilter();
  setupWdopStateFilter();
  setupWdcStateFilter();
  setupDomStateFilter();
  setupBrStateFilter();
  $('#plsu-filter').addEventListener('input', e => {
    plsuFilter = e.target.value;
    plsuExpanded = false;
    renderPlsUnmatched();
  });
  setupPlsuStateFilter();
  setupEditorPicker();
  setupOverpassPicker();
  openSection(location.hash.slice(1));
}

// The file references a system by KEY — a stable string (the operator name, or
// "wd:Q…") that changes only when the OSM tag does. Array positions would be
// cheaper on the wire but shift whenever any system is added, removed, or
// renamed, rewriting most of the file in every daily diff for no real change.
//
// The UI wants an integer handle it can pass around in `data-sys` attributes, so
// resolve keys to positions once here and let the rest of the page work in
// indices exactly as before. Unknown or absent keys become -1.
function resolveSystemKeys() {
  const byKey = new Map(data.systems.map((s, i) => [s.k ?? s.n, i]));
  for (const l of data.libs) l[L.sys] = l[L.sys] == null ? -1 : (byKey.get(l[L.sys]) ?? -1);
  for (const p of data.pls || []) p.sysIdx = byKey.get(p.sysKey) ?? -1;
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
  const libCount = gs => (gs || []).reduce((n, g) => n + g.libs.length, 0);
  const wdOpLibs = libCount(data.wdOperators);
  const wdConflictLibs = libCount(data.wdConflicts);
  const unTwins = (data.unnamedPairs || []).length;
  $('#tiles').innerHTML =
    tile(`${COUNTRY.code} libraries`, fmt(total)) +
    tile('Library systems', fmt(data.systems.length)) +
    tile('Have an operator', pct(withOp, total) + '%', `${fmt(withOp)} of ${fmt(total)}`) +
    tile('Have operator:wikidata', pct(withWd, total) + '%', `${fmt(withWd)} of ${fmt(total)}`) +
    (data.pls && data.pls.length ? (
      tile('Branches missing from OSM', `<span class="qa-delta-miss">${fmt(plsMissing)}</span>`,
        `${CENSUS.name} branches with no OSM library nearby – likely need creating`, '#pls') +
      tile('Branches untagged in OSM', `<span class="pls-untagged-n">${fmt(plsUntagged)}</span>`,
        `${CENSUS.name} branches present in OSM but missing the operator tag`, '#pls')
    ) : '') +
    (wdOpLibs ? tile('Operator sourced from Wikidata', `<span class="pls-untagged-n">${fmt(wdOpLibs)}</span>`,
      'Operator-less libraries whose own Wikidata item names the system that runs them', '#wd-operators') : '') +
    (wdConflictLibs ? tile('Operator mismatches', `<span class="qa-delta-miss">${fmt(wdConflictLibs)}</span>`,
      'Libraries whose operator:wikidata disagrees with their own Wikidata item', '#wd-conflicts') : '') +
    (unTwins ? tile('Unnamed with a named twin', `<span class="pls-untagged-n">${fmt(unTwins)}</span>`,
      'Unnamed libraries with a named library mapped at the same spot – keep one element and remove the duplicate', '#unnamed') : '');
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
    // One combined address column (housenumber AND street) keeps the table narrow.
    if (ADDR_MASK) row.address = pct(libs.filter(l => (l[L.flags] & ADDR_MASK) === ADDR_MASK).length, libs.length);
    return row;
  });
  const { col, dir } = stateSort;
  rows.sort((a, b) => (col === 'name'
    ? a.name.localeCompare(b.name) * dir
    : (a[col] - b[col]) * dir || a.name.localeCompare(b.name)));
  return rows;
}

// The addr column only exists when the data tracks the addr:* flags.
const stateCols = () => [
  { id: 'name', label: 'State' },
  { id: 'libs', label: 'Libraries' },
  { id: 'operator', label: 'operator' },
  { id: 'operator:wikidata', label: 'wikidata' },
  { id: 'phone', label: 'phone' },
  { id: 'website', label: 'website' },
  { id: 'opening_hours', label: 'hours' },
  ...(ADDR_MASK ? [{ id: 'address', label: 'address' }] : [])
];

function renderStateTable() {
  const cols = stateCols();
  const rows = stateRows();
  const arrow = c => stateSort.col === c ? (stateSort.dir === -1 ? ' ▾' : ' ▴') : '';
  $('#state-table').innerHTML = `
    <thead><tr>${cols.map(c =>
      `<th data-col="${c.id}" class="${c.id === 'name' ? '' : 'num'}">${escapeHtml(c.label)}${arrow(c.id)}</th>`).join('')}
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${fmt(r.libs)}</td>
      ${cols.slice(2).map(c => `<td class="num">${r[c.id]}%</td>`).join('')}
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
let wdState = '';                 // stateIdx as a string, '' = all
let wdSort = { col: 'c', dir: -1 };

// Full state/province name (as the boundary source spells it) -> postal code,
// from the country config, so every region dropdown shows the same two-letter
// codes the PLS panes use. Unmapped names display in full.
const stateAbbr = name => COUNTRY.regionAbbr[name] || name;

// sysIdx -> Set(stateIdx), derived from the library rows (systems carry no
// state of their own; a multi-state system matches each of its states).
let sysStates = null;
function getSysStates() {
  if (!sysStates) {
    sysStates = new Map();
    for (const l of data.libs) {
      if (l[L.sys] < 0 || l[L.state] < 0) continue;
      if (!sysStates.has(l[L.sys])) sysStates.set(l[L.sys], new Set());
      sysStates.get(l[L.sys]).add(l[L.state]);
    }
  }
  return sysStates;
}

// Populate the state <select> with states that actually have gap systems.
function setupWdStateFilter() {
  const sel = $('#wd-state');
  if (!sel) return;
  const states = new Set();
  data.systems.forEach((s, i) => {
    if (!s.w) for (const st of getSysStates().get(i) ?? []) states.add(st);
  });
  const opts = [...states]
    .map(st => ({ st, abbr: stateAbbr(data.states[st]) }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr))
    .map(x => `<option value="${x.st}" title="${escapeHtml(data.states[x.st])}">${escapeHtml(x.abbr)}</option>`);
  sel.insertAdjacentHTML('beforeend', opts.join(''));
  sel.addEventListener('change', () => { wdState = sel.value; wdExpanded = false; renderWikidataGaps(); });
}

const WD_COLS = [
  { id: 'n',  label: 'System' },
  { id: 'c',  label: 'Branches', num: true },
  { id: 'sw', label: 'Suggested' }
];

// Where a suggested operator:wikidata came from, strongest first. `ss` lists
// every source that proposed the same item, so agreement between two of them is
// worth showing — it's the difference between a hint and a near-certainty.
const WD_SOURCE = {
  branch: {
    short: 'branch item',
    why: 'This system’s own libraries carry wikidata items naming this as their parent organization — a statement about these very branches'
  },
  fscs: {
    short: 'FSCS id',
    why: 'This system crosswalked to an IMLS PLS system, and this Wikidata item carries that Federal-State Cooperative System ID (P6618)'
  },
  domain: {
    short: 'shared domain',
    why: 'Suggested via a shared website domain with wikidata-tagged libraries — the weakest of the three, verify before applying'
  }
};

function suggestionBadge(s) {
  const sources = s.ss?.length ? s.ss : ['domain'];   // older data carried no `ss`
  // Two independent sources agreeing is a much stronger claim than one.
  const strong = sources.length > 1 || sources[0] === 'branch';
  const why = sources.map(x => WD_SOURCE[x]?.why ?? x).join('. ') +
    (sources.length > 1 ? '. Two independent sources agree.' : '');
  const label = sources.map(x => WD_SOURCE[x]?.short ?? x).join(' + ');
  return `<span class="qa-badge ${strong ? 'qa-badge-wd' : 'qa-badge-mixed'}" title="${escapeHtml(why)}">
    <a href="https://www.wikidata.org/wiki/${escapeHtml(s.sw)}" target="_blank" rel="noopener">${escapeHtml(s.sw)}</a>${
    s.sn ? ` ${escapeHtml(s.sn)}` : ''} <span class="qa-badge-src">${escapeHtml(label)}</span></span>`;
}

function renderWikidataGaps() {
  const term = wdFilter.trim().toLowerCase();
  const { col, dir } = wdSort;
  const gaps = data.systems
    .map((s, i) => ({ ...s, idx: i }))
    .filter(s => !s.w)
    .filter(s => !wdState || getSysStates().get(s.idx)?.has(+wdState))
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
      <td>${s.sw ? suggestionBadge(s) : ''}${(s.nw || []).map(q =>
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
    list.innerHTML = `<p class="qa-note">No ${escapeHtml(CENSUS.short)} findings (dataset unavailable, or every matched system is complete). 🎉</p>`;
    $('#pls-more').hidden = true;
    return;
  }
  const term = plsFilter.trim().toLowerCase();
  // The file is ordered by system key (stable diffs); rank the biggest
  // opportunities first here, where the ordering is actually wanted.
  const gaps = x => x.p.missing.length + x.p.untagged.length;
  const rows = data.pls
    .map(p => ({ p, name: data.systems[p.sysIdx]?.n || '' }))
    .filter(x => !plsState || x.p.state === plsState)
    .filter(x => !term || x.name.toLowerCase().includes(term))
    .sort((x, y) => gaps(y) - gaps(x) || x.name.localeCompare(y.name));

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
      `<span class="pls-geo" title="${escapeHtml(CENSUS.short)} geocode precision">${escapeHtml(m.geo || '')}</span>`,
      editAt(m.lat, m.lon), 'Create in OSM editor')).join('');
    const untagged = p.untagged.map(u => row('pls-untagged', titleCase(u.name),
      `↳ OSM: “${escapeHtml(u.osmName)}”`,
      u.osmHasOperator ? '<span class="qa-badge qa-badge-mixed">wrong operator?</span>' : '<span class="qa-badge qa-badge-miss">no operator tag</span>',
      editRef(u.osm, u.osmLat, u.osmLon, u.lat, u.lon), 'Fix tags in OSM editor')).join('');
    const disc = p.discrepancies.map(dd => row('pls-disc', titleCase(dd.name),
      `OSM coordinate is ~${fmt(dd.dist)}m from the ${escapeHtml(CENSUS.short)} location – verify`,
      '', editRef(dd.osmId, dd.osmLat, dd.osmLon, dd.lat, dd.lon), 'Check location in OSM editor')).join('');

    // Show the system's operator:wikidata so it's handy to copy when tagging the
    // untagged/missing branches below. Confirmed (.w) is a solid badge; a
    // domain-derived suggestion (.sw) is shown as an unconfirmed hint.
    const qidNote = sys.w
      ? `<span class="pls-qid" title="operator:wikidata for this system – apply to the branches below">operator:wikidata = <a href="https://www.wikidata.org/wiki/${escapeHtml(sys.w)}" target="_blank" rel="noopener">${escapeHtml(sys.w)}</a></span>`
      : sys.sw
        ? `<span class="pls-qid pls-qid-suggested" title="Suggested via a shared website domain – verify before applying">operator:wikidata ≈ <a href="https://www.wikidata.org/wiki/${escapeHtml(sys.sw)}" target="_blank" rel="noopener">${escapeHtml(sys.sw)}</a> ?</span>`
        : '';

    // Other operator spellings that crosswalked to the same PLS system — the
    // system is fragmented in OSM, which is a sharper statement of the problem
    // than the branches merely showing up as untagged.
    const variants = p.variants?.length
      ? `<div class="pls-qid-row"><span class="pls-qid pls-qid-suggested"
          title="These libraries belong to the same ${escapeHtml(CENSUS.short)} system but carry a different operator value – consolidating the spelling is the underlying fix">also tagged as ${
        p.variants.map(v => `“${escapeHtml(v)}”`).join(' · ')}</span></div>`
      : '';
    return `<div class="pls-sys">
      <div class="pls-sys-head">
        <span class="qa-coll-name">${escapeHtml(name)}</span>
        <span class="qa-coll-meta">${escapeHtml(CENSUS.short)} ${fmt(p.plsCount)} · OSM ${fmt(p.osmCount)} ·
          ${p.missing.length ? `<b class="qa-delta-miss">${p.missing.length} missing</b>` : ''}
          ${p.missing.length && p.untagged.length ? ' · ' : ''}
          ${p.untagged.length ? `<b class="pls-untagged-n">${p.untagged.length} untagged</b>` : ''}
          ${p.closed ? `<span class="qa-badge qa-badge-not" title="${escapeHtml(CENSUS.short)} outlets recorded as closed – via the branch's Wikidata item (date of official closure) or a disused:/was: lifecycle tag in OSM – and therefore not counted as missing">${p.closed} closed</span>` : ''}
          ${p.shared ? `<span class="qa-badge qa-badge-not" title="${escapeHtml(CENSUS.short)} outlets co-located with an already-matched branch (a makerspace, genealogy room, or service listed separately by the census) – OSM correctly maps them as one object, so nothing to fix">${p.shared} co-located</span>` : ''}
          <button class="qa-link-btn" data-sys="${p.sysIdx}">Explore →</button></span>
      </div>
      ${qidNote ? `<div class="pls-qid-row">${qidNote}</div>` : ''}
      ${variants}
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
    list.innerHTML = `<p class="qa-note">No unmatched ${escapeHtml(CENSUS.short)} systems (dataset predates this report, or every multi-outlet system crosswalked). Regenerated daily.</p>`;
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
    // The system's own operator already sits on a branch (below the matcher's
    // branch floor): found, not ambiguous. Encourage finishing the tagging –
    // same operator on the rest, operator:wikidata on all.
    const found = (u.ops || []).find(o => o.m);
    const foundBadge = found
      ? `<span class="qa-badge qa-badge-wd" title="“${escapeHtml(found.n)}” is already the operator on at least one branch – fewer branches than the matcher needs. Copy that operator to the remaining branches and add operator:wikidata to every branch; the system then crosswalks on the next daily build.">operator found – tag the rest</span> `
      : '';
    // ALL libraries in the outlets' bbox, unfiltered by operator — the point is
    // to eyeball what's there when the operator tags are broken or absent.
    // Older qa-data has a centroid instead of a bbox; keep the map fallback.
    const link = u.bb
      ? turboLink(turboLibsBboxUrl(u.bb))
      : `<a class="qa-icon-link" href="https://www.openstreetmap.org/#map=10/${u.lat}/${u.lon}" target="_blank" rel="noopener" title="View this system's area on OSM">🔍</a>`;
    return `<div class="pls-row">
      <span class="pls-name">${escapeHtml(titleCase(u.name))}</span>
      <span class="pls-detail">${escapeHtml(u.state)} · ${u.outlets} outlets · ${escapeHtml(CENSUS.short)} ${escapeHtml(u.fscskey)}</span>
      <span class="pls-meta">${foundBadge}${badge}</span>
      ${found ? wdSearchLink(titleCase(u.name)) : ''}${link}
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
let brState = '';                 // stateIdx as a string, '' = all
let brSort = { col: 'delta', dir: -1 };

// Populate the state <select> with states that have branch-count rows.
function setupBrStateFilter() {
  const sel = $('#br-state');
  if (!sel) return;
  const states = new Set();
  data.systems.forEach((s, i) => {
    if (s.wb != null || plsBySys.has(i))
      for (const st of getSysStates().get(i) ?? []) states.add(st);
  });
  const opts = [...states]
    .map(st => ({ st, abbr: stateAbbr(data.states[st]) }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr))
    .map(x => `<option value="${x.st}" title="${escapeHtml(data.states[x.st])}">${escapeHtml(x.abbr)}</option>`);
  sel.insertAdjacentHTML('beforeend', opts.join(''));
  sel.addEventListener('change', () => { brState = sel.value; brExpanded = false; renderBranchCounts(); });
}

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
    .filter(s => !brState || getSysStates().get(s.idx)?.has(+brState))
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
  const q = `[out:json][timeout:60];\narea(${QA_AREA_ID})->.us;\nnwr[amenity=library]["website"~"${domain}",i](area.us);\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

const DOM_PREVIEW = 30;
let domExpanded = false;
let domFilter = '';
let domState = '';                // stateIdx as a string, '' = all

// Populate the state <select> with states that actually have domain clusters.
function setupDomStateFilter() {
  const sel = $('#dom-state');
  if (!sel || !data.domains?.length) return;
  const states = new Set(data.domains.flatMap(x => x.st).filter(i => i >= 0));
  const opts = [...states]
    .map(st => ({ st, abbr: stateAbbr(data.states[st]) }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr))
    .map(x => `<option value="${x.st}" title="${escapeHtml(data.states[x.st])}">${escapeHtml(x.abbr)}</option>`);
  sel.insertAdjacentHTML('beforeend', opts.join(''));
  sel.addEventListener('change', () => { domState = sel.value; domExpanded = false; renderDomains(); });
}

function renderDomains() {
  const term = domFilter.trim().toLowerCase();
  const rows = (data.domains || [])
    .filter(x => !domState || x.st.includes(+domState))
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

// ---------------- Unnamed libraries with a named twin ----------------
//
// build-qa.mjs pairs every unnamed library with the nearest named one within
// 150 m and, where a way is involved, verifies real containment against the
// building outline (match.in). Almost always the same library mapped twice –
// the fix is to keep one element and remove the duplicate.
const UN_PREVIEW = 30;
let unExpanded = false;
let unFilter = '';
let unState = '';                 // stateIdx as a string, '' = all

function setupUnStateFilter() {
  const sel = $('#un-state');
  if (!sel || !data.unnamedPairs?.length) return;
  const states = new Set(data.unnamedPairs.map(x => x.st).filter(i => i >= 0));
  const opts = [...states]
    .map(st => ({ st, abbr: stateAbbr(data.states[st]) }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr))
    .map(x => `<option value="${x.st}" title="${escapeHtml(data.states[x.st])}">${escapeHtml(x.abbr)}</option>`);
  sel.insertAdjacentHTML('beforeend', opts.join(''));
  sel.addEventListener('change', () => { unState = sel.value; unExpanded = false; renderUnnamedPairs(); });
}

const osmPageLink = osm =>
  `<a href="https://www.openstreetmap.org/${OSM_TYPE[osm[0]]}/${osm.slice(1)}" target="_blank" rel="noopener">${OSM_TYPE[osm[0]]} ${osm.slice(1)}</a>`;

function renderUnnamedPairs() {
  const term = unFilter.trim().toLowerCase();
  const rows = (data.unnamedPairs || [])
    .filter(x => !unState || x.st === +unState)
    .filter(x => !term || x.match.n.toLowerCase().includes(term) || (x.match.op || '').toLowerCase().includes(term))
    // Verified containment first, then nearest – the surest fixes on top.
    .sort((a, b) => (b.match.in ? 1 : 0) - (a.match.in ? 1 : 0) || a.match.dist - b.match.dist);

  const shown = unExpanded ? rows : rows.slice(0, UN_PREVIEW);
  $('#un-table').innerHTML = `
    <thead><tr><th>Unnamed object</th><th>Named twin</th><th class="num">Where</th><th>State</th><th>Actions</th></tr></thead>
    <tbody>${shown.length ? shown.map(x => {
      const where = x.match.in
        ? '<span class="qa-badge qa-badge-wd">inside ✓</span>'
        : `${x.match.dist}&nbsp;m`;
      const twin =
        `<a href="https://www.openstreetmap.org/${OSM_TYPE[x.match.osm[0]]}/${x.match.osm.slice(1)}" target="_blank" rel="noopener">${escapeHtml(x.match.n)}</a>` +
        (x.match.op ? ` <span class="pls-geo">${escapeHtml(x.match.op)}</span>` : '') +
        (x.others ? ` <span class="qa-badge qa-badge-not">+${x.others} more named</span>` : '');
      return `<tr>
        <td>${osmPageLink(x.osm)}</td>
        <td>${twin}</td>
        <td class="num">${where}</td>
        <td>${x.st >= 0 ? escapeHtml(stateAbbr(data.states[x.st])) : ''}</td>
        <td class="qa-actions"><a class="qa-icon-link" href="${editObject(x.osm[0], x.osm.slice(1), x.lat, x.lon)}" target="_blank" rel="noopener" title="Open in editor (both objects are within the loaded area)">✏️</a></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="qa-note" style="padding:14px 10px">No pairs match.</td></tr>'}</tbody>`;

  const more = $('#un-more');
  more.hidden = unExpanded || rows.length <= UN_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} pairs`;
  more.onclick = () => { unExpanded = true; renderUnnamedPairs(); };
}

// ---------------- Wikidata-sourced operators ----------------
//
// A library's own `wikidata=` item usually names the system that runs it, which
// makes the operator *sourced* rather than guessed. build-qa.mjs resolves those
// items and splits the result two ways: groups where OSM has no operator at all
// (a ready-to-apply suggestion) and groups where OSM's operator:wikidata
// disagrees with the item (a question to judge).

// Human labels for the entity kinds build-qa.mjs emits.
const WD_KIND = {
  libnet: 'library network', library: 'library', university: 'university',
  school: 'school', gov: 'government', place: 'place',
  admin: 'administrative area', org: 'organization', other: 'unclassified'
};
// A place, its government, or a bare administrative area sitting in
// operator:wikidata is the specific mistake worth showing first.
const WD_PLACELIKE = new Set(['gov', 'place', 'admin']);

// Placelike kinds read as a problem, a library network as the thing to aim for.
function wdKindBadge(kind) {
  const cls = WD_PLACELIKE.has(kind) ? 'qa-badge-miss'
    : kind === 'libnet' || kind === 'library' ? 'qa-badge-wd'
      : 'qa-badge-not';
  return `<span class="qa-badge ${cls}">${escapeHtml(WD_KIND[kind] || kind)}</span>`;
}
const wdItemLink = q =>
  `<a href="https://www.wikidata.org/wiki/${escapeHtml(q)}" target="_blank" rel="noopener">${escapeHtml(q)}</a>`;

// The property the claim came from, spelled out — P137 states the operator
// outright, the other two are inferred from structure, so the distinction is
// worth showing on the row rather than hiding it.
const WD_PROP = {
  P137: 'operator',
  P749: 'parent organization',
  P361: 'part of'
};

// Overpass Turbo link for exactly this group's OSM objects, so the whole set
// can be loaded and edited in one pass.
function turboIdsUrl(osmIds) {
  const kind = { n: 'node', w: 'way', r: 'relation' };
  const byType = { n: [], w: [], r: [] };
  for (const o of osmIds) byType[o[0]]?.push(o.slice(1));
  const parts = Object.entries(byType)
    .filter(([, ids]) => ids.length)
    .map(([t, ids]) => `  ${kind[t]}(id:${ids.join(',')});`);
  const q = `[out:json][timeout:60];\n(\n${parts.join('\n')}\n);\nout center tags;`;
  return 'https://overpass-turbo.eu/?Q=' + encodeURIComponent(q) + '&R';
}

// One library line, shared by both sections: name, its own Wikidata item and
// where the claim came from, state, and an edit link.
function wdLibRow(l) {
  return `<div class="pls-row pls-untagged">
    <span class="pls-name">${escapeHtml(l.n || '(unnamed)')}</span>
    <span class="pls-detail">↳ ${wdItemLink(l.q)} says ${escapeHtml(WD_PROP[l.pr] || l.pr)}</span>
    <span class="pls-meta"><span class="pls-geo">${escapeHtml(l.s >= 0 ? stateAbbr(data.states[l.s]) : '')}</span></span>
    <a class="qa-icon-link" href="${editObject(l.osm[0], l.osm.slice(1), l.lat, l.lon)}" target="_blank" rel="noopener" title="Fix tags in OSM editor">✏️</a>
  </div>`;
}

// Shared state-filter wiring: both sections carry `st` (state indexes touched).
function setupWdGroupStateFilter(selId, groups, onChange) {
  const sel = $(selId);
  if (!sel || !groups?.length) return;
  const states = new Set(groups.flatMap(g => g.st));
  const opts = [...states]
    .map(st => ({ st, abbr: stateAbbr(data.states[st]) }))
    .sort((a, b) => a.abbr.localeCompare(b.abbr))
    .map(x => `<option value="${x.st}" title="${escapeHtml(data.states[x.st])}">${escapeHtml(x.abbr)}</option>`);
  sel.insertAdjacentHTML('beforeend', opts.join(''));
  sel.addEventListener('change', () => onChange(sel.value));
}

const WDOP_PREVIEW = 20;
let wdopExpanded = false, wdopFilter = '', wdopState = '';

function setupWdopStateFilter() {
  setupWdGroupStateFilter('#wdop-state', data.wdOperators, v => {
    wdopState = v; wdopExpanded = false; renderWdOperators();
  });
}

function renderWdOperators() {
  const list = $('#wdop-list');
  if (!list) return;
  const groups = data.wdOperators || [];
  if (!groups.length) {
    list.innerHTML = '<p class="qa-note">Nothing to suggest – either every wikidata-tagged library already has an operator, or this build came from a source without <code>wikidata</code> tags. 🎉</p>';
    $('#wdop-more').hidden = true;
    return;
  }
  const term = wdopFilter.trim().toLowerCase();
  // File order is by Q-id (stable diffs); biggest work sets first is what's
  // wanted on screen.
  const rows = groups
    .filter(g => !wdopState || g.st.includes(+wdopState))
    .filter(g => !term || (g.po || g.pn || '').toLowerCase().includes(term) || g.pq.toLowerCase() === term)
    .sort((a, b) => b.libs.length - a.libs.length || (a.po || a.pn).localeCompare(b.po || b.pn));

  if (!rows.length) {
    list.innerHTML = '<p class="qa-note">No systems match.</p>';
    $('#wdop-more').hidden = true;
    return;
  }

  const shown = wdopExpanded ? rows : rows.slice(0, WDOP_PREVIEW);
  list.innerHTML = shown.map((g, i) => {
    // Where OSM's spelling and Wikidata's label differ, show the label too —
    // it's the evidence behind the suggestion.
    const alt = g.po && g.pn && g.po !== g.pn
      ? ` <span class="pls-geo" title="English label on Wikidata">Wikidata: “${escapeHtml(g.pn)}”</span>` : '';
    return `<div class="pls-sys">
      <div class="pls-sys-head">
        <span class="qa-coll-name">${escapeHtml(g.po || g.pn)}</span>
        <span class="qa-coll-meta">${wdKindBadge(g.pk)} ·
          <b class="pls-untagged-n">${fmt(g.libs.length)}</b> ${g.libs.length === 1 ? 'library' : 'libraries'} ·
          ${escapeHtml(g.st.map(i => stateAbbr(data.states[i])).join(' / '))}
          ${turboLink(turboIdsUrl(g.libs.map(l => l.osm)))}
          ${wdItemLink(g.pq)}</span>
      </div>
      ${wdFixBar(g, i, 'wdop', alt)}
      ${g.libs.map(wdLibRow).join('')}
    </div>`;
  }).join('');
  bindWdFixActions(list, shown, 'wdop', 'add');

  const more = $('#wdop-more');
  more.hidden = wdopExpanded || rows.length <= WDOP_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} systems`;
  more.onclick = () => { wdopExpanded = true; renderWdOperators(); };
}

// ---- Delivering a group's tags to an editor -------------------------------
//
// Shared by both Wikidata panes. The only differences between them are the
// changeset wording, the JOSM layer name, and whether existing values may be
// replaced — captured in the WD_FIX_MODE table below.
//
// The tags a group should end up with. `operator:wikidata` is the whole point;
// the operator NAME rides along because it is almost always needed too — the
// operator-less libraries have no name at all, and the mismatched ones usually
// carry the wrong one (San Diego's branches read `operator=City of San Diego`
// next to the city's Q-id, so correcting only the Q-id leaves the pair
// contradicting itself).
//
// Two sources for that name, and the difference matters to a reviewer: `po` is
// the spelling OSM already uses for the asserted item, `pn` is Wikidata's
// English label — right far more often than not, but not an established OSM
// value. Callers surface which one they got via wdFixName().
function wdFixName(g) {
  return g.po ? { name: g.po, fromOsm: true } : g.pn ? { name: g.pn, fromOsm: false } : null;
}
function wdFixTags(g) {
  const n = wdFixName(g);
  return { 'operator:wikidata': g.pq, ...(n ? { operator: n.name } : {}) };
}
const tagLines = tags => Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('\n');

const WD_FIX_MODE = {
  // Operator-less libraries: nothing to clobber, so merge additively.
  add: {
    overwrite: false,
    layer: g => `Add operator — ${g.pn || g.pq}`
  },
  // Mismatches: the current value is wrong, so it has to be replaced.
  fix: {
    overwrite: true,
    layer: g => `Fix operator:wikidata — ${g.pn || g.pq}`
  }
};

// There is deliberately no "open the whole group in iD" link. iD has no URL
// parameter for setting tags at all, and its `id=` hash — which does accept a
// comma-separated list — only selects entities it has already downloaded. iD
// loads by viewport, so a group spread across a county never has more than a
// couple of its objects in memory and the selection silently comes up short.
// Per-library edit links (below) work fine; JOSM is the route for a whole group.

async function copyTags(g, btn) {
  const text = tagLines(wdFixTags(g));
  try {
    await navigator.clipboard.writeText(text);
    toast('Tags copied – paste into the editor’s text view');
  } catch {
    // Clipboard needs a secure context and permission; show the text instead of
    // failing silently so it can still be copied by hand.
    btn.title = text;
    toast('Couldn’t copy – the tags are in this button’s tooltip', true);
  }
}

// JOSM is the one editor that can genuinely be handed the finished tags: the
// group goes over as a single unsaved layer with them already applied.
async function sendFixToJosm(g, mode) {
  const { overwrite, layer } = WD_FIX_MODE[mode];
  const tags = wdFixTags(g);
  const skips = [];
  let xml;
  try {
    xml = await buildOsmXml(g.libs.map(l => ({ osm: l.osm, tags })), [], {
      onSkip: (b, why) => skips.push(`${b.osm}: ${why}`),
      overwrite
    });
  } catch (e) {
    toast(`Couldn’t prepare data (${e.message}).`, true);
    return;
  }
  const ok = await loadData(xml, layer(g));
  if (!ok) toast('JOSM didn’t respond – is it running with Remote Control enabled?', true);
  else if (skips.length) {
    console.warn('Wikidata-operator skips:', skips);
    toast(`Sent ${g.libs.length - skips.length}/${g.libs.length} to JOSM (${skips.length} skipped) – review before uploading`, true);
  } else {
    toast(`Sent ${g.libs.length} to JOSM – review the layer before uploading`);
  }
}

// The "here are the tags, take them to an editor" bar. `ns` namespaces the data
// attributes so the two panes' buttons don't collide.
function wdFixBar(g, i, ns, note = '') {
  const fix = wdFixTags(g);
  const name = wdFixName(g);
  return `<div class="wd-fix">
    <span class="wd-fix-tags" title="What these libraries should end up tagged with">${
      Object.entries(fix).map(([k, v]) => {
        // Flag a name that came from Wikidata's label rather than from
        // established OSM usage — it's a suggestion, not a convention.
        const guessed = k === 'operator' && name && !name.fromOsm;
        return `<code${guessed ? ' class="wd-fix-guess" title="From Wikidata\'s English label – no OSM system uses this item yet, so check the spelling mappers would expect"' : ''}>${escapeHtml(k)}=${escapeHtml(v)}${guessed ? ' ?' : ''}</code>`;
      }).join(' ')
    }${note}</span>
    <span class="wd-fix-actions">
      <button class="qa-link-btn" data-${ns}-copy="${i}">Copy tags</button>
      <button class="qa-link-btn" data-${ns}-josm="${i}"
         title="Send all ${g.libs.length} to JOSM as one layer with the tags already applied">Send to JOSM →</button>
    </span>
  </div>`;
}

function bindWdFixActions(list, shown, ns, mode) {
  list.querySelectorAll(`[data-${ns}-copy]`).forEach(b =>
    b.addEventListener('click', () => copyTags(shown[+b.dataset[`${ns}Copy`]], b)));
  list.querySelectorAll(`[data-${ns}-josm]`).forEach(b =>
    b.addEventListener('click', () =>
      withBusy(b, 'Sending…', () => sendFixToJosm(shown[+b.dataset[`${ns}Josm`]], mode))));
}

const WDC_PREVIEW = 20;
let wdcExpanded = false, wdcFilter = '', wdcState = '';

function setupWdcStateFilter() {
  setupWdGroupStateFilter('#wdc-state', data.wdConflicts, v => {
    wdcState = v; wdcExpanded = false; renderWdConflicts();
  });
}

function renderWdConflicts() {
  const list = $('#wdc-list');
  if (!list) return;
  const groups = data.wdConflicts || [];
  if (!groups.length) {
    list.innerHTML = '<p class="qa-note">No library disagrees with its own Wikidata item. 🎉</p>';
    $('#wdc-more').hidden = true;
    return;
  }
  const term = wdcFilter.trim().toLowerCase();
  const rows = groups
    .filter(g => !wdcState || g.st.includes(+wdcState))
    .filter(g => !term ||
      `${g.tn} ${g.pn}`.toLowerCase().includes(term) ||
      g.tw.toLowerCase() === term || g.pq.toLowerCase() === term)
    // A place or government tagged where a library entity exists is the mistake
    // worth fixing first; everything else is a judgement call.
    .sort((a, b) =>
      (WD_PLACELIKE.has(b.tk) - WD_PLACELIKE.has(a.tk)) ||
      b.libs.length - a.libs.length ||
      (a.tn || a.tw).localeCompare(b.tn || b.tw));

  if (!rows.length) {
    list.innerHTML = '<p class="qa-note">No mismatches match.</p>';
    $('#wdc-more').hidden = true;
    return;
  }

  const shown = wdcExpanded ? rows : rows.slice(0, WDC_PREVIEW);
  list.innerHTML = shown.map((g, i) => `<div class="pls-sys">
      <div class="pls-sys-head">
        <span class="qa-coll-name">${escapeHtml(g.tn || g.tw)} ${wdKindBadge(g.tk)}</span>
        <span class="qa-coll-meta">→ ${escapeHtml(g.pn || g.pq)} ${wdKindBadge(g.pk)} ·
          <b class="pls-untagged-n">${fmt(g.libs.length)}</b> ${g.libs.length === 1 ? 'library' : 'libraries'} ·
          ${escapeHtml(g.st.map(i => stateAbbr(data.states[i])).join(' / '))}
          ${turboLink(turboIdsUrl(g.libs.map(l => l.osm)))}</span>
      </div>
      <div class="pls-qid-row">
        <span class="pls-qid pls-qid-suggested">tagged operator:wikidata = ${wdItemLink(g.tw)} ·
          their items say ${wdItemLink(g.pq)}</span>
      </div>
      ${wdFixBar(g, i, 'wdc')}
      ${g.libs.map(wdLibRow).join('')}
    </div>`).join('');
  bindWdFixActions(list, shown, 'wdc', 'fix');

  const more = $('#wdc-more');
  more.hidden = wdcExpanded || rows.length <= WDC_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} mismatches`;
  more.onclick = () => { wdcExpanded = true; renderWdConflicts(); };
}

// ---------------- Collisions ----------------

// sysIdx -> its library rows, built once on demand. The collisions pane needs
// the actual object behind a one-branch side so it can link straight to the edit.
let sysLibsIndex = null;
function sysLibs(idx) {
  if (!sysLibsIndex) {
    sysLibsIndex = new Map();
    for (const l of data.libs) {
      if (l[L.sys] < 0) continue;
      if (!sysLibsIndex.has(l[L.sys])) sysLibsIndex.set(l[L.sys], []);
      sysLibsIndex.get(l[L.sys]).push(l);
    }
  }
  return sysLibsIndex.get(idx) ?? [];
}

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
      const idx = sysByName.get(name);
      // Direct link to the tagged operator:wikidata item, when there is one.
      const wd = hasWd ? data.systems[idx]?.w : null;
      // A typo side is usually a single stray object, and then the fix is one
      // edit — so skip the query and the system table and open it directly.
      const libs = idx === undefined ? [] : sysLibs(idx);
      const only = libs.length === 1 ? libs[0] : null;
      return `
      <div class="qa-coll-side">
        <span class="qa-coll-name">${escapeHtml(name)}</span>
        <span class="qa-coll-meta">${fmt(cnt)} ${cnt === 1 ? 'branch' : 'branches'}
          ${wd ? `<span class="qa-badge qa-badge-wd" title="operator:wikidata"><a href="https://www.wikidata.org/wiki/${escapeHtml(wd)}" target="_blank" rel="noopener">${escapeHtml(wd)}</a> ✓</span>` : ''}
          ${only
            ? `<a class="qa-icon-link" href="${editObject(only[L.type], only[L.id], only[L.lat], only[L.lon])}" target="_blank" rel="noopener" title="Edit ${escapeHtml(only[L.name] || 'this library')} – the only library tagged with this operator">✏️</a>`
            : ''}
          ${turboLink(turboUrl('operator', name))}
          ${idx !== undefined ? `<button class="qa-link-btn" data-sys="${idx}">Explore →</button>` : ''}
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

  // Snapshot table (from the committed daily data).
  $('#sys-table').innerHTML = `
    <thead><tr><th>Library</th><th>State</th>
      ${TAG_DEFS.map(t => `<th class="num"><code>${escapeHtml(tagLabel(t.key))}</code></th>`).join('')}
      <th></th></tr></thead>
    <tbody>${libs.map(l => `<tr>
      <td>${escapeHtml(l[L.name] || '(unnamed)')}</td>
      <td>${escapeHtml(data.states[l[L.state]] || '')}</td>
      ${TAG_DEFS.map(t => `<td class="num">${(l[L.flags] & t.bit) ? CHECK : CROSS}</td>`).join('')}
      <td><a href="${editObject(l[L.type], l[L.id], l[L.lat], l[L.lon])}" target="_blank" rel="noopener">edit ↗</a></td>
    </tr>`).join('')}</tbody>`;
}

// Live details: fetch this system from Overpass and show the full tracked-tag
// set, replacing the snapshot table.
async function loadLive() {
  if (currentSys < 0) return;
  const s = data.systems[currentSys];
  $('#live-note').textContent = 'Fetching live data from Overpass…';
  return withBusy($('#btn-live'), 'Loading…', () => loadLiveInner(s));
}

async function loadLiveInner(s) {
  try {
    const { features: feats, osmBase } = await fetchLibrariesMeta(s.w ? 'wikidata' : 'operator', s.w || s.n);
    if (!feats.length) throw new Error('no results');
    // Public mirrors can lag OSM by weeks — always say how old the data is.
    $('#live-note').textContent =
      `From Overpass (data as of ${osmBase ? new Date(osmBase).toLocaleString() : 'unknown'}) – ` +
      `${feats.length} libraries, all ${TRACKED_TAGS.length} tracked tags.`;
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
    // One endpoint, no silent retry elsewhere — say which failure it was so a
    // misconfigured or overloaded server is diagnosable.
    const why = e.name === 'TimeoutError' ? 'the server did not answer in time' : e.message;
    $('#live-note').textContent =
      `Could not fetch live data (${why}). Check the Overpass server setting above, or try again shortly.`;
  }
}

$('#btn-live').addEventListener('click', loadLive);

boot();
