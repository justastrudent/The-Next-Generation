/** Pure geometry / provenance helpers for the supplied GIS environment. */
export const ENVIRONMENT_VERSION='2026.11.24-environment';
export const ENVIRONMENT_STYLES=Object.freeze({
 house:{wall:'#d4cec1',roof:'#657581'},
 industrial:{wall:'#b9c4c8',roof:'#667e8e'},
 apartment:{wall:'#d1d5cf',roof:'#76837b'},
 public:{wall:'#d2c4b0',roof:'#69867a'},
 commercial:{wall:'#c7c3b9',roof:'#7c807d'},
 unknown:{wall:'#b9bcb7',roof:'#7f8984'},
});
export const ROAD_STYLES=Object.freeze({paved:'#606a6d',unpaved:'#9f9580',unknown:'#78817e'});
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const METRES_LAT=111320,METRES_LON=111320*Math.cos(36.61*Math.PI/180);
export function boundsDistanceM(lon,lat,b){
 const dx=Math.max(b[0]-lon,0,lon-b[2])*METRES_LON,dy=Math.max(b[1]-lat,0,lat-b[3])*METRES_LAT;
 return Math.hypot(dx,dy);
}
export function boundsIntersect(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];}
export function pointInRing(point,ring){let yes=false;const[x,y]=point;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
 const a=ring[i],b=ring[j];if(((a[1]>y)!==(b[1]>y))&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;
 }return yes;
}
export function pointInPolygon(point,rings){return pointInRing(point,rings[0])&&!rings.slice(1).some(r=>pointInRing(point,r));}
export function elevationAt(field,lon,lat){
 if(!field)return undefined;
 const gx=(lon-field.west)/field.stepLon,gy=(lat-field.south)/field.stepLat,x=Math.floor(gx),y=Math.floor(gy);
 if(x<0||y<0||x>=field.width-1||y>=field.height-1)return undefined;
 const ids=[y*field.width+x,y*field.width+x+1,(y+1)*field.width+x,(y+1)*field.width+x+1];
 const h=ids.map(i=>field.values[i]);if(h.some(v=>!Number.isFinite(v)))return undefined;
 const u=gx-x,v=gy-y;
 return h[0]*(1-u)*(1-v)+h[1]*u*(1-v)+h[2]*(1-u)*v+h[3]*u*v;
}
export function median(values){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return undefined;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
export function displayHeight(native,scene){
 if(!Number.isFinite(native))return undefined;
 const factor=Number.isFinite(scene?.verticalExaggeration)?scene.verticalExaggeration:1;
 const relative=Number.isFinite(scene?.verticalExaggerationRelativeHeight)?scene.verticalExaggerationRelativeHeight:0;
 return relative+(native-relative)*factor;
}
/** Datum offset is local and inferred. It is never presented as a geodetic conversion. */
export function terrainBlend(native,pointHeight,offset,u,v,{maxCorrectionM=1.2,weight=.2,edgeWeight=1,bridgeDistanceM=Infinity}={}){
 if(![native,pointHeight,offset].every(Number.isFinite))return native;
 const seam=Math.sin(Math.PI*clamp(u,0,1))**2*Math.sin(Math.PI*clamp(v,0,1))**2;
 const bridge=clamp((bridgeDistanceM-12)/28,0,1);
 return native+clamp((pointHeight+offset-native)*weight,-maxCorrectionM,maxCorrectionM)*seam*edgeWeight*bridge;
}
/** Sample the original provider at the same positions as the point field before blending. */
export function createTerrainHeightmap({rectangle,field,sampleNative,size=65,maxCorrectionM=1.2,bridgeBounds=[],isWater=()=>false}){
 const deg=180/Math.PI,offsets=[];
 for(let yi=1;yi<=3;yi++)for(let xi=1;xi<=3;xi++){
  const lon=rectangle.west+(rectangle.east-rectangle.west)*xi/4,lat=rectangle.south+(rectangle.north-rectangle.south)*yi/4;
  const native=sampleNative(lon,lat),h=elevationAt(field,lon*deg,lat*deg);
  if(!isWater(xi/4,1-yi/4)&&Number.isFinite(native)&&Number.isFinite(h))offsets.push(native-h);
 }
 if(offsets.length<4)return null;
 const offset=median(offsets);if(!Number.isFinite(offset)||Math.abs(offset)>150)return null;
 const buffer=new Float32Array(size*size);let changed=0,maxDelta=0;
 const east=field.west+field.stepLon*(field.width-1),north=field.south+field.stepLat*(field.height-1);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const u=x/(size-1),v=y/(size-1),lon=rectangle.west+(rectangle.east-rectangle.west)*u,lat=rectangle.north-(rectangle.north-rectangle.south)*v;
  const native=sampleNative(lon,lat);if(!Number.isFinite(native))return null;
  const longitude=lon*deg,latitude=lat*deg,h=elevationAt(field,longitude,latitude);
  const edgeM=Math.min((longitude-field.west)*METRES_LON,(east-longitude)*METRES_LON,(latitude-field.south)*METRES_LAT,(north-latitude)*METRES_LAT);
  let bd=Infinity;for(const b of bridgeBounds)bd=Math.min(bd,boundsDistanceM(longitude,latitude,b));
  const corrected=isWater(u,v)?native:terrainBlend(native,h,offset,u,v,{maxCorrectionM,edgeWeight:clamp(edgeM/120,0,1),bridgeDistanceM:bd});
  buffer[y*size+x]=corrected;const delta=Math.abs(corrected-native);maxDelta=Math.max(maxDelta,delta);if(delta>.001)changed++;
 }
 return {buffer,width:size,height:size,offset,changed,maxDelta};
}
export function polygonHeightSourceLabel(record){
 if(record.attributeMismatch)return '외곽선 제공 자료 · 주소 속성 불일치 · 높이 미확인 추정';
 return record.heightSource==='recorded'?'외곽선·높이 제공 자료':record.heightSource==='floors_estimate'?'외곽선·층수 제공 자료 · 층고로 높이 추정':'외곽선 제공 자료 · 높이 미확인 추정';
}
export function bridgeHeightAt(point,anchors,heights){
 if(!anchors?.length||!heights?.every(Number.isFinite))return undefined;
 const a=anchors[0],b=anchors[1],dx=(b[0]-a[0])*METRES_LON,dy=(b[1]-a[1])*METRES_LAT;
 const denom=dx*dx+dy*dy,t=denom?clamp(((point[0]-a[0])*METRES_LON*dx+(point[1]-a[1])*METRES_LAT*dy)/denom,0,1):.5;
 return heights[0]+(heights[1]-heights[0])*t+.12;
}
