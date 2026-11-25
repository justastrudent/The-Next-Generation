"""Generate original procedural glTF 2.0 assets. Geometry is illustrative, not a survey."""
from pathlib import Path
import argparse, json, struct, math
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'assets',help="Model output directory (default: this package's assets/)")
OUT=parser.parse_args().output.resolve(); OUT.mkdir(parents=True,exist_ok=True)
class GLB:
 def __init__(self):
  self.g={'asset':{'version':'2.0','generator':'MetroRookies procedural models'},'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':[],'buffers':[{'byteLength':0}],'bufferViews':[],'accessors':[]}; self.b=bytearray(); self.meshes={}
 def mat(self,name,color,metal=0,rough=.65,emissive=None):
  v={'name':name,'pbrMetallicRoughness':{'baseColorFactor':color,'metallicFactor':metal,'roughnessFactor':rough},'doubleSided':True}
  if len(color)>3 and color[3]<1:v['alphaMode']='BLEND'
  if emissive:v['emissiveFactor']=emissive
  self.g['materials'].append(v);return len(self.g['materials'])-1
 def arr(self,vals,typ,ncomp,minmax=False):
  while len(self.b)%4:self.b.append(0)
  start=len(self.b);fmt='f' if typ==5126 else 'H';self.b.extend(struct.pack('<'+fmt*len(vals),*vals));self.g['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(self.b)-start,'target':34963 if typ==5123 else 34962})
  a={'bufferView':len(self.g['bufferViews'])-1,'componentType':typ,'count':len(vals)//ncomp,'type':{1:'SCALAR',2:'VEC2',3:'VEC3'}[ncomp]}
  if minmax:a.update({'min':[min(vals[i::ncomp]) for i in range(ncomp)],'max':[max(vals[i::ncomp]) for i in range(ncomp)]})
  self.g['accessors'].append(a);return len(self.g['accessors'])-1
 def mesh(self,kind,mat):
  key=(kind,mat)
  if key in self.meshes:return self.meshes[key]
  p=[];n=[];ix=[]
  if kind=='box':
   faces=[([( .5,-.5,-.5),(.5,.5,-.5),(.5,.5,.5),(.5,-.5,.5)],(1,0,0)),([(-.5,-.5,.5),(-.5,.5,.5),(-.5,.5,-.5),(-.5,-.5,-.5)],(-1,0,0)),([(-.5,.5,-.5),(-.5,.5,.5),(.5,.5,.5),(.5,.5,-.5)],(0,1,0)),([(-.5,-.5,.5),(-.5,-.5,-.5),(.5,-.5,-.5),(.5,-.5,.5)],(0,-1,0)),([(.5,-.5,.5),(.5,.5,.5),(-.5,.5,.5),(-.5,-.5,.5)],(0,0,1)),([(-.5,-.5,-.5),(-.5,.5,-.5),(.5,.5,-.5),(.5,-.5,-.5)],(0,0,-1))]
   for verts,norm in faces:
    off=len(p)//3
    for vert in verts:p.extend(vert);n.extend(norm)
    ix.extend([off,off+1,off+2,off,off+2,off+3])
  elif kind=='cylinder':
   seg=20
   for j in range(seg):
    a=2*math.pi*j/seg;b=2*math.pi*(j+1)/seg;off=len(p)//3
    for ang,y in [(a,-.5),(a,.5),(b,.5),(b,-.5)]:p.extend([math.cos(ang)*.5,y,math.sin(ang)*.5]);n.extend([math.cos(ang),0,math.sin(ang)])
    ix.extend([off,off+1,off+2,off,off+2,off+3])
    for y,sgn in [(-.5,-1),(.5,1)]:
     off=len(p)//3
     for x,z in [(0,0),(.5*math.cos(a),.5*math.sin(a)),(.5*math.cos(b),.5*math.sin(b))]:p.extend([x,y,z]);n.extend([0,sgn,0])
     ix.extend([off,off+1,off+2])
  elif kind=='sphere':
   rings=9;seg=14
   for i in range(rings+1):
    theta=math.pi*i/rings
    for j in range(seg+1):
     phi=2*math.pi*j/seg;v=[math.sin(theta)*math.cos(phi),math.cos(theta),math.sin(theta)*math.sin(phi)];p.extend([x*.5 for x in v]);n.extend(v)
   for i in range(rings):
    for j in range(seg):
     a=i*(seg+1)+j;b=a+seg+1;ix.extend([a,b,a+1,a+1,b,b+1])
  self.g['meshes'].append({'primitives':[{'attributes':{'POSITION':self.arr(p,5126,3,True),'NORMAL':self.arr(n,5126,3)},'indices':self.arr(ix,5123,1),'material':mat}]});v=len(self.g['meshes'])-1;self.meshes[key]=v;return v
 def node(self,name,pos=(0,0,0),size=(1,1,1),mat=None,kind='box',parent=None,rot=None):
  d={'name':name,'translation':list(pos),'scale':list(size)}
  if mat is not None:d['mesh']=self.mesh(kind,mat)
  if rot:d['rotation']=list(rot)
  self.g['nodes'].append(d);idx=len(self.g['nodes'])-1
  if parent is None:self.g['scenes'][0]['nodes'].append(idx)
  else:self.g['nodes'][parent].setdefault('children',[]).append(idx)
  return idx
 def save(self,name):
  self.g['buffers'][0]['byteLength']=len(self.b);j=json.dumps(self.g,separators=(',',':')).encode();j+=b' '*((-len(j))%4);self.b+=b'\0'*((-len(self.b))%4)
  raw=struct.pack('<III',0x46546c67,2,12+8+len(j)+8+len(self.b))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(self.b),0x004e4942)+self.b
  (OUT/name).write_bytes(raw)

def vehicle(name,rgb):
 g=GLB();white=g.mat('Pearl body',[.91,.95,.96,1],.25,.28);paint=g.mat('Route accent',rgb+[1],.3,.25);dark=g.mat('Rubber',[.025,.035,.045,1]);glass=g.mat('Panoramic glazing',[.08,.22,.3,.45],.2,.2);metal=g.mat('Alloy',[.48,.56,.60,1],.85,.2);lights=g.mat('Headlights',[.98,.98,.9,1],emissive=[.8,.8,.7]);red=g.mat('Tail lights',[.95,.08,.08,1],emissive=[.5,0,0]);seat=g.mat('Seats',[.13,.2,.25,1]);skin=g.mat('Passenger',[.91,.67,.49,1]);shirt=g.mat('Coats',[.28,.4,.53,1]);box=g.mat('Parcel',[.67,.4,.18,1]);tape=g.mat('Tape',[.89,.77,.49,1])
 g.node('Chassis',(0,.55,0),(2.12,.24,5.45),dark)
 g.node('LowerBody',(0,.96,0),(2.28,.65,5.65),paint)
 g.node('Floor',(0,1.12,0),(2.1,.12,5.25),white)
 # White front/rear structural frames and pillars.
 for x in [-1.08,1.08]:
  for z in [-2.67,-1.2,.55,2.67]:g.node('Pillar',(x,1.98,z),(.11,1.5,.12),white)
  g.node('Window',(x,2.01,0),(.035,1.15,5.16),glass)
 g.node('Windshield',(0,2,-2.7),(2.05,1.2,.045),glass)
 g.node('FrontFace',(0,1.2,-2.8),(2.2,.55,.12),white)
 g.node('FrontDisplay',(0,2.62,-2.73),(1.5,.25,.04),dark)
 for x in [-.76,.76]:g.node('LED',(x,1.16,-2.88),(.5,.12,.06),lights)
 g.node('Sensor',(0,2.92,0),(.38,.18,.38),dark,'cylinder')
 roof=g.node('ROOF',(0,2.77,0),(2.35,.18,5.8),white)
 for x in [-1.13,1.13]:g.node('RoofRail',(x,2.73,0),(.1,.14,5.75),paint)
 # Door slides toward rear, kept as independent named node.
 door=g.node('DOOR',(1.16,1.9,-.77))
 g.node('DoorGlass',(0,.13,0),(.045,1.26,.98),glass,parent=door)
 for z in [-.51,.51]:g.node('DoorFrame',(0,0,z),(.07,1.6,.055),white,parent=door)
 g.node('DoorBottom',(0,-.68,0),(.07,.2,1.08),white,parent=door)
 g.node('DoorHandle',(.035,-.05,-.34),(.05,.26,.03),metal,parent=door)
 hatch=g.node('HATCH',(0,2.55,2.78))
 g.node('HatchBody',(0,-.63,0),(2.05,1.26,.07),white,parent=hatch)
 g.node('RearWindow',(0,-.3,.045),(1.74,.51,.025),glass,parent=hatch)
 g.node('RearHandle',(0,-1.05,.05),(.38,.045,.035),dark,parent=hatch)
 for x in [-.99,.99]:g.node('TailLight',(x,1.25,2.87),(.13,.32,.05),red)
 wheelrot=[0,0,math.sin(math.pi/4),math.cos(math.pi/4)]
 for x in [-1.13,1.13]:
  for z in [-1.85,1.85]:
   g.node('Wheel',(x,.48,z),(.83,.22,.83),dark,'cylinder',rot=wheelrot)
   g.node('WheelHub',(x*1.1,.48,z),(.47,.035,.47),metal,'cylinder',rot=wheelrot)
 for i in range(11):
  x=(-.64 if i%2==0 else .64);z=-1.85+(i//2)*.66
  g.node('SeatBase',(x,1.34,z),(.51,.2,.49),seat)
  g.node('SeatBack',(x,1.63,z+.23),(.51,.59,.13),seat)
  p=g.node(f'PAX_{i}',(x,1.48,z))
  g.node('Body',(0,.23,0),(.35,.48,.25),shirt,parent=p)
  g.node('Head',(0,.62,-.01),(.25,.28,.25),skin,'sphere',parent=p)
 for i in range(8):
  p=g.node(f'CARGO_{i}',(-.67+(i%4)*.44,1.32+(i//4)*.39,2.17))
  g.node('Box',(0,0,0),(.37,.34,.37),box,parent=p)
  g.node('Tape',(0,.173,0),(.08,.008,.38),tape,parent=p)
 g.save(name)

for name,color in [('drt-teal.glb',[.3216,.8784,.7686]),('drt-amber.glb',[1,.7137,.3569]),('drt-purple.glb',[.6549,.6078,1])]:vehicle(name,color)

g=GLB();skin=g.mat('Skin',[.88,.65,.46,1]);shirt=g.mat('Jacket',[.94,.4,.18,1]);pants=g.mat('Trousers',[.06,.13,.2,1]);shoe=g.mat('Shoes',[.03,.04,.05,1]);hair=g.mat('Hair',[.08,.05,.04,1]);
g.node('Torso',(0,1.12,0),(.42,.58,.24),shirt);g.node('Head',(0,1.59,0),(.3,.34,.29),skin,'sphere');g.node('Hair',(0,1.7,.03),(.32,.16,.3),hair,'sphere')
for side,x in [('L',-.28),('R',.28)]:
 p=g.node('ARM_'+side,(x,1.35,0));g.node('Sleeve',(0,-.19,0),(.14,.4,.17),shirt,parent=p);g.node('Hand',(0,-.43,0),(.13,.18,.13),skin,'sphere',parent=p)
 p=g.node('LEG_'+side,(x*.52,.84,0));g.node('Leg',(0,-.34,0),(.17,.68,.2),pants,parent=p);g.node('Shoe',(0,-.73,-.07),(.2,.13,.34),shoe,parent=p)
g.save('passenger.glb')
g=GLB();box=g.mat('Cardboard',[.65,.39,.17,1]);tape=g.mat('Packing tape',[.92,.79,.52,1]);g.node('Parcel',(0,.25,0),(.54,.5,.48),box);g.node('Tape',(0,.503,0),(.1,.008,.49),tape);g.save('parcel.glb')
print('Generated', ', '.join(p.name for p in OUT.glob('*.glb')))
