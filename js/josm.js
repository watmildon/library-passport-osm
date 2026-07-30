// josm.js — JOSM Remote Control helpers shared by the QA and Augment pages.
//
// JOSM listens on http://127.0.0.1:8111 when "Remote Control" is enabled.
// Browsers whitelist http://127.0.0.1 from HTTPS pages, so we call the plain
// HTTP endpoint (the 8112 HTTPS one is deprecated). Responses carry no CORS
// headers, so a no-cors fetch can't be READ — we can only distinguish
// "dispatched" from "connection refused" (JOSM not running). We therefore can't
// confirm JOSM actually accepted a command, only that it was sent.
//
// Command reference: https://josm.openstreetmap.de/wiki/Help/RemoteControlCommands

export const JOSM = 'http://127.0.0.1:8111';

const OSM_TYPE = { n: 'node', w: 'way', r: 'relation' };

// A small bounding box (~40m) around a coordinate, for load_and_zoom.
export function bboxAround(lat, lon, d = 0.0002) {
  return {
    left: (lon - d).toFixed(6), right: (lon + d).toFixed(6),
    top: (lat + d).toFixed(6), bottom: (lat - d).toFixed(6)
  };
}

// Fire a JOSM remote-control command in the background (no new tab). Resolves to
// true if dispatched, false if the connection was refused. Callers usually pass
// the returned boolean to a toast.
export async function josmSend(url) {
  try {
    await fetch(url, { mode: 'no-cors' });
    return true;
  } catch {
    return false;
  }
}

// --- load_data: one OSM XML document, one layer, no per-object dialogs -------
//
// The addtags flow (load_object?…&addtags=) pops a confirmation dialog PER
// object, and each load_object with new_layer makes its own layer. To send a
// whole system's suggestions as one reviewable layer with no clicking, we build
// a single OSM XML document and hand it to JOSM's load_data command.
//
// Modifying an EXISTING object in that document requires its current version and
// full geometry (for ways/relations, all referenced members must be present or
// JOSM treats the way as incomplete and can't edit/upload it). So existing
// objects are read from Overpass (one query, `out meta` + recursion), the
// suggested tags are merged in, and the target element is marked action="modify".
// (buildOsmXml can also emit brand-new nodes with negative ids — a generic
// capability; the augmentation page only ever fills existing objects.)

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function tagsXml(tags) {
  return Object.entries(tags)
    .filter(([, v]) => v != null && String(v) !== '')
    .map(([k, v]) => `<tag k="${xmlEscape(k)}" v="${xmlEscape(v)}"/>`)
    .join('');
}

// Fetch ALL of a system's existing objects + their geometry in ONE Overpass
// query (`out meta` gives versions; `>;` recurses ways down to their nodes with
// coords). Using Overpass — the same source the augment data was built from —
// keeps us off the tightly rate-limited OSM API. `endpoints` is tried in order so
// a bad custom instance or a down mirror falls back. Returns a Map(elKey ->
// element) covering every target and referenced member; throws if all fail.
async function fetchObjects(endpoints, osmKeys) {
  if (!osmKeys.length) return new Map();
  // Group ids by type into id-lists: node(1,2,3); way(4,5); relation(6);
  const byType = { node: [], way: [], relation: [] };
  for (const k of osmKeys) byType[OSM_TYPE[k[0]]].push(k.slice(1));
  const sel = Object.entries(byType)
    .filter(([, ids]) => ids.length)
    .map(([t, ids]) => `${t}(id:${ids.join(',')});`)
    .join('');
  const q = `[out:json][timeout:90];(${sel});(._;>;);out meta;`;
  const body = 'data=' + encodeURIComponent(q);

  const urls = (Array.isArray(endpoints) ? endpoints : [endpoints]).filter(Boolean);
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const map = new Map();
      for (const el of (await res.json()).elements || []) map.set(el.type[0] + el.id, el);
      return map;
    } catch (e) {
      lastErr = e;
      console.warn(`  augment: Overpass ${url} failed: ${e.message}`);
    }
  }
  throw new Error(`all Overpass endpoints failed (${lastErr?.message || 'unknown'})`);
}

// Serialize one OSM API element to XML. `modifyId` (the target's "t123" key)
// gets action="modify"; referenced members are emitted verbatim so JOSM has a
// complete, editable object.
function elementXml(el, targetKey) {
  const key = el.type[0] + el.id;
  const action = key === targetKey ? ' action="modify"' : '';
  const common = `id="${el.id}" version="${el.version}"`;
  if (el.type === 'node') {
    const body = tagsXml(el.tags || {});
    return `<node ${common} lat="${el.lat}" lon="${el.lon}"${action}>${body}</node>`;
  }
  if (el.type === 'way') {
    const nds = (el.nodes || []).map(n => `<nd ref="${n}"/>`).join('');
    return `<way ${common}${action}>${nds}${tagsXml(el.tags || {})}</way>`;
  }
  // relation
  const mems = (el.members || []).map(m =>
    `<member type="${m.type}" ref="${m.ref}" role="${xmlEscape(m.role || '')}"/>`).join('');
  return `<relation ${common}${action}>${mems}${tagsXml(el.tags || {})}</relation>`;
}

// Build one OSM XML document for a batch of branches:
//   existing: [{ osm, tags }]  — current objects fetched from Overpass, the
//                                suggested tags merged onto the target (modify)
//   created:  [{ lat, lon, tags }] — emitted as new nodes with negative ids
// `overpassEndpoints` is an array of instances to read current objects from,
// tried in order. Returns the XML string. Existing objects that Overpass doesn't
// return are skipped (reported via onSkip); if Overpass fails entirely, existing
// edits are skipped but any new nodes are still emitted so the send isn't a total
// loss.
export async function buildOsmXml(existing, created, { overpassEndpoints, onSkip } = {}) {
  const parts = [];
  const seen = new Set();

  let objs = new Map();
  if (existing.length && overpassEndpoints) {
    try { objs = await fetchObjects(overpassEndpoints, existing.map(b => b.osm)); }
    catch (e) { for (const b of existing) onSkip?.(b, e.message); }
  }

  // Emit an element (and, for ways/relations, its referenced members) once.
  const emit = (el, targetKey) => {
    const key = el.type[0] + el.id;
    if (!seen.has(key)) { seen.add(key); parts.push(elementXml(el, targetKey)); }
    // Pull in referenced members so ways/relations are complete in the layer.
    const refs = el.type === 'way' ? (el.nodes || []).map(n => 'n' + n)
      : el.type === 'relation' ? (el.members || []).map(m => m.type[0] + m.ref) : [];
    for (const rk of refs) { const m = objs.get(rk); if (m) emit(m, null); }
  };

  for (const b of existing) {
    const target = objs.get(b.osm);
    if (!target) { if (objs.size) onSkip?.(b, 'not returned by Overpass'); continue; }
    // Merge suggested tags additively (don't clobber a value that now exists).
    target.tags = { ...(target.tags || {}) };
    for (const [k, v] of Object.entries(b.tags)) if (!target.tags[k]) target.tags[k] = v;
    emit(target, b.osm);
  }

  // New nodes: negative ids, own coordinates.
  created.forEach((b, i) => {
    parts.push(`<node id="${-(i + 1)}" version="0" lat="${b.lat}" lon="${b.lon}">${tagsXml(b.tags)}</node>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="library-passport-osm augment">\n${parts.join('\n')}\n</osm>\n`;
}

// Send an OSM XML document to JOSM as one new named layer (no per-object
// dialogs). Per the wiki, load_data's `data` must URL-encode &, = and ? too, so
// encodeURIComponent (which encodes all three) is exactly right.
export async function loadData(xml, layerName) {
  const p = new URLSearchParams({ new_layer: 'true' });
  if (layerName) p.set('layer_name', layerName);
  const url = `${JOSM}/load_data?${p.toString()}&data=${encodeURIComponent(xml)}`;
  return josmSend(url);
}

// Plain object-edit link for the current web editor (iD / Rapid) — the fallback
// for users without JOSM. No pre-filled tags (web editors can't accept them via
// URL), but it opens the object / location so they can edit by hand.
export function webEditObjectUrl(editor, type, id, lat, lon) {
  const t = OSM_TYPE[type] || type;
  if (editor === 'rapid') return `https://rapideditor.org/edit#id=${t[0]}${id}${lat != null ? `&map=19/${lat}/${lon}` : ''}`;
  return `https://www.openstreetmap.org/edit?editor=id&${t}=${id}`;
}
export function webEditAtUrl(editor, lat, lon) {
  if (editor === 'rapid') return `https://rapideditor.org/edit#map=19/${lat}/${lon}`;
  return `https://www.openstreetmap.org/edit?editor=id#map=19/${lat}/${lon}`;
}
