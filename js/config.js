// config.js — deployment-level settings.

// The Overpass endpoint every page talks to.
//
// ONE endpoint, not a fallback chain. Chaining looks resilient but behaves
// badly: a busy public mirror doesn't refuse a request, it queues it and holds
// the connection open, so the "fallback" only starts after the first has hung
// for its whole timeout. One endpoint plus a real timeout fails fast and tells
// the user something actionable — and anyone who cares about throughput should
// point the app at their own instance anyway.
//
// Users set theirs in the app's onboarding screen or the Overpass field in the
// QA/Augment headers; ?overpass=<url> also works and is persisted.

export const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// How long any single Overpass request may take before we give up on it.
export const OVERPASS_TIMEOUT_MS = 35000;

const LS_OVERPASS = 'libpass:overpass-custom';

// The user-supplied Overpass endpoint, if any. A ?overpass= query param wins and
// is saved; otherwise the previously saved value is used.
export function customOverpass() {
  try {
    const fromQuery = new URL(location.href).searchParams.get('overpass');
    if (fromQuery) {
      localStorage.setItem(LS_OVERPASS, fromQuery);
      return fromQuery;
    }
    return localStorage.getItem(LS_OVERPASS) || '';
  } catch {
    return '';
  }
}

// Persist (or clear) a user-supplied Overpass endpoint.
export function setCustomOverpass(url) {
  try {
    const v = (url || '').trim();
    if (v) localStorage.setItem(LS_OVERPASS, v);
    else localStorage.removeItem(LS_OVERPASS);
  } catch { /* storage unavailable — ignore */ }
}

// The endpoint to use: the user's, else the public default.
export function overpassEndpoint() {
  return customOverpass() || DEFAULT_ENDPOINT;
}

// Basemap style (OpenFreeMap positron — free, no API key).
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
