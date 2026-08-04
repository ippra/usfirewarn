# Libraries -------------------------------------------------------------------
library(tidyverse)
library(sf)
library(skimr)

# Data -------------------------------------------------------------------------
# Both folders are the local archive pulled from the Iowa Environmental Mesonet.
# Top them up with 01_refresh_data.R; this script only reads what is on disk, so
# a rebuild is reproducible and works offline.
#
# raw_warning_text_files (every FRW product, all WFOs):
#   https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FRW&fmt=zip&sdate=2006-01-01T00:00Z&edate=2026-08-03T00:00Z&limit=9999
#   single product: .../wx/afos/p.php?pil=FRWOUN&e=202503150225   (the iem_url column)
#
# misc_warning_shape_files (non-VTEC/non-SPS polygons, 2022+ only):
#   https://mesonet.agron.iastate.edu/request/gis/misc.phtml
#   PROD_ID also resolves at /api/1/nwstext/<PROD_ID>

# Paths -----------------------------------------------------------------------
# Relative to the working directory, so the folder can be copied or shared and
# still work. Start R in the archive folder (open the .Rproj, or setwd()).
base_dir <- getwd()
text_dir <- file.path(base_dir, "raw_warning_text_files")
shape_dir <- file.path(base_dir, "misc_warning_shape_files")

if (!dir.exists(text_dir)) {
  stop("No archive found in ", base_dir,
       "\nStart R in the fire_warning_archive folder, or run 01_refresh_data.R first.",
       call. = FALSE)
}

# Warning polygons ------------------------------------------------------------
# IEM misc archive (2022+); most warnings are UGC-only and have no polygon.
# One shapefile per incremental fetch, so read them all and stack. Filter to FRW
# inside the map: each file holds every misc product type, not just fire.
# Windows overlap by design, so slice_tail below is also the dedupe.
frw_shapes <-
  list.files(shape_dir, pattern = "\\.shp$", full.names = TRUE) |>
  map(\(f) read_sf(f) |> filter(str_starts(PIL, "FRW"))) |>
  reduce(rbind) |>
  st_make_valid() |>   # one IEM polygon has a duplicate vertex that s2 rejects
  transmute(
    product_id = str_c(str_remove_all(PIL, " "), "_", str_sub(PROD_ID, 1, 12)),
    expire_time_utc = ymd_hms(EXPIRE),
    revised = str_detect(PROD_ID, "-RRA$")
  ) |>
  arrange(product_id, revised) |>
  slice_tail(n = 1, by = product_id)

# Warning text ----------------------------------------------------------------
frw <-
  tibble(file = list.files(text_dir, pattern = "\\.txt$", full.names = TRUE)) |>
  mutate(
    # a few products still carry raw WMO framing (SOH/ETX bytes, CR line endings)
    raw_text = map_chr(file, read_file) |> str_remove_all("[\001\003\r]"),

    # older state-level PILs are 5 chars space-padded to 6, e.g. "FRWNM "
    product_id = basename(file) |> str_remove("\\.txt$") |> str_remove_all(" "),
    product_type = "FRW",
    product_pil = str_remove(product_id, "_\\d{12}$"),

    issue_time_utc = str_extract(product_id, "\\d{12}") |> ymd_hm(tz = "UTC"),
    issue_date = as_date(issue_time_utc),
    issue_year = year(issue_time_utc),
    issue_month = month(issue_time_utc),
    issue_day = day(issue_time_utc),

    transmission_id = str_match(raw_text, "^\\s*(\\d+)")[, 2],
    wmo_header = str_match(raw_text, "(?m)^([A-Z]{4}\\d{2})")[, 2],
    issuing_wfo_id = str_match(raw_text, "(?m)^[A-Z]{4}\\d{2}\\s+(K[A-Z]{3})")[, 2],
    issuing_wfo = str_remove(issuing_wfo_id, "^K"),

    ugc_header = str_extract(raw_text, "(?m)^[A-Z]{2}[CZM]\\d{3}[\\d>-]*-"),
    ugc_state = str_sub(ugc_header, 1, 2),
    ugc_type = str_sub(ugc_header, 3, 3),

    eas_activation_requested =
      str_detect(raw_text, regex("EAS ACTIVATION REQUESTED", ignore_case = TRUE)),

    iem_url = str_c("https://mesonet.agron.iastate.edu/wx/afos/p.php?pil=",
                    product_pil, "&e=", format(issue_time_utc, "%Y%m%d%H%M"))
  ) |>
  left_join(frw_shapes, by = "product_id") |>
  st_as_sf() |>
  mutate(has_polygon = as.integer(!st_is_empty(geometry))) |>
  select(
    product_id, product_type, product_pil, wmo_header,
    issue_time_utc, issue_date, issue_year, issue_month, issue_day,
    expire_time_utc,
    issuing_wfo_id, issuing_wfo,
    ugc_header, ugc_state, ugc_type,
    eas_activation_requested, has_polygon, revised,
    transmission_id, iem_url, raw_text
  ) |>
  arrange(issue_time_utc)

# Cache -----------------------------------------------------------------------
# The built object, so the app does not have to re-read 16 MB of raw text and
# shapefiles on every startup. xz gets it to ~90 KB, which is what makes the app
# deployable: this is the only data file Connect Cloud needs.
saveRDS(frw, file.path(base_dir, "frw.rds"), compress = "xz")

# Checks ----------------------------------------------------------------------
# print() so these still show when the script is sourced by 00_run_pipeline.R.
cat(frw$raw_text[1])
frw |> st_drop_geometry() |> skim() |> print()
frw |> st_drop_geometry() |> count(has_polygon) |> print()
