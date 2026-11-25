/** A fixed, display-only parked truck beside the Gangnae post-office model.
 * The offset was checked against the delivered GIS polygons and depot waiting
 * slots. It does not represent a surveyed parking bay or an operating DRT.
 */
import {offsetPoint} from './service-visuals.js';

// Delivered GLB bounds, in the facility convention: right / forward, metres.
export const POSTAL_TRUCK_FOOTPRINT = Object.freeze([-1.148, -2.760, 1.148, 2.756]);
export const POSTAL_TRUCK_OFFSET = Object.freeze({right: -10, forward: 3.5});
const finite = x => typeof x === 'number' && Number.isFinite(x);

export function getPostalTruckPlacement(servicePlacements, network) {
  const depotId = String(network?.depot || 'DEPOT');
  const facility = servicePlacements?.get?.(depotId);
  const node = network?.nodes?.[depotId];
  if (!facility || facility.kind !== 'depot' || !node ||
      ![facility.lon, facility.lat, facility.heading, node.lon, node.lat].every(finite)) return null;
  const position = offsetPoint(facility, POSTAL_TRUCK_OFFSET.right, POSTAL_TRUCK_OFFSET.forward);
  return {
    id: 'parked-postal-truck', kind: 'postal-truck', asset: 'postal-truck.glb',
    ...position, heading: facility.heading, depotId,
    sourceLon: node.lon, sourceLat: node.lat,
    positionBasis: 'illustrative_parked_offset', staticScenery: true, countsAsDrt: false,
    offsetRightM: POSTAL_TRUCK_OFFSET.right, offsetForwardM: POSTAL_TRUCK_OFFSET.forward,
  };
}

/** Footprint used by geometry checks; this does not hide or alter any GIS item. */
export function postalTruckFootprint(placement, {clearanceM = 0} = {}) {
  if (!placement || ![placement.lon, placement.lat, placement.heading].every(finite)) return null;
  const gap = finite(clearanceM) ? Math.max(0, Math.min(1, clearanceM)) : 0;
  const [left, back, right, front] = POSTAL_TRUCK_FOOTPRINT;
  const ring = [[left-gap,back-gap],[right+gap,back-gap],[right+gap,front+gap],
                [left-gap,front+gap],[left-gap,back-gap]].map(([r,f]) => {
    const p = offsetPoint(placement, r, f); return [p.lon,p.lat];
  });
  return {id: placement.id, kind: 'postal-truck', origin: [placement.lon,placement.lat], ring,
    bounds: [Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),
             Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))], clearanceM: gap};
}
