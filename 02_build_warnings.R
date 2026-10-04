library(tidyverse)
library(sf)
library(jsonlite)

source(here::here("00_paths.R"))

# Fire Warnings ----------------------------------------------------------------
# Gives every Fire Warning a shape, an expiry, a local time and a summary:
#
#   warnings.geojson       one feature per warning, for the map and the list
#   warning_text.json      full product text by id, fetched when a reader
#                          opens a warning or searches the text
#   states.geojson         state outlines, drawn over every base map
#   manifest.json          the build stamp, coverage and when IEM was asked
#
# Shape comes from the warning's own LAT...LON polygon where it has one - every
# warning since 2022 and some from 2017 and 2019 - and otherwise from the
# counties its UGC line names. The polygon is in the text itself, so IEM's
# separate shapefile archive, which starts in 2022, is not needed.
#
# Writes outputs/02_warnings/.

out <- file.path(outputs, "02_warnings")

files <- list.files(warnings_dir, pattern = "\\.txt$", full.names = TRUE)
if (length(files) == 0) {
  stop("No warnings at ", warnings_dir, " - run 01_refresh_warnings.R first.")
}

if (!file.exists(fetched_file)) {
  stop("No ", fetched_file, " - run 01_refresh_warnings.R first.")
}

# Offices, declared, so a warning from an office not in the table stops the
# build rather than appearing unlabeled.
offices_data <- offices_reference |>
  read_csv(col_types = cols(.default = col_character())) |>
  transmute(office, office_name = paste("NWS", city), office_state = state)

# Products write local time with the zone's abbreviation. Hours from UTC.
zone_offsets_data <- tribble(
  ~tz,   ~utc_offset,
  "EST", -5,
  "EDT", -4,
  "CST", -6,
  "CDT", -5,
  "MST", -7,
  "MDT", -6,
  "PST", -8,
  "PDT", -7
)

# Read -------------------------------------------------------------------------
# The UGC block can wrap across lines and ends at its ddhhmm purge time.
ugc_pattern <- "(?m)^([A-Z]{2}[CZ]\\d{3}[0-9A-Z>\\s-]*?\\d{6}-)"

# The issue line, "417 PM CST THU FEB 18 2016", which older products put at the
# end of the office line rather than on a line of its own.
stamp_pattern <- paste0(
  "(?i)\\d{3,4} [AP]M ([A-Z]{3}) [A-Z]{3} [A-Z]{3} \\d{1,2} \\d{4}"
)

# Some products still carry raw WMO framing: SOH and ETX bytes, CR line ends.
# Older state-level PILs are five characters padded to six, "FRWNM ".
products_data <- tibble(file = files) |>
  mutate(
    text = map_chr(file, read_file) |> str_remove_all("[\001\003\r]"),
    product_id = basename(file) |>
      str_remove("\\.txt$") |>
      str_remove_all(" "),
    pil = str_remove(product_id, "_\\d{12}$"),
    issue_utc = ymd_hm(str_extract(product_id, "\\d{12}"), tz = "UTC"),
    office = str_match(text, "(?m)^[A-Z]{4}\\d{2}\\s+K([A-Z]{3})\\s")[, 2],
    ugc_block = str_match(text, ugc_pattern)[, 2],
    tz = str_to_upper(str_match(text, stamp_pattern)[, 2])
  )

no_ugc_data <- products_data |>
  filter(is.na(ugc_block) | is.na(issue_utc))

if (nrow(no_ugc_data) > 0) {
  print(select(no_ugc_data, product_id, office))
  stop("Products above have no readable UGC line or issue time.")
}

unknown_office_data <- products_data |>
  anti_join(offices_data, by = "office")

if (nrow(unknown_office_data) > 0) {
  print(select(unknown_office_data, product_id, office))
  stop("Offices above are not in ", offices_reference, ".")
}

unknown_zone_data <- products_data |>
  anti_join(zone_offsets_data, by = "tz")

if (nrow(unknown_zone_data) > 0) {
  print(select(unknown_zone_data, product_id, tz))
  stop("Products above have no issue line, or a time zone not declared here.")
}

# UGC --------------------------------------------------------------------------
# "OKZ004>007-010-OKC015-150300-": a code carries its state and type forward to
# the bare numbers after it, > is an inclusive range, and the last token is the
# purge time. Returns the expanded codes and the purge token, or NA codes when a
# token does not parse.
parse_ugc <- function(block) {
  tokens <- str_split(str_remove_all(block, "\\s"), "-")[[1]]
  tokens <- tokens[tokens != ""]
  purge <- tokens[length(tokens)]
  prefix <- NA_character_
  codes <- character()

  for (token in head(tokens, -1)) {
    m <- str_match(token, "^([A-Z]{2}[CZ])?(\\d{3})(?:>(\\d{3}))?$")
    if (is.na(m[1, 1]) || (is.na(m[1, 2]) && is.na(prefix))) {
      return(list(codes = NA_character_, purge = purge))
    }
    if (!is.na(m[1, 2])) prefix <- m[1, 2]
    from <- as.integer(m[1, 3])
    to <- if (is.na(m[1, 4])) from else as.integer(m[1, 4])
    codes <- c(codes, sprintf("%s%03d", prefix, from:to))
  }

  list(codes = codes, purge = purge)
}

warnings_data <- products_data |>
  mutate(
    ugc = map(ugc_block, parse_ugc),
    codes = map(ugc, "codes"),
    purge = map_chr(ugc, "purge")
  )

bad_ugc_data <- warnings_data |>
  filter(map_lgl(codes, \(x) anyNA(x) || length(x) == 0))

if (nrow(bad_ugc_data) > 0) {
  print(select(bad_ugc_data, product_id, ugc_block))
  stop("Products above have a UGC line that does not parse.")
}

# Times ------------------------------------------------------------------------
# The purge time gives day, hour and minute only. It takes the issue month, or
# the next month when that would fall before the issue time.
#
# A warning is dated by the calendar day where it was issued, from the zone on
# its own issue line: an evening warning in Texas is the next day in UTC.
warnings_data <- warnings_data |>
  left_join(zone_offsets_data, by = "tz") |>
  mutate(
    expire_utc = make_datetime(
      year(issue_utc), month(issue_utc),
      as.integer(str_sub(purge, 1, 2)),
      as.integer(str_sub(purge, 3, 4)),
      as.integer(str_sub(purge, 5, 6)),
      tz = "UTC"
    ),
    expire_utc = if_else(
      expire_utc < issue_utc - hours(1),
      expire_utc %m+% months(1),
      expire_utc
    ),
    local_start = as.Date(issue_utc + dhours(utc_offset)),
    local_end = as.Date(expire_utc + dhours(utc_offset))
  )

bad_expiry_data <- warnings_data |>
  filter(
    is.na(expire_utc) |
      expire_utc < issue_utc |
      expire_utc > issue_utc + days(2)
  )

if (nrow(bad_expiry_data) > 0) {
  print(select(bad_expiry_data, product_id, issue_utc, purge, expire_utc))
  stop("Warnings above expire before issue or more than two days after.")
}

# Counties ---------------------------------------------------------------------
# County codes are FIPS; zone codes go through the NWS zone-county file. Every
# code must resolve, or a warning would lose part of its area.
counties_data <- counties_reference |>
  st_read(quiet = TRUE)

state_fips_data <- counties_data |>
  st_drop_geometry() |>
  distinct(state, state_fips)

zones_data <- zone_county_reference |>
  read_csv(col_types = cols(.default = col_character())) |>
  select(codes = ugc, zone_geoid = fips)

areas_data <- warnings_data |>
  select(product_id, codes) |>
  unnest(codes) |>
  distinct() |>
  mutate(state = str_sub(codes, 1, 2), type = str_sub(codes, 3, 3)) |>
  left_join(state_fips_data, by = "state") |>
  left_join(zones_data, by = "codes", relationship = "many-to-many") |>
  mutate(
    geoid = if_else(
      type == "C",
      paste0(state_fips, str_sub(codes, 4, 6)),
      zone_geoid
    )
  ) |>
  select(product_id, codes, type, geoid) |>
  left_join(
    counties_data |> st_drop_geometry() |> select(geoid, name, state),
    by = "geoid"
  )

unresolved_data <- areas_data |>
  filter(is.na(name))

if (nrow(unresolved_data) > 0) {
  print(unresolved_data)
  stop("UGC codes above match no county or zone.")
}

# Zone numbers change: NWS Tulsa split the Osage, Sequoyah and Le Flore zones
# between the 2025 and 2026 files. A reused number would put an old warning in
# the wrong county without any code failing. A warning with a polygon is
# checked against it below; one without must name at least one of its counties.
# County codes are FIPS and cannot be misread this way; their texts often name
# only towns (Guymon, not Texas County).
squash <- \(x) str_to_upper(str_remove_all(x, "[^A-Za-z]"))

name_check_data <- areas_data |>
  filter(type == "Z") |>
  left_join(select(warnings_data, product_id, text), by = "product_id") |>
  filter(!str_detect(text, "LAT\\.\\.\\.LON")) |>
  mutate(named = str_detect(squash(text), fixed(squash(name)))) |>
  summarise(
    named = any(named),
    zones = paste(unique(codes), collapse = " "),
    .by = product_id
  ) |>
  filter(!named)

if (nrow(name_check_data) > 0) {
  print(name_check_data)
  stop("Zone-coded warnings above have no polygon and name none of the ",
       "counties their zones resolve to.")
}

# "Beckham, Roger Mills (OK); Wheeler (TX)"
area_lists_data <- areas_data |>
  distinct(product_id, geoid, name, state) |>
  arrange(product_id, state, name) |>
  summarise(
    names = paste(name, collapse = ", "),
    geoids = list(geoid),
    .by = c(product_id, state)
  ) |>
  summarise(
    states = paste(state, collapse = ","),
    areas = paste0(names, " (", state, ")", collapse = "; "),
    geoids = list(unlist(geoids)),
    .by = product_id
  )

if (nrow(area_lists_data) != nrow(warnings_data)) {
  stop("Area lists cover ", nrow(area_lists_data), " of ",
       nrow(warnings_data), " warnings.")
}

# Polygons ---------------------------------------------------------------------
# LAT...LON pairs in hundredths of a degree, longitude west and written without
# its sign; five digits past 100 degrees.
parse_polygon <- function(text) {
  body <- str_match(text, "LAT\\.\\.\\.LON((?:\\s+\\d{4,5})+)")[1, 2]
  if (is.na(body)) return(NULL)
  v <- as.numeric(str_extract_all(body, "\\d+")[[1]])
  if (length(v) %% 2 != 0 || length(v) < 6) return("bad")
  xy <- cbind(-v[c(FALSE, TRUE)] / 100, v[c(TRUE, FALSE)] / 100)
  rbind(xy, xy[1, ])
}

warnings_data <- warnings_data |>
  mutate(ring = map(text, parse_polygon))

# The contiguous states; no office outside them has issued a Fire Warning.
bad_polygons_data <- warnings_data |>
  filter(map_lgl(ring, \(r) {
    identical(r, "bad") ||
      (is.matrix(r) && (any(r[, 1] < -125 | r[, 1] > -66) ||
                          any(r[, 2] < 24 | r[, 2] > 50)))
  }))

if (nrow(bad_polygons_data) > 0) {
  print(select(bad_polygons_data, product_id))
  stop("Warnings above have a LAT...LON polygon that is malformed or outside ",
       "the contiguous states.")
}

sf_use_s2(FALSE)

unite_counties <- function(ids) {
  counties_data |>
    filter(geoid %in% ids) |>
    st_union() |>
    st_geometry()
}

warnings_data <- warnings_data |>
  left_join(area_lists_data, by = "product_id") |>
  mutate(
    has_polygon = map_lgl(ring, is.matrix),
    geometry = map2(ring, geoids, \(r, ids) {
      if (is.matrix(r)) st_make_valid(st_sfc(st_polygon(list(r))))[[1]]
      else unite_counties(ids)[[1]]
    }) |>
      st_sfc(crs = 4326)
  ) |>
  st_as_sf()

# A warning's polygon must overlap at least one county its UGC line names. This
# is the check that a zone number resolved to the right place.
misplaced_data <- warnings_data |>
  filter(has_polygon) |>
  mutate(
    overlaps = map2_lgl(geometry, geoids, \(g, ids) {
      polygon <- st_sfc(g, crs = 4326)
      any(st_intersects(polygon, unite_counties(ids), sparse = FALSE))
    })
  ) |>
  filter(!overlaps)

if (nrow(misplaced_data) > 0) {
  print(select(st_drop_geometry(misplaced_data), product_id, areas))
  stop("Warnings above have a polygon outside every county they name.")
}

# Text -------------------------------------------------------------------------
# Who asked for the warning, and what the message says. Older products put the
# agency after "at the request of" and open with a sentence saying a message
# follows, sometimes as its own paragraph and sometimes run into the message,
# so that sentence is removed. Products written in capitals are left that way
# rather than guessed into sentence case.
summarise_text <- function(text) {
  paragraphs <- str_split(text, "\\n\\s*\\n")[[1]] |> str_squish()
  stamp <- str_which(paragraphs, stamp_pattern)
  if (length(stamp) == 0) return(NA_character_)
  body <- paragraphs[-seq_len(stamp[1])]
  end <- str_which(body, "^(&&|\\$\\$|PRECAUTIONARY|LAT\\.\\.\\.LON)")
  if (length(end) > 0) body <- body[seq_len(end[1] - 1)]
  body <- body |>
    str_remove("(?i)^(\\.{3})?THE FOLLOWING MESSAGE IS.*?(\\.\\s+|$)")
  body <- body[body != ""]
  if (length(body) == 0) return(NA_character_)
  # A headline, "...Prepare to Evacuate...", is skipped for the message under
  # it, unless the headline is all there is.
  if (length(body) > 1 && str_detect(body[1], "^\\.{3}.*\\.{3}$")) {
    body <- body[-1]
  }
  # "The National Weather Service has issued..." is followed by bulleted
  # detail; the first bullet is where the fire is.
  if (length(body) > 1 && str_starts(body[2], fixed("*"))) {
    return(paste(body[1], body[2]))
  }
  # Messages relayed from county alerting systems arrive wrapped in ellipses.
  body[1] |>
    str_remove("^\\.{3}\\s*") |>
    str_remove("\\s*\\.{3,}$")
}

title_if_caps <- function(x) {
  if_else(!is.na(x) & !str_detect(x, "[a-z]"), str_to_title(x), x)
}

requested_pattern <- "(?i)REQUESTED BY (.+?) (?:RELAYED BY|\\d{3,4} [AP]M )"
request_pattern <- paste0(
  "(?i)AT THE REQUEST OF (?:THE )?(?:LOCAL )?(.+?)",
  "(?:\\.|,| RELAYED BY| AND HAS BEEN)"
)

warnings_data <- warnings_data |>
  mutate(
    flat = str_squish(text),
    requested_by = coalesce(
      str_match(flat, requested_pattern)[, 2],
      str_match(flat, request_pattern)[, 2]
    ),
    requested_by = title_if_caps(str_squish(requested_by)),
    summary = map_chr(text, summarise_text),
    eas = str_detect(flat, "(?i)EAS ACTIVATION REQUESTED")
  ) |>
  left_join(offices_data, by = "office") |>
  arrange(issue_utc, product_id)

no_summary_data <- warnings_data |>
  filter(is.na(summary))

if (nrow(no_summary_data) > 0) {
  print(select(st_drop_geometry(no_summary_data), product_id))
  stop("Warnings above have no paragraph after the issue time to summarise.")
}

message(
  "Warnings: ", nrow(warnings_data), " from ",
  n_distinct(warnings_data$office), " offices, ",
  sum(warnings_data$has_polygon), " with their own polygon, ",
  sum(!warnings_data$has_polygon), " drawn as whole counties"
)

# Write ------------------------------------------------------------------------
# Built beside the live directory and swapped in at the end, so a failed write
# leaves the last good build in place.
staging <- paste0(out, ".next")
unlink(staging, recursive = TRUE)
dir.create(staging, recursive = TRUE)

# A point inside each shape, for the dot that marks a warning when the map is
# zoomed too far out to show a polygon a few miles across.
marks <- warnings_data |>
  st_geometry() |>
  st_point_on_surface() |>
  st_coordinates()

# Times as minutes since 1970 UTC, days as local calendar days counted from
# archive_start, and each warning's own offset so the browser can print its
# local time without knowing the zone.
warnings_data |>
  mutate(lon = round(marks[, 1], 3), lat = round(marks[, 2], 3)) |>
  transmute(
    id = product_id,
    t0 = as.integer(as.numeric(issue_utc) %/% 60),
    t1 = as.integer(as.numeric(expire_utc) %/% 60),
    d0 = as.integer(local_start - archive_start),
    d1 = as.integer(local_end - archive_start),
    tz,
    off = as.integer(utc_offset * 60),
    office,
    office_name,
    states,
    areas,
    requested_by,
    summary,
    polygon = has_polygon,
    eas,
    lon,
    lat,
    url = paste0(
      "https://mesonet.agron.iastate.edu/wx/afos/p.php?pil=", pil,
      "&e=", format(issue_utc, "%Y%m%d%H%M")
    )
  ) |>
  st_write(
    file.path(staging, "warnings.geojson"),
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=4", "RFC7946=YES")
  )

warnings_data |>
  st_drop_geometry() |>
  select(product_id, text) |>
  deframe() |>
  as.list() |>
  write_json(file.path(staging, "warning_text.json"), auto_unbox = TRUE)

counties_data |>
  summarise(geometry = st_union(geometry), .by = state) |>
  st_write(
    file.path(staging, "states.geojson"),
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=3", "RFC7946=YES")
  )

# The day indexes run through today, so the timeline ends at the present even
# when the newest warning is months old.
built_utc <- Sys.time()

list(
  build = format(built_utc, "%Y%m%d%H%M%S", tz = "UTC"),
  checked_utc = read_lines(fetched_file, n_max = 1),
  epoch = format(archive_start),
  latest_day = as.integer(max(as.Date(built_utc), warnings_data$local_end) -
                            archive_start),
  total = nrow(warnings_data),
  polygons = sum(warnings_data$has_polygon),
  first_issued = format(min(warnings_data$issue_utc), "%Y-%m-%dT%H:%MZ"),
  last_issued = format(max(warnings_data$issue_utc), "%Y-%m-%dT%H:%MZ")
) |>
  write_json(
    file.path(staging, "manifest.json"),
    auto_unbox = TRUE,
    pretty = TRUE
  )

unlink(out, recursive = TRUE)
invisible(file.rename(staging, out))
