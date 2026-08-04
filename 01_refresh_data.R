# Refresh the IEM archive -------------------------------------------------------
# Incremental. The two folders accumulate, and each run asks IEM only for the
# window that is not already on disk: the newest thing we hold, less a lookback,
# through tomorrow. A refresh the day after a refresh is one small request each,
# not a re-pull of 2006-present and 11 MB of polygons.
#
# Run this, then 02_build_archive.R (or 00_run_pipeline.R for both).

library(tidyverse)

# Relative to the working directory; start R in the archive folder.
base_dir <- getwd()
text_dir <- file.path(base_dir, "raw_warning_text_files")
shape_dir <- file.path(base_dir, "misc_warning_shape_files")

dir.create(text_dir, showWarnings = FALSE)
dir.create(shape_dir, showWarnings = FALSE)

# How far back each run re-asks. IEM backfills late products, and an -RRA
# correction carries the *original's* timestamp, so a window starting exactly at
# the newest file on disk would silently miss both. Overlap is cheap; the build
# dedupes on product_id and unzip overwrites in place.
lookback_days <- 7

# Where each archive begins, used only on a cold start (empty folder).
text_start <- "2006-01-01T00:00Z"
shape_start <- "2022-01-01T00:00Z"

ets_time <- as.POSIXct(Sys.Date() + 1, tz = "UTC")
ets <- format(ets_time, "%Y-%m-%dT%H:%MZ")

# Text products ----------------------------------------------------------------
# pil=FRW is a prefix match, so this pulls every WFO. Filenames are
# PIL_YYYYMMDDHHMM.txt, so the newest one on disk is where we resume from.
have_text <- list.files(text_dir, pattern = "\\.txt$")
newest_text <- ymd_hm(str_extract(have_text, "\\d{12}"), tz = "UTC")

sdate <-
  if (length(have_text) == 0) text_start else
    format(max(newest_text) - days(lookback_days), "%Y-%m-%dT%H:%MZ")

message("text: requesting ", sdate, " to ", ets)

str_c("https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py",
      "?pil=FRW&fmt=zip&order=asc&limit=9999",
      "&sdate=", sdate,
      "&edate=", ets) |>
  download.file(file.path(tempdir(), "frw_text.zip"), mode = "wb")

# overwrite: within a window an -RRA correction and the original share a
# filename, and the correction wins on extraction
unzip(file.path(tempdir(), "frw_text.zip"), exdir = text_dir, overwrite = TRUE)

# Polygons ---------------------------------------------------------------------
# Non-VTEC/non-SPS polygons only; this archive does not exist before 2022. IEM
# names the files misc_<sts>_<ets>.shp using the requested window, so the newest
# ets on disk is the point our local copy is complete to. Each fetch lands as its
# own shapefile alongside the others; the build stacks them.
have_shape <- list.files(shape_dir, pattern = "\\.shp$")
covered_to <- ymd_hm(str_match(have_shape, "_(\\d{12})\\.shp$")[, 2], tz = "UTC")

sts <-
  if (length(have_shape) == 0) shape_start else
    format(max(covered_to) - days(lookback_days), "%Y-%m-%dT%H:%MZ")

# Every fetch leaves a new shapefile behind, so skip entirely when disk already
# reaches ets — otherwise a second run the same day pays 8 MB for a window it
# holds and leaves a redundant file for the build to read forever.
if (length(have_shape) > 0 && max(covered_to) >= ets_time) {
  message("polygons: already cover through ", ets, ", skipping")
} else {
  message("polygons: requesting ", sts, " to ", ets)

  str_c("https://mesonet.agron.iastate.edu/cgi-bin/request/gis/misc.py",
        "?format=shp",
        "&sts=", sts,
        "&ets=", ets) |>
    download.file(file.path(tempdir(), "misc_shapes.zip"), mode = "wb")

  unzip(file.path(tempdir(), "misc_shapes.zip"), exdir = shape_dir, overwrite = TRUE)
}

# What came down ---------------------------------------------------------------
# New = filenames that were not there before. A product that was already on disk
# and got re-fetched inside the lookback window does not count as new, even if an
# -RRA rewrote it.
new_text <- setdiff(list.files(text_dir, pattern = "\\.txt$"), have_text)
new_shape <- setdiff(list.files(shape_dir, pattern = "\\.shp$"), have_shape)

cat("\ntext products:", length(have_text) + length(new_text),
    "on disk,", length(new_text), "new\n")
cat("range:", str_c(range(str_extract(list.files(text_dir, pattern = "\\.txt$"),
                                      "\\d{12}")), collapse = " to "), "\n")
cat("polygon shapefiles:", length(have_shape) + length(new_shape),
    "on disk,", length(new_shape), "new\n")
if (length(new_text) > 0) print(new_text)
