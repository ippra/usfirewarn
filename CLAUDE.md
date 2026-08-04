# Fire Warning Archive

An archive of NWS Fire Warning (FRW) text products, joined to warning polygons where
they exist. Source is the Iowa Environmental Mesonet (IEM). R / tidyverse / sf.

## Scripts

| Script | Does |
|---|---|
| `00_run_pipeline.R` | Sources the other two in order. The normal entry point. |
| `01_refresh_data.R` | Tops up the local archive from IEM. **Incremental** — asks only for the window not already on disk. |
| `02_build_archive.R` | Reads the local archive and builds `frw`. Never touches the network. |

They stay separate on purpose: the build reads only what is on disk, so a rebuild is
reproducible and works offline. Both still run standalone.

## Refresh is incremental

`raw_warning_text_files/` and `misc_warning_shape_files/` accumulate — there are no
longer dated snapshot folders, and no paths to bump after a refresh.

Each run resumes from the newest thing on disk, less `lookback_days` (7). The lookback
is not optional: IEM backfills late products, and an `-RRA` correction carries the
*original's* timestamp, so a window starting exactly at the newest local file would
silently miss both. Overlap is cheap — `unzip` overwrites text in place, and the build
dedupes polygons on `product_id`.

- **Text** — resumes from the max `YYYYMMDDHHMM` across the `.txt` filenames.
- **Polygons** — IEM names each file `misc_<sts>_<ets>.shp` from the requested window,
  so the newest `ets` on disk is the point the local copy is complete to. Each fetch
  lands as its own shapefile next to the others and the build stacks them. The download
  is skipped outright when disk already reaches `ets`, so a second run the same day
  costs nothing and does not leave a redundant file behind.

A full pull is ~11 MB of polygons (every misc product type, not just fire); a daily
top-up is ~100 KB. Do not "simplify" this back into a full re-download.

## Data sources

- **Text** — `cgi-bin/afos/retrieve.py?pil=FRW&fmt=zip&limit=9999`. `pil` is a prefix
  match, so `FRW` returns every WFO. Archive starts 2006-01-13.
- **Polygons** — `cgi-bin/request/gis/misc.py?format=shp`. Non-VTEC, non-SPS polygons
  only, and **nothing before 2022**.

Most warnings have no polygon at all. That is normal, not a join failure.

## Output

`frw` — one row per warning, an `sf` object. As of 2026-08-04: 628 warnings, 2006–2026,
216 with polygons.

Joined on `product_id` (`PIL_YYYYMMDDHHMM`), built from the text filename on one side
and `PIL` + `PROD_ID` on the other. Left join from text, so every warning survives;
`expire_time_utc`, `revised`, and geometry are `NA`/empty where no polygon exists.
`has_polygon` flags this 1/0.

Geography comes from the polygon, not from parsing UGC codes. Only the raw
`ugc_header`, `ugc_state`, and `ugc_type` are kept. The C/Z mix inverts over time —
pre-2020 is mostly county codes, 2020+ mostly zone codes — so the 412 warnings
without polygons have no usable geometry unless UGC parsing is added later.

## Conventions

- One flat pipe per object. Avoid helper functions.
- `st_drop_geometry()` before any tabular summary. `count()` and `skim()` on an `sf`
  object union the geometry, which is slow and can fail on a bad polygon.
- The pipe already absorbs several IEM data quirks (raw teleprinter framing, a
  space-padded PIL, an invalid polygon, `-RRA` corrections that supersede an
  original). Don't remove those lines without checking the NA counts afterward.
