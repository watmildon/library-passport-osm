// storage.js — all persistent state lives in localStorage.
// Visits are keyed per library system so switching systems and back is lossless.

const LS_CONFIG = 'libpass:config';   // { mode, value, systemName }
const LS_DATA   = 'libpass:data';     // GeoJSON FeatureCollection of fetched libraries
const LS_VISITS = 'libpass:visits';   // { [systemKey]: { [featureId]: true } }

// Bump when the shape of a stored feature's properties changes, so returning
// users with stale cached data re-fetch instead of showing wrong tag info.
export const DATA_VERSION = 2;

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { console.warn('localStorage write failed', e); }
}

// A stable key identifying the current system (used to namespace visits).
export function systemKey(config) {
  return config ? `${config.mode}:${config.value}` : 'unknown';
}

export function loadConfig() { return readJSON(LS_CONFIG, null); }
export function saveConfig(cfg) { writeJSON(LS_CONFIG, cfg); }

export function loadData() { return readJSON(LS_DATA, null); }
export function saveData(fc) { writeJSON(LS_DATA, { ...fc, version: DATA_VERSION }); }

// Visits for a given system.
export function loadVisits(config) {
  const all = readJSON(LS_VISITS, {});
  return all[systemKey(config)] || {};
}

export function saveVisits(config, visits) {
  const all = readJSON(LS_VISITS, {});
  all[systemKey(config)] = visits;
  writeJSON(LS_VISITS, all);
}

// Clear the current system's config + cached data (visits are preserved).
export function clearSystem() {
  localStorage.removeItem(LS_CONFIG);
  localStorage.removeItem(LS_DATA);
}
