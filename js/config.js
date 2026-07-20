// config.js — deployment-level settings.

// Overpass endpoints, tried in order until one succeeds.
//
// Users can supply their own instance in the onboarding screen (e.g. a faster or
// self-hosted server). The public mirrors are the fallback so the app works for
// everyone out of the box. A custom endpoint can also be passed via the
// ?overpass=<url> query param, which takes precedence and is persisted.

const PUBLIC_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

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

export function overpassEndpoints() {
  const custom = customOverpass();
  return custom ? [custom, ...PUBLIC_ENDPOINTS] : PUBLIC_ENDPOINTS;
}

// Basemap style (OpenFreeMap positron — free, no API key).
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
