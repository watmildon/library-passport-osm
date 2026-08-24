#!/usr/bin/env node
// data-diff-summary.mjs — summarize what a data rebuild actually changed.
//
// Compares the working-tree data files against the committed (HEAD) versions and
// prints one line per section: how many entries were added, removed, or edited.
// The daily workflow puts this in the commit body, so `git log` answers "did this
// refresh do anything surprising?" without opening a multi-megabyte diff.
//
// It also doubles as the alarm for identity bugs: every section is compared by a
// STABLE key (a system key, an OSM element id, an FSCS key — never an array
// position), so a change that reshuffles records without changing them shows up
// here as zero, while the raw diff would be enormous. A refresh that reports
// thousands of "changed" entries with no real mapping activity behind it means
// something upstream started rewriting identity again.
//
// meta is skipped — its generated/sourceDate fields change on every run by design.
//
// Usage:  node scripts/data-diff-summary.mjs [--ref HEAD]
// Prints nothing (exit 0) when there is no committed version to compare against.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const refArg = process.argv.indexOf('--ref');
const REF = refArg >= 0 ? process.argv[refArg + 1] : 'HEAD';

// Per-file, per-section identity. Every key must be derived from the record's
// own content, never from its position in the array.
const QA_SECTIONS = {
  systems:      s => s.k ?? s.n,
  libs:         r => r[1] + r[2],              // OSM type + id
  collisions:   c => `${c.a} ${c.b}`,
  ambiguous:    a => a.n,
  domains:      d => d.d,
  unnamedPairs: u => u.osm,
  wdOperators:  g => g.pq,
  wdConflicts:  g => `${g.tw} ${g.pq}`,
  pls:          p => p.sysKey,
  plsUnmatched: u => u.fscskey,
  augment:      a => a.sysKey
};

const FILES = [
  { path: 'data/qa-data.json',    label: 'qa-data',    sections: QA_SECTIONS },
  { path: 'data/ca-qa-data.json', label: 'ca-qa-data', sections: QA_SECTIONS },
  {
    path: 'data/ca-library-outlets.json',
    label: 'ca-library-outlets',
    sections: {
      outlets: o => o.id
    }
  },
  {
    path: 'data/us-library-systems.json',
    label: 'us-library-systems',
    sections: {
      systems: s => `${s.mode} ${s.value}`
    }
  },
  {
    path: 'data/ca-library-systems.json',
    label: 'ca-library-systems',
    sections: {
      systems: s => `${s.mode} ${s.value}`
    }
  }
];

// The committed version of a file, or null when it isn't in the ref (new file,
// shallow checkout, not a git repo — all fine, we just have nothing to compare).
function committed(path) {
  try {
    // stderr is piped (not inherited) so a file new to the ref doesn't print
    // git's "exists on disk, but not in HEAD" noise — it's an expected case.
    return JSON.parse(execFileSync('git', ['show', `${REF}:${path}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch {
    return null;
  }
}

function compare(oldArr, newArr, keyOf) {
  const index = arr => {
    const m = new Map();
    for (const x of arr || []) {
      const k = keyOf(x);
      // A missing key (an older file predating the field) or a duplicate one
      // would make the comparison lie — say so rather than report a wrong count.
      if (k == null || m.has(k)) return null;
      m.set(k, JSON.stringify(x));
    }
    return m;
  };
  const a = index(oldArr), b = index(newArr);
  if (!a || !b) return null;

  let added = 0, changed = 0;
  for (const [k, v] of b) {
    if (!a.has(k)) added++;
    else if (a.get(k) !== v) changed++;
  }
  let removed = 0;
  for (const k of a.keys()) if (!b.has(k)) removed++;
  return { added, removed, changed };
}

const lines = [];
for (const file of FILES) {
  const before = committed(file.path);
  if (!before) continue;

  let current;
  try {
    current = JSON.parse(readFileSync(join(ROOT, file.path), 'utf8'));
  } catch {
    continue;
  }

  for (const [section, keyOf] of Object.entries(file.sections)) {
    if (!Array.isArray(current[section])) continue;
    // A section the committed file doesn't have yet is new — count it all as
    // added rather than silently skipping it, so the build that introduces a
    // section says so.
    const d = compare(Array.isArray(before[section]) ? before[section] : [], current[section], keyOf);
    if (!d) { lines.push(`${file.label}/${section}: not comparable (missing or duplicate keys)`); continue; }
    const parts = [
      d.changed && `${d.changed} changed`,
      d.added   && `${d.added} added`,
      d.removed && `${d.removed} removed`
    ].filter(Boolean);
    if (parts.length) lines.push(`${file.label}/${section}: ${parts.join(', ')}`);
  }
}

if (lines.length) console.log(lines.join('\n'));
