// street-expand.mjs — expand US street-name abbreviations to full OpenStreetMap
// style (e.g. "Ave S" -> "Avenue South"). Ported from the Python
// street_name_utils.py in the mascotscanning project, which itself descends from
// the TIGER-ROAR JOSM plugin / OSM-address-parser / josm-validator-rules lineage.
// Pure functions, no I/O.
//
// Conservative by design: only the LEADING directional, the TRAILING street type
// (or second-to-last word when the last is a directional), and a TRAILING
// directional are eligible for expansion. Ambiguous abbreviations are omitted
// from the tables so the source value passes through unchanged rather than being
// guessed wrong.

export const DIRECTIONAL_EXPAND = {
  n: 'North', s: 'South', e: 'East', w: 'West',
  ne: 'Northeast', nw: 'Northwest', se: 'Southeast', sw: 'Southwest'
};

// USPS Pub 28 canonical abbrev -> full word, plus JOSM USStreetNameExpander
// additions. Ambiguous entries (br, byu, dv, vl) are intentionally omitted.
export const STREET_TYPE_EXPAND = {
  aly: 'Alley', anx: 'Annex', arc: 'Arcade', ave: 'Avenue',
  bch: 'Beach', bnd: 'Bend', blf: 'Bluff', blfs: 'Bluffs', btm: 'Bottom',
  blvd: 'Boulevard', brg: 'Bridge', brk: 'Brook', brks: 'Brooks', bg: 'Burg',
  bgs: 'Burgs', byp: 'Bypass', cp: 'Camp', cyn: 'Canyon', cpe: 'Cape',
  cswy: 'Causeway', ctr: 'Center', ctrs: 'Centers', cir: 'Circle', cirs: 'Circles',
  clf: 'Cliff', clfs: 'Cliffs', clb: 'Club', cmn: 'Common', cmns: 'Commons',
  cor: 'Corner', cors: 'Corners', crse: 'Course', ct: 'Court', cts: 'Courts',
  cv: 'Cove', cvs: 'Coves', crk: 'Creek', cres: 'Crescent', crst: 'Crest',
  xing: 'Crossing', xrd: 'Crossroad', xrds: 'Crossroads', curv: 'Curve',
  dl: 'Dale', dm: 'Dam', dr: 'Drive', drs: 'Drives', est: 'Estate',
  ests: 'Estates', expy: 'Expressway', ext: 'Extension', exts: 'Extensions',
  fall: 'Fall', fls: 'Falls', fry: 'Ferry', fld: 'Field', flds: 'Fields',
  flt: 'Flat', flts: 'Flats', frd: 'Ford', frds: 'Fords', frst: 'Forest',
  frg: 'Forge', frgs: 'Forges', frk: 'Fork', frks: 'Forks', ft: 'Fort',
  fwy: 'Freeway', gdn: 'Garden', gdns: 'Gardens', gtwy: 'Gateway', gln: 'Glen',
  glns: 'Glens', grn: 'Green', grns: 'Greens', grv: 'Grove', grvs: 'Groves',
  hbr: 'Harbor', hbrs: 'Harbors', hvn: 'Haven', hts: 'Heights', hwy: 'Highway',
  hl: 'Hill', hls: 'Hills', holw: 'Hollow', inlt: 'Inlet', is: 'Island',
  iss: 'Islands', isle: 'Isle', jct: 'Junction', jcts: 'Junctions', ky: 'Key',
  kys: 'Keys', knl: 'Knoll', knls: 'Knolls', lk: 'Lake', lks: 'Lakes',
  land: 'Land', lndg: 'Landing', ln: 'Lane', lgt: 'Light', lgts: 'Lights',
  lf: 'Loaf', lck: 'Lock', lcks: 'Locks', ldg: 'Lodge', loop: 'Loop',
  mall: 'Mall', mnr: 'Manor', mnrs: 'Manors', mdw: 'Meadow', mdws: 'Meadows',
  mews: 'Mews', ml: 'Mill', mls: 'Mills', msn: 'Mission', mtwy: 'Motorway',
  mt: 'Mount', mtn: 'Mountain', mtns: 'Mountains', nck: 'Neck', orch: 'Orchard',
  oval: 'Oval', opas: 'Overpass', park: 'Park', pkwy: 'Parkway', pass: 'Pass',
  psge: 'Passage', path: 'Path', pike: 'Pike', pne: 'Pine', pnes: 'Pines',
  pl: 'Place', pln: 'Plain', plns: 'Plains', plz: 'Plaza', pt: 'Point',
  pts: 'Points', prt: 'Port', prts: 'Ports', pr: 'Prairie', radl: 'Radial',
  rnch: 'Ranch', rpd: 'Rapid', rpds: 'Rapids', rst: 'Rest', rdg: 'Ridge',
  rdgs: 'Ridges', riv: 'River', rd: 'Road', rds: 'Roads', rte: 'Route',
  row: 'Row', rue: 'Rue', run: 'Run', shl: 'Shoal', shls: 'Shoals',
  shr: 'Shore', shrs: 'Shores', skwy: 'Skyway', spg: 'Spring', spgs: 'Springs',
  spur: 'Spur', sq: 'Square', sqs: 'Squares', sta: 'Station', stra: 'Stravenue',
  strm: 'Stream', st: 'Street', sts: 'Streets', smt: 'Summit', ter: 'Terrace',
  trwy: 'Throughway', tpke: 'Turnpike', trak: 'Track', trce: 'Trace',
  trfy: 'Trafficway', trl: 'Trail', tunl: 'Tunnel', un: 'Union', uns: 'Unions',
  upas: 'Underpass', vly: 'Valley', vlys: 'Valleys', via: 'Viaduct', vw: 'View',
  vws: 'Views', vlg: 'Village', vlgs: 'Villages', vis: 'Vista', walk: 'Walk',
  wall: 'Wall', way: 'Way', wl: 'Well', wls: 'Wells',
  // JOSM USStreetNameExpander additions (github.com/watmildon/josm-validator-rules)
  acc: 'Access', ambl: 'Amble', app: 'Approach', artl: 'Arterial', arty: 'Artery',
  av: 'Avenue', blk: 'Block', blv: 'Boulevard', bwlk: 'Boardwalk', bypa: 'Bypass',
  bywy: 'Byway', bzr: 'Bazaar', cct: 'Circuit', ch: 'Chase', cly: 'Colony',
  cnl: 'Canal', cnr: 'Corner', coll: 'College', cr: 'Creek', ctyd: 'Courtyard',
  cutt: 'Cutting', dvwy: 'Driveway', elb: 'Elbow', expwy: 'Expressway',
  fawy: 'Fairway', fmrd: 'Farm to Market Road', ftrl: 'Firetrail', gd: 'Grade',
  gr: 'Grove', gro: 'Grove', hw: 'Highway', intg: 'Interchange', jn: 'Junction',
  jnc: 'Junction', lkt: 'Lookout', lp: 'Loop', mal: 'Mall', mkt: 'Market',
  ovps: 'Overpass', piaz: 'Piazza', pk: 'Peak', pky: 'Parkway', pnt: 'Point',
  prkwy: 'Parkway', pvt: 'Private', qdrt: 'Quadrant', qtrs: 'Quarters', qy: 'Quay',
  qys: 'Quays', rdge: 'Ridge', rmrd: 'Ranch to Market Road', rt: 'Route',
  rty: 'Rotary', rw: 'Row', srvc: 'Service', tce: 'Terrace', tfwy: 'Trafficway',
  thfr: 'Thoroughfare', thwy: 'Throughway', tl: 'Trail', tlwy: 'Tollway',
  tr: 'Trail', trk: 'Track', unp: 'Underpass', wd: 'Wood', whrf: 'Wharf',
  wkwy: 'Walkway', wlk: 'Walk', wy: 'Way',
  // Common non-USPS variants seen in the wild.
  trail: 'Trail', crt: 'Court', pkway: 'Parkway'
};

export const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
  eleventh: '11th', twelfth: '12th', thirteenth: '13th', fourteenth: '14th',
  fifteenth: '15th', sixteenth: '16th', seventeenth: '17th', eighteenth: '18th',
  nineteenth: '19th', twentieth: '20th'
};

const SAINT_NAMES = new Set([
  'andrew', 'andrews', 'anne', 'ann', 'anthony', 'augustine', 'bernard',
  'catherine', 'catherines', 'charles', 'christopher', 'claire', 'clare',
  'clair', 'cloud', 'david', 'edward', 'edwards', 'elmo', 'francis',
  'george', 'helena', 'helens', 'james', 'john', 'johns', 'joseph',
  'lawrence', 'louis', 'luke', 'margaret', 'mark', 'marks', 'martin',
  'mary', 'marys', 'michael', 'nicholas', 'olaf', 'patrick', 'paul',
  'peter', 'rose', 'simon', 'stephen', 'thomas', 'vincent'
]);

// Lowercase prepositions / articles used as interior words in proper names.
const LOWERCASE_ARTICLES = new Set([
  'del', 'de', 'di', 'du', 'la', 'las', 'los', 'el',
  'of', 'on', 'for', 'a', 'an', 'the', 'at', 'to', 'in', 'via', 'by',
  'or', 'and', 'but'
]);

const DIRECTIONAL_FULL = new Set(Object.values(DIRECTIONAL_EXPAND).map(v => v.toLowerCase()));
// Street-type words in either form (abbrev key or expanded value), for the
// "E Street" guard — "Street" itself is a type word even though it isn't a key.
const STREET_TYPE_ANY = new Set([
  ...Object.keys(STREET_TYPE_EXPAND),
  ...Object.values(STREET_TYPE_EXPAND).map(v => v.toLowerCase())
]);
const SAINT_RE = /^St\.?\s+(\S+)/i;
const COUNTY_ROAD_RE = /^CR(?=\s+\d)/i;
const FS_ROAD_RE = /^Fs Road\b/i;
const stripDot = w => w.toLowerCase().replace(/\.$/, '');

// Expand abbreviations in a US street name. Input should already be reasonably
// cased (e.g. title-cased); expansion overwrites the affected words.
export function expand(name) {
  if (!name) return name;
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length) return name;

  // Directional prefix — tolerate a trailing period ("W.").
  if (words.length > 1) {
    const first = stripDot(words[0]);
    if (DIRECTIONAL_EXPAND[first]) {
      // Don't expand a lone "E" when the street is literally "E Street".
      const isEStreet = first === 'e' && words.length === 2 && STREET_TYPE_ANY.has(stripDot(words[1]));
      if (!isEStreet) words[0] = DIRECTIONAL_EXPAND[first];
    }
  }

  // Directional suffix.
  if (words.length > 1) {
    const last = stripDot(words[words.length - 1]);
    if (DIRECTIONAL_EXPAND[last]) words[words.length - 1] = DIRECTIONAL_EXPAND[last];
  }

  // Street type: last word, or second-to-last if the last is a directional.
  let typeIndex = words.length - 1;
  if (words.length > 2) {
    const lastLower = words[typeIndex].toLowerCase();
    if (DIRECTIONAL_EXPAND[lastLower] || DIRECTIONAL_FULL.has(lastLower)) typeIndex = words.length - 2;
  }
  const typeLower = stripDot(words[typeIndex]);
  if (STREET_TYPE_EXPAND[typeLower]) words[typeIndex] = STREET_TYPE_EXPAND[typeLower];

  // Word ordinals ("First" -> "1st").
  for (let i = 0; i < words.length; i++) {
    const wl = words[i].toLowerCase();
    if (ORDINAL_WORDS[wl]) words[i] = ORDINAL_WORDS[wl];
  }

  // Lowercase interior articles ("Casa Del Mar" -> "Casa del Mar"), never the first.
  for (let i = 1; i < words.length; i++) {
    if (LOWERCASE_ARTICLES.has(words[i].toLowerCase())) words[i] = words[i].toLowerCase();
  }

  let result = words.join(' ');

  // Saint expansion at the START of the name.
  const m = result.match(SAINT_RE);
  if (m && SAINT_NAMES.has(m[1].toLowerCase())) result = 'Saint ' + m[1] + result.slice(m[0].length);

  result = result.replace(COUNTY_ROAD_RE, 'County Road');
  result = result.replace(FS_ROAD_RE, 'Forest Service Road');
  return result;
}
