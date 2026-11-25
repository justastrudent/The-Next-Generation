"""Road-node rerouting on the same directed split-link network.

No instantaneous U-turn: finish travel to the next original road node first.
Link directions are represented; intersection-specific turn bans are not supplied.
"""
import csv,json,sqlite3,math
from functools import lru_cache
import networkx as nx

class RoadRouter:
    def __init__(self,folder):
        self.graph=nx.DiGraph()
        features=json.loads((folder/'split_links_4326.geojson').read_text(encoding='utf-8'))['features']
        for f in features:
            p=f['properties'];a=p['segment_from_index'];b=p['segment_to_index']
            time=float(p['time_min']);km=float(p['length_m'])/1000
            for u,v in [(a,b)]+([(b,a)] if p['oneway']==0 else []):
                old=self.graph.get_edge_data(u,v)
                if old is None or (time,km)<(old['time'],old['km']):self.graph.add_edge(u,v,time=time,km=km)
        with sqlite3.connect(folder/'canonical_gangnae_network.sqlite') as con:
            names=[str(r[0]) for r in con.execute('select node_id from road_node where main_component=1')]
        names.sort();self.original_count=len(names);index={name:i for i,name in enumerate(names)}
        with (folder/'snap_QA.csv').open(encoding='utf-8-sig') as f:
            self.service={r['point_id']:(int(r['service_graph_node'].rsplit('_',1)[1]) if r['service_graph_node'].startswith('SPLIT_') else index[r['service_graph_node']]) for r in csv.DictReader(f)}

    def node(self,name):return int(name[5:]) if name.startswith('ROAD_') else self.service[name]

    @lru_cache(maxsize=512)
    def paths(self,source):return nx.single_source_dijkstra(self.graph,source,weight='time')

    @lru_cache(maxsize=65536)
    def travel(self,a,b):
        source=self.node(a);target=self.node(b);times,paths=self.paths(source)
        if target not in times:return math.inf,math.inf
        path=paths[target];km=sum(self.graph[u][v]['km'] for u,v in zip(path,path[1:]))
        return times[target],km

    def next_road_anchor(self,leg,now):
        if now>=leg.arrival-1e-9 or leg.minutes<=0:return None
        source=self.node(leg.from_node);target=self.node(leg.stop.node)
        times,paths=self.paths(source);path=paths[target]
        total=times[target]
        if total<=0:return None
        total_km=sum(self.graph[u][v]['km'] for u,v in zip(path,path[1:]))
        departure=leg.arrival-leg.minutes;elapsed=now-departure
        time=0.;km=0.
        for u,v in zip(path,path[1:]):
            time+=self.graph[u][v]['time'];km+=self.graph[u][v]['km']
            scaled_time=time*leg.minutes/total
            if scaled_time+1e-9>=elapsed and v<self.original_count and v!=target:
                distance=km*leg.km/total_km if total_km>0 else 0
                return f'ROAD_{v}',departure+scaled_time,scaled_time,distance
        return None
