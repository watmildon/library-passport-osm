# Canadian province data sources for the outlet census

Research notes for extending `data/ca-library-outlets.json` (built by
`scripts/build-ca-outlets.mjs`) beyond BC and Ontario's single-location
systems. Each entry lists the best branch-level source found, what it would
take to ingest, and dead ends already checked (so they aren't re-litigated).
URLs were verified working as of 2026-08-22 unless marked otherwise.

**Already ingested:** BC (Geographic Sites Registry via WFS, live, coords) ·
ON single-location systems (Annual Survey addresses, OpenCage-geocoded) ·
ON big-city layers: Toronto, Ottawa, Hamilton (OGL-family city portals) ·
MB: Winnipeg (city open data) · NS (archived branches snapshot, OGL-NS).
Mississauga/London were deliberately deferred (bespoke city terms, not
OGL-family) — OGL-licensed sources went first.

## Priority summary

| Jurisdiction | Best source | Status / effort | Coords? |
|---|---|---|---|
| QC | BAnQ "Bottin des bibliothèques" (1,047 branches, CC-BY 4.0) | **geocoded & cached — write `fetchQC()`** (731 point-precision outlets ready) | banked |
| ON multi-branch | Toronto/Ottawa/Hamilton **INGESTED**; Mississauga/London deferred (non-OGL city terms); long tail per-city | partial | yes |
| NS | Wayback snapshot **INGESTED** (75 branches, `data/sources/`); spot-check closures over time | done | yes |
| PE | LibCal locations JSON (26 branches, one request) | ingest (license caveat) | yes |
| NL | Open Data NL KMZ (97 points, 2012!) + nlpl.ca reconcile | ingest + verify | yes |
| MB | Winnipeg **INGESTED**; ODCAF/manual for the rest of the province | partial | partial |
| AB | Monthly PDF directory + Edmonton/Calgary open data + ODCAF | PDF parse + geocode | partial |
| NB | Scrape 70 consistent ASP directory pages | scrape + geocode | no |
| SK | ODCAF 2020 snapshot (upstream directory is dead) | **geocoded & cached — but only 14% precise; needs the ODCAF-corroboration rule** | banked |
| YT | Scrape one libnet locations page (16 branches) | scrape + geocode | no |
| NT | 211 NWT entries (21 community libraries) | scrape + manual | no |
| NU | publiclibraries.nu.ca (8 branches, PO boxes only) | manual placement | no |

## National base/cross-check layer: StatCan ODCAF

**Open Database of Cultural and Art Facilities** — the closest thing Canada
has to a national PLS outlet file.

- <https://www.statcan.gc.ca/en/lode/databases/odcaf> — zip:
  <https://www150.statcan.gc.ca/n1/en/pub/21-26-0001/2020001/ODCAF_V1.0.zip>
- CSV, 7,972 facilities; `ODCAF_Facility_Type = "library or archives"` gives
  **3,013 branch-level records** nationally with name, address parts, city,
  province, and (partial) lat/lon. Open Government Licence – Canada.
- **Caveats:** v1.0 is a 2020 snapshot (no v2 exists); coordinate coverage is
  uneven (MB 99%, AB 38%, SK 19%, NB ~63%); archives are mixed into the
  library type (filter by name — plus ~200 records from the "Canadian Museums
  Association" provider skew archival); tiny book-deposit outlets inflate SK.
- **Measured coordinate quality (2026-08-22, against the live BC registry):**
  of 246 name-paired BC records, only **57% are within 100 m and 73% within
  250 m of the registry point; 18% are more than 1 km off** (max ~965 km). Our
  matcher's spatial gates are 200–250 m, so ODCAF coordinates used directly
  would fabricate false findings for roughly a quarter of records — **treat
  ODCAF as an address book, not a coordinate source.** Its coords are still
  useful as corroboration: a geocode that agrees with ODCAF within ~250 m is
  near-certainly right.
- Per-province library-slice counts (records / with coords): QC 896/880
  (BAnQ-sourced — superseded by the newer, larger bottin), ON 808/650,
  SK 353/68, AB 319/121, BC 299/285, NL 101/99 (the same stale 2012 KMZ),
  NS 80/74, MB 83/82, NB 71/45, PE 2, YT 1, NT/NU 0 — useless for the
  smallest jurisdictions.
- **Role: the primary (only) source for SK — via the geocode pipeline, not its
  own coords; a cross-check/corroboration layer for AB, MB, QC, NB.** Skip for
  BC/ON (better sources in hand), NL (same data as the KMZ), PE/territories
  (absent).

## Quebec — solved, needs geocoding

**BAnQ "Bottin des bibliothèques publiques"** on Données Québec — a true
branch-level census, the QC equivalent of what we built for BC.

- <https://www.donneesquebec.ca/recherche/dataset/a5a36aa3-1b1a-4dd1-a78b-23008e368ef7>
  (CSV, semicolon-delimited; 2024 file, updated 2025-09)
- **1,047 rows**, one per point de service: municipality, library name,
  service-point name, address, postal code, admin region. **No coordinates.**
  CC-BY 4.0.
- Verified big-city coverage: Montréal 46, Québec City 26, Gatineau 12,
  Laval 9, Longueuil 9 — Réseau BIBLIO rural branches included.
- **Status (2026-08-23): geocoding DONE.** All 1,045 unique addresses are in
  the committed cache (zero no-results); **731 (70%) came back at point
  precision** and will pass the outlet gate. Remaining work is pure code:
  write `fetchON`-style `fetchQC()` in `build-ca-outlets.mjs` using the query
  format below — every lookup hits the cache, no API calls. Expect QC to
  produce the project's largest missing-branch list (~731 census outlets vs
  539 `amenity=library` in OSM Quebec). Remember the ATTRIBUTION.md entry
  (CC-BY 4.0, BAnQ) when it lands.
- Supplements with coords (mostly redundant): Longueuil, Repentigny and
  Shawinigan publish GeoJSON on Données Québec (CC-BY 4.0). Montréal's own
  portal has **no** branch dataset (its "Lieux culturels municipaux" is 2017 —
  stale). The BiblioQuébec map (geopratic.com) is this bottin geocoded via
  Google — its coords are not reusable.

## Ontario multi-branch systems — big five ready, long tail per-city

All verified live, all with coordinates:

| City | Dataset | Count | License |
|---|---|---|---|
| Toronto | open.toronto.ca "Library Branch General Information" (GeoJSON/CSV; refreshed 2026-06) | ~100 | OGL – Toronto |
| Ottawa | open.ottawa.ca "Ottawa Public Library Locations 2024" (ArcGIS FeatureServer) | 34 | Ottawa Open Data 2.0 |
| Mississauga | data.mississauga.ca "City Libraries" (FeatureServer; addr, phone, website) | 18 | city terms (open-data style) |
| Hamilton | open.hamilton.ca "Libraries" (GeoJSON/CSV) — includes closed Greensville, verify | 23 | Hamilton Open Data |
| London | opendata.london.ca "Libraries" (GeoJSON/CSV) | 17 | city terms |

- Province-wide dead ends (checked): Ontario GeoHub/LIO has no library layer;
  olservice.ca has no public directory or machine-readable endpoint.
- Remaining gap: other multi-branch systems (Brampton, Vaughan, Markham,
  Windsor, Kitchener, Sudbury…) — expect a per-city ArcGIS-Hub hunt like the
  above.

## Nova Scotia — retired dataset, recoverable from Wayback

The Socrata dataset ("Public Library Branches and Contact Information",
`btmb-pp7q`) was removed between April and August 2026; no replacement exists
on data.novascotia.ca (catalog API confirms).

- **Working Wayback capture (Sept 2024):**
  `http://web.archive.org/web/20240919224635/https://data.novascotia.ca/api/views/btmb-pp7q/rows.geojson?accessType=DOWNLOAD`
  — 88 features, **85 with point geometry**; name, type, system code
  (e.g. AVRL), address, city, postal, phone, link. Was NS OGL.
- Data version 2023-05; ~2 years stale — spot-check against the 9 regional
  systems' own sites before trusting closures/moves.
- Dead ends: GeoNOVA ArcGIS REST 404s, NSTDB buildings carry no names,
  library.novascotia.ca is WAF-blocked.

## Prince Edward Island — one JSON call

- **LibCal locations API:**
  `https://peilibrary.libcal.com/api_hours_grid.php?iid=4032&format=json` —
  28 records (26 unique branches after dropping booking duplicates) with
  name, **lat/lon**, and address/phone in a contact block.
- data.princeedwardisland.ca (ArcGIS Hub, 94 datasets) has zero library
  layers; princeedwardisland.ca itself is bot-blocked (POI pages archived on
  Wayback if needed).
- **Caveat:** LibCal is operational service data, not formally open-licensed —
  fine as a matching/QA reference, not something to republish as-is.

## Newfoundland and Labrador — official but ancient

- **Open Data NL "Public Libraries" KMZ:**
  dataset `https://opendata.gov.nl.ca/public/opendata/page/?page-id=datasetdetails&id=85`,
  file `…/filedownload/?file-id=289` — **97 placemarks** with name, community,
  phone, postal code, street address, lat/lon. OGL – NL. Internal timestamps
  say **2012** (portal: revised 2014) — predates a decade of closures.
- Reconcile against the current directory at nlpl.ca/locations-hours/ (~90+
  branches, 4 divisions; WordPress markup, no JSON API — messy scrape) or the
  ODCAF NL slice (101 records, 2020, 99% coords).

## Manitoba — Winnipeg ready, rest is 2020-vintage

- **Winnipeg:** <https://data.winnipeg.ca/Libraries/Library/bt47-pkkm>
  (Socrata) — 20 branches, lat/lon, address, website, amenities; refreshed
  2026-08. OGL – Winnipeg. **Ready.**
- **Rest of province:** the Public Library Services Branch directory lives on
  mb.countingopinions.com — bot-blocked (Imperva), needs a manual browser
  download; vendor platform, license unclear. ODCAF's MB slice (83 records,
  **99% with coords**, 2020) is the practical base outside Winnipeg.
- Dead ends: MB geoportal/MLI has zero library datasets; the Manitoba Library
  Association map is community-maintained with no export.

## Alberta — current data trapped in a PDF

- **Alberta Public Library Directory** (open.alberta.ca): branch-level,
  authoritative, refreshed several times a year — latest
  `ma-alberta-public-library-directory-2026-08.pdf` (verified; 1.3 MB). All
  24 resources on the dataset are PDF; no structured version exists.
  OGL – Alberta. Needs PDF table extraction + geocoding.
- **Edmonton** (`jn25-zspi`) and **Calgary** (`m9y7-ui7j`) publish ready
  lat/lon branch datasets (~40 branches combined).
- ODCAF AB slice: 319 records, 38% coords, 2020 — the base to refresh against
  the PDF.
- Dead ends: the province's statistics XLSX has no addresses; GeoDiscover
  Alberta has no library layer.

## Saskatchewan — ODCAF is all that's left

- The provincial branch directory (libraries.gov.sk.ca "Rex9") is **dead —
  DNS no longer resolves.** ODCAF scraped it in 2020: **353 SK records**
  (many tiny book-deposit outlets), only 19% with coords.
- No SK open-data or GeoHub dataset exists (456-dataset catalog: zero hits);
  sasklibraries.ca lists only the 11 member systems.
- **Status (2026-08-23): geocoding DONE, result poor.** The 265 street-addressed,
  noise-filtered ODCAF rows are in the cache, but only **36 (14%) at point
  precision** — rural SK addresses mostly resolve to postal/town centroids,
  which the precision gate rightly rejects. A bare `fetchSK()` would yield ~36
  outlets. To be worth more, it needs the **ODCAF-corroboration rule**: accept
  a below-gate geocode when ODCAF's own 2020 coordinate agrees within ~250 m
  (two independent weak sources agreeing ≈ one strong one). ODCAF alone is not
  trustworthy — measured against the BC registry, its coordinates are outside
  our matcher's gates ~27% of the time. Then a freshness check against the
  regional systems' own sites (Wapiti, Chinook, Lakeland…). Wayback has Rex9
  captures if a diffable snapshot helps.

## Territories — small, scrape-and-place

- **Yukon:** `https://yukonlibraries.libnet.info/locations` — 16 locations
  with street addresses on one page (yukon.ca 403s bots and just links here).
  A couple are km-marker descriptions (Tagish). Scrape + geocode; trivial.
- **NWT:** nwtpls.gov.nt.ca is dead (DNS). The ECE page lists 21 community
  libraries **by community only, no addresses**; 211 NWT (nt.211.ca) has
  per-community entries with facility addresses. Many are in schools —
  expect manual placement.
- **Nunavut:** publiclibraries.nu.ca lists 8 branches with **PO boxes only**
  (communities largely lack street addressing). Manual placement against OSM
  community knowledge; ~8–11 records.

## Cross-cutting notes

- **Licensing:** provincial OGLs (BC/ON/AB/NS/NL/Canada/Toronto/Winnipeg…)
  and CC-BY 4.0 (Québec) are all attribution-style — add each ingested source
  to `ATTRIBUTION.md`. Two caveats flagged above: Manitoba's CountingOpinions
  directory and PEI's LibCal feed are vendor/operational data without explicit
  open licences — use as reference layers, don't republish verbatim.
- **Geocode budget:** QC and SK are already banked (below). Still to geocode
  when their sources are ready: NB (~60 scraped addresses) and the AB
  directory once parsed (~300) — well within a day of quota each. The
  committed cache (`data/ca-geocode-cache.json`) makes every run one-time.
- **Pre-fetched cache entries (completed 2026-08-23):** SK (265 ODCAF
  noise-filtered, street-addressed rows) and the full QC bottin (1,045) are
  geocoded into the committed cache — 1,474 entries total with ON's 164.
  **The future `fetchSK()`/`fetchQC()` must build queries exactly as follows
  or the cache never hits:**
  - SK: `` [`${Street_No} ${Street_Name}`.trim(), City, 'Saskatchewan', Postal_Code, 'Canada'].filter(Boolean).join(', ') ``
    (ODCAF `..` treated as missing; rows without a street name skipped)
  - QC: `[ADRESSE, MUNICIPALITÉ, 'Quebec', CODEPOSTAL, 'Canada'].filter(Boolean).join(', ')`
    (CASE POSTALE ignored — PO boxes)
- **Matcher fit:** sources with real coordinates slot straight into
  `build-ca-outlets.mjs` like BC did; address-only sources follow the Ontario
  pattern (geocode → point-precision gate). PO-box/community-only records
  (NU, parts of NT) don't fit the pipeline and are better served by the
  Wikidata branch-item route.
