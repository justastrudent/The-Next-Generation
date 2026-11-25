#!/usr/bin/env python3
"""Convert the fixed MetroRookies execution logs to honest, seekable 3D replay data.

Reuses the team's original network preparation and directed RoadRouter algorithms.
It does NOT run the optimiser or change service timestamps, and it never makes a
straight-line substitute for an unmatched route. Intermediate positions are
network reconstructions, not recorded GPS observations.

Examples:
  python scripts/convert.py --repository /path/to/MetroRookies --output data
  python scripts/convert.py --source-dir /path/to/research_data --output data

Run from the package root. The default output is this package's data/ folder,
served beside index.html by a local HTTP server. The bundled 42 runs are ready
to replay; conversion is only needed when intentionally rebuilding the data.
"""
from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import math
import shutil
import sqlite3
import sys
import zipfile
from collections import Counter
from dataclasses import asdict
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT.parent
sys.path.insert(0, str(SCRIPT / "vendor" / "gangnae"))

REPO = "https://github.com/km-minsang/MetroRookies"
CODE_ZIP = "05_시뮬레이션코드/김민상_강내면_온라인DRT_주차3분_코드.zip"
NETWORK_PATH = "03_네트워크자료/강내면/강내우회경로/강내면_우회경로확장_검증본.gpkg"
SPEED_PATH = "03_네트워크자료/강내면/강내우회경로/강내links_확장본_속도30.csv"
CALLS_PATH = "02_청주지역자료/DRT호출데이터_청주전역_23년11월(231106-231112).xlsx"
HUBS_PATH = "04_통행+물류자료/강내면_물류 데이터.xlsx"
RESULT_DIR = "06_분석결과/김민상_주차3분_최종확정"
DATES = [f"2023-11-{day:02d}" for day in range(6, 13)]
DEPOT = (127.3616417, 36.6237876)
EPS_TIME = 1e-5  # minutes
EPS_DISTANCE = 1e-5  # km


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def read_csv(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def number(value, fallback=None):
    if value is None or str(value).strip() == "":
        return fallback
    result = float(value)
    if not math.isfinite(result):
        return fallback
    return int(result) if result.is_integer() else result


def typed(row):
    result = {}
    for key, value in row.items():
        if value in ("True", "False"):
            result[key] = value == "True"
        else:
            try:
                result[key] = number(value)
            except (ValueError, TypeError):
                result[key] = value
    return result


def literal_list(value):
    if not value:
        return None
    result = ast.literal_eval(value)
    return result if isinstance(result, list) else None


def digest(path):
    payload = Path(path).read_bytes()
    return {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
            "gitBlobSha": hashlib.sha1(b"blob " + str(len(payload)).encode() + b"\0" + payload).hexdigest()}


def extract_zip(path, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(destination):
                raise ValueError("Unsafe ZIP member: " + member.filename)
        archive.extractall(destination)


def inputs_from_args(args):
    if args.repository:
        root = args.repository.resolve()
        sources = {"network": root / NETWORK_PATH, "speeds": root / SPEED_PATH,
                   "calls": root / CALLS_PATH, "hubs": root / HUBS_PATH}
        archives = {day: root / RESULT_DIR / f"김민상_주차3분_실행결과_{day}.zip" for day in DATES}
    else:
        root = args.source_dir.resolve()
        sources = {"network": root / "network_original.gpkg", "speeds": root / "links.csv",
                   "calls": root / "calls.xlsx", "hubs": root / "logistics.xlsx"}
        archives = {day: root / f"results_{day}.zip" for day in DATES}
    for path in [*sources.values(), *archives.values()]:
        if not path.is_file():
            raise FileNotFoundError(path)
    return sources, archives


def prepare_network(sources, cache):
    """Exactly the team's prepare.py input selection, speed overlay and split logic."""
    import pandas as pd
    from data import load_drt_csv, load_hubs_xlsx, select_network, normalize_to_sqlite, build_od_link_snap

    raw, network, processed = cache / "raw", cache / "network", cache / "processed"
    for folder in (raw, network, processed):
        folder.mkdir(parents=True, exist_ok=True)
    gpkg = raw / "강내면_우회경로확장_검증본.gpkg"
    shutil.copy2(sources["network"], gpkg)
    frame = pd.read_excel(sources["calls"])
    frame = frame[frame.GOV_AREA.astype(str).str.strip().eq("강내")].copy()
    frame.to_csv(processed / "calls_source.csv", index=False, encoding="cp949")
    requests, observations, coords, calls_qa = load_drt_csv(processed / "calls_source.csv")
    hubs = load_hubs_xlsx(sources["hubs"])
    stock = {hub.id: math.ceil(hub.expected_daily) for hub in hubs}
    if sum(stock.values()) != 158 or len(requests) != 531:
        raise ValueError("Source inputs differ from the fixed 531-call / 158-parcel experiment")
    pd.DataFrame([{**asdict(hub), "quantity": stock[hub.id]} for hub in hubs]).to_csv(processed / "hubs.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame([asdict(request) for request in requests]).to_csv(processed / "requests.csv", index=False, encoding="utf-8-sig")
    coords.update({hub.id: (hub.lon, hub.lat) for hub in hubs})
    coords["DEPOT"] = DEPOT
    canonical = network / "canonical_gangnae_network.sqlite"
    report = normalize_to_sqlite(select_network(raw, network_file=gpkg), canonical,
                                 speed_file=sources["speeds"], speed_column="speed", speed_unit="kmh",
                                 node_layer="gangnae_node", link_layer="gangnae_link", require_link_geometry=True)
    od = build_od_link_snap(canonical, coords, qa_dir=network, max_snap_m=100)
    od.save(network)
    import numpy as np
    report.update(unreachable_pairs=int((~np.isfinite(od.time)).sum()), max_snap_m=max(od.snaps.values()),
                  points=len(coords), parcels=sum(stock.values()), calls=calls_qa)
    write_json(network / "network_manifest.json", report)
    return network, processed


class GeometryRouter:
    """Use the original directed shortest-time graph AND the same edge tie order."""
    def __init__(self, folder):
        from routing import RoadRouter
        from pyproj import Transformer
        self.router = RoadRouter(folder)
        self.features = read_json(folder / "split_links_4326.geojson")["features"]
        self.transformer = Transformer.from_crs(4326, 5179, always_xy=True)
        self.edges = {}
        self.cache = {}
        self.maximum_gap_m = 0.0
        for feature in self.features:
            p = feature["properties"]
            coords = feature["geometry"]["coordinates"]
            a, b = p["segment_from_index"], p["segment_to_index"]
            t, km = float(p["time_min"]), float(p["length_m"]) / 1000
            for u, v, geometry in [(a, b, coords)] + ([(b, a, coords[::-1])] if p["oneway"] == 0 else []):
                old = self.edges.get((u, v))
                if old is None or (t, km) < (old["minutes"], old["km"]):
                    self.edges[u, v] = {"minutes": t, "km": km, "coordinates": geometry, "parentLink": p["parent_link_id"]}

    def route(self, source, target):
        key = source + ">" + target
        if key in self.cache:
            return key, self.cache[key]
        u, v = self.router.node(source), self.router.node(target)
        times, paths = self.router.paths(u)
        if v not in times:
            self.cache[key] = None
            return key, None
        path = paths[v]
        minutes = times[v]
        km = sum(self.router.graph[a][b]["km"] for a, b in zip(path, path[1:]))
        coordinates, point_times, point_distances, links = [], [], [], []
        elapsed = travelled = 0.0
        for a, b in zip(path, path[1:]):
            edge = self.edges[a, b]
            points = edge["coordinates"]
            projected = [self.transformer.transform(*xy[:2]) for xy in points]
            distances = [0.0]
            for xy, nxt in zip(projected, projected[1:]):
                distances.append(distances[-1] + math.dist(xy, nxt))
            length = distances[-1]
            if coordinates:
                old_xy = self.transformer.transform(*coordinates[-1])
                gap = math.dist(old_xy, projected[0])
                self.maximum_gap_m = max(self.maximum_gap_m, gap)
                if gap > 0.25:
                    raise ValueError(f"Noncontinuous path geometry: {source} -> {target}, gap {gap:.3f}m")
            for i, xy in enumerate(points):
                if i == 0 and coordinates:
                    continue
                coordinates.append([round(float(xy[0]), 8), round(float(xy[1]), 8)])
                point_times.append(elapsed + edge["minutes"] * distances[i] / length if length else elapsed)
                point_distances.append(travelled + edge["km"] * distances[i] / length if length else travelled)
            elapsed += edge["minutes"]
            travelled += edge["km"]
            links.append(edge["parentLink"])
        fractions = [round(t / minutes, 10) for t in point_times] if minutes > 0 else []
        if fractions:
            fractions[0], fractions[-1] = 0, 1
        distance_fractions = [round(d / km, 10) for d in point_distances] if km > 0 else []
        if distance_fractions:
            distance_fractions[0], distance_fractions[-1] = 0, 1
        result = {"coordinates": coordinates, "fractions": fractions, "distanceFractions": distance_fractions, "minutes": minutes, "distanceKm": km,
                  "quality": "reconstructed_network", "graphNodes": path, "parentLinks": links}
        self.cache[key] = result
        return key, result


def network_for_web(folder, processed, geometry):
    with sqlite3.connect(folder / "canonical_gangnae_network.sqlite") as database:
        raw_nodes = sorted(database.execute("SELECT node_id,lon,lat FROM road_node WHERE main_component=1").fetchall(), key=lambda row: str(row[0]))
    nodes = {f"ROAD_{i}": {"lon": round(lon, 8), "lat": round(lat, 8), "label": f"도로 노드 {i}",
                            "kind": "road", "sourceNodeId": str(name), "graphIndex": i}
             for i, (name, lon, lat) in enumerate(raw_nodes)}
    hub_names = {row["id"]: row["name"] for row in read_csv(processed / "hubs.csv")}
    for row in read_csv(folder / "snap_QA.csv"):
        name = row["point_id"]
        kind = "depot" if name == "DEPOT" else "stop" if name.startswith("STOP_") else "hub"
        label = "강내우체국" if name == "DEPOT" else hub_names.get(name, "정류장 " + name.removeprefix("STOP_"))
        nodes[name] = {"lon": round(float(row["road_lon"]), 8), "lat": round(float(row["road_lat"]), 8),
                       "label": label, "kind": kind, "originalLon": float(row["source_lon"]),
                       "originalLat": float(row["source_lat"]), "snapM": float(row["snap_distance_m"]),
                       "graphIndex": geometry.router.node(name), "sourceLinkId": row["link_id"]}
    roads = [{"id": str(i), "parentLinkId": f["properties"]["parent_link_id"],
              "fromIndex": f["properties"]["segment_from_index"], "toIndex": f["properties"]["segment_to_index"],
              "oneway": f["properties"]["oneway"], "minutes": f["properties"]["time_min"],
              "coordinates": [[round(x, 8), round(y, 8)] for x, y, *_ in f["geometry"]["coordinates"]]}
             for i, f in enumerate(geometry.features)]
    return {"schemaVersion": 1, "crs": "EPSG:4326", "nodes": nodes, "roads": roads,
            "services": [name for name in nodes if not name.startswith("ROAD_")], "depot": "DEPOT",
            "scope": "Gangnae post office; no Seocheongju virtual access links",
            "positionBasis": "Source road geometry and road-projected service coordinates; not GPS observations"}


def convert_run(folder, day, scenario, mode, geometry, requests):
    run_id = f"{day}_{mode}_{scenario}"
    routes, events = {}, []
    mismatch, mapped, stationary, parking = [], 0, 0, 0
    max_dt = max_dd = 0.0
    kinds = Counter()
    for source_row, row in enumerate(read_csv(folder / "events.csv")):
        kind = row["kind"]
        kinds[kind] += 1
        event = {"id": source_row, "vehicle": number(row.get("vehicle")), "kind": kind,
                 "time": number(row["time_min"]), "completed": number(row.get("completed_min")),
                 "departure": number(row.get("departure_min")), "from": row.get("from_node") or None,
                 "to": row.get("node") or None, "distanceKm": number(row.get("distance_km")),
                 "travelMin": number(row.get("travel_min")), "passengers": number(row.get("passenger_count")),
                 "cargo": number(row.get("cargo_after_units")), "quantity": number(row.get("quantity")),
                 "requestId": row.get("request_id") or None, "hubId": row.get("hub_id") or None,
                 "pathId": None, "geometryQuality": "no_position_record",
                 "onboardIds": literal_list(row.get("onboard_ids")), "cargoIds": literal_list(row.get("cargo_ids")),
                 "passengersBefore": number(row.get("passengers_onboard_during_service")),
                 "emptyTravel": row.get("empty_travel") == "True" if row.get("empty_travel") else None,
                 "parkingInterrupted": row.get("parking_interrupted") == "True" if row.get("parking_interrupted") else None}
        if kind == "PARK_SEARCH":
            event["geometryQuality"] = "virtual_stationary"
            parking += 1
        elif event["from"] and event["to"] and event["travelMin"] is not None:
            path_id, route = geometry.route(event["from"], event["to"])
            if route is None:
                event["geometryQuality"] = "unmatched"
                mismatch.append({"event": source_row, "reason": "unreachable"})
            else:
                dt = abs(route["minutes"] - event["travelMin"])
                dd = abs(route["distanceKm"] - event["distanceKm"])
                max_dt, max_dd = max(max_dt, dt), max(max_dd, dd)
                event["pathTimeDifferenceMin"], event["pathDistanceDifferenceKm"] = dt, dd
                if dt > EPS_TIME or dd > EPS_DISTANCE:
                    event["geometryQuality"] = "unmatched"
                    mismatch.append({"event": source_row, "from": event["from"], "to": event["to"], "timeDifferenceMin": dt, "distanceDifferenceKm": dd})
                elif route["minutes"] <= 1e-12:
                    event["geometryQuality"] = "stationary_recorded"
                    stationary += 1
                else:
                    event["geometryQuality"] = "reconstructed_network"
                    event["pathId"] = path_id
                    routes[path_id] = route
                    mapped += 1
        elif event["to"]:
            event["geometryQuality"] = "stationary_recorded"
        events.append(event)
    passengers = []
    for row in read_csv(folder / "passengers.csv"):
        request = requests[row["request_id"]]
        passengers.append({"id": row["request_id"], "vehicle": number(row.get("vehicle")),
                           "call": number(row.get("call_min")), "pickup": number(row.get("pickup_min")),
                           "dropoff": number(row.get("dropoff_min")), "wait": number(row.get("wait_min")),
                           "people": number(row.get("people")), "pickupNode": request["pickup"],
                           "dropoffNode": request["dropoff"], "status": row["status"]})
    parcels = [{"id": row["parcel_id"], "vehicle": number(row.get("vehicle")), "hub": row["hub_id"],
                "loaded": number(row.get("loaded_min")), "delivered": number(row.get("delivered_min")), "status": row["status"]}
               for row in read_csv(folder / "parcels.csv")]
    validation = {"eventCount": len(events), "reconstructedMovements": mapped, "stationaryServices": stationary,
                  "virtualParkingEvents": parking, "unmatchedMovements": len(mismatch), "mismatches": mismatch,
                  "maximumTimeDifferenceMin": max_dt, "maximumDistanceDifferenceKm": max_dd,
                  "kindCounts": dict(kinds), "sourceValidation": read_json(folder / "validation.json")}
    summary = read_json(folder / "summary.json")
    summary["max_wait_min"] = max((passenger["wait"] or 0 for passenger in passengers), default=0)
    summary["wait_over_15_count"] = sum((passenger["wait"] or 0) > 15 for passenger in passengers)
    summary["electricity_estimate_krw"] = summary["total_km"] * 75.52
    summary["electricity_estimate_kwh"] = summary["total_km"] * 0.256
    return {"schemaVersion": 1, "id": run_id, "date": day, "scenario": scenario, "mode": mode,
            "timeOrigin": "06:00", "timeRange": [30, 990], "summary": summary, "events": events,
            "routes": routes, "passengers": passengers, "parcels": parcels,
            "vehicles": [typed(row) for row in read_csv(folder / "vehicles.csv")], "validation": validation}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--repository", type=Path, help="Downloaded km-minsang/MetroRookies checkout")
    source.add_argument("--source-dir", type=Path, help="Folder of standardized downloaded source files")
    parser.add_argument("--output", type=Path, default=PACKAGE_ROOT / "data",
                        help="Output data directory (default: this package's data/)")
    parser.add_argument("--cache-dir", type=Path, default=PACKAGE_ROOT / "build" / "replay-cache",
                        help="Rebuild cache directory, excluded from portable packages")
    parser.add_argument("--prepared-network", type=Path, help="Use already regenerated original data/network directory")
    parser.add_argument("--processed", type=Path, help="Matching original data/processed directory")
    args = parser.parse_args(argv)
    sources, archives = inputs_from_args(args)
    output, cache = args.output.resolve(), args.cache_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    if bool(args.prepared_network) != bool(args.processed):
        parser.error("--prepared-network and --processed must be supplied together")
    if args.prepared_network:
        network, processed = args.prepared_network.resolve(), args.processed.resolve()
    else:
        network, processed = prepare_network(sources, cache)
    for day, archive in archives.items():
        extract_zip(archive, cache / "results")
    results = cache / "results" / "gangnae_online" / "results"
    requests = {row["id"]: row for row in read_csv(processed / "requests.csv")}
    geometry = GeometryRouter(network)
    web_network = network_for_web(network, processed, geometry)
    write_json(output / "network.json", web_network)
    # These previously missing processed assets are reproducibly regenerated.
    for filename in ("split_links_4326.geojson", "snap_QA.csv"):
        shutil.copy2(network / filename, output / filename)
    for filename in ("requests.csv", "hubs.csv"):
        shutil.copy2(processed / filename, output / filename)
    descriptors, validations = [], []
    for day in DATES:
        for mode in ("integrated", "passenger_only"):
            for scenario in ("S0", "S1", "S2"):
                name = scenario + ("_passenger_only" if mode == "passenger_only" else "")
                converted = convert_run(results / day / name, day, scenario, mode, geometry, requests)
                relative = f"runs/{converted['id']}.json"
                write_json(output / relative, converted)
                descriptors.append({"id": converted["id"], "date": day, "scenario": scenario, "mode": mode,
                                    "url": "data/" + relative, "summary": converted["summary"],
                                    "eventCount": len(converted["events"]), "unmatchedMovements": converted["validation"]["unmatchedMovements"]})
                validations.append({"id": converted["id"], **converted["validation"]})
                print(f"{converted['id']}: {len(converted['events'])} events, {converted['validation']['unmatchedMovements']} unmatched", flush=True)
    source_paths = {"network": NETWORK_PATH, "speeds": SPEED_PATH, "calls": CALLS_PATH, "hubs": HUBS_PATH}
    provenance = {"repository": REPO, "originalCode": REPO + "/blob/main/" + CODE_ZIP,
                  "sources": [{"name": key, "repositoryPath": source_paths[key], **digest(path)} for key, path in sources.items()],
                  "resultArchives": [{"date": day, "repositoryPath": f"{RESULT_DIR}/김민상_주차3분_실행결과_{day}.zip", **digest(path)} for day, path in archives.items()],
                  "algorithm": "Original prepare.py/data.py link projection and split + routing.py RoadRouter shortest travel time; no optimiser rerun",
                  "recorded": "Service arrival/completion times, vehicle assignments, passenger/cargo postservice states, travel distance/time",
                  "reconstructed": "Ordered road geometry between logged endpoints; within-link position interpolated by directed edge travel time",
                  "virtual": "PARK_SEARCH contributes logged accounting distance/time but stays at the last service node",
                  "animation": "Door, trunk, walking and box motions are illustrative choreography during logged service intervals",
                  "costs": "Electricity: total logged distance × 0.256kWh/km × 295KRW/kWh; includes virtual parking distance. S2 optimiser weights remain provisional."}
    validation = {"runs": len(validations), "events": sum(v["eventCount"] for v in validations),
                  "reconstructedMovements": sum(v["reconstructedMovements"] for v in validations),
                  "unmatchedMovements": sum(v["unmatchedMovements"] for v in validations),
                  "virtualParkingEvents": sum(v["virtualParkingEvents"] for v in validations),
                  "maximumTimeDifferenceMin": max(v["maximumTimeDifferenceMin"] for v in validations),
                  "maximumDistanceDifferenceKm": max(v["maximumDistanceDifferenceKm"] for v in validations),
                  "maximumJoinGapM": geometry.maximum_gap_m,
                  "sourceRoadNodes": 2021, "mainComponentRoadNodes": geometry.router.original_count,
                  "sourceRoadLinks": 4715, "splitRoadLinks": len(geometry.features),
                  "serviceNodes": len(geometry.router.service), "maxSnapM": max(n.get("snapM", 0) for n in web_network["nodes"].values()),
                  "tolerance": {"timeMin": EPS_TIME, "distanceKm": EPS_DISTANCE},
                  "interpretation": "Agreement validates replay reconstruction against these logs; not a claim of observed GPS, actual road accessibility, or unique historical route."}
    annual = {"S0": {"annualDistanceKm": 209877, "annualCostKrw": 43484134, "costPerKmKrw": 207.19},
              "S1": {"annualDistanceKm": 260806, "annualCostKrw": 47330294, "costPerKmKrw": 181.48},
              "S2": {"annualDistanceKm": 240322, "annualCostKrw": 45783344, "costPerKmKrw": 190.51}}
    manifest = {"schemaVersion": 1, "title": "MetroRookies 강내면 DRT 실행로그 재생", "timeOrigin": "06:00", "timezone": "Asia/Seoul",
                "dates": DATES, "scenarios": ["S0", "S1", "S2"], "modes": ["integrated", "passenger_only"],
                "networkUrl": "data/network.json", "runs": descriptors, "validation": validation, "provenance": provenance,
                "annualCostEstimates": annual,
                "costAssumptions": {"electricityKwhPerKm": 0.256, "electricityKrwPerKwh": 295, "electricityKrwPerKm": 75.52,
                                    "vehiclePurchaseKrw": 110925480, "years": 9, "residualFraction": 0.35, "vehicles": 3,
                                    "annualDays": 365, "insurancePerVehicleDayKrw": 1918, "maintenancePerVehicleDayKrw": 1370,
                                    "scope": "User-supplied annual estimates for integrated operation only; not actual costs or confirmed S2 optimisation coefficients"}}
    write_json(output / "manifest.json", manifest)
    write_json(output / "provenance.json", provenance)
    write_json(output / "validation.json", {"summary": validation, "runs": validations})
    print(json.dumps(validation, ensure_ascii=False, indent=2))
    if validation["unmatchedMovements"]:
        print("Unmatched movements are explicitly withheld from map animation.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
