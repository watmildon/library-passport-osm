// systems.js — the curated list of US library systems for onboarding autocomplete.
// Data is generated from QLever's osm-planet SPARQL endpoint (see scripts/build-systems.md).

let cache = null;

// Load the systems list once (lazily). Returns [] if the file is unavailable,
// so the manual-entry fallback still works offline.
export async function loadSystems() {
  if (cache) return cache;
  try {
    const res = await fetch('./data/us-library-systems.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    cache = json.systems || [];
  } catch (e) {
    console.warn('Could not load US library systems list:', e);
    cache = [];
  }
  return cache;
}

// Rank systems for a query. Prioritises prefix matches, then word-boundary
// matches, then substring; ties broken by library count (bigger systems first).
export function searchSystems(systems, query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const s of systems) {
    const name = s.name.toLowerCase();
    let score;
    if (name.startsWith(q)) score = 0;
    else if (new RegExp('\\b' + escapeRe(q)).test(name)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (s.value.toLowerCase() === q) score = 0; // exact Q-id / operator value
    else continue;
    scored.push({ s, score });
  }
  scored.sort((a, b) => a.score - b.score || (b.s.count - a.s.count) || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map(x => x.s);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
