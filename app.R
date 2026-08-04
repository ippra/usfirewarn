# Browse the archive ------------------------------------------------------------
# Scrolling table at the bottom; click a row to read the product text and see its
# polygon. Sources 02_build_archive.R at startup (<1s), so it always shows what is
# on disk — no separate cache to go stale. Run with:
#
#   shiny::runApp("03_explore_app.R")

library(shiny)
library(bslib)
library(DT)
library(leaflet)
library(sf)
library(dplyr)
library(stringr)

# runApp() sets the working directory to the folder holding this file, so
# everything below is found relative to it wherever the folder lives.
#
# Prefer the cached build. It is ~90 KB against 16 MB of raw text and
# shapefiles, so this is the only data file that has to be deployed — and it
# keeps the raw archive, plus tidyverse and skimr, out of the deployment.
# Falling back to a live build means a local checkout still works with no cache.
if (file.exists("frw.rds")) {
  frw <- readRDS("frw.rds")
} else {
  message("no frw.rds; building from the raw archive")
  invisible(capture.output(source("02_build_archive.R")))
}

# leaflet wants long/lat; the IEM polygons come in NAD83
frw_ll <- st_transform(frw, 4326)

# What the table shows. Row order here is the row order the click reports back,
# so keep this one row per frw row and in the same order.
frw_tbl <-
  frw |>
  st_drop_geometry() |>
  transmute(
    Issued = format(issue_time_utc, "%Y-%m-%d %H:%M"),
    PIL = product_pil,
    WFO = issuing_wfo,
    State = ugc_state,
    Polygon = if_else(has_polygon == 1, "yes", ""),
    EAS = if_else(eas_activation_requested, "yes", ""),

    # Hidden column, but DataTables still searches hidden columns — this is what
    # makes the search box match on product text. str_squish first: the text is
    # hard-wrapped at ~69 chars, so a phrase the user types on one line is often
    # split across two in the raw product and would not match otherwise.
    # ~0.5 MB for the whole archive, so sending it all to the client is fine.
    Text = str_squish(raw_text)
  )

# UI ----------------------------------------------------------------------------
ui <- page_fillable(
  title = "Fire Warning Archive",
  padding = 10,
  gap = 10,

  tags$head(tags$style(HTML("
    .product-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.35;
      white-space: pre;
      margin: 0;
    }
    .meta { font-size: 13px; margin-bottom: 10px; }
    .meta span { color: #6c757d; }
    .meta b { font-weight: 600; }
    .empty {
      display: flex; align-items: center; justify-content: center;
      height: 100%; color: #6c757d; font-size: 14px;
    }
    /* a height:100% chain through uiOutput collapses to zero unless every
       wrapper carries a height, so pin the map container explicitly */
    #map_panel { height: 100%; }
    #map_panel .leaflet-container { height: 100% !important; }
    /* the table lives in a narrow column now, so keep the cells tight */
    table.dataTable td, table.dataTable th { font-size: 12px; padding: 3px 6px; }
    .dataTables_filter input { font-size: 12px; }
  "))),

  # Left column stacks map over table; right column is the text, full height.
  layout_columns(
    col_widths = c(5, 7),

    layout_columns(
      col_widths = 12,
      row_heights = c(1, 1),
      card(
        card_header(textOutput("map_title", inline = TRUE)),
        card_body(uiOutput("map_panel", fill = TRUE), padding = 0)
      ),
      card(
        card_header("Warnings — click a row"),
        card_body(DTOutput("tbl"), padding = 5)
      )
    ),

    card(
      card_header("Product text"),
      card_body(uiOutput("text_panel"), class = "overflow-auto")
    )
  )
)

# Server ------------------------------------------------------------------------
server <- function(input, output, session) {

  output$tbl <- renderDT(
    frw_tbl,
    selection = "single",
    rownames = FALSE,
    options = list(
      paging = FALSE,
      scrollY = "100%",
      scrollX = TRUE,      # narrow column; scroll rather than squash the columns
      scrollCollapse = TRUE,
      order = list(list(0, "desc")),   # newest first
      dom = "ft",
      # hide the text column without making it unsearchable
      columnDefs = list(list(targets = 6, visible = FALSE, searchable = TRUE)),
      language = list(search = "", searchPlaceholder = "Search table + text")
    ),
    fillContainer = TRUE
  )

  # the selected frw row, or NULL when nothing is clicked yet
  picked <- reactive({
    i <- input$tbl_rows_selected
    if (length(i) == 0) NULL else frw_ll[i, ]
  })

  output$map_title <- renderText({
    if (is.null(picked())) "Polygon" else picked()$product_id
  })

  output$map_panel <- renderUI({
    if (is.null(picked())) {
      div(class = "empty", "Select a warning below.")
    } else if (picked()$has_polygon == 0) {
      # normal, not a join failure: the polygon archive only starts in 2022 and
      # most warnings are UGC-only
      div(class = "empty", "No polygon for this warning.")
    } else {
      leafletOutput("map", height = "100%")
    }
  })

  output$map <- renderLeaflet({
    req(picked())
    req(picked()$has_polygon == 1)

    bb <- st_bbox(picked())

    # Google-style basemap. Voyager is the closest free tile set to Google's road
    # map (same warm palette, roads and POI labels); Esri imagery plus a labels
    # overlay stands in for Satellite. Google's own tiles need an API key.
    leaflet(picked()) |>
      addProviderTiles(providers$CartoDB.Voyager, group = "Map") |>
      addProviderTiles(providers$Esri.WorldImagery, group = "Satellite") |>
      addProviderTiles(providers$CartoDB.VoyagerOnlyLabels, group = "Satellite") |>
      addPolygons(
        color = "#c1440e", weight = 2, opacity = 1,
        fillColor = "#e8590c", fillOpacity = 0.25
      ) |>
      addLayersControl(
        baseGroups = c("Map", "Satellite"),
        position = "topright",
        options = layersControlOptions(collapsed = FALSE)
      ) |>
      addScaleBar(position = "bottomleft",
                  options = scaleBarOptions(imperial = TRUE, metric = FALSE)) |>
      fitBounds(bb[["xmin"]], bb[["ymin"]], bb[["xmax"]], bb[["ymax"]])
  })

  output$text_panel <- renderUI({
    if (is.null(picked())) {
      return(div(class = "empty", "Select a warning below."))
    }

    d <- picked()

    tagList(
      div(
        class = "meta",
        span("Issued "), tags$b(format(d$issue_time_utc, "%Y-%m-%d %H:%M UTC")),
        if (!is.na(d$expire_time_utc))
          tagList(span(" · Expires "),
                  tags$b(format(d$expire_time_utc, "%Y-%m-%d %H:%M UTC"))),
        span(" · WFO "), tags$b(d$issuing_wfo),
        if (!is.na(d$ugc_header)) tagList(span(" · UGC "), tags$b(d$ugc_header)),
        if (isTRUE(d$eas_activation_requested)) tags$b(" · EAS requested"),
        if (isTRUE(d$revised)) tags$b(" · revised (-RRA)"),
        br(),
        tags$a(href = d$iem_url, target = "_blank", "View on IEM")
      ),
      tags$pre(class = "product-text", d$raw_text)
    )
  })
}

shinyApp(ui, server)
