#!/usr/bin/env python3
"""Import the team's actual plans/decisions without rerunning the optimiser.

Input: extracted 김민상_주차3분_실행결과_YYYY-MM-DD.zip files.
Output: browser-safe, deterministic decision replay JSON for all 42 runs.
ETA is a separately labelled calculation from committed plan order, original
directed travel times, earliest/service fields and immutable active legs.
It is checked against the original acceptance-time pickup promises.
No rejected candidate values, counterfactual waiting times or decisions are made up.

python scripts/decision_convert.py --results /path/to/gangnae_online/results
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import itertools
import json
import math
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REPOSITORY = "https://github.com/km-minsang/MetroRookies"
SOURCE_COMMIT = "62f78246e3f0547607d0b95d944a9da981699fc1"
CODE_BLOB = "e90577bfd686b4eab839e72d5e799b8856fc095e"
EPS = 1e-6


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def rows(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def fnum(value):
    if value in (None, ""):
        return None
    x = float(value)
    return x if math.isfinite(x) else None


def digest(path):
    data = Path(path).read_bytes()
    return hashlib.sha256(data).hexdigest()


class DirectedRouter:
    """The same edge choice and Dijkstra tie order as routing.py RoadRouter.

    Uses only Python's standard library. NetworkX single_source_dijkstra uses
    (distance, monotonically increasing counter, node); we use the same order.
    Shortest time paths are chosen; the distance is then summed on that path.
    Signed edge references use +/- (network.roads array index + 1).
    """
    def __init__(self, data):
        self.network = load(data / "network.json")
        self.indices = {name: node["graphIndex"] for name, node in self.network["nodes"].items()}
        self.adjacency = defaultdict(dict)
        self.cache = OrderedDict()
        self.travel_cache = {}
        features = load(data / "split_links_4326.geojson")["features"]
        roads = self.network["roads"]
        if len(features) != len(roads):
            raise ValueError("Road geometry array and split links no longer align")
        for index, (feature, road) in enumerate(zip(features, roads)):
            p = feature["properties"]
            a, b = int(p["segment_from_index"]), int(p["segment_to_index"])
            minutes, km = float(p["time_min"]), float(p["length_m"]) / 1000
            if (road["fromIndex"], road["toIndex"]) != (a, b) or abs(road["minutes"] - minutes) > EPS:
                raise ValueError(f"Road {index} topology or time mismatch")
            for u, v, edge in [(a, b, index + 1)] + ([(b, a, -(index + 1))] if p["oneway"] == 0 else []):
                old = self.adjacency[u].get(v)
                if old is None or (minutes, km) < old[:2]:
                    self.adjacency[u][v] = (minutes, km, edge)

    def paths(self, source):
        if source in self.cache:
            self.cache.move_to_end(source)
            return self.cache[source]
        count = itertools.count()
        queue = [(0.0, next(count), source)]
        seen, finished, previous = {source: 0.0}, {}, {}
        while queue:
            distance, _, node = heapq.heappop(queue)
            if node in finished:
                continue
            finished[node] = distance
            for target, edge in self.adjacency[node].items():
                proposed = distance + edge[0]
                if target in finished:
                    continue
                if target not in seen or proposed < seen[target]:
                    seen[target] = proposed
                    previous[target] = (node, edge)
                    heapq.heappush(queue, (proposed, next(count), target))
        result = (finished, previous)
        self.cache[source] = result
        if len(self.cache) > 384:
            self.cache.popitem(last=False)
        return result

    def route(self, from_node, to_node):
        key = from_node + ">" + to_node
        if key in self.travel_cache:
            return self.travel_cache[key]
        source, target = self.indices[from_node], self.indices[to_node]
        distances, previous = self.paths(source)
        if target not in distances:
            raise ValueError(f"Unreachable committed plan edge: {key}")
        node, km, edges = target, 0.0, []
        while node != source:
            predecessor, edge = previous[node]
            km += edge[1]
            edges.append(edge[2])
            node = predecessor
        edges.reverse()
        # Sum in forward traversal order, exactly as the source RoadRouter.
        node, forward_km = source, 0.0
        for edge_ref in edges:
            road = self.network["roads"][abs(edge_ref) - 1]
            target_node = road["toIndex"] if edge_ref > 0 else road["fromIndex"]
            forward_km += self.adjacency[node][target_node][1]
            node = target_node
        result = {"from": from_node, "to": to_node, "minutes": distances[target], "km": forward_km, "edges": edges}
        self.travel_cache[key] = result
        return result


def stop_record(stop, at, completed, departure, from_node, route_key, locked=False):
    record = {"kind": stop["kind"], "nodeId": stop["node"], "time": at, "completed": completed,
              "departure": departure, "from": from_node, "path": route_key, "service": stop["service"]}
    if stop.get("req_id"):
        record["requestId"] = str(stop["req_id"])
    if stop.get("hub_id"):
        record["hubId"] = stop["hub_id"]
    if stop.get("quantity"):
        record["quantity"] = stop["quantity"]
    if stop.get("manifest"):
        record["manifest"] = stop["manifest"]
        record["quantity"] = sum(pair[1] for pair in stop["manifest"])
    if locked:
        record["locked"] = True
    return record


def normalize_vehicle(raw, now, router, paths):
    node, time = raw["node"], now
    stops = []
    if raw.get("active"):
        active = raw["active"]
        stop = active["stop"]
        key = active["from_node"] + ">" + stop["node"]
        paths[key] = router.route(active["from_node"], stop["node"])
        stops.append(stop_record(stop, active["arrival"], active["completed"], active["arrival"] - active["minutes"], active["from_node"], key, True))
        node, time = stop["node"], active["completed"]
    for stop in raw["future"]:
        key = node + ">" + stop["node"]
        route = router.route(node, stop["node"])
        paths[key] = route
        at = max(time + route["minutes"], stop.get("earliest", 0), 30)
        departure = at - route["minutes"]
        stops.append(stop_record(stop, at, at + stop["service"], departure, node, key))
        node, time = stop["node"], at + stop["service"]
    return {"nodeId": raw["node"], "onboard": raw["onboard"], "cargo": raw["cargo"], "stops": stops}


def convert_one(source, canonical, router):
    plans_path = source / "plans.jsonl"
    raw_plans = [json.loads(line) for line in plans_path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    call_rows = rows(source / "decisions.csv")
    search_rows = load(source / "local_search.json")
    timings = rows(source / "optimizer_timing.csv")
    run = load(canonical)
    passengers = {str(p["id"]): p for p in run["passengers"]}
    searches_by_time = defaultdict(list)
    for item in search_rows:
        searches_by_time[round(item["time_min"], 8)].append({
            "tested": item["tested"], "initialScore": item["initial_score"],
            "finalScore": item["final_score"], "acceptedMoves": item["accepted_moves"]})
    timing_by_time = {round(float(item["time_min"]), 8): item for item in timings}
    paths, snapshots, calls = {}, [], []
    for index, item in enumerate(raw_plans):
        now = item["time_min"]
        timing = timing_by_time.get(round(now, 8), {})
        snapshot = {"id": index, "time": now, "trigger": item["trigger"],
                    "vehicles": {vid: normalize_vehicle(raw, now, router, paths) for vid, raw in item["vehicles"].items()},
                    "revealedIds": item["revealed_ids"]}
        search = searches_by_time.get(round(now, 8))
        if search:
            snapshot["search"] = {"tested": sum(s["tested"] for s in search), "initialScore": search[0]["initialScore"],
                                  "finalScore": search[-1]["finalScore"],
                                  "acceptedMoves": dict(sum((Counter(s["acceptedMoves"]) for s in search), Counter()))}
        if timing:
            snapshot["optimizerSeconds"] = fnum(timing.get("seconds"))
        snapshots.append(snapshot)
    snapshots_by_time = {round(s["time"], 8): s for s in snapshots}
    promise_errors, multiple_call_times = [], Counter(round(float(c["time_min"]), 8) for c in call_rows)
    for raw in call_rows:
        now, rid = float(raw["time_min"]), str(raw["request_id"])
        passenger = passengers.get(rid)
        if passenger is None or abs(passenger["call"] - now) > EPS:
            raise ValueError(f"Canonical passenger/call mismatch {canonical.name} {rid}")
        accepted = raw["accepted"] == "True"
        vid = int(raw["vehicle"]) if raw.get("vehicle") else None
        if accepted and int(passenger["vehicle"]) != vid:
            raise ValueError(f"Vehicle assignment mismatch {canonical.name} {rid}")
        promise = fnum(raw.get("promised_pickup_min"))
        call = {"requestId": rid, "time": now, "accepted": accepted, "vehicle": vid,
                "candidatesTested": int(raw["candidates_tested"]) if raw.get("candidates_tested") else None,
                "promisedPickup": promise, "promisedWaitMin": promise - now if promise is not None else None,
                "score": json.loads(raw["score"]) if raw.get("score") else None}
        if raw.get("reason"):
            call["reason"] = raw["reason"]
        calls.append(call)
        if accepted:
            snapshot = snapshots_by_time[round(now, 8)]
            found = [s for s in snapshot["vehicles"][str(vid)]["stops"] if s.get("requestId") == rid and s["kind"] == "PU"]
            if len(found) != 1:
                raise ValueError(f"New pickup not unique in committed plan {rid}")
            error = found[0]["time"] - promise
            # Simultaneous calls are accepted in stable ID order; the final plan
            # can shift an earlier accepted promise within the source 1 min tolerance.
            tolerance = 1.0 + EPS if multiple_call_times[round(now, 8)] > 1 else EPS
            if abs(error) > tolerance:
                raise ValueError(f"Plan ETA mismatch {canonical.name} {rid}: {error}")
            promise_errors.append(abs(error))
    if len(calls) != len(run["passengers"]):
        raise ValueError(f"Missing passenger decisions {canonical.name}")
    # Independent numerical cross-check of the entire remaining fleet plan,
    # including final depot return. This is the source route_score convention:
    # the immutable active leg is excluded from both candidate scores.
    score_errors = []
    calls_by_time = defaultdict(list)
    for call in calls:
        calls_by_time[round(call["time"], 8)].append(call)
    for snapshot in snapshots:
        fleet_km, fleet_wait = 0.0, 0.0
        for vehicle in snapshot["vehicles"].values():
            node = vehicle["nodeId"]
            for stop in vehicle["stops"]:
                if not stop.get("locked"):
                    fleet_km += paths[stop["path"]]["km"]
                    if stop["kind"] == "PU":
                        passenger = passengers[stop["requestId"]]
                        fleet_wait += (stop["time"] - passenger["call"]) * passenger["people"]
                node = stop["nodeId"]
            fleet_km += router.route(node, "DEPOT")["km"]
        last_calls = calls_by_time.get(round(snapshot["time"], 8), [])
        expected = snapshot.get("search", {}).get("finalScore") or (last_calls[-1]["score"] if last_calls else None)
        if expected is None:
            continue
        if run["scenario"] == "S0":
            actual, reference = [fleet_km, fleet_wait], expected
        elif run["scenario"] == "S1":
            actual, reference = [fleet_wait, fleet_km], expected
        else:
            # S2 accounting/weight assumptions are intentionally not inferred.
            actual, reference = [fleet_km], [expected[1]]
        error = max(abs(a - b) for a, b in zip(actual, reference))
        if error > EPS:
            raise ValueError(f"Full plan score mismatch {canonical.name} {snapshot['time']}: {actual} != {reference}")
        score_errors.append(error)
    # Every committed passenger stop must refer to demand already revealed then.
    for snapshot in snapshots:
        revealed = set(map(str, snapshot["revealedIds"]))
        for vehicle in snapshot["vehicles"].values():
            for stop in vehicle["stops"]:
                rid = stop.get("requestId")
                if rid and (rid not in revealed or passengers[rid]["call"] > snapshot["time"] + EPS):
                    raise ValueError(f"Future request leaked into plan {rid}")
    output = {
        "schemaVersion": 1, "runId": run["id"], "timeOrigin": "06:00",
        "source": "original_committed_plan_log", "snapshots": snapshots, "calls": calls, "paths": paths,
        "objective": {"scenario": run["scenario"], "name": {"S0": "거리 최소화", "S1": "승객 대기시간 최소화", "S2": "통합비용 최소화"}[run["scenario"]],
                      "scoreUnits": {"S0": ["km", "인·분"], "S1": ["인·분", "km"], "S2": ["참고 비용점수", "km"]}[run["scenario"]],
                      "provisional": run["scenario"] == "S2"},
        "methodology": {
            "algorithm": "온라인 승하차 삽입 + 다회차 용량제약 VRP 국소탐색",
            "passengerDemand": "호출 시점에만 공개되는 동적 수요",
            "freightDemand": "목적지·수량 사전 확정, 08:30 작업 가능",
            "freightRouting": "하차 순서·미적재 작업의 차량 배정·적재 방문을 재계획",
            "constraints": ["여객 11명", "물류 8개", "기존 승차 약속 변경 허용 1분", "승차→하차 선후관계", "탑승객이 있으면 우체국 적재 불가", "운행 중 다음 도로 노드까지 진행 유지", "22:00 서비스 종료·22:30 복귀"],
            "wait15HardConstraint": False,
            "candidateDetailsAvailable": False,
            "insertionCandidateCountMeaning": "원본 제약 검사를 통과하여 점수 평가까지 진행한 승하차 삽입 후보 수",
            "globalOptimalityGuaranteed": False},
        "provenance": {"repository": SOURCE_REPOSITORY, "repositoryCommit": SOURCE_COMMIT, "codeGitBlob": CODE_BLOB,
                       "sourceFolder": str(source.parent.name) + "/" + source.name,
                       "plansSha256": digest(plans_path), "decisionsSha256": digest(source / "decisions.csv"),
                       "canonicalRunSha256": digest(canonical),
                       "recorded": "계획 순서·확정 차량·호출 시각·승차 약속·후보 수·국소탐색 점수 (원본 plans.jsonl / decisions.csv / local_search.json)",
                       "eta": "원본 방향성 도로 통행시간과 계획의 서비스시간으로 재계산; 승차 약속과 검증",
                       "geometry": "최단 통행시간 도로망 복원, GPS 관측 아님",
                       "before": "직전 기록 계획 중 현재 시점에 남은 작업; 동일 이벤트의 사전 후보 스냅샷은 아님",
                       "impacts": "두 기록 계획의 예정시각 차이; 특정 물류 작업의 인과적 지연값이나 미선택 후보 평가가 아님"},
        "validation": {"passed": True, "canonicalAssignmentsMatched": len(calls), "promiseChecks": len(promise_errors),
                       "maxPromiseDifferenceMin": max(promise_errors, default=0), "futureRequestLeaks": 0,
                       "fullFleetScoreChecks": len(score_errors), "maxFleetScoreDifference": max(score_errors, default=0),
                       "snapshots": len(snapshots), "paths": len(paths), "etaSource": "validated_plan_recalculation"}}
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "decisions")
    args = parser.parse_args()
    router = DirectedRouter(args.data)
    report = {"schemaVersion": 1, "sourceCommit": SOURCE_COMMIT, "runs": []}
    for canonical in sorted((args.data / "runs").glob("*.json")):
        run = load(canonical)
        folder = run["scenario"] + ("_passenger_only" if run["mode"] == "passenger_only" else "")
        source = args.results / run["date"] / folder
        out = convert_one(source, canonical, router)
        write(args.output / f'{run["id"]}.json', out)
        report["runs"].append({"id": run["id"], **out["validation"]})
        print(run["id"], out["validation"], flush=True)
    report["passed"] = all(r["passed"] for r in report["runs"])
    report["runCount"] = len(report["runs"])
    report["snapshotCount"] = sum(r["snapshots"] for r in report["runs"])
    report["passengerDecisionCount"] = sum(r["promiseChecks"] for r in report["runs"])
    report["maxPromiseDifferenceMin"] = max(r["maxPromiseDifferenceMin"] for r in report["runs"])
    report["fullFleetScoreChecks"] = sum(r["fullFleetScoreChecks"] for r in report["runs"])
    report["maxFleetScoreDifference"] = max(r["maxFleetScoreDifference"] for r in report["runs"])
    write(ROOT / "docs" / "dispatch-validation.json", report)
    print(json.dumps({k: v for k, v in report.items() if k != "runs"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
