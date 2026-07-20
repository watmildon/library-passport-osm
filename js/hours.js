// hours.js — evaluate OSM opening_hours tags against the local system clock.
// Wraps the vendored opening_hours.js library and caches parsed instances.

import opening_hours from '../vendor/opening_hours.js';

const cache = new Map(); // featureId -> opening_hours instance | null (unparseable)

function instanceFor(feature) {
  const id = feature.properties.id;
  if (cache.has(id)) return cache.get(id);

  const tag = feature.properties.opening_hours;
  let inst = null;
  if (tag) {
    try { inst = new opening_hours(tag, null, { locale: 'en' }); }
    catch { inst = null; } // exotic / invalid syntax -> treat as unknown
  }
  cache.set(id, inst);
  return inst;
}

// 'open' | 'closed' | 'unknown' at time `at` (defaults to now).
export function openState(feature, at = new Date()) {
  if (!feature.properties.opening_hours) return 'unknown';
  const inst = instanceFor(feature);
  if (!inst) return 'unknown';
  try { return inst.getState(at) ? 'open' : 'closed'; }
  catch { return 'unknown'; }
}

// Human phrase for the next open/close transition, e.g. "Closes Fri 6:00 PM".
export function nextChangeLabel(feature, at = new Date()) {
  const inst = instanceFor(feature);
  if (!inst) return '';
  try {
    const nc = inst.getNextChange(at);
    if (!nc) return '';
    const openNow = inst.getState(at);
    const when = nc.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return (openNow ? 'Closes ' : 'Opens ') + when;
  } catch {
    return '';
  }
}

// Drop cached instances (call when the minute rolls over for a fresh evaluation).
export function resetHoursCache() { cache.clear(); }
