"""Validate delivered GLB geometry and animation contracts, not source builders."""
import json, struct, unittest, math
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1]

def read_glb(name):
    b=(ROOT/'assets'/name).read_bytes();magic,version,length=struct.unpack_from('<III',b)
    assert magic==0x46546c67 and version==2 and length==len(b)
    count,kind=struct.unpack_from('<II',b,12);assert kind==0x4e4f534a
    g=json.loads(b[20:20+count]);offset=20+count;size,kind=struct.unpack_from('<II',b,offset);assert kind==0x004e4942
    return g,b[offset+8:offset+8+size]

def matrix(node):
    if 'matrix' in node:return np.array(node['matrix']).reshape((4,4),order='F')
    x,y,z,w=node.get('rotation',[0,0,0,1]);r=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    m=np.eye(4);m[:3,:3]=r@np.diag(node.get('scale',[1,1,1]));m[:3,3]=node.get('translation',[0,0,0]);return m

def geometry(g,b):
    results={}
    def visit(i,parent):
        n=g['nodes'][i];m=parent@matrix(n)
        if 'mesh' in n:
            points=[]
            for pr in g['meshes'][n['mesh']]['primitives']:
                ac=g['accessors'][pr['attributes']['POSITION']];assert ac['type']=='VEC3' and ac['componentType']==5126
                bv=g['bufferViews'][ac['bufferView']];offset=bv.get('byteOffset',0)+ac.get('byteOffset',0);stride=bv.get('byteStride',12)
                p=np.array([struct.unpack_from('<fff',b,offset+k*stride) for k in range(ac['count'])]);assert np.isfinite(p).all()
                points.append((m@np.c_[p,np.ones(len(p))].T).T[:,:3])
            results[n['name']]=np.concatenate(points)
        for ch in n.get('children',[]):visit(ch,m)
    for i in g['scenes'][g.get('scene',0)]['nodes']:visit(i,np.eye(4))
    return results

class ServiceModels(unittest.TestCase):
    def test_files_are_self_contained_finite_glb(self):
        for name in ['passenger.glb','service-post-office.glb','service-village-hall.glb','service-stop-shelter.glb','service-stop-sign.glb']:
            with self.subTest(name=name):
                g,b=read_glb(name)
                self.assertFalse(any('uri' in x for x in g.get('buffers',[])))
                self.assertFalse(any('uri' in x for x in g.get('images',[])))
                self.assertFalse(g.get('cameras'))
                coords=np.concatenate(list(geometry(g,b).values()))
                self.assertGreaterEqual(coords[:,1].min(),-.001)
                self.assertLess(coords[:,1].max(),4.1)
                tris=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives'])
                self.assertLess(tris,8000)
    def test_passenger_animatable_pivots_and_front(self):
        g,b=read_glb('passenger.glb');nodes={n['name']:n for n in g['nodes']}
        for name in ('ARM_L','ARM_R','LEG_L','LEG_R'):
            self.assertIn(name,nodes);self.assertGreater(len(nodes[name]['children']),1)
            self.assertNotIn('matrix',nodes[name]);self.assertEqual(nodes[name].get('rotation',[0,0,0,1]),[0,0,0,1])
        self.assertAlmostEqual(nodes['ARM_L']['translation'][1],1.326,places=3)
        self.assertAlmostEqual(nodes['LEG_L']['translation'][1],.88,places=3)
        coords=geometry(g,b);all_points=np.concatenate(list(coords.values()))
        self.assertTrue(1.65<all_points[:,1].max()<1.72)
        self.assertLess(coords['Nose'][:,2].mean(),0) # front=-Z
        self.assertLess(coords['Shoe L'][:,1].min(),.07)
    def test_sign_lettering_fits_fascias(self):
        for file,node,height,y_center in [('service-post-office.glb','강내우체국 간판',.39,2.94),('service-village-hall.glb','마을회관 간판',.30,2.66),('service-stop-shelter.glb','정류장 간판',.145,2.48)]:
            g,b=read_glb(file);points=geometry(g,b)[node]
            self.assertLessEqual(np.ptp(points[:,1]),height+.001)
            self.assertAlmostEqual((points[:,1].min()+points[:,1].max())/2,y_center,places=3)
            self.assertLess(points[:,2].max(),0)

if __name__=='__main__':unittest.main(verbosity=2)
