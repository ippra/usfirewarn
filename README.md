# usfirewarn - US FireWarn

A static site that maps every National Weather Service Fire Warning issued in
the United States since 2006: where it applied, when, who asked for it and
what it said. It updates itself as new warnings are issued.

It replaces the Shiny browser this repository used to hold, and is built the
same way as its Oklahoma sibling, [`okfirewarn`](https://github.com/ippra/okfirewarn),
which maps Oklahoma's warnings with satellite fire detections and Wireless
Emergency Alerts.

- **Site:** https://ippra.github.io/usfirewarn/

It is an IPPRA Labs project: a working tool built on data other agencies
publish, rather than one of the institute's own data products. Labs projects
are hosted on GitHub Pages and are not released to ippra.net.

## What it does

- **Every warning on one map.** A warning's own polygon is drawn solid; an
  older warning issued for whole counties, with no polygon, is drawn dashed
  as those counties. A dot marks each warning until the map is zoomed in far
  enough to see a shape a few miles across.
- **Read the warning.** Clicking a warning, on the map or in the list, opens
  it beside the map: the time in force, the counties, the office, the agency
  that asked for it, the full text as issued, and a link to the original at
  IEM. Where several warnings cover one spot, the click lists them.
- **Search the text.** The search box matches the full text of every warning,
  with line breaks ignored, so a phrase typed on one line matches a product
  that wraps it across two.
- **Any date range.** Presets (all years, 12 months, year to date, 90 days,
  any single year), date fields, and a timeline of warnings issued that you
  drag to select. The arrow buttons move the range by its own length.
- **Filter by office or state.** From the menus, or by clicking a row in the
  ranking of offices and states. The timeline follows the search and filters,
  so it shows when the warnings you are looking at were issued.
- **Historic days.** The five days with the most warnings issued, each one
  click from the map.
- **Four base maps:** dark, light, streets and satellite imagery.
- **Share and export.** The address bar always holds the current view,
  including the open warning, so a copied link reproduces it. Save the map as
  a PNG with a title and credits, or download the selected warnings as CSV.
- **Updates itself.** The site refreshes from IEM every three hours, and an
  open page checks for a newer build every 10 minutes and loads it without a
  reload.
- **Light, dark and greyscale.** "Adjust colors" in the masthead switches the
  page's theme, as on the institute's other dashboards.

## The pipeline

Scripts run in number order. Each sources `00_paths.R`, which resolves paths
against the project root, so nothing is machine-specific.

| step | what it is |
|---|---|
| `00_run_pipeline.R` | runs 01-03; the entry point for a scheduled update |
| `01_refresh_warnings.R` | re-pulls every NWS Fire Warning from the Iowa Environmental Mesonet into `data/frw_text/`: about 550 KB, a second or two, so no incremental state |
| `02_build_warnings.R` | parses each warning's area, polygon, expiry, local time, requesting agency and summary → `outputs/02_warnings/` |
| `03_build_dashboard.R` | copies `site/` and the warnings into one static directory → `outputs/03_site/` |
| `04_map_offices.R` | analysis, not part of the site: counts warnings by office and draws the print map → `outputs/04_wfo_warning_counts.*` |

```
IEM Fire Warning text
        │
01_refresh_warnings.R
        │
data/frw_text/              reference/ (counties, zones, offices)
        │                          │
02_build_warnings.R ───────────────┘
        │
outputs/02_warnings/ ──────────────┐
        │   site/ (front end)      │
        ▼                          ▼
03_build_dashboard.R        04_map_offices.R
        │                          │
outputs/03_site/            outputs/04_wfo_warning_counts.*
the deployable site         the print map
```

## Building and previewing

```sh
Rscript 00_run_pipeline.R     # refresh, build data, assemble site
python3 preview.py            # http://localhost:8904
```

R packages: `tidyverse`, `sf`, `jsonlite`, `curl`, `here`. `rmapshaper` to
rebuild `reference/` or run `04_map_offices.R`, which also needs the NWS
county warning area boundaries in `data/w_16ap26/` (27 MB, from
https://www.weather.gov/gis/CWABounds).

Every script stops loudly instead of producing a quietly wrong site: an IEM
pull that reaches its limit or comes back far smaller than the archive on
disk, a warning from an office not in `reference/offices.csv`, a time zone not
declared, a warning whose UGC line, expiry or polygon does not parse, a county
or zone code that resolves to no county, a polygon outside every county its
warning names (unless the product is listed as not a Fire Warning in
`reference/`), a message with nothing to summarise, and R or CSV files in the
published directory all halt the build. A failed run leaves the last good site
in place.

## Decisions worth knowing

**Shapes come from the warning's own text.** Every warning since 2022, and
some from 2017 and 2019, carries a `LAT...LON` polygon in the product: 251 of
645. IEM's separate warning shapefiles start in 2022 and hold fewer, so the
build parses the text and needs no shapefile. The other 394 are drawn as the
counties their UGC line names, which is usually far more ground than the fire
threatened.

**Re-pulled whole, not topped up.** The archive is 550 KB. A full pull each
run means there is no local state to drift, and a correction IEM has received
(`-RRA`, which carries the original's timestamp) replaces the original without
a lookback window to tune.

**Dates are local to the warning.** Each product prints its issue time with a
zone, "620 PM CDT". The build takes the warning's calendar day from that, so
an evening warning in Texas is not dated the next day in UTC, and the page
prints each warning's time as its readers saw it. A zone abbreviation the
build has not been told about stops it.

**A warning belongs to a day it was in force.** A warning appears for any
selected date between the local day it was issued and the day it expired, so
one running past midnight shows on both. The timeline and the "busiest day"
count warnings by the day they were issued.

**Expiry is the UGC purge time.** The UGC line ends with day, hour and minute
only; the build takes the issue month, or the next when that would fall before
the issue time, and stops on anything expiring before issue or more than two
days after.

**Zone numbers change.** Warnings name either counties, which are FIPS codes,
or public forecast zones, which NWS renumbers. `reference/zone_county.csv`
combines two NWS files so old numbers still resolve, and because a reused
number would silently move an old warning, each zone-coded warning is checked
against its evidence: a polygon must overlap one of its counties, and a
warning without one must name one in its text.

**Not every product in the archive is a Fire Warning.** Local alerting
systems relay through the same NWS product, and one sent a test ("DOUGCO
ALERT TEST 260 PLEASE IGNORE") whose polygon sat in a different county from
the one its UGC line named. The build's polygon check caught it. Such products
are read and listed with their reason in `reference/excluded_warnings.csv`,
and the build drops them; any other product whose polygon lies outside every
county it names still stops the build until it is read.

**Summaries and requesters are extracted by rule.** The summary is the first
paragraph after the issue line, skipping a headline and the sentence saying a
message follows; the requesting agency is read from the header or from "at the
request of". Both are best effort across twenty years of formats, and some
read clumsily. The full text beside the map is the record.

**Counts are not fire activity.** Offices, and the agencies they relay for,
differ in whether they use Fire Warnings at all: NWS Norman and NWS Amarillo
issued more than half the archive. The About section says so.

## The front end

`site/` is hand-edited: `index.html`, `engine.js`, `engine.css`, and MapLibre
GL JS 6.10.0 vendored under `site/assets/vendor/`. The chrome is the
institute's shared look (`ippra/okfirewarn`, `ippra/s3ok_dash`, `ippra/errs`):
the IPPRA bar, the midnight masthead with its viridis strip, and the light,
dark and greyscale themes under "Adjust colors". The themes restyle the panel
and timeline only; the map's colors follow the base map, because the marks sit
on it.

Fire Warnings are violet, as on OK FireWarn, where the color was checked with
the dataviz palette validator against each base map's background. Fills are
faint, so places warned many times read as darker ground. The open warning is
outlined in the base map's strongest contrast rather than a second hue.

The only third-party requests are base map tiles: CARTO for the vector maps,
Esri for satellite imagery and the labels over it. If tiles fail, the state
lines and every warning still draw.

## Deploying

One deployment: GitHub Pages, automatic. As an IPPRA Labs project the site is
not copied to ippra.net.

`.github/workflows/refresh.yml` runs the whole pipeline every three hours and
on every push to `main`, and publishes `outputs/03_site/` to
https://ippra.github.io/usfirewarn/. The repository's Pages source must be set
to GitHub Actions (Settings, Pages).

A failed run publishes nothing: the site keeps its last good build and GitHub
emails the repository owner. The usual causes are IEM being down (the next run
retries) or a new warning the build cannot place or summarise, which names the
product to look at. GitHub stops the schedule after 60 days without a commit;
the Actions tab has a button to restart it.

The masthead carries a Labs badge on every build, and the site is open to
search engines.

The site is plain static files with relative URLs, so it runs under any path
and needs no server-side code. Should it ever move to another host: serve
`index.html` with `Cache-Control: no-cache`, so a new build is seen without a
hard refresh. Everything else carries a build stamp and can be cached as long
as the server likes.
