-- us-library-operators.sql — extract US library operators from Layercake.
--
-- Run by scripts/build-systems.mjs via the DuckDB CLI. Queries OpenStreetMap US's
-- Layercake POI extract (GeoParquet, hosted at data.openstreetmap.us) directly
-- over HTTP — only the needed columns/row-groups are read, not the whole 4GB file.
--
-- Emits one row per (operator, operator:wikidata) pair for amenity=library
-- features inside the United States, with a count, as a JSON array. The COPY
-- target is a placeholder that build-systems.mjs replaces with a temp file it
-- then reads (portable across OSes, unlike COPY TO '/dev/stdout').
--
-- US scoping is a precise point-in-polygon test against the US boundary
-- (OSM relation 148838, taken from Layercake's own boundaries layer). A cheap
-- bounding-box prefilter narrows candidates first so ST_Contains runs on far
-- fewer rows. A plain bbox alone is not enough — e.g. Toronto falls inside the
-- CONUS bounding box — hence the polygon test.

INSTALL spatial; LOAD spatial;
INSTALL httpfs; LOAD httpfs;
SET http_timeout = 300000;

CREATE TEMP TABLE us AS
  SELECT geometry AS geom
  FROM 'https://data.openstreetmap.us/layercake/boundaries.parquet'
  WHERE id = 148838 AND type = 'relation';

CREATE TEMP TABLE us_libs AS
  SELECT p.operator AS operator, p."operator:wikidata" AS wikidata
  FROM 'https://data.openstreetmap.us/layercake/pois.parquet' p, us
  WHERE p.amenity = 'library'
    AND (p.bbox.xmin BETWEEN -180 AND -64)   -- cheap bbox prefilter (US longitudes)
    AND (p.bbox.ymin BETWEEN 17 AND 72)      -- cheap bbox prefilter (US latitudes)
    AND ST_Contains(us.geom, p.geometry);    -- precise boundary test

COPY (
  SELECT operator, wikidata, COUNT(*) AS count
  FROM us_libs
  WHERE operator IS NOT NULL OR wikidata IS NOT NULL
  GROUP BY operator, wikidata
  ORDER BY count DESC
) TO '{{OUT}}' (FORMAT json, ARRAY true);
