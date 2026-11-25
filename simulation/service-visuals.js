/** Display-only scenery and actor staging. Never changes network nodes or event times.
 * Facility footprints/exteriors and shelter/sign choices are illustrations, not surveyed assets.
 */
const RAD=Math.PI/180;
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
const smooth=v=>{const n=clamp(v);return n*n*(3-2*n);};
export const FACILITY_MODELS=Object.freeze({depot:'service-post-office.glb',hub:'service-village-hall.glb',shelter:'service-stop-shelter.glb',sign:'service-stop-sign.glb'});
export const HUB_SQUARE_IMAGE='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#eaa66f" stroke="#122431" stroke-width="2"/></svg>');
export function distanceM(a,b){return Math.hypot((a.lon-b.lon)*111320*Math.cos((a.lat+b.lat)*RAD/2),(a.lat-b.lat)*111320);}
export function offsetPoint(p,right,forward=0){const h=(Number(p.heading)||0)*RAD;return{lon:Number(p.lon)+(right*Math.cos(h)+forward*Math.sin(h))/(111320*Math.cos(Number(p.lat)*RAD)),lat:Number(p.lat)+(-right*Math.sin(h)+forward*Math.cos(h))/111320};}
const hash=id=>[...String(id)].reduce((a,c)=>(Math.imul(a,31)+c.codePointAt(0))>>>0,7);
function local(point,origin){return{x:(point[0]-origin.lon)*111320*Math.cos(origin.lat*RAD),y:(point[1]-origin.lat)*111320};}
function roadSegment(node,segments){
 let best=null,score=Infinity;
 for(const segment of segments){const a=local(segment.a,node),b=local(segment.b,node),dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;if(len<.0001)continue;const t=clamp(-(a.x*dx+a.y*dy)/len),d=Math.hypot(a.x+dx*t,a.y+dy*t);if(d<score){score=d;best={heading:((Math.atan2(dx,dy)/RAD)%180+180)%180,distance:d};}}
 return best||{heading:0,distance:Infinity};
}
/** Returns a new Map; canonical lon/lat/IDs are copied into source fields, never overwritten. */
export function buildServicePlacements(network){
 const segments=[],byLink=new Map();
 for(const road of network?.roads||[]){const coords=road.coordinates||[],key=String(road.parentLinkId??road.id);if(!byLink.has(key))byLink.set(key,[]);for(let i=1;i<coords.length;i++){const a=coords[i-1],b=coords[i];if(!a?.slice(0,2).every(finite)||!b?.slice(0,2).every(finite))continue;const s={a,b};segments.push(s);byLink.get(key).push(s);}}
 const ids=network?.services?.length?network.services:Object.keys(network?.nodes||{}).filter(id=>!/^ROAD_/.test(id));
 const placements=new Map();
 for(const id of ids){const n=network.nodes[id];if(!n||!finite(n.lon)||!finite(n.lat))continue;const kind=id===network.depot||n.kind==='depot'?'depot':/hub/i.test(n.kind||id)?'hub':'stop';
  const nearest=roadSegment(n,byLink.get(String(n.sourceLinkId))||segments),roadHeading=nearest.heading;
  const dx=finite(n.originalLon)?(Number(n.originalLon)-n.lon)*111320*Math.cos(n.lat*RAD):0,dy=finite(n.originalLat)?(Number(n.originalLat)-n.lat)*111320:0;
  const signed=dx*Math.cos(roadHeading*RAD)-dy*Math.sin(roadHeading*RAD),side=Math.abs(signed)>.8?Math.sign(signed):hash(id)%2?1:-1;
  const variant=kind==='stop'?(hash(id)%4===0?'sign':'shelter'):kind;
  const sideM=kind==='depot'?10:kind==='hub'?8:variant==='shelter'?5.2:4.3;
  const axis={lon:Number(n.lon),lat:Number(n.lat),heading:roadHeading};let position=offsetPoint(axis,side*sideM),positionBasis='illustrative_roadside_offset';
  // Depot's supplied pre-snap point is available in the source network. Its building footprint remains illustrative.
  if(kind==='depot'&&finite(n.originalLon)&&finite(n.originalLat)&&Math.hypot(dx,dy)>=5&&Math.hypot(dx,dy)<=50){position={lon:Number(n.originalLon),lat:Number(n.originalLat)};positionBasis='supplied_depot_poi_with_illustrative_building';}
  // Nearby facilities must remain separate. Move only the visual model along the same roadside.
  if(kind!=='depot'){let shift=0;for(let tries=0;tries<8;tries++){const conflict=[...placements.values()].some(other=>distanceM(position,other)<(kind==='hub'||other.kind==='hub'||other.kind==='depot'?7:3.7));if(!conflict)break;shift+=kind==='hub'?8:4.2;position=offsetPoint(axis,side*sideM,shift);}}
  const heading=((Math.atan2(Number(n.lon)-position.lon,(Number(n.lat)-position.lat)/Math.cos(n.lat*RAD))/RAD)+360)%360;
  const facility={id:String(id),kind,variant,...position,heading,roadHeading,side,sourceLon:Number(n.lon),sourceLat:Number(n.lat),asset:FACILITY_MODELS[variant],positionBasis,facilityTypeBasis:kind==='stop'?'illustrative_deterministic_type':'illustrative_exterior',label:kind==='depot'?'강내우체국':kind==='hub'?`${n.label||id} · 물류하차지`:(n.label||id)};
  // Shelter front is -Z, i.e. forward in this heading convention; stand immediately outside its canopy.
  facility.waiting=offsetPoint(facility,0,variant==='shelter'?1.15:variant==='sign'?0.8:kind==='hub'?3.2:3.8);
  placements.set(String(id),facility);
 }
 return placements;
}
export function findServicePlacement(placements,{nodeId,lon,lat}={}){
 if(nodeId!=null&&placements?.has(String(nodeId)))return placements.get(String(nodeId));
 if(!finite(lon)||!finite(lat))return null;let found=null,distance=2;
 for(const p of placements?.values?.()||[]){const d=distanceM({lon:Number(lon),lat:Number(lat)},{lon:p.sourceLon,lat:p.sourceLat});if(d<distance){distance=d;found=p;}}
 return found;
}
export function waitingPoint(placement,index=0){return offsetPoint({...placement.waiting,heading:placement.heading},((index%3)-1)*.62,-Math.floor(index/3)*.65);}
/** One movement per logged box, briskly staged inside the original service interval.
 * Count/state updates remain owned by replay-core at event.completed.
 */
export function cargoAnimation(state){
 const a=state?.animation,kind=a?.kind;if(kind!=='loading'&&kind!=='delivery')return null;
 const quantity=Math.max(1,Math.min(8,Math.round(Number(a.quantity)||1))),duration=Number(state.event?.completed)-Number(state.event?.time);
 const seconds=finite(duration)&&duration>0?duration*60:60,elapsed=clamp(a.progress)*seconds;
 const unit=Math.min(4,seconds/(quantity+1)),doorSeconds=Math.min(2,seconds*.1),motionSeconds=Math.max(.001,Math.min(quantity*unit,seconds-2*doorSeconds)),end=doorSeconds+motionSeconds+doorSeconds;
 const open=Math.min(smooth(elapsed/doorSeconds),smooth((end-elapsed)/doorSeconds));
 const moving=elapsed>=doorSeconds&&elapsed<doorSeconds+motionSeconds,part=clamp((elapsed-doorSeconds)/motionSeconds)*quantity;
 const cycle=Math.min(quantity-1,Math.floor(part)),action=smooth(part-cycle),fraction=kind==='delivery'?action:1-action;
 return{open,action,fraction,visible:moving,cycle,quantity,visualComplete:elapsed>=end,elapsedSeconds:elapsed,visualDurationSeconds:end};
}
function localPoint(p,state){const east=(p.lon-state.lon)*111320*Math.cos(state.lat*RAD),north=(p.lat-state.lat)*111320,h=(Number(state.heading)||0)*RAD;return{right:east*Math.cos(h)-north*Math.sin(h),forward:east*Math.sin(h)+north*Math.cos(h)};}
function samplePath(points,t){let lengths=[],sum=0;for(let i=1;i<points.length;i++){const d=Math.hypot(points[i].right-points[i-1].right,points[i].forward-points[i-1].forward);lengths.push(d);sum+=d;}let distance=clamp(t)*sum;for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const p=lengths[i]?clamp(distance/lengths[i]):1,a=points[i],b=points[i+1];return{right:a.right+(b.right-a.right)*p,forward:a.forward+(b.forward-a.forward)*p,headingDelta:Math.atan2(b.right-a.right,b.forward-a.forward)/RAD};}distance-=lengths[i];}return points.at(-1);}
/** Walk from the same waiting anchor used by the standing figures to the actual side door.
 * Opposite-side stops use a short path around the rear of the van, never through its body.
 */
export function passengerPose(state,placement,index=0){
 const a=state?.animation;if(!a||!['boarding','alighting'].includes(a.kind))return null;
 const action=smooth((clamp(a.progress)-.15)/.7),outbound=a.kind==='alighting';
 const start=placement?localPoint(waitingPoint(placement,index),state):{right:5.15,forward:.15};
 const door={right:.82,forward:.15},outside={right:1.65,forward:.15};
 const around=start.forward>=0?4.2:-4.2;
 const approach=start.right<1.45?[start,{right:Math.min(-1.85,start.right),forward:around},{right:1.85,forward:around},outside,door]:[start,outside,door];
 const points=outbound?[...approach].reverse():approach,pose=samplePath(points,action),pos=offsetPoint(state,pose.right,pose.forward);
 return{...pos,heading:((Number(state.heading)||0)+pose.headingDelta+360)%360,action,visible:clamp(a.progress)<.94};
}
/** Public modern Cesium APIs only. Legacy V-World engines keep their native elevation. */
export function applyNaturalTerrain(scene){
 const globe=scene?.globe,previous={};let relief=false,detail=false;
 if(globe&&'maximumScreenSpaceError'in globe&&Number.isFinite(globe.maximumScreenSpaceError)){previous.maximumScreenSpaceError=globe.maximumScreenSpaceError;globe.maximumScreenSpaceError=Math.min(globe.maximumScreenSpaceError,1.5);detail=true;}
 if(scene&&'verticalExaggeration'in scene&&Number.isFinite(scene.verticalExaggeration)){
  try{previous.verticalExaggeration=scene.verticalExaggeration;scene.verticalExaggeration=.9;relief=scene.verticalExaggeration===.9;}catch{}
 }
 return{reliefFactor:relief?0.9:1,reliefApplied:relief,detailApplied:detail,previous};
}
export function sampledDisplayHeight(height,scene){if(!finite(height))return undefined;const factor=Number.isFinite(scene?.verticalExaggeration)?scene.verticalExaggeration:1,relative=Number.isFinite(scene?.verticalExaggerationRelativeHeight)?scene.verticalExaggerationRelativeHeight:0;return(Number(height)-relative)*factor+relative;}
