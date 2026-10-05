library(tidyverse)
library(jsonlite)

source(here::here("00_paths.R"))

# Dashboard Assembly -----------------------------------------------------------
# Copies the hand-edited front end in site/ and 02's warnings into one static
# directory. Computes nothing: every warning and count is 02's.
#
# Writes outputs/03_site/ - plain static files, no server code. Preview:
#   python3 preview.py

warnings_in <- file.path(outputs, "02_warnings")
out <- file.path(outputs, "03_site")

data_files <- file.path(
  warnings_in,
  c("manifest.json", "warnings.geojson", "warning_text.json", "states.geojson")
)
if (!all(file.exists(data_files))) {
  stop("No warnings - run 02_build_warnings.R first.")
}

build <- read_json(data_files[1])$build

# Assemble ---------------------------------------------------------------------
# Built beside the live directory and swapped in at the end, so a host serving
# outputs/03_site during a scheduled refresh never sees a half-copied site.
staging <- paste0(out, ".next")
unlink(staging, recursive = TRUE)
dir.create(staging, recursive = TRUE)

invisible(file.copy(
  list.files(site_src, full.names = TRUE),
  staging,
  recursive = TRUE
))

dir.create(file.path(staging, "data"))
invisible(file.copy(data_files, file.path(staging, "data")))

# Every stamped asset URL changes with the data build, so a host may cache
# engine.js and engine.css indefinitely. index.html cannot stamp itself and
# must be served with Cache-Control: no-cache; manifest.json is fetched with a
# query string and no-store, and the other data files with the build stamp.
stamped <- c("index.html", "engine.js", "engine.css")

for (file in stamped) {
  path <- file.path(staging, file)
  read_file(path) |>
    str_replace_all(fixed("__BUILD__"), build) |>
    write_file(path)
}

# Guards -----------------------------------------------------------------------
published <- list.files(staging, recursive = TRUE, all.files = TRUE)

leaked <- published[str_detect(published, "\\.(R|csv|part|DS_Store)$")]
if (length(leaked) > 0) {
  print(leaked)
  stop("Files above do not belong in the published site.")
}

unstamped <- stamped |>
  keep(\(f) str_detect(read_file(file.path(staging, f)), fixed("__BUILD__")))
if (length(unstamped) > 0) {
  print(unstamped)
  stop("Files above still carry the __BUILD__ placeholder.")
}

unlink(out, recursive = TRUE)
invisible(file.rename(staging, out))

site_mb <- sum(file.size(file.path(out, published))) / 1e6
message(
  "Site: ", length(published), " files, ",
  round(site_mb, 1), " MB, build ", build
)
