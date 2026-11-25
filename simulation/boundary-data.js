/** Validate an uploaded EPSG:4326 boundary without inventing or repairing geometry.
 * Geometry stays separate from the simulation network, routing and event records.
 * This checks coordinate/ring structure, not a full GIS topology validation.
 */
export const BOUNDARY_MAX_BYTES = 15 * 1024 * 1024;
const MAX_VERTICES = 250000;
const MAX_FEATURES = 10000;
const SUPPORTED = new Set(['Polygon','MultiPolygon','LineString','MultiLineString']);

export function parseBoundaryGeoJSON(input,{allowEmpty=false}={}) {
  const source=typeof input==='string'?JSON.parse(input):input;
  if(!source||typeof source!=='object')throw new Error('GeoJSON 경계 파일을 선택해 주세요.');
  const crs=source.crs?.properties?.name;
  if(crs&&!/(?:4326|CRS:?84)\b/i.test(String(crs)))throw new Error('QGIS에서 EPSG:4326 — WGS 84로 다시 내보내 주세요.');
  let features;
  if(source.type==='FeatureCollection')features=source.features;
  else if(source.type==='Feature')features=[source];
  else if(SUPPORTED.has(source.type))features=[{type:'Feature',properties:{},geometry:source}];
  else throw new Error('Polygon/MultiPolygon 면 또는 LineString/MultiLineString 경계선이 필요합니다.');
  if(!Array.isArray(features))throw new Error('GeoJSON features 배열이 올바르지 않습니다.');
  if(features.length>MAX_FEATURES)throw new Error('경계 객체가 너무 많습니다. QGIS에서 강내면 객체만 선택해 내보내 주세요.');
  if(!features.length&&!allowEmpty)throw new Error('경계 객체가 없습니다. QGIS에서 내보낼 객체 선택을 확인해 주세요.');
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];
  let vertexCount=0,polygonCount=0,lineCount=0;
  function coordinate(value){
    if(!Array.isArray(value)||value.length<2||typeof value[0]!=='number'||typeof value[1]!=='number'||!Number.isFinite(value[0])||!Number.isFinite(value[1]))throw new Error('경계에 올바르지 않은 좌표가 있습니다. 경도·위도 숫자를 확인해 주세요.');
    const [lon,lat]=value;
    if(lon< -180||lon>180||lat< -90||lat>90)throw new Error('투영좌표로 보이는 값이 있습니다. EPSG:4326으로 내보내 주세요.');
    if(++vertexCount>MAX_VERTICES)throw new Error('경계 정점이 너무 많습니다. 강내면 객체만 내보내 주세요.');
    bounds[0]=Math.min(bounds[0],lon);bounds[1]=Math.min(bounds[1],lat);bounds[2]=Math.max(bounds[2],lon);bounds[3]=Math.max(bounds[3],lat);
    return [lon,lat]; // Boundary elevation is supplied by the selected map terrain.
  }
  function path(value,ring=false){
    if(!Array.isArray(value)||value.length<(ring?4:2))throw new Error(ring?'면 경계의 링에는 닫힌 좌표 4개 이상이 필요합니다.':'경계선에는 좌표 2개 이상이 필요합니다.');
    const points=value.map(coordinate);
    if(ring){
      const a=points[0],b=points[points.length-1];
      if(a[0]!==b[0]||a[1]!==b[1])throw new Error('면 경계가 닫혀 있지 않습니다. QGIS에서 도형을 확인한 뒤 다시 내보내 주세요.');
      if(new Set(points.slice(0,-1).map(p=>p.join(','))).size<3)throw new Error('면 경계에는 서로 다른 정점 3개 이상이 필요합니다.');
      // Translate to the first vertex to avoid cancellation in longitude/latitude products.
      let area=0;for(let i=0;i<points.length-1;i++)area+=(points[i][0]-a[0])*(points[i+1][1]-a[1])-(points[i+1][0]-a[0])*(points[i][1]-a[1]);
      if(area===0)throw new Error('면적이 없는 면 경계입니다. QGIS에서 도형을 확인해 주세요.');
    }else if(!points.some(p=>p[0]!==points[0][0]||p[1]!==points[0][1]))throw new Error('길이가 없는 경계선입니다.');
    return points;
  }
  function polygon(value){
    if(!Array.isArray(value)||!value.length)throw new Error('면 경계의 바깥 링이 없습니다.');
    polygonCount++;return value.map(r=>path(r,true));
  }
  const output=features.map((feature,index)=>{
    if(!feature||feature.type!=='Feature'||!feature.geometry)throw new Error(`${index+1}번째 객체에 경계 도형이 없습니다.`);
    const geometry=feature.geometry,type=geometry.type;
    if(!SUPPORTED.has(type))throw new Error('행정경계 면 또는 경계선 레이어를 내보내 주세요. 점·혼합 도형은 지원하지 않습니다.');
    let coordinates;
    if(type==='Polygon')coordinates=polygon(geometry.coordinates);
    else if(type==='MultiPolygon'){
      if(!Array.isArray(geometry.coordinates)||!geometry.coordinates.length)throw new Error('MultiPolygon에 면 경계가 없습니다.');
      coordinates=geometry.coordinates.map(polygon);
    }else if(type==='LineString'){lineCount++;coordinates=path(geometry.coordinates);}
    else{
      if(!Array.isArray(geometry.coordinates)||!geometry.coordinates.length)throw new Error('MultiLineString에 경계선이 없습니다.');
      coordinates=geometry.coordinates.map(p=>{lineCount++;return path(p);});
    }
    const result={type:'Feature',properties:feature.properties&&typeof feature.properties==='object'&&!Array.isArray(feature.properties)?{...feature.properties}:{},geometry:{type,coordinates}};
    if(typeof feature.id==='string'||typeof feature.id==='number')result.id=feature.id;
    return result;
  });
  // Anti-meridian/global exports are outside this regional visualisation's camera model.
  if(output.length&&(bounds[2]-bounds[0]>180||bounds[3]-bounds[1]>90))throw new Error('경계 범위가 너무 넓습니다. 강내면 객체만 내보내 주세요.');
  return {geojson:{type:'FeatureCollection',features:output},bounds:output.length?bounds:null,featureCount:output.length,polygonCount,lineCount,vertexCount,empty:output.length===0};
}
