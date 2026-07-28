-- pls-outlets.sql — extract US public-library outlets from the IMLS Public
-- Libraries Survey (PLS) FY outlet file, joined to their administrative entity
-- for the system name. Run by scripts/build-pls.mjs via the DuckDB CLI.
--
-- Placeholders replaced by build-pls.mjs: {{OUTLET}} {{AE}} {{OUT}} — all local
-- UTF-8-converted CSVs (the IMLS files ship as Windows-1252).
--
-- Keeps only physical library buildings (central + branch); bookmobiles (BS) and
-- books-by-mail (BM) are not OSM library POIs. Geocode quality flags are kept so
-- the QA page can gate "place here" suggestions on precision.

INSTALL spatial; LOAD spatial;   -- not required, but harmless + future-proofs geo use

CREATE TEMP TABLE ae AS
  SELECT FSCSKEY, LIBNAME AS system_name, STABR AS system_state
  FROM read_csv_auto('{{AE}}', header = true, all_varchar = true);

CREATE TEMP TABLE outlet AS
  SELECT * FROM read_csv_auto('{{OUTLET}}', header = true, all_varchar = true);

COPY (
  SELECT
    o.FSCSKEY || '-' || o.FSCS_SEQ            AS id,
    o.FSCSKEY                                 AS fscskey,
    ae.system_name                            AS system_name,
    o.STABR                                   AS state,
    o.LIBNAME                                 AS name,
    o.ADDRESS                                 AS addr,
    o.CITY                                    AS city,
    o.ZIP                                     AS zip,
    o.PHONE                                   AS phone,
    o.C_OUT_TY                                AS type,           -- CE | BR
    TRY_CAST(o.LATITUDE  AS DOUBLE)           AS lat,
    TRY_CAST(o.LONGITUD  AS DOUBLE)           AS lon,
    o.GEOSTATUS                               AS geostatus,      -- E matched, T tied
    o.GEOMTYPE                                AS geomtype,       -- PointAddress etc.
    o.STATSTRU                                AS structchg       -- 00 none, 02 new, ...
  FROM outlet o
  LEFT JOIN ae ON ae.FSCSKEY = o.FSCSKEY
  WHERE o.C_OUT_TY IN ('CE', 'BR')
    AND TRY_CAST(o.LATITUDE AS DOUBLE) IS NOT NULL
    AND TRY_CAST(o.LONGITUD AS DOUBLE) IS NOT NULL
  ORDER BY o.FSCSKEY, o.FSCS_SEQ
) TO '{{OUT}}' (FORMAT json, ARRAY true);
