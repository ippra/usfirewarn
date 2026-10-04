# Paths ------------------------------------------------------------------------
# Every script sources this so data locations are defined once. The project is
# self-contained: the raw archive is rebuilt from IEM by 01_refresh_warnings.R
# and lives under data/, which is gitignored, so nothing here needs configuring
# on a new machine.

project_root <- here::here()

data_dir <- file.path(project_root, "data")
reference_dir <- file.path(project_root, "reference")
site_src <- file.path(project_root, "site")
outputs <- file.path(project_root, "outputs")

# Source -----------------------------------------------------------------------
# NWS Fire Warnings (FRW), every office, from the Iowa Environmental Mesonet's
# text archive, which holds them from 13 January 2006. Re-pulled in full each
# refresh: the whole archive is about 550 KB and a second or two, so there is
# no local state to drift, and a correction IEM has received replaces the
# original.
# https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py
warnings_dir <- file.path(data_dir, "frw_text")
fetched_file <- file.path(warnings_dir, "fetched_utc")
frw_url <- "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"

# The dashboard's first day, and the day its day indexes count from.
archive_start <- as.Date("2006-01-01")

# Reference Tables -------------------------------------------------------------
# Sources and build dates are in reference/README.md; build_reference.R writes
# all three.

# County outlines, for warnings issued without a polygon of their own. Census
# cartographic boundary file, 2023 vintage, 1:5,000,000.
counties_reference <- file.path(reference_dir, "us_counties_2023.geojson")

# Which counties each public forecast zone covers, for warnings that name
# zones. NWS zone-county correlation files of 18 March 2025 and 16 April 2026,
# combined, because zones are renumbered between files and old warnings keep
# the old numbers.
zone_county_reference <- file.path(reference_dir, "zone_county.csv")

# The name and city of each forecast office, from the NWS county warning area
# boundary file of 16 April 2026.
offices_reference <- file.path(reference_dir, "offices.csv")

# NWS county warning area boundaries, an input to 04_map_offices.R only. 27 MB,
# so not in the repository:
# https://www.weather.gov/gis/CWABounds
cwa_file <- file.path(data_dir, "w_16ap26", "w_16ap26.shp")
