"""Structural and metric inspection of delivered GLB assets, without a map API."""
from pathlib import Path
import json, struct, math, hashlib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'

def matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix']).reshape((4,4), order='F')
    x,y,z,w=node.get('rotation',[0,0,0,1])
    result=np.eye(4)
    result[:3,:3]=np.array([
        [1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],
        [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],
        [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]
    ])@np.diag(node.get('scale',[1,1,1]))
    result[:3,3]=node.get('translation',[0,0,0])
    return result

def inspect(path):
    raw=path.read_bytes()
    magic,version,length=struct.unpack_from('<4sII',raw)
    assert magic==b'glTF' and version==2 and length==len(raw)
    offset=12;chunks=[]
    while offset<len(raw):
        size,kind=struct.unpack_from('<II',raw,offset);offset+=8
        assert size%4==0 and offset+size<=len(raw)
        chunks.append((kind,raw[offset:offset+size]));offset+=size
    assert offset==len(raw) and chunks[0][0]==0x4E4F534A
    data=json.loads(chunks[0][1]);binary=next(b for k,b in chunks if k==0x004E4942)
    assert len(data['buffers'])==1 and 'uri' not in data['buffers'][0]
    assert len(binary)>=data['buffers'][0]['byteLength']
    names=[n.get('name') for n in data['nodes']]
    needed=['DOOR','HATCH','HATCH_R','ROOF']+[f'PAX_{i}' for i in range(11)]+[f'CARGO_{i}' for i in range(8)]
    assert all(names.count(name)==1 for name in needed)
    for view in data['bufferViews']:
        assert view.get('buffer',0)==0
        assert view.get('byteOffset',0)+view['byteLength']<=len(binary)
    for image in data.get('images',[]):
        assert 'uri' not in image and 'bufferView' in image
        assert image['mimeType'] in ('image/png','image/jpeg')
    minimum=np.full(3,np.inf);maximum=np.full(3,-np.inf);triangles=0
    for mesh in data['meshes']:
        for primitive in mesh['primitives']:
            assert primitive.get('mode',4)==4
            indices=data['accessors'][primitive['indices']]
            assert indices['count']%3==0
            triangles+=indices['count']//3
            pos=data['accessors'][primitive['attributes']['POSITION']]
            assert len(pos['min'])==3 and len(pos['max'])==3
            assert all(math.isfinite(float(x)) for x in pos['min']+pos['max'])
    visited=set()
    def walk(index,parent):
        nonlocal minimum,maximum
        assert index not in visited;visited.add(index)
        node=data['nodes'][index];transform=parent@matrix(node)
        if 'mesh' in node:
            for primitive in data['meshes'][node['mesh']]['primitives']:
                accessor=data['accessors'][primitive['attributes']['POSITION']]
                lo,hi=accessor['min'],accessor['max']
                points=np.array([[x,y,z,1] for x in (lo[0],hi[0]) for y in (lo[1],hi[1]) for z in (lo[2],hi[2])])
                world=(transform@points.T).T[:,:3]
                minimum=np.minimum(minimum,world.min(axis=0));maximum=np.maximum(maximum,world.max(axis=0))
        for child in node.get('children',[]):walk(child,transform)
    for node in data['scenes'][data.get('scene',0)]['nodes']:walk(node,np.eye(4))
    size=maximum-minimum
    assert 5.5<size[2]<7.0, ('Length/forward axis',size)
    assert 2.0<size[1]<3.1, ('Height/up axis',size)
    assert 1.9<size[0]<3.2, ('Width',size)
    assert -.04<=minimum[1]<=.08, ('Tire ground height',minimum[1])
    assert all(name not in ' '.join(str(x) for x in names).upper() for name in ['STUDIO','CAMERA'])
    return {'file':path.name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'triangles':triangles,'meshes':len(data['meshes']),'nodes':len(data['nodes']),'embeddedImages':len(data.get('images',[])),'requiredNodesPresent':True,'boundsMinM':minimum.tolist(),'boundsMaxM':maximum.tolist(),'sizeXYZM':size.tolist(),'externalAssets':0}

if __name__=='__main__':
    results=[inspect(ASSETS/f'drt-cheongju-{i:02d}.glb') for i in range(1,4)]
    output=ROOT/'validation';output.mkdir(exist_ok=True)
    payload={'status':'passed','models':results,'scope':'GLB binary, scene graph, material image embedding, metre bounds and animation-node contract. Not a live V-World GPU test.'}
    (output/'glb-validation.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(payload,ensure_ascii=False))
