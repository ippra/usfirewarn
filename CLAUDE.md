# Fire Warning Archive

An archive of NWS Fire Warning (FRW) text products, joined to warning polygons where
they exist. Source is the Iowa Environmental Mesonet (IEM). R / tidyverse / sf.

## Scripts

| Script | Does |
|---|---|
| `00_run_pipeline.R` | Sources the other two in order. The normal entry point. |
| `01_refresh_data.R` | Tops up the local archive from IEM. **Incremental** — asks only for the window not already on disk. |
| `02_build_archive.R` | Reads the local archive, builds `frw`, writes `frw.rds`. Never touches the network. |
| `03_map_warnings.R` | Counts warnings by issuing WFO and maps them onto CWA boundaries. Reads `frw.rds`; never touches the network. |
| `app.R` | Shiny browser for the archive. Reads `frw.rds`. |

They stay separate on purpose: the build reads only what is on disk, so a rebuild is
reproducible and works offline. Each still runs standalone. `00_run_pipeline.R` stops
at the build; `03` is analysis, run it when you want the map.

All paths are relative to the working directory, so the folder can be moved or shared.
Start R in the archive folder. The app must stay named `app.R` — `rsconnect` normalizes
the Shiny entrypoint to that name, and Connect Cloud will not find it under any other.

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
- **CWA boundaries** — `w_16ap26/`, from https://www.weather.gov/gis/CWABounds. 27 MB,
  gitignored, re-downloadable. `CWA` is the field that matches `issuing_wfo`.

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

## Deployment (Posit Connect Cloud)

Deployed with the **Posit Publisher** extension, which uploads directly from this
folder. No git and no GitHub repo involved — the public-repo requirement in Posit's
docs applies only to the git-backed publishing flow, which this project does not use.
`manifest.json` likewise belongs to that flow and is not what Publisher reads.

Config lives in `.posit/publish/`. The file list there is the deployment, not
`.gitignore`. Redeploy is the extension's "Deploy Your Project" button.

`frw.rds` (~90 KB) is what the app reads; `raw_warning_text_files/` and
`misc_warning_shape_files/` (16 MB) are deliberately not deployed. `app.R` prefers the
cache and only falls back to sourcing `02_build_archive.R` when it is missing, which is
why the app imports `dplyr`/`stringr` rather than `tidyverse`.

**After any refresh, rebuild the cache and redeploy:**

```r
source("00_run_pipeline.R")   # refresh + rewrite frw.rds
```

Then hit Deploy in the extension.

Beware what is in the Publisher file list. Including `01_refresh_data.R` and
`02_build_archive.R` drags `tidyverse` and `skimr` into the dependency scan, and the
refresh script is actively unsafe to run on the server: the raw archive is not
deployed, so it would see an empty folder, resolve `sdate` to 2006-01-01, and pull the
entire archive from IEM on every container start.

## Mapping by office

`03_map_warnings.R` writes `03_wfo_warning_counts.csv` (one row per office, all 125,
zeros included), `03_wfo_warning_counts.pdf` (the publication copy, vector, font
embedded) and `03_wfo_warning_counts.png` (for a quick look and for slides).

Every issuing office joins to a CWA polygon, and the script stops if one ever does not
rather than dropping it off the map.

The map is meant to be publication-ready, and three things in it are deliberate:

- **The count is printed inside each office that has one.** The fill carries the
  pattern, the label carries the value, so the reader never has to estimate from a
  colour. Labels sit at `st_point_on_surface()`, not `st_centroid()` — a centroid can
  land outside a concave CWA.
- **Binned fill, with "None" as its own key.** OUN and AMA alone are over half the
  archive, so a continuous scale flattens everything else to white; and a zero
  competing with the lowest bin for the palest colour reads as "one or two".
- **The legend gets a layer of empty geometries, one per bin.** ggplot draws no key
  glyph for a bin with no data — 50–99 is empty right now — and `override.aes` does
  not bring it back. The dummy layer gives every key a data row without drawing
  anything on the map. Don't delete it as dead code.

Two things about the PDF are load-bearing:

- **The device is `quartz()`, not `cairo_pdf`.** cairo fails here with "invalid font
  type" because it cannot resolve a macOS system font, and the base `pdf()` device
  drops the en dash. cairo is the fallback off macOS.
- **Boundaries are thinned with `rmapshaper::ms_simplify()`** before plotting. At full
  county-level detail the shapefile is 1.7 million vertices and the PDF is 18 MB;
  thinned, it is under 1 MB and looks identical at this scale. It must be
  `ms_simplify()` and not `st_simplify()` — the latter thins each polygon
  independently and opens slivers between neighbouring offices.

Font falls back to `sans` where Avenir Next and Helvetica Neue are not installed;
`rmapshaper` and `ragg` are used when present but neither is required.

Alaska, Hawaii, the Pacific and Puerto Rico are dropped from the map only — they have
never issued an FRW, and they cost CONUS most of the frame. They are still in the CSV.

## Conventions

- One flat pipe per object. Avoid helper functions.
- `st_drop_geometry()` before any tabular summary. `count()` and `skim()` on an `sf`
  object union the geometry, which is slow and can fail on a bad polygon.
- The pipe already absorbs several IEM data quirks (raw teleprinter framing, a
  space-padded PIL, an invalid polygon, `-RRA` corrections that supersede an
  original). Don't remove those lines without checking the NA counts afterward.
