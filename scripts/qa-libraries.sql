-- qa-libraries.sql — per-library QA extraction from Layercake.
--
-- Run by scripts/build-qa.mjs via the DuckDB CLI. Same remote-GeoParquet
-- approach as us-library-operators.sql: only the needed columns/row-groups are
-- read over HTTP, never the whole file.
--
-- Two outputs (COPY targets are placeholders build-qa.mjs replaces with temp
-- files it then reads):
--   {{OUT_LIBS}} — one row per US library: identifiers, name, state,
--                  operator / operator:wikidata, tag-presence flags, lon/lat.
--   {{OUT_COLL}} — likely-typo operator name pairs (small Levenshtein
--                  distance), for the QA page's collision report.
--
-- US scoping matches us-library-operators.sql: cheap bbox prefilter, then a
-- precise ST_Contains against US boundary relation 148838. States are assigned
-- by point-in-polygon against admin_level=4 boundaries (bbox-prefiltered to the
-- US extent; non-US admin areas in that window never contain a US-scoped point).

INSTALL spatial; LOAD spatial;
INSTALL httpfs; LOAD httpfs;
SET http_timeout = 300000;

CREATE TEMP TABLE us AS
  SELECT geometry AS geom
  FROM 'https://data.openstreetmap.us/layercake/boundaries.parquet'
  WHERE id = 148838 AND type = 'relation';

CREATE TEMP TABLE states AS
  SELECT name[1] AS state, geometry AS geom
  FROM 'https://data.openstreetmap.us/layercake/boundaries.parquet'
  WHERE admin_level = '4' AND boundary = 'administrative'
    AND name IS NOT NULL AND len(name) > 0
    AND bbox.xmax >= -180 AND bbox.xmin <= -64
    AND bbox.ymax >= 17   AND bbox.ymin <= 72;

CREATE TEMP TABLE us_libs AS
  SELECT
    p.type,
    p.id,
    p.name[1]                                    AS name,
    p.operator                                   AS operator,
    p."operator:wikidata"                        AS wikidata,
    p.website                                    AS website,
    p.phone         IS NOT NULL                  AS has_phone,
    p.website       IS NOT NULL                  AS has_website,
    p.opening_hours IS NOT NULL                  AS has_hours,
    ROUND((p.bbox.xmin + p.bbox.xmax) / 2, 4)    AS lon,
    ROUND((p.bbox.ymin + p.bbox.ymax) / 2, 4)    AS lat,
    p.geometry                                   AS geom
  FROM 'https://data.openstreetmap.us/layercake/pois.parquet' p, us
  WHERE p.amenity = 'library'
    AND (p.bbox.xmin BETWEEN -180 AND -64)
    AND (p.bbox.ymin BETWEEN 17 AND 72)
    AND ST_Contains(us.geom, p.geometry);

-- Per-library rows with state. GROUP BY guards against a point matching more
-- than one admin_level=4 polygon (overlapping/disputed boundaries).
COPY (
  SELECT
    l.type, l.id,
    any_value(l.name)           AS name,
    min(s.state)                AS state,
    any_value(l.operator)       AS operator,
    any_value(l.wikidata)       AS wikidata,
    any_value(l.website)        AS website,
    any_value(l.has_phone)      AS has_phone,
    any_value(l.has_website)    AS has_website,
    any_value(l.has_hours)      AS has_hours,
    any_value(l.lon)            AS lon,
    any_value(l.lat)            AS lat
  FROM us_libs l
  LEFT JOIN states s ON ST_Contains(s.geom, l.geom)
  GROUP BY l.type, l.id
) TO '{{OUT_LIBS}}' (FORMAT json, ARRAY true);

-- Likely-typo operator pairs: names within Levenshtein distance 2 of each other
-- (case-insensitive; distance 0 means the names differ only in case). Lengths
-- must be within 1 character — real typos rarely change length by more, and a
-- looser bound admits noise like "LA County" vs "Lake County". The distance
-- threshold scales down for short names to limit false positives.
-- `wd` is the dominant operator:wikidata tagged on an operator name's libraries
-- (the most frequent one, if any). Used to drop pairs that are deliberately
-- distinct systems rather than typos (see the join condition below).
CREATE TEMP TABLE ops AS
  WITH wd_counts AS (
    SELECT operator, wikidata, COUNT(*) AS n,
           ROW_NUMBER() OVER (PARTITION BY operator ORDER BY COUNT(*) DESC, wikidata) AS rn
    FROM us_libs
    WHERE operator IS NOT NULL AND wikidata IS NOT NULL
    GROUP BY operator, wikidata
  )
  SELECT
    o.operator                        AS name,
    COUNT(*)                          AS cnt,
    bool_or(o.wikidata IS NOT NULL)   AS has_wd,
    MAX(w.wikidata)                   AS wd
  FROM us_libs o
  LEFT JOIN wd_counts w ON w.operator = o.operator AND w.rn = 1
  WHERE o.operator IS NOT NULL
  GROUP BY o.operator;

COPY (
  SELECT
    a.name AS a, b.name AS b,
    a.cnt  AS count_a, b.cnt  AS count_b,
    a.has_wd AS a_has_wd, b.has_wd AS b_has_wd,
    levenshtein(lower(a.name), lower(b.name)) AS lev
  FROM ops a
  JOIN ops b ON a.name < b.name
  WHERE abs(length(a.name) - length(b.name)) <= 1
    AND levenshtein(lower(a.name), lower(b.name))
        <= CASE WHEN length(a.name) >= 12 THEN 2 ELSE 1 END
    -- Drop pairs where both sides carry a wikidata tag but they differ: those
    -- are deliberately distinct systems (e.g. Houston vs Boston), not typos.
    -- Same-Q-id pairs (only the operator string differs) are kept — real typos.
    AND NOT (a.wd IS NOT NULL AND b.wd IS NOT NULL AND a.wd <> b.wd)
  ORDER BY greatest(a.cnt, b.cnt) DESC
) TO '{{OUT_COLL}}' (FORMAT json, ARRAY true);
