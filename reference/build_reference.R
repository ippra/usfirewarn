library(tidyverse)
library(sf)

source(here::here("00_paths.R"))

# Reference Tables -------------------------------------------------------------
# Writes the three tables in reference/ from their public sources. Run by hand
# when a source publishes a new vintage, not by the pipeline: the build reads
# the committed tables, so it needs no network beyond IEM.
#
# Sources, downloaded to data/reference_src/ when not already there:
#   Census cartographic boundary file, counties, 2023, 1:5,000,000
#     https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip
#   NWS zone-county correlation files, 18 March 2025 and 16 April 2026
#     https://www.weather.gov/gis/ZoneCounty
#   NWS county warning area boundaries, 16 April 2026 (w_16ap26)
#     https://www.weather.gov/gis/CWABounds

src_dir <- file.path(data_dir, "reference_src")
dir.create(src_dir, recursive = TRUE, showWarnings = FALSE)

fetch <- function(url, dest) {
  if (!file.exists(dest)) {
    curl::curl_download(url, dest)
  }
  dest
}

# Counties ---------------------------------------------------------------------
county_zip <- fetch(
  "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip",
  file.path(src_dir, "cb_2023_us_county_5m.zip")
)
unzip(county_zip, exdir = file.path(src_dir, "county5m"))

counties_data <- file.path(src_dir, "county5m", "cb_2023_us_county_5m.shp") |>
  read_sf() |>
  st_transform(4326) |>
  select(geoid = GEOID, name = NAME, state = STUSPS, state_fips = STATEFP)

# ms_simplify() keeps shared borders shared, so neighbouring counties still
# tile; st_simplify() thins each one alone and opens slivers between them.
counties_thin_data <- counties_data |>
  rmapshaper::ms_simplify(keep = 0.35, keep_shapes = TRUE) |>
  st_make_valid() |>
  arrange(geoid)

if (nrow(counties_thin_data) != nrow(counties_data)) {
  stop("Simplifying changed the county count.")
}

unlink(counties_reference)
counties_thin_data |>
  st_write(
    counties_reference,
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=3", "RFC7946=YES")
  )

# Zones ------------------------------------------------------------------------
zone_base <- "https://www.weather.gov/source/gis/Shapefiles/County/"
zone_vintages <- c("bp18mr25", "bp16ap26")
zone_columns <- c(
  "state", "zone", "cwa", "zone_name", "state_zone", "county", "fips",
  "time_zone", "fe_area", "lat", "lon"
)

zones_data <- zone_vintages |>
  set_names() |>
  map(\(v) {
    file <- paste0(v, ".dbx")
    fetch(paste0(zone_base, file), file.path(src_dir, file)) |>
      read_delim(
        delim = "|",
        col_names = zone_columns,
        col_types = cols(.default = col_character())
      )
  }) |>
  list_rbind(names_to = "vintage") |>
  mutate(ugc = paste0(state, "Z", zone))

# A zone number that names different counties in the two files has been reused,
# and an old warning would be drawn in the new place.
reused_data <- zones_data |>
  summarise(
    fips = paste(sort(unique(fips)), collapse = " "),
    .by = c(ugc, vintage)
  ) |>
  filter(n() == 2, n_distinct(fips) > 1, .by = ugc)

message(
  "Zones: ", n_distinct(zones_data$ugc), " across both files, ",
  n_distinct(reused_data$ugc), " covering different counties in each"
)

# The newer file's name and office win where the two differ.
zones_data |>
  arrange(ugc, fips, desc(vintage)) |>
  summarise(
    cwa = first(cwa),
    zone_name = first(zone_name),
    county = first(county),
    vintages = paste(sort(unique(vintage)), collapse = " "),
    .by = c(ugc, fips)
  ) |>
  arrange(ugc, fips) |>
  write_csv(zone_county_reference)

# Offices ----------------------------------------------------------------------
if (!file.exists(cwa_file)) {
  stop("No CWA boundaries at ", cwa_file, " - see 00_paths.R for the source.")
}

cwa_file |>
  read_sf() |>
  st_drop_geometry() |>
  distinct(office = CWA, city = CITY, state = ST, region = REGION) |>
  arrange(office) |>
  write_csv(offices_reference)
