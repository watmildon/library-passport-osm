// augment.js — Augment page: loads the daily qa-data.json `augment` section and
// delivers per-branch / per-system PLS-derived tag suggestions into JOSM review
// layers via Remote Control. Additive-only; the mapper reviews before uploading.

import { searchSystems } from './systems.js';
import { overpassEndpoint } from './config.js';
import { setupOverpassPicker, withBusy } from './controls.js';
import { josmSend, buildOsmXml, loadData, webEditObjectUrl } from './josm.js';

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = n => n.toLocaleString();

// Order tags read most-useful-first in the chip row.
const TAG_ORDER = ['name', 'operator:wikidata', 'phone',
  'addr:housenumber', 'addr:street', 'addr:unit', 'addr:city', 'addr:postcode', 'amenity'];
function orderedTagEntries(tags) {
  const keys = Object.keys(tags).sort((a, b) => {
    const ia = TAG_ORDER.indexOf(a), ib = TAG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map(k => [k, tags[k]]);
}

// ---------------- Toast (shared visual with qa page) ----------------
let toastTimer = null;
function toast(msg, isError = false) {
  let el = $('#qa-toast');
  if (!el) { el = document.createElement('div'); el.id = 'qa-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'qa-toast show' + (isError ? ' qa-toast-error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'qa-toast'; }, isError ? 4000 : 1800);
}

// ---------------- JOSM delivery ----------------
// A stable, human-readable review-layer name per system so a mapper can tell
// where suggestions landed (and repeated sends for the same system coalesce).
function layerNameFor(system) {
  return `PLS augment · ${system.n}`;
}

// True if a branch has any additive (fill-blank) tag to send. Conflict-only
// branches have nothing to push — they're flagged for the mapper to resolve.
const hasFill = b => b.tags && Object.keys(b.tags).length > 0;

// Send a batch of branches to JOSM as ONE osm data layer via load_data: the
// matched objects are read from Overpass and emitted as action="modify" with the
// fill-blank tags merged in. One layer, no per-object confirmation dialogs.
// Conflicting values are never sent — only the additive fills. Returns { sent }.
async function sendBranches(branches, layerName, { label } = {}) {
  const fillable = branches.filter(hasFill);
  if (!fillable.length) {
    toast('Nothing to fill here — the remaining items are conflicts to review by hand.', true);
    return { sent: 0 };
  }
  const skips = [];
  toast(`Preparing ${fillable.length === 1 ? 'suggestion' : fillable.length + ' suggestions'} for JOSM…`);

  // Read each object's current geometry and version from the configured Overpass
  // server. This is the slow step — see the note in josm.js.
  let xml;
  try {
    xml = await buildOsmXml(fillable, [], {
      endpoint: overpassEndpoint(),
      onSkip: (b, why) => skips.push(`${b.plsName}: ${why}`)
    });
  } catch (e) {
    toast(`Couldn’t prepare data (${e.message}).`, true);
    return { sent: 0 };
  }

  const ok = await loadData(xml, layerName);
  const sent = fillable.length - skips.length;
  if (!ok) {
    toast('JOSM didn’t respond — is it running with Remote Control enabled?', true);
  } else if (skips.length) {
    console.warn('Augment skips:', skips);
    toast(`Sent ${sent}/${fillable.length} to JOSM (${skips.length} skipped) — review before uploading`, true);
  } else {
    toast(`Sent ${label || sent + ' suggestion(s)'} to JOSM — review the layer before uploading`);
  }
  return { sent };
}

async function sendOneBranch(branch, system) {
  await sendBranches([branch], layerNameFor(system), { label: `“${branch.plsName}”` });
}

async function sendSystem(sysAug, system) {
  const fillable = sysAug.branches.filter(hasFill);
  await sendBranches(sysAug.branches, layerNameFor(system),
    { label: `${fillable.length} suggestion${fillable.length === 1 ? '' : 's'}` });
}

// ---------------- Editor fallback (no JOSM) ----------------
// iD can't accept pre-filled tags via URL, but we can open the object so a mapper
// can apply the shown tags (or resolve a conflict) by hand.
function fallbackLink(branch) {
  const url = webEditObjectUrl('id', branch.osm[0], branch.osm.slice(1), branch.lat, branch.lon);
  return `<a class="aug-fallback" href="${url}" target="_blank" rel="noopener" title="Open in the iD web editor (no pre-filled tags)">open in iD ↗</a>`;
}

// ---------------- Data ----------------
let data = null;
let augBySys = new Map();   // sysIdx -> augment entry
let searchable = [];        // systems that HAVE suggestions, for the picker
let currentSys = -1;

async function boot() {
  // A setting, not a feature of the data — wire it before anything can bail out.
  setupOverpassPicker();
  try {
    const res = await fetch('./data/qa-data.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    $('#qa-meta').textContent = 'Could not load augment data (' + e.message + ').';
    return;
  }
  // Entries reference their system by KEY — a stable string that only changes
  // when the OSM tag does, so the daily diff shows real change instead of an
  // array-position reshuffle. Resolve to an index once; the UI passes indices
  // around in `data-sys` attributes. An unresolvable key means the system is
  // gone from this build, so drop the entry rather than render a blank row.
  const sysByKey = new Map(data.systems.map((s, i) => [s.k ?? s.n, i]));
  data.augment = (data.augment || [])
    .map(a => ({ ...a, sysIdx: sysByKey.get(a.sysKey) ?? -1 }))
    .filter(a => a.sysIdx >= 0);

  const aug = data.augment;
  augBySys = new Map(aug.map(a => [a.sysIdx, a]));

  const m = data.meta;
  const fy = m.plsFiscalYear ? `IMLS PLS FY${m.plsFiscalYear} · ` : '';
  $('#qa-meta').textContent =
    `${fy}${fmt(aug.length)} systems with suggestions · data as of ` +
    `${(m.sourceModified || m.layercakeModified) ? new Date(m.sourceModified || m.layercakeModified).toLocaleDateString() : m.generated}`;

  if (!aug.length) {
    $('#tiles').innerHTML = '<p class="qa-note">No augmentation suggestions in this dataset. 🎉</p>';
    return;
  }

  searchable = aug.map(a => {
    const s = data.systems[a.sysIdx];
    return { name: s.n, value: s.w || s.n, count: a.branches.length, sysIdx: a.sysIdx };
  });

  renderTiles(aug);
  setupStateFilter(aug);
  renderSystemsTable();
  setupExplorer();
  probeJosm();

  $('#sys-filter').addEventListener('input', e => { sysFilter = e.target.value; sysExpanded = false; renderSystemsTable(); });
}

// ---------------- Overview tiles ----------------
function renderTiles(aug) {
  let libs = 0, conflictCount = 0;
  const tagCounts = {};
  for (const a of aug) for (const b of a.branches) {
    libs++;
    for (const k of Object.keys(b.tags || {})) tagCounts[k] = (tagCounts[k] || 0) + 1;
    conflictCount += (b.conflicts || []).length;
  }
  const grp = keys => keys.reduce((n, k) => n + (tagCounts[k] || 0), 0);
  const tile = (label, value, hint) =>
    `<div class="qa-tile" ${hint ? `title="${escapeHtml(hint)}"` : ''}>
      <div class="qa-tile-label">${escapeHtml(label)}</div><div class="qa-tile-value">${value}</div></div>`;

  $('#tiles').innerHTML =
    tile('Systems', fmt(aug.length), 'Crosswalked systems with at least one suggestion') +
    tile('Libraries to augment', fmt(libs), 'Existing OSM libraries with a tag to fill or a conflict to review') +
    tile('Conflicts', conflictCount ? `<span class="qa-delta-miss">${fmt(conflictCount)}</span>` : '0', 'PLS values that differ from an existing OSM tag — review by hand') +
    tile('operator:wikidata', fmt(grp(['operator:wikidata']))) +
    tile('phone', fmt(grp(['phone']))) +
    tile('address tags', fmt(grp(['addr:housenumber', 'addr:street', 'addr:unit', 'addr:city', 'addr:postcode'])), 'Total addr:* fills across all libraries') +
    tile('name', fmt(grp(['name'])), 'Unnamed OSM libraries PLS can name');
}

// ---------------- Systems table ----------------
const SYS_PREVIEW = 25;
let sysExpanded = false, sysFilter = '', sysStateVal = '';

function setupStateFilter(aug) {
  const sel = $('#sys-state');
  const states = [...new Set(aug.map(a => a.state).filter(Boolean))].sort();
  sel.insertAdjacentHTML('beforeend', states.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
  sel.addEventListener('change', () => { sysStateVal = sel.value; sysExpanded = false; renderSystemsTable(); });
}

// Per-system tallies: libraries with fills, and total conflicts to review.
function tallySystem(a) {
  let fills = 0, conflicts = 0;
  for (const b of a.branches) {
    if (b.tags && Object.keys(b.tags).length) fills++;
    conflicts += (b.conflicts || []).length;
  }
  return { fills, conflicts };
}

function systemRows() {
  const term = sysFilter.trim().toLowerCase();
  return (data.augment || [])
    .map(a => {
      const s = data.systems[a.sysIdx];
      const { fills, conflicts } = tallySystem(a);
      return { a, s, name: s.n, fills, conflicts, total: a.branches.length };
    })
    .filter(r => !sysStateVal || r.a.state === sysStateVal)
    .filter(r => !term || r.name.toLowerCase().includes(term))
    .sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
}

function renderSystemsTable() {
  const rows = systemRows();
  const shown = sysExpanded ? rows : rows.slice(0, SYS_PREVIEW);
  $('#sys-table').innerHTML = `
    <thead><tr><th>System</th><th>State</th><th class="num">Libraries</th><th class="num">Fills</th><th class="num">Conflicts</th><th></th></tr></thead>
    <tbody>${shown.length ? shown.map(r => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.a.state || '')}</td>
      <td class="num"><b>${r.total}</b></td>
      <td class="num">${r.fills || '—'}</td>
      <td class="num">${r.conflicts ? `<span class="qa-delta-miss">${r.conflicts}</span>` : '—'}</td>
      <td><button class="qa-link-btn" data-sys="${r.a.sysIdx}">Augment →</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="qa-note" style="padding:14px 10px">No systems match.</td></tr>'}</tbody>`;

  const more = $('#sys-more');
  more.hidden = sysExpanded || rows.length <= SYS_PREVIEW;
  more.textContent = `Show all ${fmt(rows.length)} systems`;
  more.onclick = () => { sysExpanded = true; renderSystemsTable(); };

  $('#sys-table').querySelectorAll('[data-sys]').forEach(b =>
    b.addEventListener('click', () => selectSystem(+b.dataset.sys)));
}

// ---------------- Explorer / per-system view ----------------
function setupExplorer() {
  const input = $('#aug-search');
  const box = $('#aug-suggest');
  let results = [], active = -1;
  const close = () => { box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); active = -1; };
  const render = () => {
    if (!results.length) { box.innerHTML = ''; close(); return; }
    box.innerHTML = results.map((s, i) => `
      <div class="suggest-item ${i === active ? 'active' : ''}" role="option" data-i="${i}">
        <span class="si-name">${escapeHtml(s.name)}</span>
        <span class="si-meta">${s.count} suggestion${s.count === 1 ? '' : 's'}</span>
      </div>`).join('');
    box.classList.add('show'); input.setAttribute('aria-expanded', 'true');
    box.querySelectorAll('.suggest-item').forEach(el =>
      el.addEventListener('mousedown', e => { e.preventDefault(); choose(results[+el.dataset.i]); }));
  };
  const choose = s => { input.value = s.name; close(); selectSystem(s.sysIdx); };
  input.addEventListener('input', () => { results = searchSystems(searchable, input.value); active = -1; render(); });
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('show')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[Math.max(active, 0)] || results[0]; if (c) choose(c); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

function tagChips(tags) {
  return orderedTagEntries(tags)
    .map(([k, v]) => `<span class="aug-chip"><code>${escapeHtml(k)}</code>=${escapeHtml(v)}</span>`)
    .join('');
}

// Conflict rows: PLS value differs from an existing OSM tag. Display-only —
// never sent to JOSM; the mapper reconciles by hand.
function conflictBlock(conflicts) {
  if (!conflicts || !conflicts.length) return '';
  const rows = conflicts.map(c => `
    <div class="aug-conflict-row">
      <code>${escapeHtml(c.key)}</code>
      <span class="aug-cf-osm" title="current OSM value">OSM: ${escapeHtml(c.osm)}</span>
      <span class="aug-cf-pls" title="IMLS PLS value">PLS: ${escapeHtml(c.pls)}</span>
    </div>`).join('');
  return `<div class="aug-conflicts" title="These differ from OSM — review by hand; not sent to JOSM">
      <span class="aug-conflict-label">⚠ ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}</span>${rows}
    </div>`;
}

function selectSystem(sysIdx) {
  currentSys = sysIdx;
  const a = augBySys.get(sysIdx);
  const s = data.systems[sysIdx];
  const view = $('#aug-view');
  if (!a) { view.hidden = true; return; }
  $('#aug-search').value = s.n;

  const qidBadge = a.qid
    ? (a.qidConfirmed
        ? `<span class="qa-badge qa-badge-wd" title="Confirmed operator:wikidata for this system"><a href="https://www.wikidata.org/wiki/${escapeHtml(a.qid)}" target="_blank" rel="noopener">${escapeHtml(a.qid)}</a> ✓</span>`
        : `<span class="qa-badge qa-badge-mixed" title="Domain-derived suggestion — verify before applying; excluded from operator:wikidata suggestions">${escapeHtml(a.qid)} ?</span>`)
    : '<span class="qa-badge qa-badge-miss">no operator:wikidata</span>';

  const osmUrl = osm => `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[osm[0]]}/${osm.slice(1)}`;
  const branchRow = (b, i) => {
    const fillable = b.tags && Object.keys(b.tags).length > 0;
    return `
    <div class="aug-row${fillable ? '' : ' aug-row-conflict-only'}">
      <div class="aug-row-head">
        <a class="aug-kind" href="${osmUrl(b.osm)}" target="_blank" rel="noopener" title="View on OpenStreetMap">${escapeHtml(b.osm)}</a>
        <span class="aug-name">${escapeHtml(b.plsName)}</span>
        ${b.dist != null ? `<span class="pls-geo" title="distance PLS↔OSM">${b.dist}m</span>` : ''}
      </div>
      ${fillable ? `<div class="aug-chips">${tagChips(b.tags)}</div>` : ''}
      ${conflictBlock(b.conflicts)}
      <div class="aug-row-actions">
        ${fillable ? `<button class="aug-send" data-branch="${i}">Send to JOSM →</button>` : ''}
        ${fallbackLink(b)}
      </div>
    </div>`;
  };

  const { fills, conflicts } = tallySystem(a);
  view.hidden = false;
  view.innerHTML = `
    <div class="aug-sys-head">
      <h3>${escapeHtml(s.n)}</h3>
      <div class="aug-sys-meta">
        ${qidBadge}
        <span class="qa-coll-meta">${a.branches.length} librar${a.branches.length === 1 ? 'y' : 'ies'} · ${fills} to fill · ${conflicts} conflict${conflicts === 1 ? '' : 's'} · state ${escapeHtml(a.state || '?')}</span>
        ${fills ? `<button class="aug-send-all" id="aug-send-all">Send ${fills} fill${fills === 1 ? '' : 's'} → JOSM</button>` : ''}
      </div>
    </div>
    <p class="qa-note">“Send” loads the object into the <code>${escapeHtml(layerNameFor(s))}</code>
      review layer with the fill-blank tags applied — one layer, no per-tag prompts.
      <strong>Conflicts are shown for review only and never sent</strong>; reconcile them by hand.
      Nothing is uploaded until you upload from JOSM.</p>
    <div class="aug-rows">${a.branches.map((b, i) => branchRow(b, i)).join('')}</div>`;

  view.querySelectorAll('[data-branch]').forEach(btn =>
    btn.addEventListener('click', () =>
      withBusy(btn, 'Sending…', () => sendOneBranch(a.branches[+btn.dataset.branch], s))));
  const sendAll = $('#aug-send-all');
  if (sendAll) sendAll.addEventListener('click', () =>
    withBusy(sendAll, 'Sending…', () => sendSystem(a, s)));

  $('#explorer').open = true;
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- JOSM presence probe ----------------
// A best-effort ping so the callout can say whether JOSM looks reachable. The
// response is opaque (no-cors), so a resolved fetch = "reachable", reject =
// "not running". Purely advisory.
async function probeJosm() {
  const status = $('#josm-status');
  const ok = await josmSend('http://127.0.0.1:8111/version');
  status.textContent = ok ? '✅ JOSM detected.' : '⚠️ JOSM not detected — start it and enable Remote Control.';
  status.className = 'aug-josm-status ' + (ok ? 'ok' : 'warn');
}

boot();
