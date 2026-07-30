# Build scripts

`build-systems.mjs` and `build-qa.mjs` query OpenStreetMap US's
[Layercake](https://openstreetmap.us/our-work/layercake/) GeoParquet extracts
remotely with DuckDB (only the needed columns/row-groups are read — the 4 GB POI
file is never fully downloaded) and are run weekly by the
[`update-systems`](../.github/workflows/update-systems.yml) GitHub Action.

## Freshness — every writer records `meta.sourceDate`

Each data writer stamps the snapshot date of the source it built from into
`meta.sourceDate` (YYYY-MM-DD) — Layercake's POI `Last-Modified` for the two
`build-*` scripts, Overpass's `timestamp_osm_base` for `refresh-systems.mjs`.
The generic `meta.source` names *which* source; `sourceDate` makes freshness
comparable across sources.

Before writing, a writer **compares its source date against the committed
`sourceDate` and only writes if it is contributing newer data** (pass `--force`
to override). This means the weekly Layercake job will *not* clobber a fresher
out-of-band refresh — e.g. after a manual Overpass run (dated later than the last
Layercake snapshot), the Monday Layercake build sees the committed data is newer
and skips. The [`update-systems`](../.github/workflows/update-systems.yml)
workflow applies the same gate up front (`force: true` input overrides) to also
skip the DuckDB install when nothing newer is available.

`refresh-systems.mjs` is an on-demand alternative for the systems list that pulls
from a dev Overpass instance instead — see below.

## `refresh-systems.mjs` — on-demand fresh systems list (dev Overpass)

Layercake lags OSM by up to a couple of weeks. After a batch of operator cleanup,
this regenerates `../data/us-library-systems.json` from live OSM via a private
Overpass instance, sharing all aggregation/labelling/output with `build-systems.mjs`
(via `systems-core.mjs`) so the file shape is identical.

```sh
npm run refresh:systems           # gated on data freshness
node scripts/refresh-systems.mjs --force   # ignore the gate
```

- **Endpoint** comes from the `OVERPASS_URL` env var, or a `.overpass-url` file in
  the repo root. That file is **gitignored** so a private instance URL never lands
  in git.
- **Freshness gate**: the committed file records the snapshot date it was built
  from; the script asks Overpass for its data timestamp (`osm3s.timestamp_osm_base`)
  and only regenerates when Overpass is newer. This keeps an on-demand run from
  clobbering a fresher weekly Layercake commit or churning the file for nothing.
  `--force` overrides it.
- US-scoped with `area(3600148838)` (the same US boundary relation Layercake uses),
  so counts stay consistent with the weekly build.

## `build-pls.mjs` — IMLS PLS outlet data

Regenerates [`../data/pls-outlets.json`](../data/pls-outlets.json) from the
**IMLS Public Libraries Survey** (PLS) — a federal census of US public libraries
(public domain, ~16,900 central + branch outlets, each with an IMLS-geocoded
lat/lon). `build-qa.mjs` cross-references this against OSM to find missing and
untagged branches.

```sh
node scripts/build-pls.mjs [--force]
```

Downloads the FY CSV zip, transcodes the Windows-1252 CSVs to UTF-8 (they contain
bytes that break UTF-8 readers), and runs [`pls-outlets.sql`](./pls-outlets.sql)
via DuckDB. PLS is published **annually with a ~2-year lag** (FY2023 released
Aug 2025); the build is gated on the fiscal year, so a rerun on the same release
is a no-op. When a new FY is published, bump `PLS_FY` and `PLS_ZIP_URL` in
`build-pls.mjs`.

## `build-qa.mjs` — Data QA dataset

Regenerates [`../data/qa-data.json`](../data/qa-data.json), the dataset behind
[`qa.html`](../qa.html) (the Data QA page).

```sh
node scripts/build-qa.mjs
```

Runs [`qa-libraries.sql`](./qa-libraries.sql), which emits one row per US
library (US-scoped by `ST_Contains` against boundary relation 148838, state
assigned by point-in-polygon against `admin_level=4` boundaries) plus a list of
likely-typo operator-name pairs (Levenshtein ≤ 2, length-scaled, computed in
DuckDB). The Node script normalizes this into one compact file:

- `meta` — generated date, Layercake freshness, totals
- `tags` — the tag behind each bit of a library's `flags` bitmask
  (phone, website, opening_hours, operator, operator:wikidata — only the tags
  the app itself uses)
- `states` / `systems` — lookup arrays referenced by index from `libs`
- `libs` — `[systemIdx, type, id, name, stateIdx, flags, lon, lat]` per library
- `collisions` — the likely-typo pairs
- `ambiguous` — operator names whose libraries form 2+ geographic clusters more
  than ~120 km apart (single-linkage): likely *distinct systems sharing a name*,
  the highest-value `operator:wikidata` targets. Per cluster: states, branch
  count, wikidata status, and a padded bbox for region-scoped Overpass queries.
- `domains` — website domains shared by 2+ libraries where at least one lacks an
  `operator` tag. A shared domain is a strong operator fingerprint, so these are
  ready-made work sets; when tagged siblings share the domain, their operator /
  wikidata values are emitted as suggestions for the untagged rest. Generic
  hosting platforms and >2-state spreads (vendor/aggregator domains) are excluded.
- `pls` — per-system IMLS PLS cross-reference (see below): `{ sysIdx, fscskey,
  plsCount, osmCount, matched, untagged[], missing[], discrepancies[] }`.
- `augment` — per-system, ready-to-apply PLS tag **suggestions** for the JOSM-first
  [augmentation page](../augment.html) (see below): `{ sysIdx, fscskey, state, qid,
  qidConfirmed, branches[] }`, each branch `{ kind:'existing'|'new', osm, lat, lon,
  plsName, tags }` where `tags` are additive-only OSM tags.

**IMLS PLS matching** ([`pls-match.mjs`](./pls-match.mjs)). Each OSM system with
≥3 libraries is crosswalked to a PLS system: name similarity proposes candidates,
and a **spatial check confirms** (a PLS system whose outlets sit near the OSM
libraries is the match — this disambiguates e.g. "New York Public Library" from
"New York Mills Public Library"). Each matched PLS outlet is then classified:
_matched_ (in OSM), _untagged_ (an OSM library exists nearby but without this
operator — add the tag), _missing_ (no OSM library there — likely create one), or
_discrepancy_ (name-matched but far from the OSM coordinate — verify location).
Requires `data/pls-outlets.json`; if absent, PLS matching is skipped.

**Wikidata branch counts.** Systems whose Wikidata item enumerates its branches
(`P527` parts typed as library branch) get that count attached as `wb` (one
WDQS query; fails soft). The QA page compares it against the OSM branch count —
a completeness hint in both directions. When several of our systems share a
Q-id (typo variants), only the principal (largest) one gets the count.

**`not:` assertions.** OSM's `not:operator:wikidata` / `not:operator` tags record
verified negatives ("definitely not that item"). Layercake doesn't extract them,
so the build fetches them with one small Overpass query (set `OVERPASS_URL` to
use a custom instance; fails soft if Overpass is unreachable). Ruled-out values
never count as real tags, veto matching suggestions, and are exposed per system
as `nw` — the QA page shows them as struck-through badges, with a conflict
warning when a system's dominant wikidata tag is itself ruled out by a mapper.

**Limitation:** Layercake's POI layer has no `addr:*` columns, so address
completion isn't in the weekly stats. The QA page's "Load live details" action
fills that gap per-system via Overpass (full tag set, incl. addresses).

**IMLS PLS augmentation** ([`pls-augment.mjs`](./pls-augment.mjs)). For each
crosswalked system, the build compares matched PLS outlets against their EXISTING
OSM libraries and emits `augment[]` for the JOSM-first
[augmentation page](../augment.html). It is scoped to improving objects that
already exist — **creating missing branches is the QA page's job** (the "Missing
branches" section). Each PLS value is sorted into (deliberately conservative — PLS
lags ~2 years and this is a mapper assist, never an automated overwrite):

- **`tags`** — an additive fill: OSM *lacks* this key, so it's safe to apply.
- **`conflicts`** — OSM *has a different value*: `[{ key, osm, pls }]`, surfaced for
  the mapper to reconcile by hand and **never auto-sent**.
- A PLS value equal to OSM's (after light normalization — phones compare on digits)
  is neither.

Fields considered: `phone` (formatted `+1 XXX-XXX-XXXX`, PLS sentinels `-3`/`-4`
dropped; conflicts flagged), `addr:housenumber`/`addr:street`/`addr:unit`/
`addr:city`/`addr:postcode` (conflicts flagged), `operator:wikidata` (the system's
Q-id, withheld when only a domain-derived *suggestion*), and `name` (**fill-only** —
a differing OSM name is a curated, differently-styled string like
"Seattle Public Library - X Branch" vs PLS "X Branch Library", so it's never flagged
as a conflict). No `website` — PLS doesn't collect it.

- **Conservative address split** — PLS ships one `ADDRESS` field; it's split into
  house number + street (+ `addr:unit` when a suite/`#` designator trails) only
  when unambiguous (clean leading number, ordinal streets like "12TH AVENUE" left
  alone, PO boxes skipped), and only when the PLS geocode is precise (`GEOSTATUS=E`
  and a `POINTADDRESS`/`SUBADDRESS`/`STREETADDRESS` `GEOMTYPE`). Street names are
  **expanded to OpenStreetMap style** (`MAIN ST.` → `Main Street`, `AVE S` →
  `Avenue South`) via [`street-expand.mjs`](./street-expand.mjs) — a JS port of the
  `street_name_utils.py` expander (TIGER-ROAR / OSM-address-parser / josm-validator-rules
  lineage), conservative about ambiguous abbreviations.
- **Live tags** — because Layercake omits `addr:*`, the augment builder does **one
  bounded Overpass request per crosswalked system** (not per library) to read
  current tags, with a polite delay and a hard cap (`AUGMENT_MAX_SYSTEMS`, default
  400; `AUGMENT_SLEEP_MS`, default 1100). Any Overpass failure **skips that one
  system** rather than failing the build — augmentation is additive to the QA data,
  never a gate on it. (Pure suggestion logic is unit-tested: `npm run test:augment`.)

### `augment-state.mjs` — per-region test data (dev Overpass)

For testing/previewing [`augment.html`](../augment.html) without a full DuckDB
build, this regenerates the `augment[]` section of `data/qa-data.json` for **one
or more states**, deriving each state's systems from the committed `libs`/`systems`
(no DuckDB) and reading current tags from a dev Overpass instance (resolved like
`refresh-systems.mjs`: `OVERPASS_URL` env, else a gitignored `.overpass-url` file).
It reuses the exact production suggestion logic, so the emitted shape matches the
weekly build.

```sh
node scripts/augment-state.mjs WA           # one state
node scripts/augment-state.mjs WA OR CA     # several (region rollout)
node scripts/augment-state.mjs --all        # every state (long-running)
node scripts/augment-state.mjs WA --replace # drop existing augment[] first
```

It **accumulates**: systems for the requested states are merged into whatever's
already in `augment[]` (keyed by `sysIdx`, so re-running a state refreshes just its
systems and untouched states are preserved). `--replace` starts from an empty
`augment[]`. Everything outside `augment[]` is preserved, and `meta.plsFiscalYear`
is stamped. Intended for generating preview / bug-fixing data; re-run `build:qa`
to regenerate the real national dataset.

## `build-systems.mjs` — US library-systems list

Regenerates [`../data/us-library-systems.json`](../data/us-library-systems.json),
the curated list powering the onboarding autocomplete.

```sh
node scripts/build-systems.mjs
```

Requires the [DuckDB CLI](https://duckdb.org/docs/installation/) on `PATH` (or set
the `DUCKDB` env var to its location) and Node 18+. Run from the repo root.

### Automated weekly refresh

The [`update-systems`](../.github/workflows/update-systems.yml) GitHub Action runs
this script every Monday (and on-demand via the Actions tab), committing the result
back to the repo so the picker keeps pace with mappers' additions and cleanups.

Two guards keep a bad upstream response from landing:

- **Absolute floor** — rejects a result with fewer than 1,000 systems.
- **±20% band** — rejects a week-over-week change greater than 20% in either
  direction (almost always an upstream glitch, not real mapping activity).

When a guard trips, the job fails without committing. If the change is genuine,
re-run the workflow manually to accept it.

### What it does

1. Queries OpenStreetMap US's [Layercake](https://openstreetmap.us/our-work/layercake/)
   POI extract — a cloud-native GeoParquet file at `data.openstreetmap.us` — with
   DuckDB, directly over HTTP. Only the needed columns/row-groups are read, so the
   4 GB file is never fully downloaded. The query ([`us-library-operators.sql`](./us-library-operators.sql))
   selects every `operator=` and `operator:wikidata=` value on `amenity=library`
   **within the United States**, scoped by a precise point-in-polygon test
   (`ST_Contains`) against US boundary relation
   [148838](https://www.openstreetmap.org/relation/148838), which is pulled from
   Layercake's own boundaries layer.
2. Enriches Wikidata-only operators (those with no co-located `operator=` name
   tag) with English labels from the [Wikidata Query Service](https://query.wikidata.org/).
3. Merges into a single ranked list: Wikidata-backed systems first (the more
   robust selector, stable across name spelling variations), then operator-name
   systems that have no Wikidata counterpart. Sorted by library count.

Each entry is `{ name, mode: 'operator' | 'wikidata', value, count }`. The app's
picker searches `name`; `mode` + `value` become the Overpass selector on load.

### Notes

- **Why Layercake, not QLever?** An earlier version queried QLever's `osm-planet`
  SPARQL endpoint, but QLever returns HTTP 403 to GitHub Actions runner IPs, which
  broke the scheduled job. Layercake is served as plain files over HTTP with no
  such block, and its data is typically fresher.
- A cheap bounding-box prefilter narrows candidates before the polygon test. A
  bbox alone is **not** sufficient — e.g. Toronto falls inside the CONUS bounding
  box — which is why the precise `ST_Contains` test is applied.
- A handful of `operator:wikidata` values point at cities or agencies rather than
  library systems (e.g. a county government). That reflects the raw OSM data; the
  list surfaces whatever is tagged.
- To refresh, just re-run — the `meta.generated` date updates automatically.
- To target a different country, change the boundary relation id in the SQL and
  the longitude/latitude prefilter ranges to match.
