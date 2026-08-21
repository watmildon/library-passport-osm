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

import { OVERPASS_TIMEOUT_MS } from './config.js';

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
//
// The timeout bounds the caller's pending state rather than the work: JOSM has
// already received the request by then, so giving up here doesn't cancel the
// layer — it just stops a wedged button from spinning forever.
const JOSM_TIMEOUT_MS = 60000;

export async function josmSend(url) {
  try {
    await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(JOSM_TIMEOUT_MS) });
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
// objects are read straight from the OSM API (see fetchObjects), the suggested
// tags are merged in, and the target element is marked action="modify".
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

// Fetch ALL of a system's existing objects + their geometry at their CURRENT
// version, straight from the OSM API's multi-fetch endpoints (CORS-enabled).
// Overpass would be one request, but public mirrors QUEUE under load — the
// mysterious 40-second send — and replication lag can hand back a STALE
// version, which becomes an upload conflict in JOSM. The API returns the
// object exactly as it is right now, which is what an edit layer must start
// from; a whole-system send is a handful of bounded GETs.
//
// The recursion is the bulk of the data: a way without its nodes is incomplete
// in JOSM and can't be edited or uploaded, so way nodes and relation members
// are pulled in batches too. (A relation member that is itself a relation is
// left incomplete — vanishingly rare for libraries, and JOSM fetches such
// members on demand.) Deleted objects come back visible:false from multi-fetch
// (a single-object GET would 410) and are simply not returned, so callers
// report them via onSkip.
//
// Returns a Map(elKey -> element) covering every target and referenced member.
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const API_CHUNK = 350;   // ids per multi-fetch request (URL-length safety)

async function apiMultiFetch(type, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += API_CHUNK) {
    const chunk = ids.slice(i, i + API_CHUNK);
    // The API 429s requests without a User-Agent. Browsers send their own (and
    // may drop this header), but naming ourselves is politeness where it sticks
    // — and it lets the fetch run outside a browser (tests).
    const res = await fetch(`${OSM_API}/${type}s.json?${type}s=${chunk.join(',')}`, {
      headers: { 'User-Agent': 'library-passport-osm/1.0 (+https://github.com/watmildon/library-passport-osm)' },
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`OSM API returned ${res.status} for ${type}s`);
    out.push(...((await res.json()).elements || []).filter(el => el.visible !== false));
  }
  return out;
}

// Current TAGS for a batch of objects — one multi-fetch request per element
// type, no geometry recursion. Returns Map(elKey -> tags); deleted objects are
// simply absent. Used by the QA map to annotate matched outlets lazily.
export async function fetchTagsBatch(osmKeys) {
  const byType = { node: [], way: [], relation: [] };
  for (const k of osmKeys) byType[OSM_TYPE[k[0]]]?.push(k.slice(1));
  const map = new Map();
  for (const [type, ids] of Object.entries(byType)) {
    if (!ids.length) continue;
    for (const el of await apiMultiFetch(type, [...new Set(ids)])) {
      map.set(el.type[0] + el.id, el.tags || {});
    }
  }
  return map;
}

async function fetchObjects(osmKeys) {
  if (!osmKeys.length) return new Map();
  const map = new Map();
  const add = els => { for (const el of els) map.set(el.type[0] + el.id, el); };

  const byType = { node: [], way: [], relation: [] };
  for (const k of osmKeys) byType[OSM_TYPE[k[0]]].push(k.slice(1));

  if (byType.relation.length) {
    const rels = await apiMultiFetch('relation', [...new Set(byType.relation)]);
    add(rels);
    for (const r of rels) for (const m of r.members || []) {
      if (m.type === 'way') byType.way.push(String(m.ref));
      else if (m.type === 'node') byType.node.push(String(m.ref));
    }
  }
  if (byType.way.length) {
    const ways = await apiMultiFetch('way', [...new Set(byType.way)]);
    add(ways);
    for (const w of ways) for (const n of w.nodes || []) byType.node.push(String(n));
  }
  if (byType.node.length) add(await apiMultiFetch('node', [...new Set(byType.node)]));
  return map;
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
// Current objects are read from the OSM API (fetchObjects). Ones the API
// doesn't return — deleted since the data was built — are skipped (reported
// via onSkip); if the fetch fails outright, existing edits are skipped but any
// new nodes are still emitted so the send isn't a total loss.
//
// Tags are merged ADDITIVELY by default — an existing value is never clobbered,
// which is what the PLS augmentation wants (it only ever fills blanks). Pass
// `overwrite: true` for the opposite case: correcting a value that is wrong
// rather than missing, e.g. an operator:wikidata that contradicts the library's
// own Wikidata item. Either way JOSM shows the result as an unsaved layer, so
// the mapper still reviews every change before upload.
export async function buildOsmXml(existing, created, { onSkip, overwrite = false } = {}) {
  const parts = [];
  const seen = new Set();

  let objs = new Map();
  if (existing.length) {
    try { objs = await fetchObjects(existing.map(b => b.osm)); }
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
    target.tags = { ...(target.tags || {}) };
    for (const [k, v] of Object.entries(b.tags)) {
      if (overwrite || !target.tags[k]) target.tags[k] = v;
    }
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
