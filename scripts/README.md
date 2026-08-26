# Build scripts

The pipeline's **primary data source is an Overpass instance** with minutely
OSM replication: `refresh-systems.mjs` (systems list) and `build-qa.mjs` (QA
dataset) query it directly and are run **daily** by the
[`update-systems`](../.github/workflows/update-systems.yml) GitHub Action.
The Layercake/DuckDB path (`build-systems.mjs`, `build-qa.mjs --layercake`)
remains as a manual fallback should the instance go away.

## Overpass endpoint — private, never logged

`overpass-source.mjs` resolves the endpoint for every script, in order:

1. the `OVERPASS_URL` env var — in CI, populated from the
   **`OVERPASS_PRIMARY_URL` repository secret**
2. a `.overpass-url` file in the repo root — **gitignored** so the URL never
   lands in git

The URL is a secret. No script prints it *or its host* — GitHub Actions only
masks the exact secret string in logs, so even the hostname would leak.
`meta.source` in the data files stays deliberately generic ("Overpass, …").

## Failover tiers and degraded mode

When the primary instance is down, the pipeline falls back along a chain of
endpoint **tiers** rather than failing for the duration of the outage:

| tier | endpoint | capability |
| --- | --- | --- |
| `primary` | `OVERPASS_URL` env (CI: the `OVERPASS_PRIMARY_URL` secret) / gitignored `.overpass-url` | no limits — the full pipeline |
| `secondary` | `OVERPASS_SECONDARY_URL` env (CI: secret) / gitignored `.overpass-secondary-url` | hosted free tier with a tight quota — degraded |
| `public` | overpass-api.de, kumi.systems | last resort — degraded |

The secondary URL may embed an API key, so it is handled exactly like the
primary: never printed, never committed, redacted from every error message
(`redact()` strips *all* configured secret endpoints from every message,
whichever tier it came from).

**How a tier is chosen.** `freshness-gate.mjs` probes the chain once per run
(`resolveOverpass()` in `overpass-source.mjs`) and pins the first tier that
answers with a usable data timestamp by writing `OVERPASS_TIER` to
`$GITHUB_ENV`. Every later step honors the pin instead of re-probing a dead
host; each tier that failed is reported as a `::warning::` with the usual
failure diagnosis. The refresh is only a hard failure when **no** tier
answers. The workflow's `tier` input (workflow_dispatch) pins the chain to one
tier for testing — "does the secondary work?" — without the chain hiding the
answer.

**What degraded mode does.** Any tier but `primary` sets degraded mode
(`degradedMode()`), and `build-qa.mjs` then rebuilds only the basics:

- The **augment stage is skipped** — it is one Overpass query per crosswalked
  system (hundreds of queries), by far the biggest consumer of the run.
- The **unnamed-twin search is skipped** — the pairing itself is local, but the
  building-outline fetch is not, and rebuilding without it would strip the
  verified-containment marks and churn the diff.
- Both sections are **carried forward** from the committed file, so the QA and
  augment pages keep working on last-full-refresh data, and `meta.degraded:
  true` records how the file was built.
- The small fail-soft queries (not:-assertions, lifecycle closures) go to the
  **public servers first**, preserving the fallback tier's quota for the big
  country-wide queries the public servers can't be trusted with.
- The **big queries get failover of their own** (`overpassQueryResilient`): in
  degraded mode the remaining public servers are tried after the active
  endpoint, and a wholly failed round is retried once after a one-minute
  cool-down — the public servers answer 429 while their per-IP slots are busy,
  and often aren't a minute later.

The systems lists (`refresh-systems.mjs`) are already "the basics" — one query
per country — so they build identically on every tier.

A degraded daily run costs roughly 11 requests against the fallback tier
(freshness probe, plus per-country timestamp + libraries for the systems
lists, and timestamp + libraries + state assignment for the QA builds), which
fits a 500-requests/month free tier with headroom — thanks to the freshness
gate, a day with no OSM changes costs just the probe. The unit tests for the
tier plumbing live in `overpass-source.test.mjs` (`npm run test:overpass`).

Planned but not yet wired: a tertiary tier on the OSM Postpass instance —
Postpass speaks SQL rather than Overpass QL, so it needs its own query
implementations, not just another URL in the chain.

## Freshness — every writer records `meta.sourceDate`

Each data writer stamps the snapshot date of the source it built from into
`meta.sourceDate` (YYYY-MM-DD) plus the full timestamp as `meta.sourceModified`
— Overpass's `osm3s.timestamp_osm_base` on the primary path, Layercake's POI
`Last-Modified` on the fallback. The generic `meta.source` names *which*
source; `sourceDate` makes freshness comparable across sources.

Before writing, a writer **compares its source date against the committed
`sourceDate` and only writes if it is contributing newer data** (pass `--force`
to override), so a rerun or an out-of-order job never clobbers fresher data.

### `freshness-gate.mjs` — the same gate, up front

`freshness-gate.mjs` applies that comparison once for the whole pipeline, so a
day with nothing to do costs one cheap `out count;` query instead of a full
rebuild. It asks the instance for its data timestamp and compares it against
the committed `sourceDate` of every country's `systemsFile` and `qaFile` (the
list comes from `js/countries.js` — a new country extends the gate for free).
Outlet censuses are deliberately excluded: they follow their own annual /
provincial release cadence and their build scripts self-gate on it.

```sh
node scripts/freshness-gate.mjs           # report + decision
node scripts/freshness-gate.mjs --force   # decide "run" regardless
```

```
Overpass snapshot: 2026-08-25T09:50:12Z (data date 2026-08-25)
Committed sourceDate:
  US systems  2026-08-24  stale    data/us-library-systems.json
  US QA       2026-08-25  current  data/qa-data.json
Rebuild needed: 1 of 4 files are older than the snapshot (US systems).
```

The [`update-systems`](../.github/workflows/update-systems.yml) workflow runs
it as its first step and keys every later step off its `run` output (the
`force: true` input passes `--force`). Under Actions it also writes the
`run`/`sourceDate` step outputs, a data-source note to the job summary, and
`::error::` annotations; run locally it just prints the report, which makes it
the quickest way to ask "is my instance healthy and is my checkout stale?".

**An unreachable instance falls back down the tier chain** (see "Failover
tiers" above); the refresh is a hard failure (exit 1) only when no tier
answers — better a red X than a silent skip that reads as "no changes today"
for a week. Every tier that failed says which way it failed; see below.

## Diagnosing an Overpass failure

Every query goes through `overpassQuery`, which classifies failures rather than
reporting "it didn't work" — a dead backend, a dead host, a rate limit and a
hung query need completely different fixes:

| What you see | What it means |
| --- | --- |
| `HTTP 502/503 … the proxy is up but the Overpass backend is not answering` | The instance's web server is fine; the Overpass service behind it needs a restart. |
| `could not connect (ECONNREFUSED)` | Nothing is listening — the instance is down, not just its backend. |
| `could not connect (ENOTFOUND)` | The host no longer resolves. |
| `HTTP 429 … rate limited` | Too many queries in flight. |
| `HTTP 504 … the query outlived the proxy` | Server-side timeout tuning, not an outage. |
| `no response within the Ns client limit` | The query was accepted and never answered — raise `maxSeconds`, or the instance is wedged. |
| `the body is not JSON` | Something other than an Overpass interpreter answered. |

Each message carries **how long the call took** before failing, which is often
the tell: a 0.2 s failure is an instant rejection, a 300 s one is a query that
was genuinely attempted. Every message is run through a redactor first, so a
proxy error page that names its upstream still can't leak the endpoint.

## `refresh-systems.mjs` — systems lists (Overpass, primary)

Regenerates a country's systems file — `../data/us-library-systems.json` by
default, `../data/ca-library-systems.json` with `--country=CA` — from live OSM,
sharing all aggregation/labelling/output with `build-systems.mjs` (via
`systems-core.mjs`) so the file shape is identical regardless of path.

```sh
npm run refresh:systems           # gated on data freshness (US)
node scripts/refresh-systems.mjs --force        # ignore the gate
node scripts/refresh-systems.mjs --country=CA   # Canada
```

- Country-scoped with `area(<boundary relation + 3600000000>)`; per-country
  boundary relations, file paths, and sanity floors live in
  [`../js/countries.js`](../js/countries.js) (US: relation 148838, matching
  Layercake, so counts stay consistent across source paths; CA: relation
  1428125).
- Refuses to write when fewer libraries come back than the country's
  `minLibraries` floor (US 10,000, CA 1,000) — a gutted response, not a real
  shrink.
- Wikidata label enrichment prefers English labels and falls back to French
  (many Quebec systems only have a French label).

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

## `build-ca-outlets.mjs` — Canadian outlet data

Regenerates `../data/ca-library-outlets.json`, the Canadian counterpart of
`pls-outlets.json` (Canada has no federal IMLS-PLS equivalent; library data is
provincial). Assembled per province from open data; only provinces with
authoritative per-branch coordinates are included:

- **BC** — the BC Geographic Warehouse's Geographic Sites Registry layer of
  public-library service points (`GSR_PUBLIC_LIBRARY_LOCS_SV`, ~250 points,
  continuously maintained), fetched as GeoJSON over WFS. Licence: Open
  Government Licence – British Columbia.
- **ON** — the single-location systems from the Annual Survey of Public
  Libraries (system-level rows carry a street address but no coordinates, so
  systems reporting exactly one service point are ingested with their address
  geocoded; multi-branch systems wait for a branch-level source). Licence:
  Open Government Licence – Ontario.
- **QC/AB/NS** — blocked on data: Quebec's survey has no addresses, Alberta
  publishes a PDF directory, Nova Scotia retired its branches dataset.

**Geocoding** is one-time via OpenCage into the committed cache
`../data/ca-geocode-cache.json` — reruns (including CI, which has no key) make
no API calls. The key is a secret: `OPENCAGE_KEY` env var or the gitignored
`.opencage-key` file, never printed or committed. Only point-precision results
(a building or a matched POI; road-level as a fallback) become outlets — an
area centroid would fabricate false "missing branch" findings.

```sh
npm run build:outlets:ca
node scripts/build-ca-outlets.mjs --force   # ignore the freshness gate
```

The output shape mirrors `pls-outlets.json` so `pls-match.mjs`/`build-qa.mjs`
consume it unchanged. `fscskey` holds a stable synthetic system key
(`BC-<system-slug>`), not a US FSCS id — the matcher only uses it as an opaque
grouping key. `geo`/`geomtype` are `'E'`/`'POINTADDRESS'` for registry points,
which `isPreciseGeocode()` accepts, enabling addr suggestions.

## `build-qa.mjs` — Data QA dataset

Regenerates a country's QA dataset — [`../data/qa-data.json`](../data/qa-data.json)
by default, `../data/ca-qa-data.json` with `--country=CA` — the data behind
[`qa.html`](../qa.html) (the Data QA page, `?country=CA` for the Canadian view).

```sh
node scripts/build-qa.mjs               # Overpass (primary) when an endpoint is configured
node scripts/build-qa.mjs --country=CA  # Canada (Overpass only)
node scripts/build-qa.mjs --layercake   # force the Layercake/DuckDB fallback (US only)
```

The outlet-census stages (PLS matching + augment) run against the country's
`outletsFile` from [`../js/countries.js`](../js/countries.js): the IMLS PLS
census for the US, the provincially-assembled `ca-library-outlets.json` for
Canada (BC only so far — Canadian findings cover just the provinces ingested).
A country with `outletsFile: null` skips those stages; the `pls`,
`plsUnmatched`, and `augment` sections come out empty and the QA page hides
those panes.

**Primary path (Overpass):** two queries — every US library with full tags
(`out center tags`, ~19k elements) and a per-state assignment (one `foreach`
over the 56 `admin_level=4` areas carrying a `US-*` ISO3166-2 code). The
likely-typo operator pairs (Levenshtein ≤ 2, length-scaled) are computed in JS
with the same rules the SQL used. Because Overpass carries `addr:*` (absent
from Layercake's POI layer), this path also tracks four address flags.

**Fallback path (`--layercake`, or no endpoint configured):** runs
[`qa-libraries.sql`](./qa-libraries.sql) via the DuckDB CLI — one row per US
library (US-scoped by `ST_Contains` against boundary relation 148838, state by
point-in-polygon against `admin_level=4` boundaries) plus the collision pairs.
No addr flags; `meta.tags` records which flags a build actually tracked, and
the QA page derives its columns from that.

Either way the Node script normalizes the rows into one compact file:

- `meta` — generated date, source + snapshot date, totals
- `tags` — the tag behind each bit of a library's `flags` bitmask
  (phone, website, opening_hours, operator, operator:wikidata, and on the
  Overpass path addr:housenumber, addr:street, addr:city, addr:postcode)
- `states` — lookup array referenced by index from `libs`
- `systems` — `{ n: name, k?: key, w: wikidata|null, c: count }`, sorted by key.
  The key is the operator name, or `wd:Q…` for a system known only by its
  `operator:wikidata` tag; `k` is emitted only where it differs from `n`.
  Systems with no `w` may also carry a suggestion: `sw` (the proposed Q-id), `sn`
  (its English label) and `ss` (which sources proposed it — see below), plus `nw`
  for items ruled out with `not:operator:wikidata`.
- `libs` — `[systemKey, type, id, name, stateIdx, flags, lon, lat]` per library
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
- `unnamedPairs` – unnamed libraries (no `name` tag) with a named library within
  150 m: the building/POI duplicate-mapping pattern, an `amenity=library`
  building with no name holding the named node (or the reverse). The fix is to
  keep one element as appropriate and remove the duplicate, never to copy tags
  onto both. Rows are
  `{ osm, st, lon, lat, match: { osm, n, op?, lon, lat, dist, in? }, others? }`
  ([`unnamed-pairs.mjs`](./unnamed-pairs.mjs), tested by `npm run test:unnamed`).
  `in: 1` means the point verifiably falls inside the way's outline – a
  dedicated fail-soft `out geom` Overpass fetch covers the ways involved in
  pairs; without it pairs are proximity-only. `others` counts additional named
  libraries in range (a multi-library building – don't merge blindly). Written
  in `osm`-key order for diff stability; the page sorts contained-first.
  item (see below), grouped by the system they point at: `{ pq, pn, pk, po, st,
  libs[] }` where `pq`/`pn` are the proposed operator's Q-id and label, `pk` its
  entity kind, and `po` the `operator` name OSM already uses for that Q-id.
- `wdConflicts` — libraries whose `operator:wikidata` disagrees with their own
  item, grouped by the `(tagged → asserted)` pair: `{ tw, tn, tk, pq, pn, pk, st,
  libs[] }`. Overpass-only, like `wdOperators`.
- `pls` — per-system IMLS PLS cross-reference (see below): `{ sysKey, fscskey,
  plsCount, osmCount, matched, closed?, shared?, variants?, untagged[], missing[], discrepancies[] }`.
  `shared` counts census outlets co-located with an already-matched member –
  PLS lists two outlets at one address (a makerspace or genealogy room inside
  the branch) that OSM correctly maps as one object; carried for the count
  math, never emitted as a finding.
  `plsUnmatched[]` rows carry `pts[]` — one point per PLS outlet (`n`, `lat`,
  `lon`, plus `osm`/`osmName`/`osmLat`/`osmLon` when some OSM library sits
  within 200 m) so the pages can navigate to each suspected library, and
  `ops[]` – the distinct operator spellings found on those matched buildings,
  with `m: 1` on any the crosswalk scores as this very PLS system (a system
  present in OSM under its own name but on fewer branches than
  `matchMinOsmLibs`; the pages present those as "found – tag the rest, add
  operator:wikidata" instead of ambiguous).
  One row per PLS system; `variants` lists the other OSM operator spellings that
  crosswalked to it.
- `augment` — per-system, ready-to-apply PLS tag **suggestions** for the JOSM-first
  [augmentation page](../augment.html) (see below): `{ sysKey, fscskey, state, qid,
  qidConfirmed, branches[] }`, each branch `{ kind:'existing'|'new', osm, lat, lon,
  plsName, tags }` where `tags` are additive-only OSM tags.

**Why systems are referenced by key, not by array index.** An index is derived
data: it used to fall out of the order systems were first seen while scanning the
library rows, so adding `operator=` to one low-id node moved that system to the
front of the array and shifted every index behind it — a one-tag edit rewrote
~5,000 library rows in the daily diff without changing a single fact. Keys change
only when the tag does. For the same reason `pls` and `augment` are written in key
order rather than ranked by severity; the QA and augmentation pages sort at render
time. The pages resolve keys to array positions once at load, so their internal
`sysIdx` handles are unchanged.

**Suggesting `operator:wikidata` for systems that lack it.** Three independent
sources feed `sw`/`sn`/`ss`, ranked by how directly each speaks about the actual
libraries:

| `ss` | source | strength |
|---|---|---|
| `branch` | the system's own libraries carry `wikidata` items naming a parent organization | a statement about these very branches |
| `fscs` | the system crosswalked to a PLS system whose FSCS ID (`P6618`) is on a Wikidata item | an exact federal identifier, reached via an inferred crosswalk |
| `domain` | libraries sharing a website domain with wikidata-tagged libraries elsewhere | weakest — a heuristic |

Branch votes are a plurality of the system's branch items, and a tie is dropped
rather than guessed. An FSCS key held by **more than one** Wikidata item is
skipped, not picked between: that's the duplicate-item situation (Orange County
Library System vs Library District), and suggesting the wrong twin entrenches it.
When two sources land on the same item, `ss` lists both and the page marks the
agreement. `not:operator:wikidata` vetoes any candidate it names.

**Operators from each library's own Wikidata item.** A branch's `wikidata` tag
identifies *the branch*, but its Wikidata item usually names the system that runs
it — `P749` parent organization, `P361` part of, or (rarely, and most directly)
`P137` operator. Angeles Mesa Branch (`Q4762622`) records its parent as Los
Angeles Public Library, which settles both `operator` and `operator:wikidata`
without guessing. The build reads every such item and splits the result:

- **`wdOperators`** — the library has no operator tag at all, so the claim
  becomes a sourced suggestion. Where OSM already uses a name for that Q-id
  elsewhere, that name is carried as `po` and preferred over the Wikidata label,
  so a suggestion matches its neighbours instead of introducing a spelling.
  `not:operator:wikidata` on an element vetoes a matching proposal.
- **`wdConflicts`** — the library's `operator:wikidata` names a *different* item
  than its own page does. The case worth fixing is a **place or its government
  tagged where a specific library entity exists**: San Diego Public Library
  branches tagged `Q16552` (the city) or `Q138816781` (the city government)
  rather than `Q5486355` (the library network). Not every mismatch is an error —
  a small library really can be run by the city, and consortium-vs-member is a
  judgement call — so each side carries an entity kind (`tk` / `pk`, one of
  `libnet`, `library`, `university`, `school`, `gov`, `place`, `admin`, `org`,
  `other`) and the page ranks the place-like ones first and presents the rest as
  questions.

Only organizations are ever *suggested*: `P361` in particular is also used for
buildings, campuses and historic districts ("part of Beacon Hill"), which is why
every proposed item is class-checked before it is offered. Both sections need the
`wikidata` tag, which Layercake's POI columns don't carry, so they are empty on
that path — the page says so rather than claiming a clean bill of health.

**IMLS PLS matching** ([`pls-match.mjs`](./pls-match.mjs)). Each OSM system with
≥3 libraries is crosswalked to a PLS system: name similarity proposes candidates,
and a **spatial check confirms** (a PLS system whose outlets sit near the OSM
libraries is the match — this disambiguates e.g. "New York Public Library" from
"New York Mills Public Library"). Each matched PLS outlet is then classified:
_matched_ (in OSM), _untagged_ (an OSM library exists nearby but without this
operator — add the tag), _missing_ (no OSM library there — likely create one), or
_discrepancy_ (name-matched but far from the OSM coordinate — verify location).
Requires `data/pls-outlets.json`; if absent, PLS matching is skipped.

**One PLS system, one OSM system.** Systems crosswalk independently, so rival
operator spellings can claim the same PLS system — and do, because that
fragmentation is what the data is full of. Name similarity can't arbitrate:
`normSystem` strips `library`, `system`, `county` and `district`, so
"Orange County" and "Orange County Library System" both reduce to `orange` and
tie at 1.0, and the spatial check passes for both because the rival spellings sit
in the same town. Unarbitrated that produced two rows for Orlando's FL0005, the
smaller of which told mappers to tag 14 OCLS branches `operator=Orange County`,
and made the augment pass query Overpass twice for one system. Claims are
therefore ranked by **how many PLS outlets the spelling actually matched** (then
OSM library count, then name similarity).

The rivals are fragments of *one* real-world system, so the winner is classified
against their **merged membership**: every rival's libraries, plus every library
under a rival's dominant QID (catching fragments that never claimed — below the
size floor, or an unscorable name like a wikidata-keyed fragment's bare Q-id).
Classifying against only the winning fragment used to flag the other fragments'
libraries as untagged/conflicting — e.g. Goldendale, correctly tagged
`operator=Fort Vancouver Regional Libraries` plus the right QID, read as a
conflict because the wikidata-keyed fragment won WA0058. The row is reported
under the best *human-named* fragment (never a bare Q-id), the other name-keyed
spellings ride along as `variants`, and `osmCount` is the merged size. Unit
tests: `npm run test:pls`.

**Closed branches.** PLS lags ~2 years, so a branch that closes after the survey
keeps generating missing/untagged findings until the next fiscal year drops it.
Closure is recorded in **open data, never in this repo** (the same philosophy as
the `not:` assertions), and either signal alone suppresses the finding:

- **Wikidata** — the branch item carries `P3999` (date of official closure) or
  `P576` (dissolved), anchored by its `P625` coordinate. Recording the closure
  on the item — and pruning the system's `P527` branch list, which self-heals
  the branch-count pane — is the curated route. Malformed dates are ignored and
  a *future* date keeps the branch flagged until it passes.
- **OSM** — the object was retagged `disused:amenity=library` /
  `was:amenity=library` (fetched with one small Overpass query, fails soft). A
  deleted object needs no OSM signal; the Wikidata route covers it.

A PLS outlet within ~250 m of either point is counted on the row as `closed`
(shown as a badge on the QA page) instead of appearing as missing/untagged.

**Wikidata branch counts.** Systems whose Wikidata item enumerates its branches
(`P527` parts typed as library branch) get that count attached as `wb` (one
WDQS query; fails soft). The QA page compares it against the OSM branch count —
a completeness hint in both directions. When several of our systems share a
Q-id (typo variants), only the principal (largest) one gets the count.

**`not:` assertions.** OSM's `not:operator:wikidata` / `not:operator` tags record
verified negatives ("definitely not that item"). Layercake doesn't extract them,
so the build fetches them with one small Overpass query (the configured
endpoint first, public mirrors as fallback; fails soft). Ruled-out values
never count as real tags, veto matching suggestions, and are exposed per system
as `nw` — the QA page shows them as struck-through badges, with a conflict
warning when a system's dominant wikidata tag is itself ruled out by a mapper.

**Fallback limitation:** Layercake's POI layer has no `addr:*` columns, so a
`--layercake` build drops the address flags (the QA page hides those columns
via `meta.tags`). The QA page's "Load live details" action still shows current
tag values per-system via Overpass either way.

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
already in `augment[]` (keyed by `sysKey`, so re-running a state refreshes just its
systems and untouched states are preserved). `--replace` starts from an empty
`augment[]`. Everything outside `augment[]` is preserved, and `meta.plsFiscalYear`
is stamped. Intended for generating preview / bug-fixing data; re-run `build:qa`
to regenerate the real national dataset.

## Automated daily refresh

The [`update-systems`](../.github/workflows/update-systems.yml) GitHub Action
runs `refresh-systems.mjs`, `build-pls.mjs` (a no-op except when a new PLS
fiscal year lands), and `build-qa.mjs` every day (and on-demand via the Actions
tab), committing the result back to the repo so the picker and QA page keep
pace with mappers' additions and cleanups. The Overpass endpoint comes from the
`OVERPASS_PRIMARY_URL` repository secret; `freshness-gate.mjs` runs first,
walks the failover chain if the primary is unreachable (see "Failover tiers"
above — a fallback tier means a degraded refresh, noted in the commit body),
and only fails the job — loudly, naming each tier's failure mode — when no
endpoint answers at all (fall back manually, below).

Guards keep a bad upstream response from landing:

- **Absolute floors** — fewer than 1,000 systems or 10,000 QA libraries.
- **±20% band** — rejects a day-over-day change greater than 20% in either
  direction (almost always an upstream glitch, not real mapping activity).

When a guard trips, the job fails without committing. If the change is genuine,
re-run the workflow manually to accept it.

### `data-diff-summary.mjs` — what the refresh actually changed

The data files are megabytes, so the raw diff can't tell you whether a refresh was
a quiet day or a disaster. This compares the working tree against `HEAD` and counts
added / removed / edited entries per section, keyed by a **stable** record key (a
system key, an OSM element id, an FSCS key — never an array position):

```sh
node scripts/data-diff-summary.mjs             # vs HEAD
node scripts/data-diff-summary.mjs --ref HEAD~1
```

```
qa-data/systems: 5 changed, 1 added, 1 removed
qa-data/libs: 15 changed, 1 added, 1 removed
qa-data/pls: 2 removed
```

The daily workflow runs it before `git add` and puts the output in the commit body
and the job summary, so `git log` shows the real size of each refresh. It's also
the alarm for identity bugs: because it compares by key, a change that merely
reorders records counts as zero here even when the raw diff is enormous. Thousands
of "changed" entries on an ordinary day means something upstream started rewriting
record identity again.

## `build-systems.mjs` — US library-systems list (Layercake fallback)

The manual fallback for `refresh-systems.mjs`: regenerates
[`../data/us-library-systems.json`](../data/us-library-systems.json) from
OpenStreetMap US's Layercake extract instead of Overpass. Use it (together with
`build-qa.mjs --layercake`) if the private Overpass instance is unavailable.

```sh
node scripts/build-systems.mjs
```

Requires the [DuckDB CLI](https://duckdb.org/docs/installation/) on `PATH` (or set
the `DUCKDB` env var to its location) and Node 18+. Run from the repo root.

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
- This Layercake path is **US-only** (the extract covers the US). Other
  countries are served by the Overpass path: add an entry to
  [`../js/countries.js`](../js/countries.js) and run
  `node scripts/refresh-systems.mjs --country=XX`.
