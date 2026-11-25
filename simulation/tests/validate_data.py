#!/usr/bin/env python3
"""Independently compare the replay export with all 42 original result folders.

Uses only the Python standard library. It does not import the converter or run
the optimisation model. Raw execution logs remain the numerical reference.
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import math
from pathlib import Path
from typing import Any


PROJECT = Path(__file__).resolve().parents[1]
DATES = [f"2023-11-{day:02d}" for day in range(6, 13)]
SCENARIOS = ["S0", "S1", "S2"]
MODES = ["integrated", "passenger_only"]
COST_REFERENCE = {
    "S0": {"annualDistanceKm": 209877, "annualOperatingKrw": 43484134, "unitKrwPerKm": 207.19},
    "S1": {"annualDistanceKm": 260806, "annualOperatingKrw": 47330294, "unitKrwPerKm": 181.48},
    "S2": {"annualDistanceKm": 240322, "annualOperatingKrw": 45783344, "unitKrwPerKm": 190.51},
}
TOLERANCE = 1e-5


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def number(value: Any, default: Any = None) -> Any:
    if value is None or value == "":
        return default
    result = float(value)
    return result if math.isfinite(result) else default


def vehicle(value: Any) -> int | None:
    v = number(value)
    return int(v) if v is not None else None


def near(a: Any, b: Any, tolerance: float = TOLERANCE) -> bool:
    av, bv = number(a), number(b)
    if av is None or bv is None:
        return av is bv
    return abs(av - bv) <= tolerance


def metres(a: list[float], b: list[float]) -> float:
    # Local equirectangular metric; sub-metre endpoint checks in a small area.
    scale = math.cos(math.radians((a[1] + b[1]) / 2))
    return 111195 * math.hypot((a[0] - b[0]) * scale, a[1] - b[1])


def coordinate_key(coordinate: list[float]) -> tuple[float, float]:
    return round(coordinate[0], 8), round(coordinate[1], 8)


def segment_key(a: list[float], b: list[float]) -> tuple[tuple[float, float], tuple[float, float]]:
    return tuple(sorted((coordinate_key(a), coordinate_key(b))))


class Audit:
    def __init__(self) -> None:
        self.checks = 0
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def check(self, condition: bool, message: str) -> None:
        self.checks += 1
        if not condition:
            self.errors.append(message)

    def equal(self, actual: Any, expected: Any, message: str) -> None:
        self.check(actual == expected, f"{message}: {actual!r} != {expected!r}")

    def close(self, actual: Any, expected: Any, message: str, tolerance: float = TOLERANCE) -> None:
        self.check(near(actual, expected, tolerance), f"{message}: {actual!r} != {expected!r}")


def resolve_export_url(dist: Path, url: str) -> Path:
    if "://" in url or url.startswith("//"):
        raise ValueError(f"Replay data must be packaged locally: {url}")
    path = (dist / url.lstrip("/")).resolve()
    path.relative_to(dist.resolve())
    return path


def validate_network(audit: Audit, network: dict) -> set:
    nodes = network["nodes"]
    audit.equal(network.get("depot"), "DEPOT", "Gangnae depot identifier")
    audit.check("DEPOT" in nodes, "Gangnae depot is missing")
    services = set(network.get("services", []))
    audit.equal(sum(s.startswith("STOP_") for s in services), 80, "Stop count")
    audit.equal(sum(s.startswith("HUB_") for s in services), 39, "Delivery hub count")
    audit.check("DEPOT" in services, "Service registry excludes depot")
    depot = nodes["DEPOT"]
    if "originalLon" in depot and "originalLat" in depot:
        audit.close(depot["originalLon"], 127.3616417, "Original Gangnae depot longitude", 1e-7)
        audit.close(depot["originalLat"], 36.6237876, "Original Gangnae depot latitude", 1e-7)
    for key, node in nodes.items():
        audit.check(126 < node["lon"] < 129 and 35 < node["lat"] < 38, f"{key}: coordinates outside expected region")
        if "snapM" in node and node["snapM"] is not None:
            audit.check(0 <= node["snapM"] <= 100, f"{key}: source service projection exceeds 100 m")
    segments = set()
    for road in network["roads"]:
        coords = road["coordinates"]
        audit.check(len(coords) >= 2, f"Road {road['id']}: fewer than two vertices")
        for coordinate in coords:
            audit.check(len(coordinate) >= 2 and 126 < coordinate[0] < 129 and 35 < coordinate[1] < 38,
                        f"Road {road['id']}: invalid WGS84 coordinate")
        for p, q in zip(coords, coords[1:]):
            if coordinate_key(p) != coordinate_key(q):
                segments.add(segment_key(p, q))
    return segments


def validate_run(audit: Audit, run: dict, raw_folder: Path, network: dict, road_segments: set) -> dict:
    label = run["id"]
    source_events = read_csv(raw_folder / "events.csv")
    source_passengers = read_csv(raw_folder / "passengers.csv")
    source_parcels = read_csv(raw_folder / "parcels.csv")
    source_summary = read_json(raw_folder / "summary.json")
    source_vehicles = read_csv(raw_folder / "vehicles.csv")
    events = run["events"]
    audit.equal(len(events), len(source_events), f"{label}: all original rows retained")
    by_id = {int(e["id"]): e for e in events}
    audit.equal(set(by_id), set(range(len(source_events))), f"{label}: unique source event indices")
    numerical_mapping = {
        "time": "time_min", "completed": "completed_min", "departure": "departure_min",
        "distanceKm": "distance_km", "travelMin": "travel_min", "quantity": "quantity",
        "cargo": "cargo_after_units", "passengers": "passenger_count",
    }
    text_mapping = {"kind": "kind", "from": "from_node", "to": "node",
                    "requestId": "request_id", "hubId": "hub_id"}
    for index, raw in enumerate(source_events):
        if index not in by_id:
            continue
        event = by_id[index]
        tag = f"{label}/event {index}"
        audit.equal(vehicle(event.get("vehicle")), vehicle(raw.get("vehicle")), f"{tag}: vehicle")
        for key, raw_key in numerical_mapping.items():
            # Non-positional activation/global rows may use their recorded time
            # as display bounds; travel and service rows must retain all times.
            if raw.get("distance_km") in ("", None) and raw.get(raw_key) in ("", None):
                continue
            audit.close(event.get(key), raw.get(raw_key), f"{tag}: {key}")
        for key, raw_key in text_mapping.items():
            audit.equal(str(event.get(key) or ""), str(raw.get(raw_key) or ""), f"{tag}: {key}")

    summary = run["summary"]
    for key, expected in source_summary.items():
        if isinstance(expected, bool):
            audit.equal(summary.get(key), expected, f"{label}: summary {key}")
        elif isinstance(expected, (int, float)) and math.isfinite(expected):
            audit.close(summary.get(key), expected, f"{label}: summary {key}")
    movement = [e for e in events if number(e.get("distanceKm")) is not None]
    audit.close(sum(e["distanceKm"] for e in movement), source_summary["total_km"], f"{label}: total distance from event ledger")
    audit.close(sum(e["distanceKm"] for e in movement if e["kind"] == "PARK_SEARCH"),
                source_summary["parking_virtual_km"], f"{label}: virtual parking distance ledger")
    audit.close(sum(e["travelMin"] for e in movement if e["kind"] == "PARK_SEARCH"),
                source_summary["parking_search_min"], f"{label}: virtual parking time ledger")

    source_vehicle_map = {vehicle(v["vehicle"]): v for v in source_vehicles}
    people = {str(p["request_id"]): int(number(p.get("people"), 1)) for p in source_passengers}
    passenger_events: dict[tuple[str, str], dict] = {}
    route_ids_checked = set()
    used_route_ids = set()
    for vid in (1, 2, 3):
        rows = sorted((e for e in movement if vehicle(e["vehicle"]) == vid), key=lambda e: int(e["id"]))
        node = "DEPOT"
        completed = 30.0
        aboard: set[str] = set()
        cargo = 0
        distance = empty_distance = 0.0
        for event in rows:
            tag = f"{label}/vehicle {vid}/event {event['id']}"
            kind = event["kind"]
            audit.equal(event["from"], node, f"{tag}: continuous vehicle position")
            audit.check(event["departure"] >= completed - TOLERANCE, f"{tag}: depart before previous service completion")
            audit.check(event["time"] >= event["departure"] - TOLERANCE and event["completed"] >= event["time"] - TOLERANCE,
                        f"{tag}: time reversal")
            audit.close(event["time"] - event["departure"], event["travelMin"], f"{tag}: travel clock")
            audit.check(event["from"] in network["nodes"] and event["to"] in network["nodes"], f"{tag}: unresolved source node")
            if not aboard:
                empty_distance += event["distanceKm"]
            distance += event["distanceKm"]
            if kind == "PARK_SEARCH":
                audit.equal(event["from"], event["to"], f"{tag}: stationary virtual parking")
                audit.check(not aboard, f"{tag}: parking search with passengers")
                audit.close(event["distanceKm"], event["travelMin"] * 0.5, f"{tag}: virtual 30 km/h cost")
                audit.check(0 < event["travelMin"] <= 3 + TOLERANCE, f"{tag}: parking duration")
                audit.check(event.get("pathId") is None, f"{tag}: invented parking road path")
                audit.equal(event.get("geometryQuality"), "virtual_stationary", f"{tag}: parking semantics")
            elif event["distanceKm"] > 1e-8:
                path_id = event.get("pathId")
                audit.check(path_id in run["routes"], f"{tag}: missing nonzero road route")
                if path_id in run["routes"]:
                    used_route_ids.add(path_id)
                    route = run["routes"][path_id]
                    audit.equal(route.get("quality"), "reconstructed_network", f"{tag}: unresolved road geometry")
                    audit.equal(event.get("geometryQuality"), "reconstructed_network", f"{tag}: unresolved movement geometry")
                    audit.close(route["minutes"], event["travelMin"], f"{tag}: directed-route time vs saved log")
                    audit.close(route["distanceKm"], event["distanceKm"], f"{tag}: directed-route distance vs saved log")
                    coords = route["coordinates"]
                    if coords and event["from"] in network["nodes"] and event["to"] in network["nodes"]:
                        a, b = network["nodes"][event["from"]], network["nodes"][event["to"]]
                        audit.check(metres(coords[0], [a["lon"], a["lat"]]) < 0.25, f"{tag}: path start differs from recorded node")
                        audit.check(metres(coords[-1], [b["lon"], b["lat"]]) < 0.25, f"{tag}: path end differs from recorded node")
                    if path_id not in route_ids_checked:
                        route_ids_checked.add(path_id)
                        fractions = route["fractions"]
                        audit.equal(len(coords), len(fractions), f"{tag}: vertex time fraction count")
                        audit.check(len(coords) >= 2, f"{tag}: insufficient road geometry")
                        if fractions:
                            audit.close(fractions[0], 0, f"{tag}: route time origin")
                            audit.close(fractions[-1], 1, f"{tag}: route time end")
                            audit.check(all(-1e-10 <= x <= 1 + 1e-10 for x in fractions), f"{tag}: route time fraction bounds")
                            audit.check(all(a <= b + 1e-10 for a, b in zip(fractions, fractions[1:])), f"{tag}: route time reversal")
                        distance_fractions = route.get("distanceFractions")
                        if distance_fractions is not None:
                            audit.equal(len(coords), len(distance_fractions), f"{tag}: vertex distance fraction count")
                            audit.close(distance_fractions[0], 0, f"{tag}: route distance origin")
                            audit.close(distance_fractions[-1], 1, f"{tag}: route distance end")
                            audit.check(all(a <= b + 1e-10 for a, b in zip(distance_fractions, distance_fractions[1:])),
                                        f"{tag}: route distance reversal")
                        for a, b in zip(coords, coords[1:]):
                            if coordinate_key(a) != coordinate_key(b):
                                audit.check(segment_key(a, b) in road_segments, f"{tag}: segment absent from supplied road linework")
            if kind == "PU":
                request = str(event["requestId"])
                audit.check(request not in aboard, f"{tag}: duplicate passenger pickup")
                aboard.add(request)
                passenger_events[(request, "PU")] = event
            elif kind == "DO":
                request = str(event["requestId"])
                audit.check(request in aboard, f"{tag}: dropoff without pickup")
                aboard.discard(request)
                passenger_events[(request, "DO")] = event
            elif kind in ("LOAD", "RESTOCK"):
                audit.equal(event["to"], "DEPOT", f"{tag}: load outside Gangnae depot")
                audit.check(not aboard and event["time"] >= 150 - TOLERANCE, f"{tag}: depot load prerequisites")
                cargo += int(event["quantity"])
            elif kind == "DELIVER":
                cargo -= int(event["quantity"])
                audit.check(event["completed"] <= 960 + TOLERANCE, f"{tag}: delivery after service deadline")
            passengers = sum(people.get(request, 1) for request in aboard)
            audit.check(0 <= passengers <= 11 and 0 <= cargo <= 8, f"{tag}: passenger/cargo capacity")
            if event.get("passengers") is not None:
                audit.equal(event["passengers"], passengers, f"{tag}: passengers must be postservice state")
            if event.get("cargo") is not None:
                audit.equal(event["cargo"], cargo, f"{tag}: cargo conservation")
            node, completed = event["to"], event["completed"]
        audit.equal(node, "DEPOT", f"{label}/vehicle {vid}: final location")
        audit.check(not aboard and cargo == 0, f"{label}/vehicle {vid}: unfinished passengers/parcels")
        audit.check(completed <= 990 + TOLERANCE, f"{label}/vehicle {vid}: return after 22:30")
        if vid in source_vehicle_map:
            audit.close(distance, source_vehicle_map[vid]["total_km"], f"{label}/vehicle {vid}: distance ledger")
            audit.close(empty_distance, source_vehicle_map[vid]["empty_km"], f"{label}/vehicle {vid}: passenger-empty distance ledger")

    exported_passengers = {str(p["id"]): p for p in run["passengers"]}
    audit.equal(set(exported_passengers), {p["request_id"] for p in source_passengers}, f"{label}: passenger identities")
    for raw in source_passengers:
        request = raw["request_id"]
        p = exported_passengers.get(request)
        if p is None:
            continue
        for key, raw_key in {"call": "call_min", "pickup": "pickup_min", "dropoff": "dropoff_min", "wait": "wait_min", "people": "people"}.items():
            audit.close(p.get(key), raw.get(raw_key), f"{label}/passenger {request}: {key}")
        audit.equal(vehicle(p.get("vehicle")), vehicle(raw.get("vehicle")), f"{label}/passenger {request}: vehicle")
        pu, do = passenger_events.get((request, "PU")), passenger_events.get((request, "DO"))
        audit.check(pu is not None and do is not None, f"{label}/passenger {request}: missing execution events")
        if pu is not None and do is not None:
            audit.close(p["pickup"], pu["time"], f"{label}/passenger {request}: pickup metric uses arrival")
            audit.close(p["dropoff"], do["time"], f"{label}/passenger {request}: dropoff metric uses arrival")
            audit.equal(p["pickupNode"], pu["to"], f"{label}/passenger {request}: origin node")
            audit.equal(p["dropoffNode"], do["to"], f"{label}/passenger {request}: destination node")
            audit.check(p["call"] <= p["pickup"] + TOLERANCE and pu["completed"] <= p["dropoff"] + TOLERANCE,
                        f"{label}/passenger {request}: request/pickup/dropoff precedence")
    exported_parcels = {str(p["id"]): p for p in run["parcels"]}
    audit.equal(set(exported_parcels), {p["parcel_id"] for p in source_parcels}, f"{label}: parcel identities")
    for raw in source_parcels:
        parcel = exported_parcels.get(raw["parcel_id"])
        if parcel is None:
            continue
        audit.equal(parcel["hub"], raw["hub_id"], f"{label}/{parcel['id']}: delivery hub")
        audit.equal(vehicle(parcel.get("vehicle")), vehicle(raw["vehicle"]), f"{label}/{parcel['id']}: vehicle")
        audit.close(parcel["loaded"], raw["loaded_min"], f"{label}/{parcel['id']}: load completion")
        audit.close(parcel["delivered"], raw["delivered_min"], f"{label}/{parcel['id']}: delivery completion")
        audit.check(parcel["loaded"] <= parcel["delivered"] <= 960 + TOLERANCE, f"{label}/{parcel['id']}: parcel precedence")
    audit.equal(len(source_parcels), 158 if run["mode"] == "integrated" else 0, f"{label}: mode parcel count")
    return {"id": label, "sourceRows": len(source_events), "movementEvents": len(movement),
            "roadRoutes": len(route_ids_checked), "passengers": len(source_passengers), "parcels": len(source_parcels),
            "totalKm": source_summary["total_km"], "virtualParkingKm": source_summary["parking_virtual_km"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=PROJECT)
    parser.add_argument("--raw", type=Path, default=PROJECT.parent / "research_data/results/gangnae_online/results")
    parser.add_argument("--report", type=Path, default=PROJECT / "docs/validation-results.json")
    args = parser.parse_args()
    audit = Audit()
    manifest = read_json(args.dist / "data/manifest.json")
    audit.equal(manifest.get("schemaVersion"), 1, "Data schema version")
    audit.equal(manifest.get("timeOrigin"), "06:00", "Time reference")
    audit.equal(manifest.get("timezone"), "Asia/Seoul", "Display timezone")
    audit.equal(set(manifest["dates"]), set(DATES), "All seven source dates")
    expected_runs = {(d, s, m) for d in DATES for s in SCENARIOS for m in MODES}
    audit.equal({(r["date"], r["scenario"], r["mode"]) for r in manifest["runs"]}, expected_runs, "All 42 date/scenario/mode combinations")
    audit.equal(len(manifest["runs"]), 42, "Unique replay count")
    network = read_json(resolve_export_url(args.dist, manifest["networkUrl"]))
    road_segments = validate_network(audit, network)
    reports = []
    weekly = collections.defaultdict(float)
    for entry in manifest["runs"]:
        run = read_json(resolve_export_url(args.dist, entry["url"]))
        for key in ("id", "date", "scenario", "mode"):
            audit.equal(run[key], entry[key], f"Manifest/run {key} agreement")
        suffix = "_passenger_only" if run["mode"] == "passenger_only" else ""
        raw_folder = args.raw / run["date"] / (run["scenario"] + suffix)
        reports.append(validate_run(audit, run, raw_folder, network, road_segments))
        if run["mode"] == "integrated":
            weekly[run["scenario"]] += run["summary"]["total_km"]
    audit.equal(sum(r["movementEvents"] for r in reports), 18384, "All execution movement/service events retained")
    cost_report = {}
    cost_config = read_json(args.dist / "data/costs.json")
    audit.equal(cost_config["fleetSize"], 3, "Cost reference fleet size")
    audit.equal(cost_config["annualDays"], 365, "Cost reference annual operating days")
    audit.close(cost_config["kwhPerKm"], 0.256, "Cost reference electricity use")
    audit.close(cost_config["krwPerKwh"], 295, "Cost reference electricity tariff")
    audit.close(cost_config["electricityKrwPerKm"], 75.52, "Cost reference electricity coefficient")
    for scenario, reference in COST_REFERENCE.items():
        actual = cost_config["annualIntegrated"][scenario]
        for output_key, reference_key in (("distanceKm", "annualDistanceKm"), ("operatingKrw", "annualOperatingKrw"), ("krwPerKm", "unitKrwPerKm")):
            audit.close(actual[output_key], reference[reference_key], f"{scenario}: packaged annual cost {output_key}")
        audit.close(reference["annualOperatingKrw"] / reference["annualDistanceKm"], reference["unitKrwPerKm"],
                    f"{scenario}: user handover annual cost unit", 0.0051)
        audit.equal(round(weekly[scenario] / 7 * 365), reference["annualDistanceKm"], f"{scenario}: 365-day fleet distance comparison")
        cost_report[scenario] = {**reference, "weeklyReplayDistanceKm": weekly[scenario],
                                "annualDistanceFromReplayKm": weekly[scenario] / 7 * 365,
                                "calculatedUnitKrwPerKm": reference["annualOperatingKrw"] / reference["annualDistanceKm"]}
    audit.close(0.256 * 295, 75.52, "Daily electricity estimate coefficient", 1e-12)
    result = {"status": "passed" if not audit.errors else "failed", "checks": audit.checks,
              "runCount": len(reports), "errorCount": len(audit.errors), "errors": audit.errors,
              "warnings": audit.warnings, "runs": reports, "annualCostReference": cost_report,
              "electricityEstimateKrwPerKm": 75.52,
              "scope": "Export-to-original-log numerical and semantic comparison; reconstructed road linework checks. Not field validation or optimisation re-execution."}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("status", "checks", "runCount", "errorCount")}, ensure_ascii=False))
    for message in audit.errors[:20]:
        print("FAIL:", message)
    return 1 if audit.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
