/** Display-only priority for existing service models. Source GIS and simulation nodes stay intact.
 * Bounds are the exported metre dimensions in docs/service-model-validation.json / Blender XY.
 * These are model footprints, not surveyed facility boundaries or land-use classifications.
 */
const RAD=Math.PI/180, M=111320, EPS=1e-8;
export const FACILITY_MODEL_FOOTPRINTS=Object.freeze({
 depot:Object.freeze([-4,-2.9000001,4,3.505]),
 hub:Object.freeze([-3.6000001,-2.62,3.6000001,3]),
 shelter:Object.freeze([-1.75,-.825,1.75,.8580001]),
 sign:Object.freeze([-.26,-.1500001,.26,.1500001])
});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const overlap=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
function bounds(points){return points.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);}
function local(point,origin){return[(point[0]-origin[0])*M*Math.cos(origin[1]*RAD),(point[1]-origin[1])*M];}
function onSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],cross=(p[0]-a[0])*dy-(p[1]-a[1])*dx;return Math.abs(cross)<=EPS*Math.max(1,Math.hypot(dx,dy))&&p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;}
function insideRing(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
 const a=ring[j],b=ring[i];if(onSegment(p,a,b))return true;
 if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }return inside;}
function insidePolygon(p,rings){return insideRing(p,rings[0])&&!rings.slice(1).some(r=>insideRing(p,r));}
function cross(a,b,c){return(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function edgesMeet(a,b,c,d){const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
 return (abC*abD<0&&cdA*cdB<0)||onSegment(c,a,b)||onSegment(d,a,b)||onSegment(a,c,d)||onSegment(b,c,d);}

/** The model's front (+Blender Y) follows the same heading as service-visuals waiting anchors. */
export function buildFacilityPriority(placements,{clearanceM=.15}={}){
 const values=placements?.values?[...placements.values()]:Array.isArray(placements)?placements:[];
 const margin=finite(clearanceM)?Math.max(0,Math.min(.25,clearanceM)):.15;
 return values.filter(p=>finite(p.lon)&&finite(p.lat)&&FACILITY_MODEL_FOOTPRINTS[p.variant||p.kind]).map(p=>{
  const b=FACILITY_MODEL_FOOTPRINTS[p.variant||p.kind],h=(finite(p.heading)?p.heading:0)*RAD;
  const xy=[[b[0]-margin,b[1]-margin],[b[2]+margin,b[1]-margin],[b[2]+margin,b[3]+margin],[b[0]-margin,b[3]+margin]];
  const ring=xy.map(([right,forward])=>[p.lon+(right*Math.cos(h)+forward*Math.sin(h))/(M*Math.cos(p.lat*RAD)),p.lat+(-right*Math.sin(h)+forward*Math.cos(h))/M]);
  ring.push([...ring[0]]);
  return{id:String(p.id),kind:p.kind,variant:p.variant,origin:[p.lon,p.lat],ring,bounds:bounds(ring),clearanceM:margin};
 });
}

/** Returns one intersecting facility, respecting courtyards/holes and rotated model dimensions. */
export function facilityConflictForPolygon(rings,priority=[]){
 if(!Array.isArray(rings)||!rings[0]?.length)return null;
 const bb=bounds(rings[0]);
 for(const facility of priority){
  if(!overlap(bb,facility.bounds))continue;
  const polygon=rings.map(r=>r.map(p=>local(p,facility.origin))),rect=facility.ring.map(p=>local(p,facility.origin));
  if(rect.some(p=>insidePolygon(p,polygon))||polygon[0].some(p=>insideRing(p,rect)))return facility;
  for(const ring of polygon)for(let i=1;i<ring.length;i++)for(let j=1;j<rect.length;j++)if(edgesMeet(ring[i-1],ring[i],rect[j-1],rect[j]))return facility;
 }
 return null;
}

/** Only conflicting polygon components are hidden. MultiPolygon neighbours are preserved. */
export function prioritizeBuilding(building,priority=[]){
 if(!priority.length||!building?.polygons?.length)return building;
 const polygons=building.polygons.filter(rings=>!facilityConflictForPolygon(rings,priority));
 if(polygons.length===building.polygons.length)return building;
 return polygons.length?{...building,polygons}:null;
}
