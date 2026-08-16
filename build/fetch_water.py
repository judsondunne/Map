#!/usr/bin/env python3
"""
Fetch the water geometry used by the pre-survey ("Coaquannock") era.

Before 1682 there is no map to draw, so that era hides the modern basemap
entirely. To still show something true, it draws real terrain plus real water:

  * PHL_water                — the Delaware and Schuylkill as they are mapped today
  * HistoricStreams_Arc      — the City's record of Philadelphia's original
                               creeks, most of them long since culverted and
                               buried under the street grid

Output: data/water.geojson   (two feature groups, tagged by `kind`)
  kind = "water"  polygon, the rivers
  kind = "stream" line, a historic creek; `name` where the City records one
"""

import json
import os

from fetch_data import BBOX, get

BASE = "https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "data", "water.geojson")


def grab(service, layer, fields):
    minlon, minlat, maxlon, maxlat = BBOX
    # Reach a little past the view so river banks do not end mid-screen.
    pad = 0.02
    page = get(f"{BASE}/{service}/FeatureServer/{layer}/query", {
        "where": "1=1",
        "geometry": f"{minlon - pad},{minlat - pad},{maxlon + pad},{maxlat + pad}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": fields,
        "geometryPrecision": "5",
        "returnGeometry": "true",
        "f": "geojson",
    })
    # ArcGIS reports failures as a 200 with an "error" body. Without this the
    # script silently writes an empty layer.
    if "error" in page:
        raise RuntimeError(f"{service}/{layer}: {page['error']}")
    return page.get("features", [])


def main():
    out = []

    rivers = grab("PHL_water", 0, "*")
    for f in rivers:
        if f.get("geometry"):
            out.append({"type": "Feature", "geometry": f["geometry"],
                        "properties": {"kind": "water"}})
    print(f"  river polygons: {len(rivers):,}")

    streams = grab("HistoricStreams_Arc", 0, "name")
    for f in streams:
        if f.get("geometry"):
            name = ((f.get("properties") or {}).get("name") or "").strip()
            out.append({"type": "Feature", "geometry": f["geometry"],
                        "properties": {"kind": "stream", "name": name}})
    named = sorted({((f.get("properties") or {}).get("name") or "").strip()
                    for f in streams} - {""})
    print(f"  historic streams: {len(streams):,}")
    print(f"  named creeks: {', '.join(named) if named else '(none)'}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": out}, fh, separators=(",", ":"))
    print(f"  wrote {OUT} ({os.path.getsize(OUT) / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
