# Run the whole thing -----------------------------------------------------------
# Refresh first (incremental: only what is not already on disk), then rebuild
# `frw` from the local archive. Either script still runs standalone.

source("01_refresh_data.R", echo = FALSE)
source("02_build_archive.R", echo = FALSE)

frw
