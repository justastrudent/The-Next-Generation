/**
 * Passenger feedback for replay, derived once from immutable research records.
 * A drop-off comparison uses the committed CALL snapshot at the first accepted
 * assignment. A later replan must never silently become the original baseline.
 * Pass simulationTime to the getters when displaying feedback in the UI.
 */
const EPS = 1e-7;
const HALF_SECOND_MIN = 1 / 120;
const number = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
const idOf = value => value === null || value === undefined ? '' : String(value);
const duration = minutes => minutes < .1 ? `${Math.max(0, Math.round(minutes * 60))}초` : `${minutes.toFixed(1)}분`;

function afterTime(rows, time) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].time <= time + EPS) lo = mid + 1; else hi = mid; }
  return lo;
}

function initialBaseline(passenger, acceptedCall, snapshots, acceptedCalls) {
  const callTime = number(acceptedCall?.time), passengerCall = number(passenger.call);
  if (!acceptedCall || callTime === null || passengerCall === null || callTime < passengerCall - EPS) return null;
  if (number(acceptedCall.vehicle) !== number(passenger.vehicle)) return null;
  const rid = idOf(passenger.id), vid = idOf(acceptedCall.vehicle);
  // Exact assignment-time evidence is required. Looking for the first later
  // snapshot would mislabel a revised plan if the original snapshot was absent.
  const first = afterTime(snapshots, callTime - 2 * EPS);
  for (let i = first; i < snapshots.length && snapshots[i].time <= callTime + EPS; i++) {
    const snapshot = snapshots[i];
    if (snapshot.trigger !== 'CALL' || Math.abs(snapshot.time - callTime) > EPS) continue;
    if (!Array.isArray(snapshot.revealedIds) || !snapshot.revealedIds.some(id => idOf(id) === rid)) continue;
    const stops = snapshot.vehicles?.[vid]?.stops;
    if (!Array.isArray(stops)) continue;
    const pickups = stops.filter(stop => stop.kind === 'PU' && idOf(stop.requestId) === rid);
    const dropoffs = stops.filter(stop => stop.kind === 'DO' && idOf(stop.requestId) === rid);
    if (pickups.length !== 1 || dropoffs.length !== 1) continue;
    const pickup = pickups[0], dropoff = dropoffs[0];
    const pickupTime = number(pickup.time), expectedArrival = number(dropoff.time), promise = number(acceptedCall.promisedPickup);
    if (pickupTime === null || expectedArrival === null || promise === null || pickupTime < callTime - EPS || expectedArrival < pickupTime - EPS) continue;
    if (idOf(pickup.nodeId) !== idOf(passenger.pickupNode) || idOf(dropoff.nodeId) !== idOf(passenger.dropoffNode)) continue;
    // The original converter permits a one-minute promise shift only when
    // simultaneous calls share a committed snapshot (none in the supplied runs).
    const simultaneous = acceptedCalls.filter(call => Math.abs(call.time - callTime) <= EPS).length > 1;
    if (Math.abs(pickupTime - promise) > (simultaneous ? 1 + EPS : EPS)) continue;
    return Object.freeze({
      expectedArrival, snapshotId: snapshot.id, assignedAt: callTime, vehicle: Number(acceptedCall.vehicle),
      etaSource: 'validated_plan_recalculation', reference: 'first_committed_plan_at_assignment',
      planSource: 'original_committed_plan_log'
    });
  }
  return null;
}

function unavailable(kind, rid, reason, at = null) {
  return Object.freeze({ kind, requestId: rid, available: false, valueMinutes: null, source: 'unavailable', reason,
    text: kind === 'boarding' ? '대기시간 기록 없음' : '예상 도착시각 없음',
    detail: kind === 'alighting' ? '최초 계획 확인 불가' : '', recordedArrival: at });
}

/**
 * Index is run-scoped and read-only. Rebuild after changing date/mode/scenario
 * or after validated decision data arrives; do not rebuild per animation frame.
 */
export function buildPassengerFeedbackIndex(run, decisionRun = null) {
  const passengers = new Map();
  for (const passenger of run?.passengers || []) {
    const rid = idOf(passenger.id);
    if (rid) passengers.set(rid, passenger);
  }
  const validated = !!(run?.id && decisionRun?.runId === run.id && decisionRun?.validation?.passed === true &&
    decisionRun?.source === 'original_committed_plan_log' && decisionRun?.validation?.etaSource === 'validated_plan_recalculation' &&
    Array.isArray(decisionRun.calls) && Array.isArray(decisionRun.snapshots));
  const snapshots = validated ? decisionRun.snapshots.filter(snapshot => number(snapshot.time) !== null).slice().sort((a, b) => a.time - b.time) : [];
  const acceptedCalls = validated ? decisionRun.calls.filter(call => call.accepted === true && number(call.time) !== null).slice().sort((a, b) => a.time - b.time) : [];
  const firstAssignments = new Map();
  for (const call of acceptedCalls) if (!firstAssignments.has(idOf(call.requestId))) firstAssignments.set(idOf(call.requestId), call);
  const records = new Map(), calls = [];
  let waitCount = 0, baselineCount = 0, arrivalCount = 0;
  for (const [rid, passenger] of passengers) {
    const call = number(passenger.call), pickup = number(passenger.pickup), dropoff = number(passenger.dropoff);
    const baseline = validated ? initialBaseline(passenger, firstAssignments.get(rid), snapshots, acceptedCalls) : null;
    let boarding = unavailable('boarding', rid, 'missing_recorded_wait', pickup);
    if (call !== null && pickup !== null && pickup >= call - EPS) {
      const wait = Math.max(0, pickup - call);
      boarding = Object.freeze({ kind: 'boarding', requestId: rid, available: true, valueMinutes: wait, waitMin: wait,
        source: 'recorded_passenger_log', text: wait <= EPS ? '대기 없이 탑승' : `${duration(wait)} 대기 후 탑승`,
        detail: '기록된 대기시간', call, recordedArrival: pickup });
      waitCount++;
    }
    let alighting = unavailable('alighting', rid, baseline ? 'missing_recorded_arrival' : 'missing_validated_initial_plan', dropoff);
    if (baseline) baselineCount++;
    if (baseline && dropoff !== null && pickup !== null && dropoff >= pickup - EPS) {
      const delay = dropoff - baseline.expectedArrival;
      const status = delay > HALF_SECOND_MIN ? 'late' : delay < -HALF_SECOND_MIN ? 'early' : 'on_time';
      const text = status === 'late' ? `+${duration(delay)} 지연` : status === 'early' ? `${duration(-delay)} 일찍 도착` : '예정대로 도착';
      alighting = Object.freeze({ kind: 'alighting', requestId: rid, available: true, valueMinutes: delay, delayMin: delay,
        status, source: 'recorded_arrival_vs_validated_initial_plan', text, detail: '최초 계획 대비',
        expectedArrival: baseline.expectedArrival, recordedArrival: dropoff, baseline });
      arrivalCount++;
    }
    records.set(rid, { boarding, alighting, pickup, dropoff });
    if (call !== null) calls.push(Object.freeze({ requestId: rid, id: rid, time: call, call,
      pickupNode: passenger.pickupNode, dropoffNode: passenger.dropoffNode,
      people: number(passenger.people) ?? 1, source: 'recorded_passenger_call' }));
  }
  calls.sort((a, b) => a.time - b.time || a.requestId.localeCompare(b.requestId));
  const feedback = (rid, kind, simulationTime) => {
    rid = idOf(rid);
    const record = records.get(rid);
    if (!record) return unavailable(kind, rid, 'unknown_request');
    const arrival = kind === 'boarding' ? record.pickup : record.dropoff;
    // Missing simulationTime permits offline inspection; live callers pass it.
    if (simulationTime !== undefined && (number(simulationTime) === null || arrival === null || simulationTime < arrival - EPS)) return null;
    return record[kind];
  };
  return Object.freeze({
    runId: run?.id ?? null,
    stats: Object.freeze({ passengerCount: passengers.size, waitCount, baselineCount, arrivalCount, validatedDecisionRun: validated }),
    getBoardingFeedback: (rid, simulationTime) => feedback(rid, 'boarding', simulationTime),
    getAlightingFeedback: (rid, simulationTime) => feedback(rid, 'alighting', simulationTime),
    /** Forward playback interval (from, to]; seeking/reloading resets the UI cursor. */
    callsBetween(from, to) {
      from = number(from); to = number(to);
      if (from === null || to === null || to <= from) return [];
      return calls.slice(afterTime(calls, from), afterTime(calls, to));
    }
  });
}
