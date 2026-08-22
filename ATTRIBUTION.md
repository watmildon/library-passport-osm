# Data sources & attribution

This project combines several open data sources. The licence for each, and the
attribution its licence asks for, are listed here. Per-source licence details
for the Canadian outlet data are also recorded machine-readably in
`data/ca-library-outlets.json` under `meta.provinces`.

## OpenStreetMap

Library locations, tags, and boundaries throughout the site and data pipeline.

© OpenStreetMap contributors, licensed under the
[Open Database License](https://www.openstreetmap.org/copyright) (ODbL).
This includes the [Layercake](https://data.openstreetmap.us/) extracts
(OpenStreetMap US) used by the fallback build path.

## Wikidata

Labels, aliases, branch lists, closure dates, and entity classifications used
for enrichment and matching.

Wikidata is [CC0](https://creativecommons.org/publicdomain/zero/1.0/) (public
domain dedication) — no attribution required.

## IMLS Public Libraries Survey (United States)

The US outlet census (`data/pls-outlets.json`) comes from the
[IMLS Public Libraries Survey](https://www.imls.gov/research-evaluation/surveys/public-libraries-survey-pls),
a work of the US federal government in the **public domain**.

## British Columbia (Canada)

BC service points in `data/ca-library-outlets.json` come from the BC
Geographic Warehouse's Geographic Sites Registry layer
([BC Public Libraries Systems – Branches and Locations](https://catalogue.data.gov.bc.ca/dataset/3d2318d4-8f5d-4208-88f5-995420d7c58f),
layer `GSR_PUBLIC_LIBRARY_LOCS_SV`).

Contains information licensed under the
[Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc).

## Ontario (Canada)

Ontario outlets in `data/ca-library-outlets.json` come from the
[Annual Survey of Public Libraries](https://data.ontario.ca/dataset/ontario-public-library-statistics)
(single-location systems, addresses geocoded).

Contains information licensed under the
[Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario).

## OpenCage

Ontario street addresses were geocoded once via the
[OpenCage Geocoding API](https://opencagedata.com/); the results are cached in
`data/ca-geocode-cache.json` as OpenCage's terms permit. Geocoding
© OpenCage, based on open data.

## Basemap

Map tiles by [OpenFreeMap](https://openfreemap.org/), style based on
[OpenMapTiles](https://openmaptiles.org/), data © OpenStreetMap contributors.

---

### OSM wiki listings

For the reverse direction — using these datasets to improve OpenStreetMap
(the QA and Augment workflows) — both provincial sources are already covered
by entries on the OSM wiki's
[Contributors](https://wiki.openstreetmap.org/wiki/Contributors) page: the
**DataBC** entry (Open Government License for Government of BC Information
v.BC1.0) and the **Government of Ontario** entry (Open Government Licence –
Ontario). The IMLS PLS data is public domain and needs no listing.
