/** Close-range surface material overlays; original GIS shells stay as fallback.
 * Swatches are original procedural textures, not surveyed photographs. */
const RAD=Math.PI/180;
function local(p,o){const a=6378137,e=0.0066943799901413165,t=o[1]*RAD,w=1-e*Math.sin(t)**2;return[(p[0]-o[0])*RAD*a/Math.sqrt(w)*Math.cos(t),(p[1]-o[1])*RAD*a*(1-e)/w**1.5];}
function area(p){return p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0];},0)/2;}
export function surfaceGroups(entries){
 const groups=new Map();
 function quad(key,record,base,verts,uv){const k=key;let g=groups.get(k);if(!g){g=[];groups.set(k,g);}g.push({record,base,verts,uv});}
 for(const {record,base,rings,spec} of entries){
  if(!Number.isFinite(base)||!Number.isFinite(spec.wallHeight))continue;
  const style=spec.style;
  const key=style==='industrial'?'metal':style==='house'?(String(record.id).split('').reduce((a,c)=>a+c.charCodeAt(0),0)%3===0?'brick':'plaster'):style==='apartment'?'concrete':'plaster';
  for(const ring of rings){
   const p=ring.slice(0,-1).map(x=>local(x,record.center));if(p.length<3)continue;
   // Only exterior ring gets overlay. Courtyards retain existing shell.
   if(ring!==rings[0])continue;
   const sign=area(p)>=0?1:-1;
   for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy);if(l<.3)continue;
    const h=spec.wallHeight,off=.055,nx=dy/l*sign*off,ny=-dx/l*sign*off;
    const verts=[[a[0]+nx,a[1]+ny,.015],[b[0]+nx,b[1]+ny,.015],[b[0]+nx,b[1]+ny,h-.015],[a[0]+nx,a[1]+ny,h-.015]],uv=[[0,0],[l/3,0],[l/3,h/3],[0,h/3]];
    if(sign<0){verts.reverse();uv.reverse();}quad(key,record,base,verts,uv);
   }
  }
  if(spec.roofRise&&spec.roofParts?.length){
   for(const part of spec.roofParts){
    const pts=area(part)<0?[...part].reverse():part;
    for(let i=1;i+1<pts.length;i++){
     const tri=[pts[0],pts[i],pts[i+1]];
     quad(style==='industrial'?'roof-metal':'roof-tile',record,base,tri.map(v=>[v[0],v[1],spec.roofZ(v)+.025]),tri.map(v=>[v[0]/3,v[1]/3]));
    }
   }
  }
 }
 return groups;
}
export function materialInstances(C,entries){
 const results=[];
 for(const [key,quads] of surfaceGroups(entries)){
  let pos=[],norm=[],st=[],idx=[];
  function flush(){if(!idx.length)return;const values=new Float64Array(pos),geo=new C.Geometry({attributes:{position:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.DOUBLE,componentsPerAttribute:3,values}),normal:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.FLOAT,componentsPerAttribute:3,values:new Float32Array(norm)}),st:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.FLOAT,componentsPerAttribute:2,values:new Float32Array(st)})},indices:pos.length/3>65535?new Uint32Array(idx):new Uint16Array(idx),primitiveType:C.PrimitiveType.TRIANGLES,boundingSphere:C.BoundingSphere.fromVertices(values)});
   results.push({key,instance:new C.GeometryInstance({geometry:geo,id:{metroEnvironment:true,kind:'building-material',provenance:'외벽 재질 시각화용 텍스처'}})});pos=[];norm=[];st=[];idx=[];}
  for(const {record,base,verts,uv} of quads){if(pos.length>175000)flush();const mat=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(...record.center,base));const o=pos.length/3;
   const a=verts[0],b=verts[1],c=verts[2],ab=b.map((v,i)=>v-a[i]),ac=c.map((v,i)=>v-a[i]),n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],len=Math.hypot(...n);if(len<1e-6)continue;
   const nn=C.Matrix4.multiplyByPointAsVector(mat,new C.Cartesian3(...n.map(v=>v/len)),new C.Cartesian3());
   for(let i=0;i<verts.length;i++){const p=C.Matrix4.multiplyByPoint(mat,new C.Cartesian3(...verts[i]),new C.Cartesian3());pos.push(p.x,p.y,p.z);norm.push(nn.x,nn.y,nn.z);st.push(...uv[i]);}idx.push(o,o+1,o+2);if(verts.length===4)idx.push(o,o+2,o+3);
  }flush();
 }
 return results;
}
export function materialPrimitives(C,entries){
 if(typeof document==='undefined'||!C.MaterialAppearance||!C.Material?.fromType)return [];
 const result=[];
 try{for(const {key,instance} of materialInstances(C,entries)){
  const material=C.Material.fromType('Image',{image:new URL(`./assets/building-materials/${key}.png`,import.meta.url).href,repeat:new C.Cartesian2(1,1)});
  const appearance=new C.MaterialAppearance({material,materialSupport:C.MaterialAppearance.MaterialSupport.TEXTURED,translucent:false,closed:false,faceForward:true});
  result.push(new C.Primitive({geometryInstances:instance,appearance,asynchronous:false,compressVertices:false}));
 }}catch(e){for(const p of result)try{p.destroy?.();}catch{};return [];}
 return result;
}
