// app.js — main controller: map, sidebar, popups, filters, onboarding.

import maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/+esm';
import { fetchLibraries } from './overpass.js';
import { MAP_STYLE, customOverpass, setCustomOverpass } from './config.js';
import { openState, nextChangeLabel, resetHoursCache } from './hours.js';
import { tagBreakdown, isComplete } from './completeness.js';
import { loadSystems, searchSystems } from './systems.js';
import {
  loadConfig, saveConfig, loadData, saveData,
  loadVisits, saveVisits, clearSystem, DATA_VERSION
} from './storage.js';

// ---------------- State ----------------
const state = {
  config: null,          // { mode, value, systemName }
  features: [],          // GeoJSON features
  visits: {},            // { [id]: true }
  filterOpenNow: false,  // grey out closed
  filterMissing: false,  // grey out libraries with complete OSM tags
  search: '',
  map: null,
  popup: null,
  onboardMode: 'operator',
  systems: [],           // curated US library-systems list
  selectedSystem: null   // system chosen from the picker
};

// ---------------- Small utilities ----------------
const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

function showLoading(msg) {
  $('#loading-msg').textContent = msg || 'Loading…';
  $('#loading').classList.add('show');
}
function hideLoading() { $('#loading').classList.remove('show'); }

// ---------------- Visits ----------------
function isVisited(id) { return !!state.visits[id]; }

function setVisited(id, val) {
  if (val) state.visits[id] = true; else delete state.visits[id];
  saveVisits(state.config, state.visits);
  refreshEverything();
}

// ---------------- Filtering ----------------
function visibleFeatures() {
  const term = state.search.trim().toLowerCase();
  if (!term) return state.features;
  return state.features.filter(f => f.properties.name.toLowerCase().includes(term));
}

// ---------------- Map ----------------
function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [-98, 40],
    zoom: 3
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  state.map.on('load', () => {
    state.map.addSource('libs', { type: 'geojson', data: emptyFC() });

    state.map.addLayer({
      id: 'lib-circles',
      type: 'circle',
      source: 'libs',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 12, 9],
        'circle-color': [
          'case',
          ['get', 'dim'], '#b0b7c0',
          ['get', 'visited'], '#2ea043',
          '#0077bb'
        ],
        'circle-opacity': ['case', ['get', 'dim'], 0.5, 0.95],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-opacity': ['case', ['get', 'dim'], 0.5, 1]
      }
    });

    state.map.addLayer({
      id: 'lib-labels',
      type: 'symbol',
      source: 'libs',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 12,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-optional': true,
        'text-max-width': 9
      },
      paint: {
        'text-color': '#33404f',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
        'text-opacity': ['case', ['get', 'dim'], 0.6, 1]
      }
    });

    state.map.on('click', 'lib-circles', e => {
      const id = e.features[0].properties.id;
      openPopup(id, e.lngLat);
    });
    state.map.on('mouseenter', 'lib-circles', () => state.map.getCanvas().style.cursor = 'pointer');
    state.map.on('mouseleave', 'lib-circles', () => state.map.getCanvas().style.cursor = '');

    if (state.features.length) { syncMapData(); fitToFeatures(); }
  });
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

// Whether a feature should be greyed out under the active filter.
// "Open now" dims closed libraries; "Missing OSM data" dims complete ones.
function shouldDim(f) {
  if (state.filterOpenNow && openState(f) === 'closed') return true;
  if (state.filterMissing && isComplete(f.properties)) return true;
  return false;
}

// GeoJSON for the map source, decorated with live visited/dim state.
function mapFC() {
  return {
    type: 'FeatureCollection',
    features: visibleFeatures().map(f => ({
      ...f,
      properties: {
        ...f.properties,
        visited: isVisited(f.properties.id),
        dim: shouldDim(f)
      }
    }))
  };
}

function syncMapData() {
  const src = state.map && state.map.getSource('libs');
  if (src) src.setData(mapFC());
}

function fitToFeatures() {
  if (!state.features.length) return;
  const b = new maplibregl.LngLatBounds();
  state.features.forEach(f => b.extend(f.geometry.coordinates));
  state.map.fitBounds(b, {
    padding: { top: 60, bottom: 60, left: 380, right: 60 },
    maxZoom: 14,
    duration: 0
  });
}

// ---------------- Popup ----------------
function popRow(k, v) { return `<div class="r"><span class="k">${k}</span><span>${v}</span></div>`; }

function openPopup(id, lngLat) {
  const f = state.features.find(x => x.properties.id === id);
  if (!f) return;
  const p = f.properties;
  const visited = isVisited(id);
  const st = openState(f);

  const badge = st === 'open'
    ? '<span class="status-badge badge-open">🟢 Open now</span>'
    : st === 'closed'
      ? '<span class="status-badge badge-closed">⚪ Closed now</span>'
      : '<span class="status-badge badge-unknown">Hours unknown</span>';
  const nc = nextChangeLabel(f);

  const rows = [];
  if (p.addr || p.city) rows.push(popRow('📍', escapeHtml([p.addr, p.city].filter(Boolean).join(', '))));
  if (p.opening_hours) {
    const suffix = nc ? ` <span style="color:var(--muted)">· ${escapeHtml(nc)}</span>` : '';
    rows.push(popRow('🕑', escapeHtml(p.opening_hours) + suffix));
  }
  if (p.phone) rows.push(popRow('📞', `<a href="tel:${escapeHtml(p.phone)}">${escapeHtml(p.phone)}</a>`));
  if (p.website) {
    const label = p.website.replace(/^https?:\/\//, '');
    rows.push(popRow('🔗', `<a href="${escapeHtml(p.website)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`));
  }

  // In "Missing OSM data" mode, show a tag breakdown and switch the OSM link to an editor link.
  let tagsSection = '';
  let osmLink = `<a href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}" target="_blank" rel="noopener" style="font-size:12px">View on OpenStreetMap ↗</a>`;
  if (state.filterMissing) {
    const { present, missing } = tagBreakdown(p);
    const presentHtml = present.map(t =>
      `<div class="tag-row tag-present"><span class="tag-k">${escapeHtml(t.label)}</span><span class="tag-v">${escapeHtml(t.value)}</span></div>`
    ).join('');
    const missingHtml = missing.map(t =>
      `<div class="tag-row tag-missing"><span class="tag-k">${escapeHtml(t.label)}</span><span class="tag-v">— missing</span></div>`
    ).join('');
    tagsSection = `
      <div class="tags-block">
        <div class="tags-title">OSM tags ${missing.length ? `· <span class="tags-count">${missing.length} missing</span>` : '· <span class="tags-complete">complete</span>'}</div>
        ${missingHtml}${presentHtml}
      </div>`;
    const editUrl = `https://www.openstreetmap.org/edit?${p.osmType}=${p.osmId}`;
    osmLink = `<a href="${editUrl}" target="_blank" rel="noopener" style="font-size:12px">✏️ Edit on OpenStreetMap ↗</a>`;
  }

  const html = `
    <div class="pop">
      <div class="pop-head">
        <p class="nm">${escapeHtml(p.name)}</p>
        ${p.operator ? `<div class="op">${escapeHtml(p.operator)}</div>` : ''}
      </div>
      <div class="pop-body">
        <div style="margin-bottom:4px">${badge}</div>
        <label class="visit-toggle">
          <span class="vt-label">Visited</span>
          <span class="switch ${visited ? 'on' : ''}" id="pop-visit" role="switch" aria-checked="${visited}" tabindex="0">
            <span class="knob"></span>
          </span>
        </label>
        ${rows.join('')}
        ${tagsSection}
        <div class="r" style="margin-top:10px">
          ${osmLink}
        </div>
      </div>
    </div>`;

  if (state.popup) state.popup.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(lngLat).setHTML(html).addTo(state.map);
  state.popup._libId = id; // remember which library this popup shows

  const toggleVisit = () => {
    const now = !isVisited(id);
    setVisited(id, now);
    openPopup(id, lngLat); // re-render with new state
    toast(now ? '📖 Marked as visited!' : 'Removed from visited');
  };
  const sw = state.popup.getElement().querySelector('#pop-visit');
  sw.addEventListener('click', toggleVisit);
  sw.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVisit(); }
  });
}

// ---------------- Sidebar list ----------------
function renderList() {
  const el = $('#list');
  const vis = visibleFeatures();

  if (!vis.length) {
    el.innerHTML = '<div class="list-empty">No libraries match your filters.</div>';
    return;
  }

  el.innerHTML = vis.map(f => {
    const p = f.properties;
    const visited = isVisited(p.id);
    const dim = shouldDim(f);

    // Right-hand indicator depends on the active filter.
    let indicator;
    if (state.filterMissing) {
      const missing = tagBreakdown(p).missing.length;
      indicator = missing
        ? `<span class="miss-badge" title="${missing} tracked tag(s) missing">${missing}</span>`
        : `<span class="status-dot dot-open" title="All tracked tags present"></span>`;
    } else {
      const st = openState(f);
      const dot = st === 'open' ? 'dot-open' : st === 'closed' ? 'dot-closed' : 'dot-unknown';
      const stTxt = st === 'open' ? 'Open now' : st === 'closed' ? 'Closed now' : 'Hours unknown';
      indicator = `<span class="status-dot ${dot}" title="${stTxt}"></span>`;
    }

    return `<div class="lib-item ${visited ? 'visited' : ''} ${dim ? 'dim' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="emoji">${visited ? '✅' : '📚'}</span>
      <div class="info">
        <div class="nm">${escapeHtml(p.name)}</div>
        <div class="meta">${escapeHtml(p.city || p.addr || '')}</div>
      </div>
      ${indicator}
    </div>`;
  }).join('');

  el.querySelectorAll('.lib-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const f = state.features.find(x => x.properties.id === id);
      if (!f) return;
      state.map.flyTo({ center: f.geometry.coordinates, zoom: 15, duration: 700 });
      openPopup(id, f.geometry.coordinates);
    });
  });
}

// ---------------- Stats ----------------
function renderStats() {
  const total = state.features.length;
  const visited = state.features.filter(f => isVisited(f.properties.id)).length;
  const pct = total ? Math.round((visited / total) * 100) : 0;
  $('#stat-fill').style.width = pct + '%';
  $('#stat-pct').textContent = pct + '%';
  $('#stat-visited').textContent = visited;
  $('#stat-total').textContent = total;
}

function refreshEverything() {
  renderStats();
  renderList();
  syncMapData();
}

// ---------------- Onboarding ----------------
function setupOnboard() {
  setupPicker();

  // Manual-entry fallback (inside <details>).
  const seg = $('#mode-seg');
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.onboardMode = b.dataset.mode;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    $('#field-operator').style.display = state.onboardMode === 'operator' ? '' : 'none';
    $('#field-wikidata').style.display = state.onboardMode === 'wikidata' ? '' : 'none';
  }));

  // Optional custom Overpass endpoint: prefill any saved value; open the section
  // if one is set so it's discoverable. Persist on change.
  const overpassInput = $('#in-overpass');
  const savedOverpass = customOverpass();
  if (savedOverpass) {
    overpassInput.value = savedOverpass;
    $('#advanced').open = true;
  }
  overpassInput.addEventListener('change', () => setCustomOverpass(overpassInput.value));

  $('#btn-load').addEventListener('click', () => doLoad());
  ['#in-operator', '#in-wikidata', '#in-overpass'].forEach(sel =>
    $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') doLoad(); }));
}

// Autocomplete over the curated US library-systems list.
function setupPicker() {
  const input = $('#in-search');
  const box = $('#suggest');
  let results = [];
  let active = -1;

  loadSystems().then(list => {
    state.systems = list;
    if (list.length) $('#picker-hint').textContent = `Searching ${list.length.toLocaleString()} US library systems from OpenStreetMap.`;
    else $('#picker-hint').textContent = 'System list unavailable — use manual entry below.';
  });

  function close() { box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); active = -1; }

  function render() {
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
  }

  function choose(sys) {
    state.selectedSystem = sys;
    input.value = sys.name;
    close();
    doLoad(sys);
  }

  input.addEventListener('input', () => {
    state.selectedSystem = null; // typing invalidates a prior pick
    results = searchSystems(state.systems || [], input.value);
    active = -1;
    render();
  });

  input.addEventListener('keydown', e => {
    if (!box.classList.contains('show')) {
      if (e.key === 'Enter') { e.preventDefault(); doLoad(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(results[active]);
      else if (results.length) choose(results[0]);
    } else if (e.key === 'Escape') { close(); }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

// Load libraries for a chosen system. `sys` comes from the picker; if omitted,
// we fall back to a prior picker selection or the manual-entry fields.
async function doLoad(sys) {
  const errEl = $('#onboard-err');
  errEl.textContent = '';

  // Persist any custom Overpass endpoint before it's used by the fetch below.
  const overpassUrl = $('#in-overpass').value.trim();
  if (overpassUrl && !/^https?:\/\/.+/i.test(overpassUrl)) {
    errEl.textContent = 'The Overpass server URL should start with http:// or https://';
    $('#advanced').open = true;
    return;
  }
  setCustomOverpass(overpassUrl);

  let mode, value, chosenName;
  const picked = sys || state.selectedSystem;
  if (picked) {
    mode = picked.mode; value = picked.value; chosenName = picked.name;
  } else {
    // Manual entry
    mode = state.onboardMode;
    value = (mode === 'wikidata' ? $('#in-wikidata').value : $('#in-operator').value).trim();
    if (!value) { errEl.textContent = 'Pick a system above, or enter one manually.'; return; }
    if (mode === 'wikidata' && !/^Q\d+$/.test(value)) {
      errEl.textContent = 'Wikidata IDs look like Q6411390.';
      return;
    }
  }

  const btn = $('#btn-load');
  btn.disabled = true; btn.textContent = 'Loading…';
  showLoading('Fetching libraries from OpenStreetMap…');

  try {
    const feats = await fetchLibraries(mode, value);
    if (!feats.length) {
      errEl.textContent = 'No libraries found for that system. Double-check the value.';
      hideLoading();
      btn.disabled = false; btn.textContent = 'Load libraries →';
      return;
    }
    state.features = feats;
    const systemName = chosenName || feats[0].properties.operator || value;
    state.config = { mode, value, systemName };
    state.visits = loadVisits(state.config);
    saveConfig(state.config);
    saveData({ type: 'FeatureCollection', features: feats });
    launchApp();
  } catch (err) {
    errEl.textContent = 'Could not reach Overpass. Try again shortly. (' + err.message + ')';
    hideLoading();
    btn.disabled = false; btn.textContent = 'Load libraries →';
  }
}

// ---------------- Launch / reset ----------------
function launchApp() {
  $('#onboard').style.display = 'none';
  $('#sidebar').style.display = 'flex';
  $('#system-name').textContent = state.config.systemName;
  $('#system-name').title = state.config.systemName;
  hideLoading();

  if (!state.map) initMap();
  else if (state.map.getSource('libs')) { syncMapData(); fitToFeatures(); }

  refreshEverything();
}

// Re-fetch libraries for an already-chosen system (stale cache or version bump).
async function reloadFromConfig(cfg) {
  state.config = cfg;
  state.visits = loadVisits(cfg);
  showLoading('Refreshing library data…');
  try {
    const feats = await fetchLibraries(cfg.mode, cfg.value);
    if (feats.length) {
      state.features = feats;
      saveData({ type: 'FeatureCollection', features: feats });
      launchApp();
      return;
    }
  } catch { /* fall through to a stale render if we have anything */ }

  // Fetch failed: fall back to whatever cached features exist so the app still works offline.
  const data = loadData();
  state.features = (data && data.features) || [];
  hideLoading();
  if (state.features.length) launchApp();
  else location.reload(); // nothing to show — send them back to onboarding
}

function resetSystem() {
  const ok = confirm('Change library system? The map will reload. Your visited marks for each system are kept in this browser.');
  if (!ok) return;
  clearSystem();
  location.reload();
}

// ---------------- Sidebar controls ----------------
function setupControls() {
  $('#search').addEventListener('input', e => {
    state.search = e.target.value;
    renderList();
    syncMapData();
  });
  $('#chip-open').addEventListener('click', e => {
    state.filterOpenNow = !state.filterOpenNow;
    e.currentTarget.classList.toggle('active', state.filterOpenNow);
    refreshEverything();
  });
  $('#chip-missing').addEventListener('click', e => {
    state.filterMissing = !state.filterMissing;
    e.currentTarget.classList.toggle('active', state.filterMissing);
    // Re-render any open popup so its tag breakdown / edit link updates.
    if (state.popup && state.popup.isOpen()) {
      const id = state.popup._libId;
      const f = id && state.features.find(x => x.properties.id === id);
      if (f) openPopup(id, state.popup.getLngLat());
    }
    refreshEverything();
  });
  $('#btn-reset').addEventListener('click', resetSystem);
}

// ---------------- Boot ----------------
function boot() {
  setupOnboard();
  setupControls();

  const cfg = loadConfig();
  const data = loadData();
  if (cfg && data && data.features && data.features.length && data.version === DATA_VERSION) {
    state.config = cfg;
    state.features = data.features;
    state.visits = loadVisits(cfg);
    launchApp();
  } else if (cfg) {
    // Config exists but cached data is missing or from an older schema — re-fetch.
    reloadFromConfig(cfg);
  }

  // Keep the "open now" view fresh as the clock advances.
  setInterval(() => {
    if (state.features.length && state.filterOpenNow) {
      resetHoursCache();
      refreshEverything();
    }
  }, 60000);
}

boot();
