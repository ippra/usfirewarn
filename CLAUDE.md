# US FireWarn

Static dashboard of every NWS Fire Warning (FRW) since 2006, from the Iowa
Environmental Mesonet. R / tidyverse / sf for the pipeline, hand-written
HTML, CSS and JavaScript with MapLibre for the site. Built the same way as
`ippra/okfirewarn`; when the two could differ, match it.

README.md is the reference: what the site does, the pipeline, the decisions
behind it and how it deploys. Read it before changing anything.

## Working here

- Run `Rscript 00_run_pipeline.R`, then `python3 preview.py` and look at
  http://localhost:8903. The build takes under a minute.
- `site/` is the front end source. `03_build_dashboard.R` copies it into
  `outputs/03_site/` and stamps `__BUILD__`; never edit the copy.
- `data/` and `outputs/` are gitignored and rebuilt by the pipeline.
- The guards in `02_build_warnings.R` are the point of the script. When a new
  warning trips one, read the product it names and fix the rule or the
  reference table; do not filter the warning away.
- `04_map_offices.R` is analysis for print, outside the pipeline. Its notes on
  the legend's empty-geometry layer, `quartz()` for the PDF and
  `ms_simplify()` are load-bearing; keep them.
- Deploying: the beta publishes from GitHub Actions on every push to `main`;
  the release at ippra.net/usfirewarn is copied by hand by Matt. The status
  tracker is the private repo `ippra/deployments`.
