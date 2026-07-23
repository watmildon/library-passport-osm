// qa.js — Data QA page: loads the weekly qa-data.json and renders
// completion stats, wikidata gaps, likely typos, and a per-system explorer.
// The explorer's "Load live details" fetches one system from Overpass to show
// the full tag set (including addresses, absent from the weekly extract).

import { searchSystems } from './systems.js';
import { fetchLibraries } from './overpass.js';
import { TRACKED_TAGS } from './completeness.js';

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
const editUrl = (t, id) => `https://www.openstreetmap.org/edit?${OSM_TYPE[t]}=${id}`;
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;
const fmt = n => n.toLocaleString();

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

  renderTiles();
  renderUsMeters();
  renderStateTable();
  renderWikidataGaps();
  renderAmbiguous();
  renderDomains();
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
  openSection(location.hash.slice(1));
}

// ---------------- Overview ----------------
function tile(label, value, hint) {
  return `<div class="qa-tile" ${hint ? `title="${escapeHtml(hint)}"` : ''}>
    <div class="qa-tile-label">${escapeHtml(label)}</div>
    <div class="qa-tile-value">${value}</div>
  </div>`;
}

function renderTiles() {
  const total = data.libs.length;
  const withOp = data.libs.filter(l => l[L.flags] & 8).length;
  const withWd = data.libs.filter(l => l[L.flags] & 16).length;
  $('#tiles').innerHTML =
    tile('US libraries', fmt(total)) +
    tile('Library systems', fmt(data.systems.length)) +
    tile('Have an operator', pct(withOp, total) + '%', `${fmt(withOp)} of ${fmt(total)}`) +
    tile('Have operator:wikidata', pct(withWd, total) + '%', `${fmt(withWd)} of ${fmt(total)}`);
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
        ? `<span class="qa-badge qa-badge-mixed" title="Suggested via a shared website domain with wikidata-tagged libraries — verify before applying"><a href="https://www.wikidata.org/wiki/${escapeHtml(s.sw)}" target="_blank" rel="noopener">${escapeHtml(s.sw)}</a> ?</span>`
        : ''}${(s.nw || []).map(q =>
          `<span class="qa-badge qa-badge-not" title="Mappers ruled this item out (not:operator:wikidata) — no need to re-research it"><a href="https://www.wikidata.org/wiki/${escapeHtml(q)}" target="_blank" rel="noopener">not ${escapeHtml(q)}</a></span>`).join(' ')}</td>
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

// ---------------- Branch counts vs Wikidata ----------------
const BR_PREVIEW = 30;
let brExpanded = false;
let brSort = { col: 'delta', dir: -1 };

const BR_COLS = [
  { id: 'n',     label: 'System' },
  { id: 'c',     label: 'OSM', num: true },
  { id: 'wb',    label: 'Wikidata', num: true },
  { id: 'delta', label: 'Δ', num: true }
];

function renderBranchCounts() {
  const { col, dir } = brSort;
  const rows = data.systems
    .map((s, i) => ({ ...s, idx: i, delta: s.c - (s.wb ?? 0) }))
    .filter(s => s.wb != null)
    .sort((a, b) => {
      let cmp;
      if (col === 'n') cmp = a.n.localeCompare(b.n);
      else if (col === 'delta') cmp = Math.abs(a.delta) - Math.abs(b.delta);
      else cmp = a[col] - b[col];
      return cmp * dir || Math.abs(b.delta) - Math.abs(a.delta) || a.n.localeCompare(b.n);
    });

  const arrow = c => brSort.col === c ? (brSort.dir === -1 ? ' ▾' : ' ▴') : '';
  const shown = brExpanded ? rows : rows.slice(0, BR_PREVIEW);
  $('#br-table').innerHTML = `
    <thead><tr>${BR_COLS.map(c =>
      `<th data-col="${c.id}" class="${c.num ? 'num' : ''}">${escapeHtml(c.label)}${arrow(c.id)}</th>`).join('')}<th>Actions</th>
    </tr></thead>
    <tbody>${shown.map(s => {
      const d = s.delta;
      const deltaCell = d === 0
        ? '<span class="qa-yes" title="OSM and Wikidata agree">✓</span>'
        : `<span class="${d < 0 ? 'qa-delta-miss' : 'qa-delta-extra'}" title="${d < 0
            ? Math.abs(d) + ' branch(es) on Wikidata not found in OSM — possibly unmapped'
            : d + ' more branch(es) in OSM than Wikidata lists — duplicates, non-branches, or stale Wikidata'}">${d > 0 ? '+' + d : d}</span>`;
      return `<tr>
        <td>${escapeHtml(s.n)}</td>
        <td class="num">${fmt(s.c)}</td>
        <td class="num"><a href="https://www.wikidata.org/wiki/${escapeHtml(s.w)}" target="_blank" rel="noopener">${fmt(s.wb)}</a></td>
        <td class="num">${deltaCell}</td>
        <td class="qa-actions">
          ${turboLink(turboUrl('wikidata', s.w))}
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
        : '<span class="qa-badge qa-badge-miss">unknown — research once, tag all</span>';
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
    if (c.lev === 0) hint = 'Same name, different capitalization — almost certainly a typo.';
    // Only claim a direction for single-edit differences: at distance 2 the pair
    // may be two genuinely different systems.
    else if (c.lev === 1 && c.ca >= 5 * c.cb && c.cb <= 2) hint = `Likely typo of “${escapeHtml(c.a)}”.`;
    else if (c.aw !== c.bw) hint = `Only one side has operator:wikidata — if these are the same system, align the other.`;
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
    ? ' <span class="qa-badge qa-badge-miss" title="Some libraries tag this item as operator:wikidata while others rule it out with not:operator:wikidata — mappers disagree; worth resolving">⚠ conflicting tags</span>'
    : '';
  const wbNote = s.wb != null
    ? (s.wb === s.c
        ? ` · <span class="qa-yes" title="Wikidata lists the same number of branches">Wikidata: ${fmt(s.wb)} ✓</span>`
        : ` · <span class="qa-badge qa-badge-mixed" title="Wikidata's branch list (P527) disagrees with the OSM count — unmapped branches, duplicates, or a stale list">Wikidata: ${fmt(s.wb)} branches</span>`)
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
      <td><a href="${editUrl(l[L.type], l[L.id])}" target="_blank" rel="noopener">edit ↗</a></td>
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
      `Live from Overpass just now — ${feats.length} libraries, all ${TRACKED_TAGS.length} tracked tags.`;
    $('#sys-table').innerHTML = `
      <thead><tr><th>Library</th><th>City</th>
        ${TRACKED_TAGS.map(t => `<th class="num"><code>${escapeHtml(t.label)}</code></th>`).join('')}
        <th></th></tr></thead>
      <tbody>${feats.map(f => {
        const p = f.properties;
        return `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.city || '')}</td>
          ${TRACKED_TAGS.map(t => `<td class="num">${t.get(p) ? CHECK : CROSS}</td>`).join('')}
          <td><a href="https://www.openstreetmap.org/edit?${p.osmType}=${p.osmId}" target="_blank" rel="noopener">edit ↗</a></td>
        </tr>`;
      }).join('')}</tbody>`;
  } catch (e) {
    $('#live-note').textContent = 'Could not fetch live data (' + e.message + '). Try again shortly.';
    btn.disabled = false;
  }
}

$('#btn-live').addEventListener('click', loadLive);

boot();
