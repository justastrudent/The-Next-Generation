from __future__ import annotations

"""Input preparation, Gangnae-only directed network and OD path matrix.

Do not substitute Cheongju-wide network. Real Gangnae file is required at runtime.
"""

# ===== Source section: data.py =====
"""Source-validated ingestion of 7-day DRT CSV and 39-site logistics XLSX.

XLSX is read using openpyxl (pip-installable). No observed times from future calls enter the online passenger request payload.
"""
import csv
from dataclasses import dataclass
from datetime import datetime, date
from pathlib import Path
from openpyxl import load_workbook

CALL_COLS = ['CALL_PK','GOV_PK','GOV_AREA','BUS_PK','승차정류장_PK','승차지_X','승차지_Y',
             '하차정류장_PK','하차지_X','하차지_Y','호출시각','승차시각','하차시각',
             '합승인원수(호출승객포함)','호출유형']
HUB_COLS = ['번호','법정리','행정리','배송 거점','주소','위도','경도','세대수','연간 물량(건)','일평균 물량(건/일)']

@dataclass(frozen=True)
class PassengerRequest:
    id: str
    date: date
    request_time: float   # minutes after midnight
    pickup: str
    dropoff: str
    # Single person/request proxy; observed pooling count is NOT group size.
    people: int = 1

@dataclass(frozen=True)
class ObservedPassenger:
    id: str
    date: date
    vehicle_id: str
    request_time: float
    pickup_time: float
    dropoff_time: float
    pickup: str
    dropoff: str
    observed_pooling_count: int

@dataclass(frozen=True)
class Hub:
    id: str
    name: str
    lon: float
    lat: float
    household_count: int
    annual_parcels: int
    expected_daily: float


def parse_minute(value: str) -> tuple[date, float]:
    t=datetime.fromisoformat(value.strip())
    return t.date(), (t.hour*3600+t.minute*60+t.second)/60


def largest_remainder(weights: list[float], total: int) -> list[int]:
    if total<0 or not weights or any(w<0 for w in weights) or sum(weights)<=0:
        raise ValueError('Nonnegative total and positive weights are required')
    a=[total*w/sum(weights) for w in weights]
    q=[int(x) for x in a]
    for i in sorted(range(len(q)),key=lambda i:(-(a[i]-q[i]), i))[:total-sum(q)]:q[i]+=1
    assert sum(q)==total
    return q


def load_drt_csv(path: str|Path):
    """Returns requests, observations, stop coordinate dict, QA summary.

    CSV includes 2023-11-06...12 completed calls only. Export observed records separately from online requests.
    """
    with Path(path).open(encoding='cp949',newline='') as f:
        reader=csv.DictReader(f)
        if list(reader.fieldnames or [])!=CALL_COLS:raise ValueError('Unexpected 7-day CSV columns')
        rows=list(reader)
    requests=[]; observed=[]; locations={};duplicates=set()
    for row in rows:
        if row['CALL_PK'] in duplicates:raise ValueError('Duplicate CALL_PK: '+row['CALL_PK'])
        duplicates.add(row['CALL_PK'])
        if row['GOV_PK'].strip()!='8' or row['GOV_AREA'].strip()!='강내':
            raise ValueError('Unexpected non-Kangnae row')
        req_date,call=parse_minute(row['호출시각'])
        pu_date,pu=parse_minute(row['승차시각']);do_date,do=parse_minute(row['하차시각'])
        if not (req_date==pu_date==do_date and call<=pu<=do):
            raise ValueError('Unexpected timestamp chronology: '+row['CALL_PK'])
        pu_id='STOP_'+str(int(row['승차정류장_PK']))
        do_id='STOP_'+str(int(row['하차정류장_PK']))
        for sid,x,y in [(pu_id,row['승차지_X'],row['승차지_Y']), (do_id,row['하차지_X'],row['하차지_Y'])]:
            pos=(float(x),float(y))
            if sid in locations and max(abs(a-b) for a,b in zip(locations[sid],pos))>1e-7:
                raise ValueError('Stop coordinate mismatch: '+sid)
            locations[sid]=pos
        rid=str(row['CALL_PK'])
        requests.append(PassengerRequest(rid,req_date,call,pu_id,do_id,1))
        observed.append(ObservedPassenger(rid,req_date,str(int(row['BUS_PK'])),call,pu,do,pu_id,do_id,
                          int(row['합승인원수(호출승객포함)'].strip())))
    if not (len(requests)==531 and len(locations)==80 and len(set(o.date for o in observed))==7):
        raise ValueError(f'Unexpected input size {len(requests)} calls/{len(locations)} stops')
    return sorted(requests,key=lambda r:(r.date,r.request_time,r.id)),observed,locations,{'calls':len(requests),'stops':len(locations),'days':7,'observed_vehicles':sorted({x.vehicle_id for x in observed})}


def load_hubs_xlsx(path: str|Path):
    """Load the 39 delivery hubs from the real Excel worksheet, read-only."""
    workbook = load_workbook(filename=path, read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        values = sheet.iter_rows(min_col=1, max_col=10, values_only=True)
        header = list(next(values))
        if header != HUB_COLS:
            raise ValueError(f'Unexpected logistics header: {header}')
        rows = [r for r in values if isinstance(r[0], (int, float))]
    finally:
        workbook.close()
    if len(rows) != 39 or sum(int(r[8]) for r in rows) != 50999:
        raise ValueError('Unexpected logistics data: expected 39 hubs and 50,999 annual parcels')
    hubs=[]
    for r in rows:
        hubs.append(Hub('HUB_'+str(int(r[0])).zfill(2),str(r[3]),float(r[6]),float(r[5]),int(r[7]),int(r[8]),float(r[9])))
    return hubs


def write_csv(path: str|Path,rows:list[dict],header:list[str]):
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f,fieldnames=header,extrasaction='ignore');writer.writeheader();writer.writerows(rows)


# ===== Source section: depot.py =====
"""Proxy logistics depot chosen from actual observed call origins, with deterministic tie-breaking.

A high-demand passenger stop is not necessarily a safe/authorized loading depot.
"""
from collections import Counter,defaultdict
from datetime import date


def select_depot(requests,stop_coords):
    by_pick=Counter(r.pickup for r in requests)
    by_drop=Counter(r.dropoff for r in requests)
    if not by_pick:raise ValueError('Cannot select proxy depot: no requests')
    ordered=sorted(by_pick,key=lambda k:(-by_pick[k],k))
    winner=ordered[0]
    lon,lat=stop_coords[winner]
    leaderboard=[{'rank':i+1,'stop_id':s,'pickup_calls':by_pick[s],
                   'dropoffs':by_drop[s],'board_and_alight':by_pick[s]+by_drop[s],
                   'lon':stop_coords[s][0],'lat':stop_coords[s][1]}
                 for i,s in enumerate(ordered)]
    out={'selected_node_id':'DEPOT','proxy_from_stop_id':winner,
         'lon':lon,'lat':lat,'pickup_calls_7d':by_pick[winner],
         'all_boarding_calls':sum(by_pick.values()),
         'selection_rule':'highest observed boarding-origin count; sorted stop_id on ties',
         'status':'PROXY_DEPOT_FROM_DEMAND_NOT_VERIFIED_LOADING_SITE',
         'notes':'Stop may be virtual, lack storage, require road access review; operating company must approve.'}
    return out,leaderboard


# ===== Source section: local_network.py =====
"""Select local *Gangnae* graph only, then normalize it to the routing engine's canonical SQLite schema.

Supported:
  - 강내*.gpkg/.sqlite with separate node/link attribute layers
  - 강내노드/강내링크 .csv/.xlsx paired files
  - optional .shp node/link layers (requires geopandas)
The authoritative network files are on the USER'S Windows computer; absent files cause an explicit error.
No fallback to Cheongju-wide layers occurs.
"""
from dataclasses import dataclass
from pathlib import Path
from collections import Counter
import csv, json, os, sqlite3
from contextlib import contextmanager

@contextmanager
def database(path):
    connection=sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()
from typing import Any
from pyproj import Transformer

WINDOWS_BASE = Path(r'C:\Users\AJOU\Desktop\김대철\차세대 공학자 설명회\py')
VALID_SUFFIXES={'.gpkg','.sqlite','.db','.xlsx','.csv','.shp'}
NETWORK_HINTS=('강내','kangnae','gangnae')
NODE_HINTS=('node','노드')
LINK_HINTS=('link','링크')


def has_gangnae_hint(name: str)->bool:
    return any(k in str(name).lower() for k in NETWORK_HINTS)


def _row_keys(row:dict[str,Any]):
    return {str(k).strip().casefold().replace(' ','').replace('_','').replace('-',''):k for k in row.keys()}


def _col(row:dict[str,Any],names,default=None):
    keys=_row_keys(row)
    for name in names:
        key=name.strip().casefold().replace(' ','').replace('_','').replace('-','')
        if key in keys:
            value=row[keys[key]]
            if value is not None and str(value).strip()!='':return value
    return default


def _number(x):
    return float(str(x).replace(',','').strip())


def _normalize_id(x):
    if isinstance(x,(int,float)) or str(x).replace('.','',1).isdigit():
        value=float(x)
        return str(int(value)) if value.is_integer() else str(value)
    return str(x).strip()


@dataclass(frozen=True)
class SelectedNetwork:
    kind:str
    source:Path|None=None
    nodes:Path|None=None
    links:Path|None=None


def available_gangnae_files(base:Path):
    if not base.is_dir():return []
    ignored={'outputs','__pycache__','.venv','.ipynb_checkpoints','results','node_modules','.pytest_cache'}
    def source_ok(p):
        return (p.is_file() and p.suffix.lower() in VALID_SUFFIXES
                and has_gangnae_hint(p.stem)
                and any(h in p.stem.lower() for h in ('link','node','링크','노드','network','네트워크','도로망','speed','속도'))
                and not any(part.lower() in ignored for part in p.relative_to(base).parts)
                and not p.stem.lower().startswith(('canonical_','od_')))
    return sorted((p for p in base.rglob('*') if source_ok(p)),
                  key=lambda p:(len(p.relative_to(base).parts),p.suffix.lower()!='.gpkg',str(p)))


def select_network(base:Path, *,network_file=None,nodes_file=None,links_file=None)->SelectedNetwork:
    """Fail closed: never discover/use files named Cheongju as default Gangnae network."""
    base=Path(base)
    if network_file:
        s=Path(network_file)
        if not s.is_file():raise FileNotFoundError(f'지정한 강내 네트워크 파일이 없습니다: {s}')
        if not has_gangnae_hint(s.stem):raise ValueError(f'강내 자료 확인이 필요합니다: {s.name} (파일명에 강내/kangnae 포함 필요)')
        if s.suffix.lower() not in ('.gpkg','.sqlite','.db'):raise ValueError('단일 --network-file은 .gpkg/.sqlite/.db만 지원합니다')
        return SelectedNetwork('gpkg',source=s)
    if nodes_file or links_file:
        if not (nodes_file and links_file):raise ValueError('--nodes, --links는 반드시 함께 지정하세요')
        n,l=Path(nodes_file),Path(links_file)
        if not (n.is_file() and l.is_file()):raise FileNotFoundError('노드/링크 중 파일이 없습니다')
        if not(has_gangnae_hint(n.stem) and has_gangnae_hint(l.stem)):
            raise ValueError('노드와 링크 모두 파일명에 강내/kangnae가 있어야 합니다')
        return SelectedNetwork('pair',nodes=n,links=l)
    expanded=base/'강내면_우회경로확장_검증본.gpkg'
    if expanded.is_file():return SelectedNetwork('gpkg',source=expanded)
    files=available_gangnae_files(base)
    gpkg=[p for p in files if p.suffix.lower() in ('.gpkg','.sqlite','.db')]
    if gpkg:
        # If historical and finalized Gangnae networks coexist, use finalized.
        # Callers may still explicitly select one with --network-file.
        gpkg=sorted(gpkg,key=lambda p:('확정' not in p.stem, '최종' not in p.stem,
                                       len(p.relative_to(base).parts),p.name))
        return SelectedNetwork('gpkg',source=gpkg[0])
    nodes=[p for p in files if any(k in p.stem.lower() for k in NODE_HINTS)]
    links=[p for p in files if any(k in p.stem.lower() for k in LINK_HINTS)]
    if nodes and links:
        # Prefer colocated pair if possible
        for n in nodes:
            matched=next((l for l in links if l.parent==n.parent),None)
            if matched:return SelectedNetwork('pair',nodes=n,links=matched)
        return SelectedNetwork('pair',nodes=nodes[0],links=links[0])
    raise FileNotFoundError(
        f'강내 노드·링크/네트워크 자료를 찾지 못했습니다: {base}\n'
        '필요: 강내네트워크.gpkg 또는 강내노드.xlsx+강내링크.xlsx (CSV도 가능).\n'
        '청주 전역 cheongju_network_final.gpkg는 자동 대체하지 않습니다.'
    )


def read_table(path:Path,layer:str|None=None):
    """Attribute table reader; geometries need separately supplied lon/lat and length attributes.

    For gpkg/shp where geometry-only coordinates exist, optional geopandas fallback is supported.
    """
    path=Path(path)
    suffix=path.suffix.lower()
    if suffix in ('.gpkg','.sqlite','.db'):
        with database(str(path)) as c:
            c.row_factory=sqlite3.Row
            tables=[x[0] for x in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            if layer is None:raise ValueError('GPKG requires layer name')
            if layer not in tables:raise ValueError(f'Layer {layer} not found in {path.name}. Available: {tables}')
            safe='"'+layer.replace('"','""')+'"'
            rows=[dict(r) for r in c.execute('SELECT * FROM '+safe)]
        return rows
    if suffix=='.csv':
        for encoding in ('utf-8-sig','cp949','euc-kr'):
            try:
                with path.open(encoding=encoding,newline='') as f:
                    return list(csv.DictReader(f))
            except UnicodeDecodeError:
                pass
        raise ValueError(f'CSV 인코딩 확인이 필요합니다: {path}')
    if suffix=='.xlsx':
        workbook = load_workbook(filename=path, read_only=True, data_only=True)
        try:
            sheet = workbook[layer] if layer else workbook.worksheets[0]
            values = sheet.iter_rows(values_only=True)
            header = [str(v).strip() if v is not None else '' for v in next(values)]
            if not any(header):
                raise ValueError(f'엑셀 첫 행의 헤더가 비어 있습니다: {path}')
            allrows = []
            for cells in values:
                if not cells or all(v is None or str(v).strip()=='' for v in cells):
                    continue
                allrows.append(dict(zip(header, cells)))
                if len(allrows) >= 50000:
                    raise ValueError('50,000 rows reached; inspect input workbook')
            return allrows
        finally:
            workbook.close()
    if suffix=='.shp':
        try:
            import geopandas as gpd
        except ImportError as e:
            raise RuntimeError('SHP support requires geopandas: pip install geopandas') from e
        gdf=gpd.read_file(path)
        return [row.to_dict() for _,row in gdf.iterrows()]
    raise ValueError(f'Unsupported network format: {path}')


def _select_layers(path:Path, node_layer=None, link_layer=None):
    with database(str(path)) as c:
        tables=[x[0] for x in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    user_tables=[n for n in tables if not n.startswith(('gpkg_','rtree_','sqlite_'))]
    node=[n for n in user_tables if any(k in n.lower() for k in NODE_HINTS)]
    link=[n for n in user_tables if any(k in n.lower() for k in LINK_HINTS)]
    if node_layer is not None or link_layer is not None:
        if not(node_layer and link_layer):
            raise ValueError('--node-layer와 --link-layer를 함께 지정하세요')
        if node_layer not in user_tables or link_layer not in user_tables:
            raise ValueError(f'레이어 이름 오류: {node_layer}, {link_layer}; 사용 가능 {user_tables}')
        return node_layer,link_layer
    if not(node and link):
        raise ValueError(f'강내 GeoPackage에서 node/link 레이어를 인식하지 못했습니다. 레이어: {user_tables}. '
                         '--node-layer 와 --link-layer 옵션으로 명시하세요.')
    if len(node)!=1 or len(link)!=1:
        raise ValueError('Ambiguous network layers; specify --node-layer and --link-layer')
    return node[0],link[0]


def _row_is_geometry_only(rows):
    return bool(rows) and not any(v is not None for v in [_col(rows[0],['lon','longitude','경도','node_x','x'])])


def _get_spatial_rows(path,layer,records,kind):
    """Use optional GeoPandas only where geometry must supply missing coordinates/length."""
    if not records:return records
    need_geometry = kind=='node' and _row_is_geometry_only(records)
    need_geometry |= kind=='link' and _col(records[0],['length_m','length','link_length','거리','연장','dist_m']) is None
    if not need_geometry:return records
    try:import geopandas as gpd
    except ImportError as e:
        raise ValueError(f'{path.name}의 {layer} 레이어에는 좌표/거리 속성이 없습니다. '
                         'geopandas를 설치하거나 노드 경도/위도, 링크 length_m 컬럼을 추가해 주세요.') from e
    gdf=gpd.read_file(path,layer=layer) if path.suffix.lower()!='.shp' else gpd.read_file(path)
    if kind=='node':
        if gdf.crs is None:raise ValueError('노드 지오메트리의 CRS가 필요합니다')
        geo=gdf.to_crs(4326).geometry
        return [dict(row,lon=float(g.x),lat=float(g.y)) for row,g in zip(records,geo)]
    if gdf.crs is None:raise ValueError('링크 지오메트리의 CRS가 필요합니다')
    geo=gdf.to_crs(5179).geometry
    return [dict(row,length_m=float(g.length)) for row,g in zip(records,geo)]


def find_speed_file(base:Path, explicit=None) -> Path|None:
    """Find authoritative Gangnae link speed workbook, if present.

    Do not silently load a similarly named Cheongju-wide speed workbook.
    """
    if explicit:
        p=Path(explicit)
        if not p.is_file():raise FileNotFoundError(f'강내 링크 속도 파일 없음: {p}')
        if not has_gangnae_hint(p.stem):raise ValueError(f'강내 속도 파일명인지 확인: {p}')
        return p
    base=Path(base)
    if not base.is_dir():return None
    expanded=base/'강내links_확장본_속도매칭검증.xlsx'
    if expanded.is_file():return expanded
    files=available_gangnae_files(base)
    scored=[]
    for p in files:
        name=p.stem.lower()
        if p.suffix.lower() not in ('.xlsx','.csv'):continue
        if ('speed' in name or '속도' in name) and ('link' in name or '링크' in name):
            scored.append(p)
    return min(scored,key=lambda x:(len(x.relative_to(base).parts),'최종' not in x.stem,x.name)) if scored else None


def overlay_final_link_speeds(link_rows:list[dict],speed_file:Path, *,
                              speed_column=None,speed_unit='kmh')->dict:
    """Override graph edge speed with an explicitly unit-labeled workbook field.

    Match by LINK_ID when both tables have one; otherwise unique (from,to) pair.
    Match failures are never silently considered successful integration.
    """
    if speed_unit not in ('kmh','mps'):
        raise ValueError('speed_unit must be kmh or mps')
    # Expanded workbook starts with a summary sheet, not the link table.
    sheet_name=None
    if Path(speed_file).suffix.lower()=='.xlsx':
        wb=load_workbook(speed_file,read_only=True,data_only=True)
        candidates=[]
        for ws in wb:
            header=next(ws.iter_rows(values_only=True),())
            keys={str(x).strip().casefold() for x in header if x is not None}
            if keys & {'link_id','linkid','링크 id','링크id','from_node'}:
                candidates.append(ws.title)
        wb.close()
        if len(candidates)!=1:
            raise ValueError(f'Expected one link speed sheet, found {candidates}')
        sheet_name=candidates[0]
    rows=read_table(speed_file,layer=sheet_name)
    if not rows:raise ValueError(f'빈 강내 링크 속도 파일: {speed_file}')
    accepted=['적용속도 km/h','speed_kph','speed_kmh','speed_km_h','avg_speed_kmh','average_speed_kmh',
       '속도_kmh','속도(km/h)','속도kmh','링크속도_kmh','통행속도_kmh','평균속도(km/h)',
       'average_speed_kph','speed (km/h)','speed_km/h','속도(km/h)','SPEED(KM/H)']
    # If the workbook uses an ambiguous `speed`/`속도` heading, require explicit unit confirmation.
    speed_names=[speed_column] if speed_column else accepted
    if _col(rows[0],speed_names) is None:
        raise ValueError(f'강내 속도파일에서 km/h 속도 컬럼을 찾지 못했습니다: {list(rows[0])}. '
                         '--speed-column 컬럼명 --speed-unit kmh 또는 mps를 명시하세요.')
    ids=['링크 ID','link_id','linkid','링크id','링크번호','링크_ID','id']
    froms=['startnode','from_node','fromnode','f_node','fnode','source','시점노드','시작노드','from_id','f_node_id']
    tos=['endnode','to_node','tonode','t_node','tnode','target','종점노드','도착노드','to_id','t_node_id']
    id_pairs={};byid={};bypair={};ambiguous_pairs=set();nonpositive=0;duplicate_conflicts=[]
    for row in rows:
        value=_col(row,speed_names)
        if value is None:continue
        try: v=_number(value)*(3.6 if speed_unit=='mps' else 1.)
        except (ValueError,TypeError):continue
        if not 0<v<=150:
            nonpositive+=1;continue
        rid=_col(row,ids)
        if rid is not None:
            k=_normalize_id(rid)
            if k in byid and abs(byid[k]-v)>1e-6:duplicate_conflicts.append(('linkid',k))
            byid[k]=v
            su,sv=_col(row,froms),_col(row,tos)
            if su is not None and sv is not None:
                pair=(_normalize_id(su),_normalize_id(sv))
                if k in id_pairs and id_pairs[k]!=pair:
                    raise ValueError(f'Conflicting speed endpoints for link {k}')
                id_pairs[k]=pair
        u,vv=_col(row,froms),_col(row,tos)
        if u is not None and vv is not None:
            key=(_normalize_id(u),_normalize_id(vv))
            if key in bypair and abs(bypair[key]-v)>1e-6:
                ambiguous_pairs.add(key)
            else:
                bypair[key]=v
    if duplicate_conflicts:
        raise ValueError('속도표의 동일 LINK_ID에 서로 다른 속도 값: '+str(duplicate_conflicts[:6]))
    for key in ambiguous_pairs:bypair.pop(key,None)
    if not byid and not bypair:raise ValueError('속도표에 링크 ID 또는 양끝 노드가 없습니다')
    matched=0;id_matches=0;edge_matches=0
    for row in link_rows:
        link_id=_col(row,ids)
        found=None
        if link_id is not None and byid:
            found=byid.get(_normalize_id(link_id))
            if found is not None:
                pair=(_normalize_id(_col(row,froms)),_normalize_id(_col(row,tos)))
                if _normalize_id(link_id) in id_pairs and id_pairs[_normalize_id(link_id)]!=pair:
                    raise ValueError(f'Speed LINK_ID endpoint mismatch: {link_id}')
                id_matches+=1
        if found is None and bypair and (link_id is None or not byid):
            u,v=_col(row,froms),_col(row,tos)
            if u is not None and v is not None:
                found=bypair.get((_normalize_id(u),_normalize_id(v)))
                if found is not None:edge_matches+=1
        if found is not None:
            row['speed_kph']=found
            row['__final_speed_overlay']=True  # chosen final speed overrides any stale GPKG travel_time
            matched+=1
    if matched<len(link_rows):
        raise ValueError('속도표 전체 매칭 실패. 누락/잘못된 LINK_ID 또는 FROM/TO를 확인하세요.')
    return {'speed_sheet':sheet_name,'speed_file':str(speed_file),'speed_rows':len(rows),
            'speed_valid_keyed_rows':max(len(byid),len(bypair)),
            'speed_matched_links':matched,'speed_total_links':len(link_rows),
            'speed_link_coverage_pct':round(100*matched/len(link_rows),2),
            'speed_matched_by_id':id_matches,'speed_matched_by_edge':edge_matches,
            'speed_rejected_invalid_values':nonpositive,'speed_ambiguous_node_pairs_excluded':len(ambiguous_pairs),'speed_unit':speed_unit,
            'speed_overlay_status':('PARTIAL_MATCH_REVIEW' if matched<len(link_rows) else 'MATCHED_ALL_LINKS')}


def normalize_to_sqlite(selected:SelectedNetwork, destination:Path, *, speed_file=None,
                        speed_column=None, speed_unit='kmh', node_layer=None, link_layer=None,
                        require_link_geometry=False):
    """Canonical SQLite data schema consumed by our original OD algorithm.

    Source must be tagged Gangnae. Does not infer false GPS observations or guaranteed road access.
    """
    if selected.kind=='gpkg':
        nt,lt=_select_layers(selected.source,node_layer=node_layer,link_layer=link_layer)
        node_rows=read_table(selected.source,nt)
        link_rows=read_table(selected.source,lt)
        node_rows=_get_spatial_rows(selected.source,nt,node_rows,'node')
        link_rows=_get_spatial_rows(selected.source,lt,link_rows,'link')
        # Use the true GPKG polyline geometry, not straight endpoint chords.
        # Re-read the layer through GeoPandas; its rows and geometry have a common order.
        try:
            import geopandas as gpd
            gdf=gpd.read_file(selected.source, layer=lt)
            if gdf.crs is None or len(gdf)!=len(link_rows):
                raise ValueError('원본 링크 geometry CRS/행 수 불일치')
            gdf=gdf.to_crs(5179)
            feature_rows=[]
            for _,feature in gdf.iterrows():
                attr=feature.drop(labels='geometry').to_dict()
                geom=feature.geometry
                if geom is None or geom.is_empty:
                    raise ValueError('강내 링크 geometry 누락')
                attr['__geometry_5179_wkt']=geom.wkt
                feature_rows.append(attr)
            # Derive geometrical length only when source attributes lack a link length.
            for attr, g in zip(feature_rows, gdf.geometry):
                if _col(attr,['length_m','length','link_length','거리','연장','dist_m']) is None:
                    attr['length_m']=float(g.length)
            link_rows=feature_rows
            geometry_status='GPKG_ACTUAL_POLYLINES'
        except Exception as e:
            if require_link_geometry:
                raise ValueError('강내 GPKG에서 실제 도로 링크 geometry를 읽어야 합니다: '+str(e)) from e
            geometry_status='NODE_ENDPOINT_CHORD_FALLBACK'
    else:
        geometry_status='NODE_ENDPOINT_CHORD_FALLBACK'
        if require_link_geometry:
            raise ValueError('Nearest-Link 정확도 보장을 위해 geometry가 있는 강내 GPKG가 필요합니다. '
                             '노드/링크 Excel만으로는 실제 도로 굴곡을 알 수 없습니다.')
        nt,lt=selected.nodes.stem,selected.links.stem
        node_rows=read_table(selected.nodes)
        link_rows=read_table(selected.links)
        if selected.nodes.suffix.lower()=='.shp':node_rows=_get_spatial_rows(selected.nodes,None,node_rows,'node')
        if selected.links.suffix.lower()=='.shp':link_rows=_get_spatial_rows(selected.links,None,link_rows,'link')
    if not node_rows or not link_rows:raise ValueError('Empty Gangnae node/link input')
    speed_report={'speed_overlay_status':'NO_EXTERNAL_SPEED_WORKBOOK'}
    if speed_file is not None:
        speed_path=Path(speed_file)
        # Even when --links points to this same workbook, validate the speed column/units
        # explicitly and merge through stable link ID or directed endpoints.
        speed_report=overlay_final_link_speeds(link_rows,speed_path,
                             speed_column=speed_column,speed_unit=speed_unit)


    conv=Transformer.from_crs(5179,4326,always_xy=True)
    nodes=[];seen=set()
    for i,row in enumerate(node_rows):
        raw_id=_col(row,['node_id','nodeid','노드id','노드번호','n_id','osmid','id','vertex_id','nodeno'])
        rawx=_col(row,['lon','longitude','경도','node_x','x','xcoord','x좌표','node_lon','node_longitude'])
        rawy=_col(row,['lat','latitude','위도','node_y','y','ycoord','y좌표','node_lat'])
        if raw_id is None or rawx is None or rawy is None:raise ValueError(f'강내 노드 컬럼 확인 필요 (row {i+2}): {list(row)}')
        nid=_normalize_id(raw_id)
        if nid in seen:raise ValueError(f'중복 node ID {nid}')
        seen.add(nid)
        x,y=_number(rawx),_number(rawy)
        if 120<=x<=135 and 30<=y<=40:
            lon,lat=x,y
        elif abs(x)>1000 and abs(y)>1000:
            lon,lat=conv.transform(x,y)
        else:
            raise ValueError(f'알 수 없는 노드 좌표계 {nid}: ({x},{y}); EPSG:4326 또는 EPSG:5179만 지원')
        nodes.append((nid,float(lon),float(lat)))

    links=[]; missing_references=[];onemode=Counter(); speed_input_count=0; time_input_count=0
    for i,row in enumerate(link_rows):
        raw_u=_col(row,['from_node','fromnode','f_node','fnode','source','startnode','시점노드','시작노드','시점id','from_id','f_node_id'])
        raw_v=_col(row,['to_node','tonode','t_node','tnode','target','endnode','종점노드','도착노드','종점id','to_id','t_node_id'])
        raw_len=_col(row,['length_m','length','link_length','linklength','거리','연장','dist_m','distance_m','road_length'])
        if raw_u is None or raw_v is None or raw_len is None:
            raise ValueError(f'강내 링크 필수 컬럼 누락 (row {i+2}): {list(row)}')
        u,v=_normalize_id(raw_u),_normalize_id(raw_v)
        if u not in seen or v not in seen:
            missing_references.append((u,v));continue
        d=_number(raw_len)
        if d<=0:continue
        raw_one=_col(row,['oneway','one_way','is_oneway','일방통행','direction'],default=None)
        if raw_one is None:
            mode=0;onemode['missing_assumed_bidirectional']+=1
        elif str(raw_one).strip().casefold() in ['1','1.0','yes','true','y','ft','forward','단방향']:
            mode=1;onemode['forward']+=1
        elif str(raw_one).strip().casefold() in ['-1','-1.0','reverse','tf','backward']:
            u,v=v,u;mode=1;onemode['reverse']+=1
        elif str(raw_one).strip().casefold() in ['0','0.0','no','false','n','both','bidirectional','양방향']:
            mode=0;onemode['bidirectional']+=1
        else:
            raise ValueError(f'일방통행 값 의미 확인 필요: {raw_one} (row {i+2})')
        highway=str(_col(row,['highway','road_type','도로등급','도로종류','road_class'],default='unclassified'))
        # Optional link speeds are only accepted in explicit km/h fields; a bare
        # `speed` label can have unknown units and is not guessed here.
        source_speed=_col(row,['speed_kph','speed_kmh','speed_km_h','avg_speed_kmh',
                         'average_speed_kmh','속도_kmh','속도(km/h)','속도kmh',
                         '링크속도_kmh','통행속도_kmh'],default=None)
        source_time=(None if row.get('__final_speed_overlay') else
            _col(row,['travel_time_min','time_min','travel_minutes','통행시간_분'],default=None))
        if source_speed is not None:
            source_speed=_number(source_speed)
            if not 0<source_speed<=150:raise ValueError(f'링크 속도 값 범위 오류(row {i+2}): {source_speed}')
            speed_input_count+=1
        if source_time is not None:
            source_time=_number(source_time)
            if not 0<source_time<1440:raise ValueError(f'링크 시간 값 범위 오류(row {i+2}): {source_time}')
            time_input_count+=1
        raw_link_id=_col(row,['link_id','linkid','링크id','링크번호','id'],default=None)
        link_id=_normalize_id(raw_link_id) if raw_link_id is not None else f'GENERATED_LINK_{i+1}'
        geom_wkt=row.get('__geometry_5179_wkt')
        links.append((u,v,d,mode,highway,source_speed,source_time,link_id,geom_wkt))
    if missing_references:
        raise ValueError(f'강내 링크의 미존재 노드 참조 {len(missing_references)}건. 예: {missing_references[:4]}')
    if not links:raise ValueError('Usable Gangnae links: zero')

    import networkx as nx
    G=nx.Graph()
    G.add_nodes_from(n[0] for n in nodes)
    G.add_edges_from((u,v) for u,v,*_ in links)
    main=min(nx.connected_components(G),key=lambda c:(-len(c),tuple(sorted(c))))
    destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
    if destination.exists():destination.unlink()
    with database(destination) as c:
        c.execute('CREATE TABLE road_node (node_id TEXT PRIMARY KEY, lon REAL, lat REAL, main_component INTEGER)')
        c.execute('CREATE TABLE road_link (from_node TEXT, to_node TEXT, length_m REAL, oneway INTEGER, highway TEXT, main_component INTEGER, speed_kph REAL, travel_time_min REAL, link_id TEXT, geom_wkt_5179 TEXT)')
        c.executemany('INSERT INTO road_node VALUES (?,?,?,?)',[(nid,lon,lat,int(nid in main)) for nid,lon,lat in nodes])
        c.executemany('INSERT INTO road_link VALUES (?,?,?,?,?,?,?,?,?,?)',[(u,v,d,o,h,int(u in main and v in main),speed,minutes,lid,wkt) for u,v,d,o,h,speed,minutes,lid,wkt in links])
    sources=[str(selected.source)] if selected.source else [str(selected.nodes),str(selected.links)]
    report={'network_scope':'GANGNAE_LOCAL_INPUT_ONLY','source_files':sources,'input_layers':[nt,lt],
            'road_node_count':len(nodes),'road_link_count':len(links),'link_geometry_status':geometry_status,
            'main_component_nodes':len(main),'other_component_nodes':len(nodes)-len(main),
            'oneway_count_or_assumption':dict(onemode),
            'coordinate_reference':'WGS84 EPSG:4326 node lon/lat, transformed from EPSG:5179 if needed',
            'road_speed_status':f'Optional source link times={time_input_count} and speeds_kph={speed_input_count}; otherwise road-class speed assumptions. Not GPS-validated',
            'source_link_time_count':time_input_count,'source_link_speed_kph_count':speed_input_count,
            'warning':'Network normalized from user local Gangnae inputs; link accessibility/turn rules still require validation.'}
    report.update(speed_report)
    return report


# ===== Source section: network.py =====
"""Directed Gangnae road OD matrix: distances along the FASTEST travel-time path.

DISCLAIMER: nearest-node snap and assumed OSM-class speeds; turn restrictions, passability,
roadside stopping, and actual time of day have NOT been calibrated. No route is a verified on-road trace.
"""
import ast,csv,sqlite3,math
from functools import cached_property
from pathlib import Path
from dataclasses import dataclass
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from pyproj import Transformer

SPEED_KPH={'motorway':65,'motorway_link':40,'trunk':50,'trunk_link':35,'primary':45,'primary_link':25,
           'secondary':40,'secondary_link':25,'tertiary':30,'tertiary_link':25,'unclassified':22,
           'residential':22,'service':15,'living_street':12,'road':20}


def speed_kph(raw):
    if raw is None:return 20
    if str(raw).startswith('['):
        try:
            x=ast.literal_eval(raw)
            if isinstance(x,(list,tuple)):return min(SPEED_KPH.get(str(v),20) for v in x)
        except (ValueError,SyntaxError):pass
    return SPEED_KPH.get(str(raw),20)

@dataclass
class OD:
    ids:list[str]
    time:np.ndarray
    distance:np.ndarray
    snaps:dict[str,float]
    shortest_distance:np.ndarray|None=None
    
    @cached_property
    def id_to_idx(self):return {key:i for i,key in enumerate(self.ids)}
    def index(self):return self.id_to_idx
    def minutes(self,a,b):
        ix=self.id_to_idx;return float(self.time[ix[a],ix[b]])
    def km(self,a,b):
        ix=self.id_to_idx;return float(self.distance[ix[a],ix[b]])/1000
    def direct_km(self,a,b):
        if self.shortest_distance is None:
            raise ValueError("최단거리 행렬 없음: network를 다시 생성하세요")
        ix=self.id_to_idx;return float(self.shortest_distance[ix[a],ix[b]])/1000
    def save(self,folder):
        out=Path(folder);out.mkdir(parents=True,exist_ok=True)
        payload=dict(ids=np.asarray(self.ids),time=self.time,distance=self.distance)
        if self.shortest_distance is not None:payload['shortest_distance']=self.shortest_distance
        np.savez_compressed(out/'od_time_optimal.npz',**payload)
        if hasattr(self,'snap_rows'):
            write_csv(out/'snap_QA.csv',self.snap_rows,
                 ['point_id','source_lon','source_lat','link_id','link_row',
                  'snap_distance_m','road_lon','road_lat','requires_review','service_graph_node'])
        else:
            with (out/'snap_QA.csv').open('w',newline='',encoding='utf-8-sig') as f:
                w=csv.writer(f);w.writerow(['point_id','distance_to_nearest_main_node_m','needs_access_review_100m'])
                for k,d in self.snaps.items():w.writerow([k,round(d,2),int(d>100)])
    @staticmethod
    def load(folder):
        from network_cache import validate
        validate(folder)
        with np.load(Path(folder)/'od_time_optimal.npz') as z:
            return OD(z['ids'].tolist(),z['time'],z['distance'],{},z['shortest_distance'] if 'shortest_distance' in z else None)


def build_od(gpkg_path, point_coords:dict[str,tuple[float,float]]) -> OD:
    """Point coords are lon,lat in EPSG:4326. Graph uses main component nodes only.

    Reconstruct length on min-time predecessor path so OD time and length use the same actual graph path.
    """
    with database(str(gpkg_path)) as c:
        nodes=c.execute('SELECT node_id,lon,lat FROM road_node WHERE main_component=1').fetchall()
        link_cols={r[1] for r in c.execute('PRAGMA table_info(road_link)')}
        speed_sql='speed_kph' if 'speed_kph' in link_cols else 'NULL AS speed_kph'
        time_sql='travel_time_min' if 'travel_time_min' in link_cols else 'NULL AS travel_time_min'
        links=c.execute(f'SELECT from_node,to_node,length_m,oneway,highway,{speed_sql},{time_sql} FROM road_link WHERE main_component=1').fetchall()
    n=len(nodes); index={str(v[0]):i for i,v in enumerate(nodes)}
    edges={}
    for u,v,length,oneway,hw,observed_speed,provided_time in links:
        u,v=str(u),str(v)
        if u not in index or v not in index or u==v or length is None or float(length)<=0:continue
        i,j=index[u],index[v];length=float(length)
        # Prefer explicitly provided minutes, next explicit speed in km/h;
        # otherwise use assumed speeds by highway class.
        if provided_time is not None and 0<float(provided_time)<1440:
            t=float(provided_time)
        elif observed_speed is not None and 0<float(observed_speed)<=150:
            t=length/1000/float(observed_speed)*60
        else:
            t=length/1000/speed_kph(hw)*60
        key=(i,j)
        if key not in edges or edges[key][0]>t:edges[key]=(t,length)
        if int(oneway)==0:
            key=(j,i)
            if key not in edges or edges[key][0]>t:edges[key]=(t,length)
    rr=[];cc=[];ww=[];lengths={}
    for (i,j),(tt,dd) in edges.items():rr.append(i);cc.append(j);ww.append(tt);lengths[(i,j)]=dd
    graph=csr_matrix((ww,(rr,cc)),shape=(n,n))
    transformer=Transformer.from_crs('EPSG:4326','EPSG:5179',always_xy=True)
    node_proj=np.array([transformer.transform(float(x[1]),float(x[2])) for x in nodes])
    tree=cKDTree(node_proj)
    ids=list(point_coords)
    snapped=[];snaps={}
    for pid,(lon,lat) in sorted(point_coords.items()):
        d,i=tree.query(transformer.transform(lon,lat))
        snapped.append(int(i));snaps[pid]=float(d)
    # One source per unique snapped node, avoids duplicates.
    selected=np.asarray(sorted(set(snapped)),dtype=int)
    cost,prev=dijkstra(graph,directed=True,indices=selected,return_predecessors=True)
    sindex={int(x):j for j,x in enumerate(selected)}
    m=len(ids);time=np.empty((m,m));distance=np.empty((m,m))
    for ii,src in enumerate(snapped):
        index_row=sindex[src];time[ii]=cost[index_row,np.asarray(snapped,dtype=int)]
        dist_cache={src:0.0}
        def dist_of(dest):
            if dest in dist_cache:return dist_cache[dest]
            trail=[];x=dest
            while x not in dist_cache:
                px=int(prev[index_row,x])
                if px<0:return float('inf')
                trail.append((px,x));x=px
            acc=dist_cache[x]
            for px,nxt in reversed(trail):
                acc+=lengths[(px,nxt)];dist_cache[nxt]=acc
            return acc
        for jj,dst in enumerate(snapped):distance[ii,jj]=dist_of(dst)
    return OD(ids,time,distance,snaps)


# ===== Source section: local_paths.py =====
"""Local Windows path detection, with explicit user-data-dir override.

Never substitute Cheongju-wide graph for Gangnae-local graph.
"""
import os
from pathlib import Path


def root_for_user(explicit=None):
    if explicit:return Path(explicit)
    env=os.environ.get('KANGNAE_DATA_DIR')
    if env:return Path(env)
    if WINDOWS_BASE.is_dir():return WINDOWS_BASE
    # Allow portable project extraction and test execution.
    root=Path(__file__).resolve().parents[2]
    for folder in [root.parent,root,root/'data'/'raw']:
        if folder.is_dir() and any(folder.glob('*231106-231112*.csv')):
            return folder
    return WINDOWS_BASE


def find_one(base, patterns):
    base=Path(base)
    if not base.is_dir():return None
    for pat in patterns:
        matches=sorted(p for p in base.rglob(pat) if p.is_file())
        if matches:return matches[0]
    return None


def resolve_raw(base,kind,explicit=None):
    if explicit is not None:
        target=Path(explicit)
        if not target.is_file():raise FileNotFoundError(f'{kind} 입력 파일을 찾지 못했습니다: {target}')
        return target
    patterns=(['*231106-231112*(1).csv','*231106-231112*.csv','*DRT*호출*.csv']
              if kind=='calls' else ['*강내면*물류*데이터*.xlsx','*강내*물류*.xlsx'])
    got=find_one(base,patterns)
    if not got:raise FileNotFoundError(f'{kind} 입력을 {base}에서 찾지 못했습니다. --{kind}로 원본 경로를 지정하세요.')
    return got


# ===== Source section: observed_gap.py =====
"""Actual completed-calls passenger-onboard-interval merging.

This detects OBSERVED NON-ONBOARD GAPS ONLY; not idle or available time.
No GPS is present, and vehicle duty boundaries are unknown.
"""
from collections import defaultdict
from dataclasses import dataclass


def vehicle_gap_events(obs:list[ObservedPassenger]):
    by=defaultdict(list)
    for x in obs:by[(x.date,x.vehicle_id)].append(x)
    gaps=[];days=[]
    for (date,vid),group in sorted(by.items()):
        intervals=[]
        for x in sorted(group,key=lambda z:(z.pickup_time,z.dropoff_time)):
            if intervals and x.pickup_time<=intervals[-1]['end']:
                intervals[-1]['end']=max(intervals[-1]['end'],x.dropoff_time)
                if x.dropoff_time>=intervals[-1]['last'].dropoff_time:intervals[-1]['last']=x
                intervals[-1]['calls'].append(x.id)
            else:
                intervals.append({'start':x.pickup_time,'end':x.dropoff_time,'first':x,'last':x,'calls':[x.id]})
        vehicle_gaps=[]
        for i,(a,b) in enumerate(zip(intervals,intervals[1:])):
            diff=b['start']-a['end']
            if diff<0:raise AssertionError('Overlapping merged interval')
            vehicle_gaps.append(diff)
            gaps.append({'date':str(date),'vehicle_id':vid,'seq':i+1,
                        'previous_dropoff_min':round(a['end'],3),'next_pickup_min':round(b['start'],3),
                        'nonpassenger_interval_min':round(diff,3),
                        'previous_dropoff_node':a['last'].dropoff,
                        'next_pickup_node':b['first'].pickup,
                        'is_actual_idle_observed':False})
        days.append({'date':str(date),'vehicle_id':vid,'calls':len(group),
                     'merged_onboard_intervals':len(intervals),
                     'candidate_nonpassenger_gaps':len(vehicle_gaps),
                     'candidate_nonpassenger_minutes':round(sum(vehicle_gaps),3),
                     'gaps_at_least_30min':sum(x>=30 for x in vehicle_gaps)})
    return gaps,days

# ===== Version 4: geometry-aware service-node insertion =====
def build_od_link_snap(
    sqlite_path: str | Path,
    point_coords: dict[str, tuple[float, float]],
    *,
    qa_dir: str | Path | None = None,
    max_snap_m: float = 100.0,
    allow_long_snaps: bool = False,
    require_actual_link_geometry: bool = True,
) -> OD:
    """OD from actual *link positions*; not from road-intersection nearest nodes.

    Each STOP/HUB/DEPOT WGS84 coordinate is projected to the nearest actual
    Gangnae road polyline (EPSG:5179). A new vertex is inserted at each unique
    projected point on its original road link. Multiple stops at the same point
    share that inserted vertex. Adjacent split edges inherit the original link's
    travel time, length, and one-way direction in proportion to arc length.

    This operation preserves the original graph topology. A nearby crossing road
    does NOT become connected unless the GPKG topological endpoints connect.
    Off-road access is NOT silently counted as a vehicle-drivable connector.
    Distances from original coordinates to projected road points are exported
    for site-access review; >max_snap_m fails unless explicitly acknowledged.

    Geometry-only nodal Excel/CSV inputs have no true link linework. They are
    rejected by default; synthetic straight chords are for explicitly approved
    diagnostics only, not an actual route validation.
    """
    import json
    from collections import defaultdict
    from shapely.geometry import Point, LineString, MultiLineString, mapping
    from shapely import wkt
    from shapely.ops import linemerge
    from shapely.strtree import STRtree
    import numpy as np
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    from pyproj import Transformer

    if not point_coords:
        raise ValueError('승하차·물류거점 좌표가 없습니다.')
    if max_snap_m <= 0:
        raise ValueError('max_snap_m must be positive')
    with database(str(sqlite_path)) as c:
        rows_n=c.execute(
            'SELECT node_id,lon,lat FROM road_node WHERE main_component=1'
        ).fetchall()
        schema={r[1] for r in c.execute('PRAGMA table_info(road_link)')}
        if 'geom_wkt_5179' not in schema:
            raise ValueError('링크 geometry 필드 없음. v4의 network 명령으로 강내 GPKG를 다시 정규화하세요.')
        rows_l=c.execute(
            'SELECT from_node,to_node,length_m,oneway,highway,speed_kph,travel_time_min,link_id,geom_wkt_5179 '
            'FROM road_link WHERE main_component=1'
        ).fetchall()
    if not rows_n or not rows_l:
        raise ValueError('강내 주 연결요소에 사용 가능한 노드 또는 링크가 없습니다.')

    project=Transformer.from_crs(4326,5179,always_xy=True)
    back=Transformer.from_crs(5179,4326,always_xy=True)
    rows_n.sort(key=lambda r:str(r[0]))
    node_names=[str(r[0]) for r in rows_n]
    node_id_index={name:i for i,name in enumerate(node_names)}
    node_xy={str(nid):project.transform(float(lon),float(lat)) for nid,lon,lat in rows_n}

    links=[]
    geom_count=0
    mismatch=[]
    for ix,(u,v,length,oneway,hw,link_speed,link_time,link_id,geom_wkt) in enumerate(rows_l):
        u,v=str(u),str(v)
        if u not in node_xy or v not in node_xy or u==v or length is None or float(length)<=0:
            continue
        geom=wkt.loads(geom_wkt) if geom_wkt else None
        if geom is None:
            if require_actual_link_geometry:
                raise ValueError(f'링크 {link_id}: 실제 polyline geometry가 없습니다. GPKG 필요.')
            geom=LineString((node_xy[u],node_xy[v]))
        else:
            geom_count+=1
        if isinstance(geom,MultiLineString):
            geom=linemerge(geom)
        if not isinstance(geom,LineString) or geom.is_empty or geom.length<=0:
            raise ValueError(f'링크 {link_id}: 연속된 LineString이 아닌 geometry {geom.geom_type}')
        # Orient original feature geometry to the selected one-way u -> v.
        a=Point(geom.coords[0]);b=Point(geom.coords[-1]);pu=Point(node_xy[u]);pv=Point(node_xy[v])
        forward=a.distance(pu)+b.distance(pv)
        reverse=a.distance(pv)+b.distance(pu)
        if reverse<forward:
            geom=LineString(list(geom.coords)[::-1]);a,b=b,a
        end_gap=max(a.distance(pu),b.distance(pv))
        if end_gap>15:
            mismatch.append({'link_id':link_id,'endpoint_gap_m':round(end_gap,2)})
        length=float(length)
        if link_time is not None and 0<float(link_time)<1440:
            t=float(link_time)
        elif link_speed is not None and 0<float(link_speed)<=150:
            t=length/1000/float(link_speed)*60
        else:
            t=length/1000/speed_kph(hw)*60
        links.append({'u':u,'v':v,'distance_m':length,'time_min':t,
                      'oneway':int(oneway),'link_id':str(link_id),'line':geom})
    if not links:
        raise ValueError('강내 주 연결요소에 유효 링크가 없습니다.')

    # Sort before building STRtree / graph: input row order must not alter ties.
    links.sort(key=lambda x:(x['link_id'],x['u'],x['v'],x['oneway'],x['time_min'],x['distance_m'],x['line'].wkb_hex))
    physical={}
    representatives={}
    for li,link in enumerate(links):
        key=(tuple(sorted((link['u'],link['v']))),link['line'].normalize().wkb_hex)
        physical[li]=representatives.setdefault(key,li)
    geometries=[link['line'] for link in links]
    tree=STRtree(geometries)
    grouped=defaultdict(list)
    rows=[]
    for pid,(lon,lat) in sorted(point_coords.items()):
        if not (-180<float(lon)<180 and -90<float(lat)<90):
            raise ValueError(f'경위도 범위 오류 {pid}: {(lon,lat)}')
        raw=Point(project.transform(float(lon),float(lat)))
        # Shapely >=2 STRtree.nearest returns the geometry's integer index.
        nearest=int(tree.nearest(raw))
        gap0=float(raw.distance(geometries[nearest]))
        candidates=tree.query(raw.buffer(gap0+1e-7))
        tied=[int(i) for i in candidates if abs(raw.distance(geometries[int(i)])-gap0)<=1e-7]
        li=physical[min(tied or [nearest])]
        line=geometries[li]
        pos=float(line.project(raw))
        projected=line.interpolate(pos)
        gap=float(raw.distance(projected))
        p_lon,p_lat=back.transform(projected.x,projected.y)
        rec={'point_id':str(pid),'source_lon':float(lon),'source_lat':float(lat),
             'link_id':links[li]['link_id'],'link_row':li,'snap_distance_m':gap,
             'road_lon':p_lon,'road_lat':p_lat,
             'requires_review':int(gap>max_snap_m)}
        rows.append(rec)
        grouped[li].append((pos,str(pid),rec))

    qa_path=Path(qa_dir) if qa_dir is not None else None
    if qa_path is not None:
        qa_path.mkdir(parents=True,exist_ok=True)
        write_csv(qa_path/'snap_QA.csv',rows,
                  ['point_id','source_lon','source_lat','link_id','link_row',
                   'snap_distance_m','road_lon','road_lat','requires_review'])
        features=[{'type':'Feature','properties':{k:v for k,v in row.items()
                   if k not in ('source_lon','source_lat','road_lon','road_lat')},
                   'geometry':mapping(Point(row['road_lon'],row['road_lat']))} for row in rows]
        (qa_path/'service_nodes_on_links.geojson').write_text(
            json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False),encoding='utf-8')
        (qa_path/'link_geometry_QA.json').write_text(json.dumps({
            'original_link_count':len(links),'actual_polyline_link_count':geom_count,
            'endpoint_geometry_mismatch_over_15m_count':len(mismatch),
            'endpoint_geometry_mismatch_examples':mismatch[:20],
            'coincident_duplicate_links':sum(i!=r for i,r in physical.items()),
            'note':'GPKG 링크 polyline은 유지하고 투영점에서만 분할합니다.'
        },ensure_ascii=False,indent=2),encoding='utf-8')

    too_far=[x for x in rows if x['requires_review']]
    if too_far and not allow_long_snaps:
        worst=sorted(too_far,key=lambda x:-x['snap_distance_m'])[:8]
        example=[(x['point_id'],round(x['snap_distance_m'],1)) for x in worst]
        raise ValueError(
            f'도로 링크에서 {max_snap_m:g}m 초과한 승하차/배송지 {len(too_far)}개: {example}. '
            'snap_QA.csv와 지도에서 실제 진입도로·정류장 좌표를 확인하세요. '
            '--allow-long-snaps를 사용하면 진단용 실행만 강제로 계속할 수 있습니다.'
        )

    # Insert projected road positions into individual original links. Each group
    # of colocated points reuses the same vertex, including DEPOT/STOP_7072.
    snapped_vertex={}
    next_i=len(node_names)
    grouped_unique=defaultdict(list)
    endpoint_eps=0.05   # metres along link
    for li, pts in sorted(grouped.items()):
        line_length=links[li]['line'].length
        unique=[]
        for pos,pid,rec in sorted(pts):
            if pos<=endpoint_eps:
                snapped_vertex[pid]=node_id_index[links[li]['u']]
                rec['service_graph_node']=links[li]['u']
            elif line_length-pos<=endpoint_eps:
                snapped_vertex[pid]=node_id_index[links[li]['v']]
                rec['service_graph_node']=links[li]['v']
            elif unique and abs(pos-unique[-1][0])<=endpoint_eps:
                snapped_vertex[pid]=unique[-1][1]
                rec['service_graph_node']=f'SPLIT_{li}_{unique[-1][1]}'
            else:
                unique.append((pos,next_i))
                snapped_vertex[pid]=next_i
                rec['service_graph_node']=f'SPLIT_{li}_{next_i}'
                next_i+=1
        grouped_unique[li]=unique

    # Coincident duplicate/reverse links with identical endpoints share splits.
    # Merely crossing or nearby roads are never merged.
    for li,rep in physical.items():
        if li!=rep:
            grouped_unique[li]=sorted((float(links[li]['line'].project(links[rep]['line'].interpolate(pos))),vertex)
                                     for pos,vertex in grouped_unique[rep])

    # Preserves shortest travel-time path distance. Only original link direction
    # is inherited by split pieces; never connect two separate crossing links.
    fastest={}
    shortest_edges={}
    split_link_features=[]
    from shapely.ops import substring
    from shapely.ops import transform as transform_geometry
    for li,link in enumerate(links):
        breaks=[(0.0,node_id_index[link['u']])]+grouped_unique[li]+[(link['line'].length,node_id_index[link['v']])]
        for (a,src),(b,dst) in zip(breaks,breaks[1:]):
            if src==dst or b<=a:continue
            ratio=(b-a)/link['line'].length
            minutes=link['time_min']*ratio
            metres=link['distance_m']*ratio
            if qa_path is not None:
                segment=substring(link['line'],a,b)
                line4326=transform_geometry(lambda x,y,z=None:back.transform(x,y),segment)
                split_link_features.append({'type':'Feature','geometry':mapping(line4326),
                     'properties':{'parent_link_id':link['link_id'],
                       'segment_from_index':src,'segment_to_index':dst,
                       'oneway':link['oneway'],'length_m':metres,
                       'time_min':minutes}})
            key=(src,dst)
            shortest_edges[key]=min(metres,shortest_edges.get(key,float("inf")))
            if key not in fastest or (minutes,metres)<fastest[key]:fastest[key]=(minutes,metres)
            if link['oneway']==0:
                reverse=(dst,src)
                shortest_edges[reverse]=min(metres,shortest_edges.get(reverse,float("inf")))
                if reverse not in fastest or (minutes,metres)<fastest[reverse]:fastest[reverse]=(minutes,metres)
    if qa_path is not None:
        (qa_path/'split_links_4326.geojson').write_text(json.dumps({
             'type':'FeatureCollection','features':split_link_features
        },ensure_ascii=False),encoding='utf-8')
    if not fastest:raise ValueError('스냅된 링크 분할 후 경로 그래프가 비어 있습니다.')
    rr=[];cc=[];ww=[];edge_lengths={}
    for (src,dst),(minutes,metres) in fastest.items():
        rr.append(src);cc.append(dst);ww.append(minutes);edge_lengths[(src,dst)]=metres
    graph=csr_matrix((np.array(ww),(np.array(rr),np.array(cc))),shape=(next_i,next_i))
    ids=list(point_coords)
    source_vertices=[snapped_vertex[str(pid)] for pid in ids]
    selected=sorted(set(source_vertices))
    time_by_source, predecessor=dijkstra(graph,directed=True,indices=selected,return_predecessors=True)
    row_index={src:i for i,src in enumerate(selected)}
    m=len(ids)
    times=np.empty((m,m));distances=np.empty((m,m))
    dest_array=np.asarray(source_vertices,dtype=int)
    for i,src in enumerate(source_vertices):
        row=row_index[src]
        times[i,:]=time_by_source[row,dest_array]
        dist_cache={src:0.}
        def length_along_shortest_path(dest):
            if dest in dist_cache:return dist_cache[dest]
            trail=[];current=dest
            while current not in dist_cache:
                prev=int(predecessor[row,current])
                if prev<0:return float('inf')
                trail.append((prev,current));current=prev
            accum=dist_cache[current]
            for a,b in reversed(trail):
                accum+=edge_lengths[(a,b)]
                dist_cache[b]=accum
            return accum
        for j,dest in enumerate(source_vertices):
            distances[i,j]=length_along_shortest_path(dest)

    # Persist correct connector diagnostics, including coincident IDs and split
    # counts; source coordinate remains in the separately exported QA table.
    od=OD(ids,times,distances,{x['point_id']:x['snap_distance_m'] for x in rows})
    distance_graph=csr_matrix((np.array([shortest_edges[(a,b)] for a,b in zip(rr,cc)]),(np.array(rr),np.array(cc))),shape=(next_i,next_i))
    shortest=dijkstra(distance_graph,directed=True,indices=source_vertices)[:,dest_array]
    od.shortest_distance=shortest
    od.snap_rows=rows
    od.inserted_link_vertices=next_i-len(node_names)
    od.gpkg_polyline_links=geom_count
    return od


def configured_depot(requests=None, stop_coords=None):
    """Independent service point: never substitute a passenger stop."""
    path=Path(__file__).resolve().parent/'config/depot.json'
    info=json.loads(path.read_text(encoding='utf-8'))
    if info['selected_node_id']!='DEPOT':raise ValueError('Expected DEPOT node')
    if not (-180<info['lon']<180 and -90<info['lat']<90):raise ValueError('Invalid depot coordinates')
    return info,[]
