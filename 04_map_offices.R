library(tidyverse)
library(sf)

source(here::here("00_paths.R"))

# Warnings by Office -----------------------------------------------------------
# Counts Fire Warnings by issuing office and maps them onto NWS county warning
# areas, for print. Analysis, not part of the site: 00_run_pipeline.R does not
# run it. Reads 02's warnings and never touches the network.
#
# Writes outputs/04_wfo_warning_counts.csv, .pdf and .png.

warnings_file <- file.path(outputs, "02_warnings", "warnings.geojson")

if (!file.exists(warnings_file)) {
  stop("No warnings - run 02_build_warnings.R first.")
}

if (!file.exists(cwa_file)) {
  stop("No CWA boundaries at ", cwa_file, " - see 00_paths.R for the source.")
}

# issue_date is the local day the warning was issued, as the site dates it.
warnings_data <- warnings_file |>
  st_read(quiet = TRUE) |>
  st_drop_geometry() |>
  transmute(issuing_wfo = office, issue_date = archive_start + d0)

# County Warning Areas ---------------------------------------------------------
# CWA is the three-letter office id that matches issuing_wfo. Guam and the
# Pacific domains carry no CWA polygon geometry worth mapping, but they are kept
# here so the count table covers every office.
cwa_data <- cwa_file |>
  read_sf() |>
  select(
    issuing_wfo = CWA, wfo_city = CITY, wfo_state = ST, wfo_region = REGION
  )

# The boundaries carry 1.7 million vertices, county-level detail that no reader
# can see at this scale and that makes an 18 MB PDF. ms_simplify() is
# Visvalingam with shared borders preserved, so offices still tile;
# st_simplify() thins each polygon independently and opens slivers between
# them. Skipped, not required, where rmapshaper is not installed.
if (requireNamespace("rmapshaper", quietly = TRUE)) {
  cwa_data <- cwa_data |>
    rmapshaper::ms_simplify(keep = 0.02, keep_shapes = TRUE)
}

# Counts by Office -------------------------------------------------------------
wfo_counts_data <- warnings_data |>
  count(issuing_wfo, name = "n_warnings")

# Check before the join, not after - an office with no polygon would otherwise
# drop out of the map without an error.
unmatched_data <- wfo_counts_data |>
  anti_join(st_drop_geometry(cwa_data), by = "issuing_wfo")

if (nrow(unmatched_data) > 0) {
  print(unmatched_data)
  stop("Offices above have no CWA polygon - they would be dropped silently.")
}

# Offices that issued nothing are real zeros, not missing data.
wfo_warnings_data <- cwa_data |>
  left_join(wfo_counts_data, by = "issuing_wfo") |>
  mutate(n_warnings = replace_na(n_warnings, 0L)) |>
  arrange(desc(n_warnings), issuing_wfo)

# Map --------------------------------------------------------------------------
# CONUS only, in Albers equal-area (EPSG:5070). Alaska, Hawaii, the Pacific and
# Puerto Rico have never issued an FRW, so they cost the map its scale for no
# information.
#
# Counts are heavily skewed - OUN and AMA alone are over half the archive - so
# the fill is binned rather than continuous, and offices that never issued one
# get their own key rather than competing with the lowest bin for the palest
# colour. The count is printed in each office that has one, so the fill carries
# the pattern and the label carries the value.
count_breaks <- c(-1, 0, 4, 9, 24, 49, 99, Inf)
count_labels <- c("None", "1–4", "5–9", "10–24", "25–49", "50–99", "100+")

# Warm sequential ramp, sand through ember. Held apart from the neutral used for
# offices with no warnings so "none" never reads as "one or two".
count_colours <- c(
  "None"  = "#ECEAE4",
  "1–4"   = "#F7E3C3",
  "5–9"   = "#F0C382",
  "10–24" = "#E29A49",
  "25–49" = "#C9663B",
  "50–99" = "#9E3B2E",
  "100+"  = "#651F22"
)

# Publication typography, with a fallback so the script still runs where these
# faces are not installed.
font_choices <- c("Avenir Next", "Helvetica Neue", "Inter", "sans")
installed_fonts <- if (requireNamespace("systemfonts", quietly = TRUE)) {
  systemfonts::system_fonts()$family
} else {
  character()
}
map_font <- font_choices[font_choices %in% c(installed_fonts, "sans")][1]

# st_point_on_surface() rather than st_centroid(): a few CWAs are concave or
# split across islands, and a centroid can land outside the polygon it labels.
wfo_conus_data <- wfo_warnings_data |>
  filter(!wfo_region %in% c("AR", "PR"), !wfo_state %in% c("PR", "VI")) |>
  st_transform(5070) |>
  mutate(count_bin = cut(n_warnings, count_breaks, labels = count_labels))

wfo_labels_data <- wfo_conus_data |>
  filter(n_warnings > 0) |>
  mutate(
    label_colour = if_else(n_warnings >= 25, "#FFFFFF", "#4A3529"),
    geometry = st_point_on_surface(geometry)
  )

# ggplot draws no key glyph for a bin that happens to be empty - 50-99 is one
# right now - and override.aes does not bring it back. A layer of empty
# geometries, one per bin, gives every key a data row; it draws nothing on the
# map and does not touch the extent.
legend_keys <- st_sf(
  count_bin = factor(count_labels, levels = count_labels),
  geometry = st_sfc(
    rep(list(st_polygon()), length(count_labels)),
    crs = st_crs(wfo_conus_data)
  )
)

wfo_map <- wfo_conus_data |>
  ggplot() +
  geom_sf(
    aes(fill = count_bin),
    colour = "#FFFFFF",
    linewidth = 0.22,
    show.legend = FALSE
  ) +
  geom_sf(data = legend_keys, aes(fill = count_bin), key_glyph = "rect") +
  geom_sf_text(
    data = wfo_labels_data,
    aes(label = n_warnings, colour = label_colour),
    family = map_font,
    fontface = "bold",
    size = 3.1
  ) +
  scale_fill_manual(values = count_colours, name = NULL, drop = FALSE) +
  scale_colour_identity() +
  guides(
    fill = guide_legend(
      nrow = 1,
      keywidth = unit(2.2, "lines"),
      keyheight = unit(0.55, "lines"),
      label.position = "bottom"
    )
  ) +
  labs(
    title = "National Weather Service Fire Warnings by Weather Forecast Office",
    # Full dates rather than years: the archive starts and ends mid-year, so
    # "2006-2026" overstates both ends by up to a year.
    subtitle = str_c(
      "N = ", nrow(warnings_data), " warnings, ",
      format(min(warnings_data$issue_date), "%B %e, %Y") |> str_squish(),
      " – ",
      format(max(warnings_data$issue_date), "%B %e, %Y") |> str_squish()
    ),
    caption = "Source: Iowa Environmental Mesonet AFOS archive"
  ) +
  theme_void(base_family = map_font, base_size = 11) +
  theme(
    plot.title = element_text(
      size = 16, face = "bold", colour = "#241C17",
      margin = margin(b = 4)
    ),
    plot.subtitle = element_text(
      size = 10.5, colour = "#6B6259", margin = margin(b = 14)
    ),
    plot.caption = element_text(
      size = 8, colour = "#8C837A", hjust = 0, margin = margin(t = 14)
    ),
    legend.position = "bottom",
    legend.justification = "left",
    legend.text = element_text(size = 8.5, colour = "#4A443E"),
    legend.margin = margin(t = 6),
    plot.background = element_rect(fill = "#FFFFFF", colour = NA),
    plot.margin = margin(22, 22, 18, 22),
    plot.title.position = "plot",
    plot.caption.position = "plot"
  )

# Output -----------------------------------------------------------------------
# Named for the script that wrote them, so provenance is readable off the file.
wfo_warnings_data |>
  st_drop_geometry() |>
  write_csv(file.path(outputs, "04_wfo_warning_counts.csv"))

# PDF is the publication copy: vector, so boundaries and labels stay sharp at
# any size, and the font is embedded.
#
# Device choice is not incidental. The base pdf() device has no font beyond its
# own metrics and drops the en dash; cairo_pdf fails outright here with "invalid
# font type" because it cannot resolve a macOS system font. quartz() handles
# both, so use it where it exists and fall back to cairo elsewhere.
pdf_file <- file.path(outputs, "04_wfo_warning_counts.pdf")

if (capabilities("aqua")) {
  grDevices::quartz(
    file = pdf_file,
    type = "pdf",
    width = 10.5,
    height = 7,
    bg = "#FFFFFF"
  )
  # print() is required: a plot is not drawn from inside a call
  print(wfo_map)
  dev.off()
} else {
  ggsave(
    pdf_file,
    wfo_map,
    width = 10.5,
    height = 7,
    bg = "#FFFFFF",
    device = cairo_pdf
  )
}

# PNG alongside it, for a quick look and for pasting into slides. ragg renders
# the labels far more cleanly than the default png device, but is not required
# to run the script.
ggsave(
  file.path(outputs, "04_wfo_warning_counts.png"),
  wfo_map,
  width = 10.5,
  height = 7,
  dpi = 320,
  bg = "#FFFFFF",
  device = if (requireNamespace("ragg", quietly = TRUE)) ragg::agg_png else NULL
)

# Checks -----------------------------------------------------------------------
wfo_warnings_data |>
  st_drop_geometry() |>
  filter(n_warnings > 0) |>
  print(n = Inf)
