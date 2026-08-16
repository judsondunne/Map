# Philadelphia Time Machine

A scrubbable 3D model of Philadelphia's historic core, from before the city
existed to today. Drag the timeline or press play; the basemap changes to the
real survey or aerial photograph closest to that year, and the 3D buildings
appear as the timeline passes the year each one was built.

```bash
python3 serve.py
```

Then open <http://localhost:8899>.

Nothing needs installing — no npm, no build step, no API keys. MapLibre GL JS
loads from a CDN; the data files are already in `data/`.

---

## What is real here

**Every basemap is a genuine georeferenced historical document.** None of it is
illustrated, redrawn, or invented.

| Year | Document | Held by |
|---|---|---|
| pre-1682 | *reconstruction — see below* | — |
| 1682 | Thomas Holme, *Portraiture of the City of Philadelphia* | Mapwarper |
| 1776 | *Plan of the City of Philadelphia in Pennsylvania* | Mapwarper |
| 1796 | John Hills, *Plan of the city of Philadelphia and its environs* | Library of Congress `g3824p.ct001369` |
| 1814 | *Map of Philadelphia, 1814* | Mapwarper |
| 1843 | *Map of Philadelphia, 1843* | Mapwarper |
| 1860 | Hexamer & Locher Atlas | Greater Philadelphia GeoHistory Network / City of Philadelphia |
| 1875 | G. M. Hopkins City Atlas | ” |
| 1895 | G. W. Bromley Atlas | ” |
| 1910 | G. W. Bromley Atlas | ” |
| 1928 | Aerial survey (Regional Planning Federation) | City of Philadelphia |
| 1942 | Land use survey | ” |
| 1959 | Aerial survey (DVRPC) | ” |
| 1975 | Aerial survey (DVRPC) | ” |
| 1996 | Aerial photography, 6-inch | ” |
| 2025 | Aerial photography, 3-inch | ” |

**The 3D buildings are the City's own data**, not a model:

- **Shape and height** — `LI_BUILDING_FOOTPRINTS`, 66,698 LiDAR-derived
  footprints inside the historic core, with roof heights in feet above grade.
- **Construction year** — the Office of Property Assessment roll
  (`opa_properties_public`). 94.0% of footprints are dated by a direct
  street-address match, 3.9% by the median of their parcel's records, and 2.1%
  estimated from neighbouring buildings.

**The pre-1682 era draws real water on real terrain.** There is no survey map of
the site before Holme's, so that era switches the modern basemap off entirely
and shows USGS elevation relief, the two rivers, and the City's record of
Philadelphia's original creeks — Dock Creek, Pegg Run, Cohocksink, Gunner's Run
— nearly all of them long since culverted and buried under the street grid. The
woodland colour is an impression. The water and the terrain are not.

---

## What is not reliable

Worth knowing before you draw conclusions from it.

- **Survivor bias is the big one.** These are buildings *standing today*, placed
  at the year they were built. Everything demolished is missing, so early years
  show a far thinner city than really stood there. The historic basemap
  underneath is the honest record — the gap between the atlas and the extrusions
  is roughly what has been lost.
- **Assessor rounding.** OPA construction years pile up on 1920 and 1925, which
  was the assessor's default for "an old rowhouse". The 1910s–20s therefore look
  like a sharper boom than they were.
- **Large buildings are dated worst.** For big commercial structures
  `year_built` often records a renovation, a company's founding year, or the
  oldest record on a shared lot. City Hall is listed as **2015**. A 173 m tower
  at 1911 Walnut carries an **1800** record.
- **Two impossible-date checks are applied**, both grounded in fact rather than
  taste: nothing in Philadelphia stood above ~40 m before the steel-frame 1890s,
  and by long convention nothing exceeded City Hall's 167 m until One Liberty
  Place broke it in 1987. Eight footprints violate one of those; their date is
  discarded and re-estimated. The "tallest structure" readout only ever counts
  buildings dated directly from a record.
- **Heights are roofs, not spires.** `approx_hgt` is used rather than the raw
  LiDAR maximum, which borrows height from whatever overhangs a footprint — it
  reads the Shops at Liberty Place as 700 ft instead of 56 ft. The cost is that
  masts are cut: Comcast Center measures 297 m here, correct to its roof.

---

## Controls

| | |
|---|---|
| Timeline | drag it, or press play |
| Space | play / pause |
| ← → | step one year |
| Drag / scroll | pan and zoom |
| Right-drag | tilt and rotate |
| Click a building | its record: name, year, height |
| **Maps** | historic-map opacity, building opacity, colour mode |
| **3D** | buildings on/off |
| **Terr** | real elevation relief |
| **Orbit** | slow rotation |
| **?** | full source list and caveats |

---

## Layout

```
index.html          markup and the caveats dialog
app.js              eras, timeline, MapLibre setup
style.css           interface
serve.py            static server, gzips the 22 MB building file to ~2.5 MB
data/
  buildings.geojson 66,698 dated footprints   {y: year, h: metres, e: estimated, n: name}
  stats.json        per-year running totals and tallest structure
  water.geojson     rivers and historic streams  {kind: water|stream, name}
build/
  fetch_data.py     rebuilds buildings.geojson + stats.json from City APIs
  fetch_water.py    rebuilds water.geojson
```

To change the area or refresh from the City's live data, edit `BBOX` in
`build/fetch_data.py` and run both scripts:

```bash
python3 build/fetch_data.py && python3 build/fetch_water.py
```

`fetch_data.py` takes about a minute — it pages 66,698 footprints out of the
ArcGIS service 2,000 at a time.

---

## Notes on the implementation

Things that are less obvious than they look, all fixed here:

- **A zero-height extrusion is still geometry.** Setting a not-yet-built
  building's height to 0 does not hide it — it paints its roof flat on the
  ground and writes to the depth buffer, tiling the historic map with solid
  silhouettes and blacking out the terrain. Buildings that do not exist yet have
  to be removed with a *filter*. The filter steps in whole years; the height
  expression carries the smooth sub-year growth.
- **MapLibre finishes loading a style inside an animation frame**, and a
  background tab gets no animation frames. Style mutations are therefore retried
  until they succeed rather than attempted once, so a page opened in a
  background tab still works when you switch to it.

### Keeping it cheap

The timeline is deliberately frugal, because a naive version of this pegs a CPU:

- **The render loop only runs while something is moving.** Paused and
  unorbited, the page schedules no frames at all.
- **Never renders at full Retina density.** 66,698 extruded solids at a 2x pixel
  ratio means filling four times the pixels for a difference invisible on a
  building edge. Capped at 1.5x, and a frame-rate watcher drops to 1x if the
  machine still struggles, then restores it when there is headroom.
- **Colour is static.** It used to flare newly-built blocks, which meant
  re-uploading a colour attribute for all 66,698 buildings on every tick — the
  most expensive thing the timeline did. Buildings still announce themselves by
  rising out of the ground.
- **Heights update at most 12 times a second**, not once per quarter-year. At
  the fast speed the old rule fired about 140 times a second.
- **The readouts update once per whole year**, not 60 times a second to display
  the same number.
- **No map markers.** MapLibre reprojects every marker's DOM position on every
  frame; the dated landmarks live on the timeline ruler instead, where hovering
  a tick still names the event.
- **The next historic sheet is switched on 30 years early at zero opacity**, so
  its tiles are decoded before the crossfade starts — Mapwarper sheets take
  about a second per tile, and tying visibility to opacity meant a map began
  loading at the exact moment it began appearing. Per-tile fading is off too, so
  a sheet does not double-fade and shimmer as tiles land.

## Sources

- [OpenDataPhilly](https://opendataphilly.org) — footprints, parcels, hydrology,
  historic streams
- [Greater Philadelphia GeoHistory Network](https://www.philageohistory.org/geohistory/)
  — the historic atlases
- [Mapwarper](https://mapwarper.net) — the early georeferenced sheets
- [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) — USGS elevation
- [CARTO](https://carto.com/attributions) / OpenStreetMap — modern reference basemap
