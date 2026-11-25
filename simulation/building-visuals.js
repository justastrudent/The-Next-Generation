/** Display-only façades on the supplied GIS footprints.
 * Height/use/floor attributes are retained. Windows, entrance locations, materials and roof
 * construction are illustrative because the source does not contain surveyed exterior assets.
 * No text labels, POI lookup, random placement, or edits to simulation/network data occur here.
 */
const RAD=Math.PI/180,M=111320;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const hash=s=>[...String(s)].reduce((a,c)=>(Math.imul(a,31)+c.codePointAt(0))>>>0,17);
const PALETTES={
 house:{walls:['#ded6c8','#d5c9b9','#dcd5c9'],roofs:['#6c7881','#7f6554','#566e6f'],trim:'#e9e2d7',plinth:'#a99e8c'},
 industrial:{walls:['#c6ccca','#bfcacb','#c9c9bf'],roofs:['#526e7c','#607c80','#697a83'],trim:'#dae0dc',plinth:'#8a9798'},
 commercial:{walls:['#d9d1c3','#d3c9ba','#d8d4c8'],roofs:['#777f7b'],trim:'#ece5da',plinth:'#9b9e99'},
 public:{walls:['#ded6c7','#d4d9d0'],roofs:['#687f79','#647886'],trim:'#eee9de',plinth:'#a4ab9e'},
 apartment:{walls:['#dfdfd6','#d9dcd7'],roofs:['#7a8784'],trim:'#ebece4',plinth:'#a3aaa6'},
 unknown:{walls:['#d1d0c6','#c8ccc5','#d0cec4'],roofs:['#798781','#6e7e7b'],trim:'#e1e0d5',plinth:'#a1aaa1'}
};
const local=(p,o)=>{const phi=o[1]*RAD,e2=0.0066943799901413165,a=6378137,w=1-e2*Math.sin(phi)**2;const n=a/Math.sqrt(w),m=a*(1-e2)/w**1.5;return[(p[0]-o[0])*RAD*n*Math.cos(phi),(p[1]-o[1])*RAD*m];};
function clean(ring,origin){const p=ring.map(v=>local(v,origin));if(p.length>1&&Math.hypot(p[0][0]-p.at(-1)[0],p[0][1]-p.at(-1)[1])<.001)p.pop();return p;}
function area(p){let n=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];n+=a[0]*b[1]-a[1]*b[0];}return n/2;}
function convex(p){let sign=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],c=p[(i+2)%p.length],z=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);if(Math.abs(z)<.005)continue;if(sign&&Math.sign(z)!==sign)return false;sign=Math.sign(z);}return !!sign;}
function clipHalf(p,axis,mid,sign){const out=[];for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],da=(a[0]*axis[0]+a[1]*axis[1]-mid)*sign,db=(b[0]*axis[0]+b[1]*axis[1]-mid)*sign;
 if(da>=-1e-7)out.push(a);if((da>1e-7&&db< -1e-7)||(da< -1e-7&&db>1e-7)){const t=da/(da-db);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}
 return out;
}

/** A pitched roof is bounded by the original footprint and keeps the supplied maximum height. */
export function buildingVisualSpec(record,rings){
 const style=record.attributeMismatch?'unknown':(PALETTES[record.style]?record.style:'unknown'),palette=PALETTES[style],seed=hash(record.id),origin=record.center;
 const points=clean(rings[0],origin),height=Number(record.height),edges=points.map((p,i)=>{const b=points[(i+1)%points.length],dx=b[0]-p[0],dy=b[1]-p[1],length=Math.hypot(dx,dy);return{p,b,dx,dy,length,index:i};});
 const longest=edges.reduce((a,b)=>b.length>a.length?b:a,edges[0]||{dx:1,dy:0,length:1,index:0});
 const axis=[-longest.dy/Math.max(.001,longest.length),longest.dx/Math.max(.001,longest.length)],vs=points.map(p=>p[0]*axis[0]+p[1]*axis[1]),lo=Math.min(...vs),hi=Math.max(...vs),span=hi-lo,mid=(hi+lo)/2;
 const eligible=['house','industrial'].includes(style)&&rings.length===1&&points.length<=10&&convex(points)&&Math.abs(area(points))>14&&span>=3&&span<=60&&height>=2.8&&height<=18;
 const rise=eligible?Math.min(style==='industrial'?1.6:1.25,span*.18,height*.23):0;
 const roofZ=p=>height-rise+rise*(1-Math.min(1,Math.abs(p[0]*axis[0]+p[1]*axis[1]-mid)/Math.max(.001,span/2)));
 return{style,origin,points,edges,height,wallHeight:height-rise,roofRise:rise,roofKind:rise?'gable':'flat',roofZ,axis,mid,front:longest.index,
   wall:palette.walls[seed%palette.walls.length],roof:palette.roofs[Math.floor(seed/7)%palette.roofs.length],trim:palette.trim,plinth:palette.plinth,
   glass:'#334b56',glassLight:'#8cabb2',frame:'#c8d5d6',door:'#536a6e',roofParts:rise?[-1,1].map(s=>clipHalf(points,axis,mid,s)).filter(p=>p.length>=3):[]};
}

/** A small material-batched triangle mesh. Coordinates are metres east/north/up. */
export class BuildingMesh {
 constructor(){this.groups=new Map();this.quads=0;this.triangles=0;}
 triangle(a,b,c,color){
  const ab=b.map((v,i)=>v-a[i]),ac=c.map((v,i)=>v-a[i]),n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],len=Math.hypot(...n);if(len<1e-8)return;
  let g=this.groups.get(color);if(!g){g={positions:[],normals:[],indices:[]};this.groups.set(color,g);}const base=g.positions.length/3;
  for(const p of[a,b,c]){g.positions.push(...p);g.normals.push(...n.map(v=>v/len));}g.indices.push(base,base+1,base+2);this.triangles++;
 }
 quad(a,b,c,d,color){this.triangle(a,b,c,color);this.triangle(a,c,d,color);this.quads++;}
 polygon(points,color){for(let i=1;i+1<points.length;i++)this.triangle(points[0],points[i],points[i+1],color);}
}

export function buildingRoofMesh(record,rings,spec=buildingVisualSpec(record,rings)){
 const mesh=new BuildingMesh();if(!spec.roofRise)return mesh;
 for(const part of spec.roofParts){const p=part.map(v=>[v[0],v[1],spec.roofZ(v)]);if(area(part)<0)p.reverse();mesh.polygon(p,spec.roof);}
 const ccw=area(spec.points)>0;
 for(const edge of spec.edges){const points=[edge.p],a=edge.p[0]*spec.axis[0]+edge.p[1]*spec.axis[1]-spec.mid,b=edge.b[0]*spec.axis[0]+edge.b[1]*spec.axis[1]-spec.mid;
  if(a*b< -1e-7){const t=a/(a-b);points.push([edge.p[0]+edge.dx*t,edge.p[1]+edge.dy*t]);}points.push(edge.b);
  for(let i=1;i<points.length;i++){const p=points[i-1],q=points[i],verts=[[p[0],p[1],spec.wallHeight],[q[0],q[1],spec.wallHeight],[q[0],q[1],spec.roofZ(q)],[p[0],p[1],spec.roofZ(p)]];if(!ccw)verts.reverse();mesh.quad(...verts,spec.wall);}
 }
 return mesh;
}

/** Sparse, low-contrast façade masses rather than a grid of invented windows.
 * All façade details are illustrative; unclassified buildings get no invented windows. */
export function buildingFacadeMesh(record,rings,{near=true,spec=buildingVisualSpec(record,rings)}={}){
 const mesh=new BuildingMesh(),h=spec.wallHeight;if(!(h>1.7))return mesh;
 const signed=area(spec.points)>0?1:-1,providedFloors=!record.attributeMismatch&&Number.isFinite(record.floors)&&record.floors>0;
 const levels=clamp(providedFloors?Math.round(record.floors):Math.max(1,Math.round(h/3.15)),1,Math.min(35,Math.max(1,Math.floor(h/2))));
 const storey=h/levels,front=spec.edges.find(e=>e.index===spec.front),long=front?.length||0;
 const back=front?spec.edges.filter(e=>e.length>0&&e.length>=long*.60&&(e.dx*front.dx+e.dy*front.dy)/(e.length*long)<-.93).sort((a,b)=>b.length-a.length)[0]:null;
 const glass='#9baeb3',glassShade='#879da6',balcony='#c2c8c6',shade='#b1b4ac';
 for(const edge of spec.edges){
  if(edge.length<1.7)continue;
  const L=edge.length,tx=edge.dx/L,ty=edge.dy/L,nx=ty*signed,ny=-tx*signed;
  const point=(u,z,depth=.14)=>[edge.p[0]+tx*u+nx*depth,edge.p[1]+ty*u+ny*depth,z];
  const panel=(left,right,bottom,top,color,depth=.14)=>{
   if(right-left<.03||top-bottom<.03)return;
   const q=[point(left,bottom,depth),point(right,bottom,depth),point(right,top,depth),point(left,top,depth)];if(signed<0)q.reverse();mesh.quad(...q,color);
  };
  const band=(left,right,z,depth=.28)=>{const q=[point(left,z,.08),point(right,z,.08),point(right,z,depth),point(left,z,depth)];if(signed>0)q.reverse();mesh.quad(...q,spec.trim);};
  const isFront=edge.index===spec.front;
  const opposing=edge===back;
  const margin=Math.min(.35,L*.10);
  panel(margin,L-margin,.03,Math.min(.34,h*.11),spec.plinth,.12);
  panel(margin,L-margin,Math.max(0,h-.18),h-.025,spec.trim,.15);
  // Unknown-use/mismatched buildings remain neutral volumes, never a fictional window grid.
  if(spec.style==='unknown')continue;
  if(spec.style==='apartment'){
   // Only the principal long elevations have a few broad, vertically continuous balcony bays.
   // Short ends are mostly solid, and no per-window tessellation is used.
   if(!(isFront||opposing)||L<4){if(L>=5)panel(L*.12,L*.25,.5,h-.45,shade,.14);continue;}
   const bays=L>=26?2:1;
   const inner=L*.84,step=inner/bays;
   for(let j=0;j<bays;j++){
    const c=L*.08+(j+.5)*step,w=Math.min(step*.55,5.2),l=c-w/2,r=c+w/2;
    panel(l-.13,r+.13,.45,h-.44,spec.trim,.16);
    panel(l,r,.55,h-.55,balcony,.20);
    // Broad spandrels only: no dark individual apertures and no grid of tiny windows.
    const stride=Math.max(3,Math.ceil(levels/(near?4:2)));
    for(let k=0;k<levels;k+=stride){const z=k*storey;panel(l+.08,r-.08,z+Math.min(.85,storey*.28),Math.min(h-.55,z+storey*.76),glass,.23);if(near&&k>0)band(l,r,z+.22,.33);}
    panel(l,r,.55,Math.min(1.22,h-.6),balcony,.24);
   }
   continue;
  }
  if(spec.style==='industrial'){
   if(!isFront)continue;
   const z=Math.min(h-.24,h*.72),left=L*.12,right=L*.88;
   if(L>4&&z>1.8)panel(left,right,z,Math.min(h-.22,z+.65),glassShade,.17);
   const w=Math.min(L*.32,4.4),c=L*.50,doorH=Math.min(3.8,h*.58);
   if(doorH>1.2){panel(c-w/2-.12,c+w/2+.12,.03,doorH+.11,spec.trim,.16);panel(c-w/2,c+w/2,.04,doorH,'#a6b1b0',.19);}
   continue;
  }
  if(!(isFront||opposing))continue;
  if(spec.style==='commercial'||spec.style==='public'){
   if(L>=3.5){
    const top=Math.min(h-.25,storey*.79);
    // One shopfront/entrance composition, not a run of identical punched openings.
    if(top>1.1){panel(L*.12,L*.88,.40,top,spec.trim,.16);panel(L*.14,L*.86,.46,top-.06,glass,.20);panel(L*.60,L*.66,.05,top-.06,spec.door,.23);}
    if(levels>1&&h>4.8)panel(L*.20,L*.80,storey+.65,Math.min(h-.30,storey+1.9),glass,.18);
    if(isFront&&near&&top>.9)band(L*.10,L*.90,top+.12,.45);
   }
   continue;
  }
  // A house has a small number of generous openings, mainly on the front and back.
  if(spec.style==='house'){
   const cols=L>=8&&isFront?2:1;
   const count=Math.min(2,levels);
   for(let f=0;f<count;f++){
    const bottom=f*storey+Math.min(.83,storey*.28),top=Math.min((f+1)*storey-.30,bottom+Math.min(1.38,storey*.51));
    for(let j=0;j<cols;j++){
     const c=cols===2?L*(j===0?.23:.77):L*(isFront?.32:.50),w=Math.min(2.4,L*(cols===2?.25:.34));
     panel(c-w/2-.07,c+w/2+.07,bottom-.06,top+.06,spec.trim,.16);
     panel(c-w/2,c+w/2,bottom,top,glass,.20);
    }
   }
   if(isFront&&L>4){const c=L*.50,w=Math.min(1.1,L*.17),top=Math.min(h-.3,2.05);panel(c-w/2,c+w/2,.03,top,spec.door,.19);if(near)band(c-w/2-.16,c+w/2+.16,top+.08,.36);}
  }
 }
 return mesh;
}

/** Batch many buildings into a few draw calls, without changing geographic positions. */
export function meshInstances(C,entries,{kind='building-detail'}={}){
 const groups=new Map();
 for(const{record,base,mesh}of entries){if(!Number.isFinite(base))continue;const matrix=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(record.center[0],record.center[1],base));
  for(const[color,g]of mesh.groups){let list=groups.get(color);if(!list){list=[];groups.set(color,list);}let target=list.at(-1);if(!target||target.positions.length+g.positions.length>180000){target={positions:[],normals:[],indices:[]};list.push(target);}
   const offset=target.positions.length/3;
   for(let i=0;i<g.positions.length;i+=3){const p=C.Matrix4.multiplyByPoint(matrix,new C.Cartesian3(...g.positions.slice(i,i+3)),new C.Cartesian3());target.positions.push(p.x,p.y,p.z);
    const n=C.Matrix4.multiplyByPointAsVector(matrix,new C.Cartesian3(...g.normals.slice(i,i+3)),new C.Cartesian3());target.normals.push(n.x,n.y,n.z);}
   for(const index of g.indices)target.indices.push(index+offset);
  }
 }
 const result=[];
 for(const[color,list]of groups)for(const g of list){if(!g.indices.length)continue;const values=new Float64Array(g.positions),geometry=new C.Geometry({
   attributes:{position:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.DOUBLE,componentsPerAttribute:3,values}),normal:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.FLOAT,componentsPerAttribute:3,values:new Float32Array(g.normals)})},
   indices:g.positions.length/3>65535?new Uint32Array(g.indices):new Uint16Array(g.indices),primitiveType:C.PrimitiveType.TRIANGLES,boundingSphere:C.BoundingSphere.fromVertices(values)});
  result.push(new C.GeometryInstance({id:{metroEnvironment:true,kind,name:'건물 외관',provenance:'실제 외곽선·속성 기반 · 창문·출입구·재료·지붕 구성은 시각 표현'},geometry,attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(color))}}));
 }
 return result;
}
