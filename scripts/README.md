# Build scripts

## `build-systems.mjs` — US library-systems list

Regenerates [`../data/us-library-systems.json`](../data/us-library-systems.json),
the curated list powering the onboarding autocomplete.

```sh
node scripts/build-systems.mjs
```

No dependencies (Node 18+ global `fetch`). Run from the repo root.

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

1. Queries [QLever](https://qlever.dev/)'s `osm-planet` SPARQL endpoint for every
   `operator=` and `operator:wikidata=` value on `amenity=library` **within the
   United States** — scoped spatially via `ogc:sfContains` against US boundary
   relation [148838](https://www.openstreetmap.org/relation/148838). QLever
   pre-computes containment, so the whole planet query returns in ~1 second.
2. Enriches Wikidata-only operators (those with no co-located `operator=` name
   tag) with English labels from the [Wikidata Query Service](https://query.wikidata.org/).
3. Merges into a single ranked list: Wikidata-backed systems first (the more
   robust selector, stable across name spelling variations), then operator-name
   systems that have no Wikidata counterpart. Sorted by library count.

Each entry is `{ name, mode: 'operator' | 'wikidata', value, count }`. The app's
picker searches `name`; `mode` + `value` become the Overpass selector on load.

### Notes

- A handful of `operator:wikidata` values point at cities or agencies rather than
  library systems (e.g. a county government). That reflects the raw OSM data; the
  list surfaces whatever is tagged.
- To refresh, just re-run — the `meta.generated` date updates automatically.
- To target a different country, change `US_RELATION` to that country's OSM
  boundary relation id.
