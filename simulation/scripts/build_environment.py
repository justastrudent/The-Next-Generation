#!/usr/bin/env python3
"""Prepare the supplied Gangnae GIS layers. Original files are never modified.

Run: python scripts/build_environment.py
Build-time dependencies: numpy, scipy. Runtime is static JSON + JavaScript.
Field dictionary: KTDB 2024 mobility base-map report, table 5-15 (PDF pp126-127).
"""
from __future__ import annotations
import argparse, collections, hashlib, json, math
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
MX = 111320 * math.cos(math.radians(36.61))
MY = 111320
ORIGIN = (127.32, 36.56)
TILE_M = 650
SOURCE_NAMES = ['gangnae_buildings', 'gangnae_roads001', 'gangnae_roads002',
                'gangnae_elevation', 'gangnae_bridges', 'gangnae_road_attributes']

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf8')

def xy(p):
    return ((p[0]-ORIGIN[0])*MX, (p[1]-ORIGIN[1])*MY)

def ring_area(r):
    return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(r, r[1:])) / 2) * MX * MY

def inside_ring(p, ring):
    x,y=p; inside=False
    for a,b in zip(ring, ring[1:]):
        if ((a[1]>y)!=(b[1]>y)) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside=not inside
    return inside

def inside_polygon(p, poly):
    return inside_ring(p,poly[0]) and not any(inside_ring(p,r) for r in poly[1:])

def mask_in_polygons(coords, ps):
    # Vectorized ray crossing, preserving administrative boundary holes.
    x=coords[:,0]/MX+ORIGIN[0];y=coords[:,1]/MY+ORIGIN[1]
    def ring_mask(ring):
        inside=np.zeros(len(coords),dtype=bool)
        for a,b in zip(ring,ring[1:]):
            if a[1]==b[1]:continue
            inside^=((a[1]>y)!=(b[1]>y)) & (x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])
        return inside
    result=np.zeros(len(coords),dtype=bool)
    for poly in ps:
        keep=ring_mask(poly[0])
        for ring in poly[1:]:keep &= ~ring_mask(ring)
        result |= keep
    return result

def polygons(geometry):
    ps = geometry['coordinates'] if geometry['type']=='MultiPolygon' else [geometry['coordinates']]
    result=[]
    for poly in ps:
        rings=[]
        for ring in poly:
            points=[]
            for p in ring:
                q=[round(float(p[0]),7), round(float(p[1]),7)]
                if not points or q!=points[-1]: points.append(q)
            if points and points[0]!=points[-1]:points.append(points[0])
            if len(points)>=4 and ring_area(points)>.015:rings.append(points)
        if rings:result.append(rings)
    return result

def bounds(ps):
    pts=[p for poly in ps for r in poly for p in r]
    return [min(p[0] for p in pts),min(p[1] for p in pts),max(p[0] for p in pts),max(p[1] for p in pts)]

def center_of(ps):
    b=bounds(ps)
    return [round((b[0]+b[2])/2,7),round((b[1]+b[3])/2,7)]

def geometry_key(ps):
    def canonical(r):
        pts=[tuple(p) for p in r[:-1]]
        a=min(range(len(pts)),key=lambda i:pts[i]);seq=pts[a:]+pts[:a]
        return min(tuple(seq),tuple([seq[0]]+list(reversed(seq[1:]))))
    return tuple(sorted((canonical(p[0]),tuple(sorted(canonical(r) for r in p[1:]))) for p in ps))

def style_for(use):
    if use and ('공장' in use or '창고' in use or '동.식물' in use):return 'industrial'
    if use and ('단독주택' in use or '다가구' in use):return 'house'
    if use and ('공동주택' in use):return 'apartment'
    if use and any(x in use for x in ['교육','노유자','공공','문화','종교']):return 'public'
    if use and any(x in use for x in ['근린','판매','업무','숙박','운수']):return 'commercial'
    return 'unknown'

def building_record(f,index):
    p=f['properties'];ps=polygons(f['geometry']);use=p.get('A9') or '';style=style_for(use)
    raw_height=p.get('A16');floors=p.get('A26')
    mismatch=bool(p.get('A4')) and '강내' not in p['A4']
    # Source attribute linkage is questionable when its legal address contradicts the clipped area.
    # Keep its footprint but do not silently reuse questionable height/floor/use attributes.
    height_source='recorded'
    if not mismatch and isinstance(raw_height,(int,float)) and 1<=raw_height<=200:
        height=float(raw_height)
    elif not mismatch and isinstance(floors,(int,float)) and 1<=floors<=60:
        height=float(floors)*(4.2 if style=='industrial' else 3.1)
        height_source='floors_estimate'
    else:
        height=3.6 if mismatch or style=='unknown' else (5.2 if style=='industrial' else 3.5)
        height_source='fallback_estimate'
    return {'id':str(p.get('A0',index)),'polygons':ps,'center':center_of(ps),'bounds':bounds(ps),
            'height':height if height_source=='recorded' else round(height,2),'heightSource':height_source,'rawHeight':raw_height,
            'floors':floors,'use':use,'style':'unknown' if mismatch else style,
            'attributeMismatch':mismatch,'vintage':p.get('A22'),'name':p.get('A24') or '',
            'areaM2':round(sum(ring_area(poly[0])-sum(ring_area(r) for r in poly[1:]) for poly in ps),1)}

def road_samples(features):
    points=[];metadata=[]
    for i,f in enumerate(features):
        for line in f['geometry']['coordinates']:
            for a,b in zip(line,line[1:]):
                ax,ay=xy(a);bx,by=xy(b);length=math.hypot(bx-ax,by-ay)
                n=max(1,math.ceil(length/10))
                for k in range(n):
                    t=(k+.5)/n; points.append([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);metadata.append((i,length/n))
    return points,metadata,cKDTree(np.array([xy(p) for p in points]))

def match_road(ps, samples, meta, tree, attrs):
    b=bounds(ps);cx=(b[0]+b[2])/2;cy=(b[1]+b[3])/2
    radius=math.hypot((b[2]-b[0])*MX,(b[3]-b[1])*MY)/2+1
    indices=tree.query_ball_point(xy([cx,cy]),radius)
    totals=collections.Counter();matches=collections.Counter()
    widths=[];lanes=[]
    for n in indices:
        q=samples[n]
        if b[0]<=q[0]<=b[2] and b[1]<=q[1]<=b[3] and any(inside_polygon(q,poly) for poly in ps):
            i,length=meta[n];p=attrs[i]['properties'];code=p.get('PVQT') or 'RDQ000'
            totals[code]+=length;matches[p.get('UFID',str(i))]+=length
            if p.get('RVWD',0)>0: widths.append(p['RVWD'])
            if p.get('RDLN',0)>0: lanes.append(p['RDLN'])
    total=sum(totals.values());code,weight=totals.most_common(1)[0] if totals else ('RDQ000',0)
    known=bool(total>3 and weight/total>=.8 and code in ('RDQ005','RDQ006'))
    return {'surface':('unpaved' if code=='RDQ005' else 'paved') if known else 'unknown',
            'attributeSource':'spatial_centerline_join' if totals else 'unmatched',
            'matchFraction':round(weight/total,3) if total else 0,
            'sourceLinks':[k for k,v in matches.most_common(8)],
            'widthRange':[min(widths),max(widths)] if widths else None,
            'lanesRange':[min(lanes),max(lanes)] if lanes else None}

def bridge_anchors(ps):
    # Major direction of the supplied footprint; take two endpoint approach anchors.
    pts=np.array([xy(p) for poly in ps for p in poly[0][:-1]])
    mean=pts.mean(axis=0);eigenvalues,vectors=np.linalg.eigh(np.cov((pts-mean).T))
    axis=vectors[:,np.argmax(eigenvalues)];projection=(pts-mean)@axis
    lo=float(projection.min());hi=float(projection.max())
    result=[]
    for s in [lo-2,hi+2]:
        q=mean+axis*s;result.append([round(q[0]/MX+ORIGIN[0],7),round(q[1]/MY+ORIGIN[1],7)])
    return result

def build(root):
    data=root/'data';output=data/'environment';output.mkdir(exist_ok=True)
    sources={n:json.loads((data/f'{n}.geojson').read_text(encoding='utf8')) for n in SOURCE_NAMES}
    tiles={};stats={'sourceCounts':{n:len(d['features']) for n,d in sources.items()},'duplicateRoads':0,
                   'buildingHeights':collections.Counter(),'buildingUse':collections.Counter(),
                   'attributeMismatch':0,'invalidHeightBelow1m':0,'roadSurface':collections.Counter()}
    def add(layer,item):
        cx,cy=xy(item['center']);key=f'{math.floor(cx/TILE_M)}_{math.floor(cy/TILE_M)}'
        tile=tiles.setdefault(key,{'buildings':[],'roads':[],'bridges':[]});tile[layer].append(item)
    for i,f in enumerate(sources['gangnae_buildings']['features']):
        r=building_record(f,i)
        if not r['polygons']:continue
        stats['buildingHeights'][r['heightSource']]+=1;stats['buildingUse'][r['style']]+=1
        stats['attributeMismatch']+=int(r['attributeMismatch'])
        stats['invalidHeightBelow1m']+=int(isinstance(r['rawHeight'],(int,float)) and 0<r['rawHeight']<1)
        add('buildings',r)
    print('Buildings prepared',flush=True)
    attrs=sources['gangnae_road_attributes']['features'];samples,meta,tree=road_samples(attrs)
    seen=set()
    for name in ['gangnae_roads001','gangnae_roads002']:
        for f in sources[name]['features']:
            ps=polygons(f['geometry']);key=geometry_key(ps)
            if key in seen:stats['duplicateRoads']+=1;continue
            seen.add(key);p=f['properties'];match=match_road(ps,samples,meta,tree,attrs)
            r={'id':p.get('UFID'),'polygons':ps,'bounds':bounds(ps),'center':center_of(ps),
               'source':name+'.geojson','classification':p.get('SCLS'),**match}
            stats['roadSurface'][r['surface']]+=1;add('roads',r)
    print('Roads prepared',flush=True)
    bridge_bounds=[]
    for f in sources['gangnae_bridges']['features']:
        ps=polygons(f['geometry']);p=f['properties'];b=bounds(ps);bridge_bounds.append(b)
        add('bridges',{'id':p.get('UFID'),'name':p.get('NAME') or '교량','polygons':ps,
                       'bounds':b,'center':center_of(ps),'anchors':bridge_anchors(ps),
                       'lengthM':p.get('LENG'),'widthM':p.get('WIDT'),
                       'deckHeightSource':'native_terrain_approaches_estimate'})
    manifest={'schemaVersion':1,'id':'gangnae-environment-20261124','sourceCRS':'OGC:CRS84',
              'coordinateOrder':'longitude,latitude','sourceDataVintage':'2026-11-06 (building A22)',
              'tileSizeM':TILE_M,'tiles':[],'stats':stats,'elevation':'elevation-grid.json',
              'bridgeBounds':bridge_bounds,'fields':{'buildingHeight':'A16','buildingFloors':'A26','buildingUse':'A9',
              'buildingVintage':'A22','spotHeight':'NUME','roadWidth':'RVWD','roadLanes':'RDLN','roadPaving':'PVQT'},
              'sources':[{'file':n+'.geojson','sha256':hashlib.sha256((data/f'{n}.geojson').read_bytes()).hexdigest()}
                         for n in SOURCE_NAMES],
              'references':['https://ktdb.go.kr/DATA/pblcte/20250805093928585.pdf',
                            'https://www.codil.or.kr/filebank/original/RK/OTKCRK230622/OTKCRK230622.pdf'],
              'warnings':['건물 위치·외곽선은 제공 자료, 높이 미기록 건물의 층고와 색·지붕 표현은 추정입니다.',
                          '건물 자료 기준일은 2026년이며 운행 로그(2023년)의 당시 경관을 입증하지 않습니다.',
                          '표고점 수직 기준과 지도 타원체 고도를 직접 합치지 않습니다. 지형 보정은 원 지형에 맞춘 제한적 시각 보정입니다.',
                          '교량 바닥 높이는 기록되어 있지 않아 접근부 지형에서 추정합니다. 실제 구조·난간을 측정한 모형은 아닙니다.',
                          '건물 주소 속성 42건이 강내면 외 주소입니다. 해당 건물은 외곽선만 사용하고 높이·용도를 미확인 처리합니다.',
                          '도로 폭·차로·포장 속성은 도로 중심선의 공간 대응 결과입니다. 실제 차선 위치 데이터가 없어 차선을 생성하지 않습니다.']}
    allbounds=[]
    for key,tile in sorted(tiles.items()):
        items=[r for values in tile.values() for r in values]
        b=[min(r['bounds'][0] for r in items),min(r['bounds'][1] for r in items),max(r['bounds'][2] for r in items),max(r['bounds'][3] for r in items)]
        allbounds.append(b);path=output/'tiles'/f'{key}.json'
        dump(path,{'id':key,**tile})
        manifest['tiles'].append({'id':key,'url':f'tiles/{key}.json','bounds':b,
                                  'counts':{k:len(v) for k,v in tile.items()},'bytes':path.stat().st_size})
    manifest['bounds']=[min(b[0] for b in allbounds),min(b[1] for b in allbounds),max(b[2] for b in allbounds),max(b[3] for b in allbounds)]
    points=sources['gangnae_elevation']['features'];ps=np.array([xy(f['geometry']['coordinates']) for f in points]);hs=np.array([f['properties']['NUME'] for f in points])
    tree=cKDTree(ps);b=manifest['bounds'];step=50
    lo=xy(b[:2]);hi=xy(b[2:]);nx=math.ceil((hi[0]-lo[0])/step)+1;ny=math.ceil((hi[1]-lo[1])/step)+1
    coords=np.array([[lo[0]+i*step,lo[1]+j*step] for j in range(ny) for i in range(nx)])
    dist,ids=tree.query(coords,k=8);weights=1/np.maximum(dist,1)**2;heights=(weights*hs[ids]).sum(axis=1)/weights.sum(axis=1)
    boundary_path=data/'gangnae_boundary.geojson'
    boundary=json.loads(boundary_path.read_text(encoding='utf8'));boundary_polys=[]
    for feature in boundary['features']:boundary_polys.extend(polygons(feature['geometry']))
    in_boundary=mask_in_polygons(coords,boundary_polys)
    manifest['boundarySha256']=hashlib.sha256(boundary_path.read_bytes()).hexdigest()
    grid={'schemaVersion':1,'width':nx,'height':ny,'west':b[0],'south':b[1],'stepLon':step/MX,'stepLat':step/MY,
          'values':[round(float(v),2) if d[0]<=220 and inside else None for v,d,inside in zip(heights,dist,in_boundary)],
          'nearestDistanceM':[round(float(d[0]),1) for d in dist],
          'method':'8-neighbour inverse-distance weighting (power2), 50m grid; clipped to supplied administrative boundary; no extrapolation beyond220m',
          'verticalDatum':'source NUME datum not established; use only relative relief after native tile anchoring',
          'measuredPointCount':len(points),'bridgeBounds':bridge_bounds}
    dump(output/'elevation-grid.json',grid);dump(output/'manifest.json',manifest)
    report={'manifest':manifest['id'],'tiles':len(tiles),'counts':{k:sum(t['counts'][k] for t in manifest['tiles']) for k in ['buildings','roads','bridges']},
            'stats':stats,'heightGrid':[nx,ny],'sourceFilesUnmodified':True,'approximationPolicy':manifest['warnings']}
    dump(output/'validation.json',report)
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=ROOT)
    build(parser.parse_args().root)
