#!/usr/bin/env python3
"""
Build the 3D building dataset for the Philadelphia Time Machine.

Sources (all official, all public):
  * Building geometry + LiDAR-derived heights
      City of Philadelphia, LI_BUILDING_FOOTPRINTS (ArcGIS FeatureServer)
      fields: max_hgt / approx_hgt (feet above grade), base_elevation, parcel_id_num
  * Construction year + storey count
      City of Philadelphia OPA "opa_properties_public" (Carto SQL API)
      joined via PWD parcels: footprint.parcel_id_num -> pwd_parcels.parcel_id
                              -> pwd_parcels.brt_id  -> opa.parcel_number

Output: data/buildings.geojson  (compact, 5-decimal coords, minimal properties)
  y  int    year built (actual, from OPA)
  e  0|1    1 = year was imputed from neighbouring buildings (no OPA record)
  h  float  height in metres above grade
  n  string building name (only when the city records one)
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

# Historic core: Delaware -> Schuylkill, Washington Ave -> Girard.
BBOX = (-75.190, 39.928, -75.132, 39.980)  # minlon, minlat, maxlon, maxlat

FOOTPRINTS = ("https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/"
              "services/LI_BUILDING_FOOTPRINTS/FeatureServer/0/query")
CARTO = "https://phl.carto.com/api/v2/sql"

FT_TO_M = 0.3048
PAGE = 2000

# Height of City Hall to the top of the William Penn statue. Nothing in
# Philadelphia was built taller until One Liberty Place in 1987.
CITY_HALL_M = 167.0

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "data", "buildings.geojson")


def get(url, params, tries=5):
    """GET with retries; returns parsed JSON."""
    qs = urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url + "?" + qs,
                headers={"User-Agent": "philadelphia-time-machine/1.0"},
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - transient network/service errors
            if attempt == tries - 1:
                raise
            print(f"    retry {attempt + 1} ({exc})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def fetch_footprints():
    """Page through the footprint service for the bbox."""
    minlon, minlat, maxlon, maxlat = BBOX
    base = {
        "where": "1=1",
        "geometry": f"{minlon},{minlat},{maxlon},{maxlat}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "parcel_id_num,approx_hgt,max_hgt,base_elevation,building_name,address",
        "geometryPrecision": "5",
        "returnGeometry": "true",
        "f": "geojson",
    }

    total = get(FOOTPRINTS, dict(base, returnCountOnly="true", f="pjson"))["count"]
    print(f"  footprints in bbox: {total:,}")

    feats, offset = [], 0
    while offset < total:
        page = get(FOOTPRINTS, dict(base, resultOffset=offset, resultRecordCount=PAGE))
        got = page.get("features", [])
        if not got:
            break
        feats.extend(got)
        offset += len(got)
        print(f"    {offset:,}/{total:,}", end="\r", flush=True)
    print(f"    fetched {len(feats):,} footprints      ")
    return feats


def norm_addr(s):
    """Loose address key: '501-35  Market St.' -> '501-35 MARKET ST'."""
    if not s:
        return ""
    return " ".join(str(s).upper().replace(".", " ").split())


def fetch_years():
    """
    Build two lookups from the assessment roll:
      by_addr[normalised address] -> year
      by_parcel[parcel_id]        -> sorted list of that parcel's years

    A single parcel often carries many OPA records, and they are not all the
    same structure. Taking the oldest record dates towers to the year of some
    long-gone building on the same lot, which is how a 178 m block ended up
    marked 1800. Matching on address first fixes that; the parcel median is
    only the fallback.
    """
    minlon, minlat, maxlon, maxlat = BBOX
    sql = f"""
        SELECT p.parcel_id,
               o.location,
               o.year_built,
               o.number_stories
        FROM pwd_parcels p
        JOIN opa_properties_public o ON o.parcel_number = p.brt_id
        WHERE p.the_geom && ST_MakeEnvelope({minlon},{minlat},{maxlon},{maxlat},4326)
          AND o.year_built ~ '^[0-9]{{4}}$'
          AND o.year_built::int BETWEEN 1650 AND 2026
    """
    rows = get(CARTO, {"q": sql})["rows"]

    by_addr, by_parcel = {}, defaultdict(list)
    for r in rows:
        year = int(r["year_built"])
        pid = r.get("parcel_id")
        if pid:
            by_parcel[pid].append(year)
        key = norm_addr(r.get("location"))
        if key:
            # Several units at one address: keep the majority year, not the oldest.
            by_addr.setdefault(key, []).append(year)

    addr = {}
    for k, years in by_addr.items():
        addr[k] = max(set(years), key=years.count)

    parcel = {}
    for k, years in by_parcel.items():
        years.sort()
        parcel[k] = years[len(years) // 2]

    print(f"  assessment records: {len(rows):,}")
    print(f"  distinct addresses: {len(addr):,}   parcels: {len(parcel):,}")
    return addr, parcel


def centroid(geom):
    """Rough centroid of the first ring of a (Multi)Polygon."""
    if geom is None:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return None
    ring = c[0] if t == "Polygon" else c[0][0] if t == "MultiPolygon" else None
    if not ring:
        return None
    sx = sum(p[0] for p in ring)
    sy = sum(p[1] for p in ring)
    return sx / len(ring), sy / len(ring)


def impute(features):
    """
    Give a year to buildings with no OPA record by taking the median year of
    the nearest dated buildings, searching outward through a ~110 m grid.
    Marked with e=1 so the UI can be honest about it.
    """
    cell = 0.001  # ~110 m
    grid = defaultdict(list)
    for f in features:
        p = f["properties"]
        if p.get("y") and p.get("_c"):
            lon, lat = p["_c"]
            grid[(int(lon / cell), int(lat / cell))].append(p["y"])

    filled = 0
    for f in features:
        p = f["properties"]
        if p.get("y") or not p.get("_c"):
            continue
        lon, lat = p["_c"]
        gx, gy = int(lon / cell), int(lat / cell)
        for radius in range(1, 7):
            near = []
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    near.extend(grid.get((gx + dx, gy + dy), ()))
            if len(near) >= 5:
                near.sort()
                p["y"] = near[len(near) // 2]
                p["e"] = 1
                filled += 1
                break
    return filled


def main():
    print("Philadelphia Time Machine - building data")
    print(f"  bbox: {BBOX}")

    raw = fetch_footprints()
    by_addr, by_parcel = fetch_years()

    features = []
    hit_addr = hit_parcel = 0
    rejected = [0]
    for f in raw:
        geom = f.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        a = f.get("properties") or {}

        # Height, in feet above grade.
        #
        # max_hgt is the raw LiDAR maximum inside the footprint, so it picks up
        # whatever overhangs it: the Shops at Liberty Place read 56 ft in
        # approx_hgt but 700 ft in max_hgt, borrowed from the tower next door.
        # approx_hgt is the curated roof height and is the trustworthy field.
        # max_hgt is only a fallback when approx_hgt is missing.
        def to_ft(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0

        approx, peak = to_ft(a.get("approx_hgt")), to_ft(a.get("max_hgt"))
        hft = approx if approx >= 2 else peak
        h = round(hft * FT_TO_M, 1)
        if h < 2:
            h = 3.5  # degenerate/missing LiDAR: assume a single storey

        props = {"h": h}

        # Address match is the reliable signal; parcel median is the fallback.
        key = norm_addr(a.get("address"))
        if key and key in by_addr:
            props["y"] = by_addr[key]
            hit_addr += 1
        else:
            pid = str(a.get("parcel_id_num") or "").strip()
            if pid in by_parcel:
                props["y"] = by_parcel[pid]
                hit_parcel += 1

        name = (a.get("building_name") or "").strip()
        if name:
            props["n"] = name

        # Reject impossible dates rather than draw them.
        #
        # OPA year_built is excellent for the rowhouse fabric but unreliable for
        # large commercial buildings, where it often records a renovation, a
        # business's founding year, or the oldest record on a shared lot.
        # (1911 Walnut is a 173 m tower of 2022 carrying an 1800 record.)
        #
        # Two checks, both grounded in documented fact rather than taste:
        #   * Nothing in the city stood above ~40 m before the steel-frame 1890s.
        #   * By long-standing convention no building exceeded City Hall's
        #     167 m until One Liberty Place broke it in 1987.
        # A footprint that violates either is mis-joined. Drop the date and let
        # the neighbour estimate fill it, flagged so the UI can say so.
        y = props.get("y")
        if y and ((y < 1890 and h > 40) or (y < 1987 and h > CITY_HALL_M)):
            del props["y"]
            rejected[0] += 1

        c = centroid(geom)
        if c:
            props["_c"] = c

        features.append({"type": "Feature", "geometry": geom, "properties": props})

    total = max(len(features), 1)
    print(f"  dated by address match: {hit_addr:,} ({hit_addr / total * 100:.1f}%)")
    print(f"  dated by parcel median: {hit_parcel:,} ({hit_parcel / total * 100:.1f}%)")
    print(f"  dates rejected as impossible (tall + pre-1890): {rejected[0]:,}")

    filled = impute(features)
    print(f"  imputed from neighbours: {filled:,}")

    kept = []
    for f in features:
        f["properties"].pop("_c", None)
        if f["properties"].get("y"):
            kept.append(f)
    print(f"  final buildings: {len(kept):,} (dropped {len(features) - len(kept):,} undatable)")

    yrs = sorted(f["properties"]["y"] for f in kept)
    print(f"  year range: {yrs[0]} - {yrs[-1]}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": kept}, fh, separators=(",", ":"))
    print(f"  wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")

    write_stats(kept)


def write_stats(features):
    """
    Precompute the per-year readouts.

    The browser needs running totals and the tallest structure for any year on
    the slider. Deriving those client-side would mean JSON.parsing the whole
    22 MB file on the main thread, which freezes the page for ~15 s. Doing it
    here lets MapLibre fetch and parse the geometry inside its own worker.
    """
    lo, hi = 1650, 2026
    n = hi - lo + 1
    built = [0] * n
    peak_h = [0.0] * n
    peak_n = [None] * n

    for f in features:
        p = f["properties"]
        i = max(0, min(n - 1, p["y"] - lo))
        built[i] += 1
        # Counts use every building, but "tallest" is a running maximum, so a
        # single bad year poisons every later year. Only buildings whose date
        # came straight from an assessment record are eligible.
        if p.get("e"):
            continue
        if p["h"] > peak_h[i]:
            peak_h[i] = p["h"]
            peak_n[i] = p.get("n")

    cumulative, tallest, tallest_name = [], [], []
    run, best_h, best_n = 0, 0.0, None
    for i in range(n):
        run += built[i]
        cumulative.append(run)
        if peak_h[i] > best_h:
            best_h, best_n = peak_h[i], peak_n[i]
        tallest.append(round(best_h, 1))
        tallest_name.append(best_n)

    out = os.path.join(HERE, os.pardir, "data", "stats.json")
    with open(out, "w") as fh:
        json.dump({
            "minYear": lo, "maxYear": hi, "total": len(features),
            "built": built, "cumulative": cumulative,
            "tallest": tallest, "tallestName": tallest_name,
        }, fh, separators=(",", ":"))
    print(f"  wrote {out} ({os.path.getsize(out) / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
