# reference/

Small tables the build reads. `build_reference.R` writes all three from their
public sources; run it by hand when a source publishes a new vintage. The
pipeline reads the committed copies, so a build needs no network beyond IEM.

| file | what it is | source |
|---|---|---|
| `us_counties_2023.geojson` | every county, thinned to 35% of its vertices with shared borders kept, for warnings issued without a polygon | Census cartographic boundary file, 2023, 1:5,000,000, https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip; built 2026-10-04 |
| `zone_county.csv` | every public forecast zone and the counties it covers, for warnings that name zones; `vintages` says which NWS file lists the pair | NWS zone-county correlation files `bp18mr25.dbx` and `bp16ap26.dbx`, https://www.weather.gov/gis/ZoneCounty, combined; built 2026-10-04 |
| `offices.csv` | each forecast office's id, city, state and NWS region; a warning from an office not listed stops the build | NWS county warning area boundaries `w_16ap26`, https://www.weather.gov/gis/CWABounds; built 2026-10-04 |

Two zone files are combined because zones are renumbered between them and old
warnings keep the old numbers: NWS Tulsa split the Osage, Sequoyah and Le Flore
zones (054, 072, 076) into 154-354, 172-272 and 176-376. Across the two files
no zone number names different counties, which `build_reference.R` reports.

The county boundaries are the 2023 vintage throughout. Connecticut's planning
regions replaced its counties in 2022, so a county-coded Connecticut warning
from before then would not resolve; there is none in the archive, and one
arriving would stop the build rather than be dropped.
