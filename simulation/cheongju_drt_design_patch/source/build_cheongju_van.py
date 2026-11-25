"""Build the photo-referenced Cheongju call-bus livery for MetroRookies.

Run: blender --background --factory-startup --python build_cheongju_van.py
Geometry is an illustrative reconstruction from one side photograph, not a CAD scan.
Blender front +Y / up +Z exports to glTF front -Z / up +Y. Metres; tires touch 0.
"""
from pathlib import Path
import os
import bpy, math, json, argparse, sys
from mathutils import Vector, Quaternion
from PIL import Image, ImageDraw, ImageFont

HERE=Path(__file__).resolve().parent
ASSETS=HERE.parent/'assets'
TEX=HERE/'textures'
ASSETS.mkdir(parents=True,exist_ok=True);TEX.mkdir(exist_ok=True)
FONT=os.environ.get('METRO_CJK_BOLD', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc' if Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc').is_file() else str(Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'/'malgunbd.ttf'))
REG=os.environ.get('METRO_CJK_REGULAR', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc' if Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc').is_file() else str(Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'/'malgun.ttf'))
COL={
 'white':'E8ECEB','roof':'F4F6F1','black':'17212A','rubber':'171B1D',
 'glass':'0B191D','glass2':'11232A','red':'E3132C','lime':'80CC13',
 'blue':'008FD2','silver':'BCC4C5','steel':'6C7478','orange':'FFAA23',
 'lamp':'F6F5DF','darkred':'B51627','seat':'3C555D','skin':'D5AC8D',
 'hair':'28232A','shirt':'558DA0','pants':'2D3946','cargo':'B9935D',
 'tape':'DECBA1','floor':'354046'}

def linear(v):
 v=v/255;return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def color(h):return tuple(linear(int(h[i:i+2],16)) for i in (0,2,4))+(1,)
def mat(name,hex,rough=.42,metal=0):
 m=bpy.data.materials.new(name);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=color(hex);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
 m.diffuse_color=color(hex);return m
M={k:mat(k,v,.66 if k in ['rubber','floor','seat','skin','hair','cargo'] else .27 if k in ['glass','glass2'] else .39,.50 if k in ['silver','steel'] else .02 if k in ['glass','glass2'] else 0) for k,v in COL.items()}
M['glass'].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.12
M['glass2'].node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.15

def parent_keep(obj,parent):
 if parent:
  obj.parent=parent;obj.location-=parent.location
 return obj
def empty(name,loc=(0,0,0)):
 o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.location=loc;return o
def mesh(name,verts,faces,material,parent=None,bevel=0):
 me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update();ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.data.materials.append(material)
 if bevel:
  mod=ob.modifiers.new('Coachwork edge radii','BEVEL');mod.width=bevel;mod.segments=2
  mod2=ob.modifiers.new('Weighted panel normals','WEIGHTED_NORMAL');mod2.keep_sharp=True;mod2.weight=50
 return parent_keep(ob,parent)
def box(name,loc,dim,material,bevel=.02,parent=None):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=dim;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material)
 if bevel:
  b=o.modifiers.new('Rounded edge','BEVEL');b.width=bevel;b.segments=2
  n=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');n.keep_sharp=True
 return parent_keep(o,parent)
def cylinder(name,loc,radius,depth,material,axis='Z',vertices=24,parent=None):
 bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=loc);o=bpy.context.object;o.name=name
 if axis=='X':o.rotation_euler[1]=math.pi/2
 if axis=='Y':o.rotation_euler[0]=math.pi/2
 o.data.materials.append(material)
 for p in o.data.polygons:p.use_smooth=len(p.vertices)==4
 b=o.modifiers.new('Soft tire edge','BEVEL');b.width=min(depth*.12,.018);b.segments=2
 return parent_keep(o,parent)
def sphere(name,loc,scale,material,parent=None):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=1,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;o.data.materials.append(material)
 for p in o.data.polygons:p.use_smooth=True
 return parent_keep(o,parent)
def rod(name,a,b,r,material,parent=None):
 mid=(Vector(a)+Vector(b))/2;direction=Vector(b)-Vector(a)
 o=cylinder(name,mid,r,direction.length,material,parent=parent);o.rotation_euler=direction.to_track_quat('Z','Y').to_euler();return o
def side_profile(name,side,profile,material,parent=None,x=1.015,thick=.035,bevel=.018):
 # Closed solid thin side panel with a real wheel cutout in the profile.
 verts=[(side*(x+off),y,z) for off in (-thick/2,thick/2) for y,z in profile];n=len(profile)
 faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
 return mesh(name,verts,faces,material,parent,bevel)
def lower_profile(start,end):
 points=[(start,.54)]
 for cy in (-1.97,1.98):
  r=.515
  if start<cy-r and end>cy+r:
   points.append((cy-r,.54))
   for j in range(17):
    a=math.pi-j*math.pi/16;points.append((cy+r*math.cos(a),.43+r*math.sin(a)))
   points.append((cy+r,.54))
 points.append((end,.54))
 if end>2.16:points.extend([(end,1.19),(2.16,1.48),(start,1.48)])
 else:points.extend([(end,1.48),(start,1.48)])
 return points
def arch(side,cy):
 verts=[]
 for j in range(25):
  a=math.pi-j*math.pi/24
  for r in (.493,.538):verts.append((side*1.046,cy+r*math.cos(a),.43+r*math.sin(a)))
 mesh('Wheel arch moulding',verts,[(2*i,2*i+1,2*i+3,2*i+2) for i in range(24)],M['rubber'])
def side_text(name,side,y0,y1,z0,z1,path,parent=None,x=1.055,uv_range=(0,1)):
 m=bpy.data.materials.get(name+' ink')
 if not m:
  m=bpy.data.materials.new(name+' ink');m.use_nodes=True
  bs=m.node_tree.nodes.get('Principled BSDF');im=bpy.data.images.load(str(path),check_existing=True)
  tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
  m.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color']);m.node_tree.links.new(tex.outputs['Alpha'],bs.inputs['Alpha']);bs.inputs['Roughness'].default_value=.45
  m.surface_render_method='DITHERED';m.use_backface_culling=False
 verts=[(side*x,y0,z0),(side*x,y1,z0),(side*x,y1,z1),(side*x,y0,z1)]
 ob=mesh(name,verts,[(0,1,2,3)] if side>0 else [(3,2,1,0)],m,parent)
 uv=ob.data.uv_layers.new(name='UVMap')
 u0,u1=uv_range
 coords=[(u0,0),(u1,0),(u1,1),(u0,1)] if side>0 else [(u1,0),(u0,0),(u0,1),(u1,1)]
 for p in ob.data.polygons:
  for loop in p.loop_indices:uv.data[loop].uv=coords[ob.data.loops[loop].vertex_index]
 return ob
def make_textures(number):
 def font(n):return ImageFont.truetype(FONT,n,index=1)
 # All decals are redrawn lettering, not pasted photo pixels.
 im=Image.new('RGBA',(1536,300),(0,0,0,0));d=ImageDraw.Draw(im)
 d.text((28,22),'청주콜 버스',font=font(204),fill=(247,250,247,255),stroke_width=1)
 d.line((1160,58,1160,240),fill=(255,171,38,255),width=10)
 d.text((1200,36),number,font=font(191),fill=(255,171,38,255))
 im.save(TEX/f'window-{number}.png')
 im=Image.new('RGBA',(1536,120),(0,0,0,0));d=ImageDraw.Draw(im)
 d.text((36,14),'내 손안의 시내버스, 바로',font=font(62),fill='white')
 d.text((910,14),'1533-5785 [호출번호]',font=font(54),fill=(255,235,44,255));im.save(TEX/'red-band-text.png')
 im=Image.new('RGBA',(768,400),(0,0,0,0));d=ImageDraw.Draw(im)
 d.text((18,84),'청주시',font=font(98),fill=(76,98,88,255));d.text((22,201),'CHEONGJU CITY',font=font(35),fill=(91,111,103,255))
 d.arc((421,72,702,325),35,202,fill=(138,200,36,255),width=78);d.arc((428,62,704,317),218,353,fill=(164,213,51,255),width=76)
 im.save(TEX/'city-mark.png')
 im=Image.new('RGBA',(800,150),(0,0,0,0));d=ImageDraw.Draw(im)
 d.text((8,47),'Powered by',font=font(43),fill='white');d.text((330,14),'바로',font=font(94),fill='white');im.save(TEX/'baro.png')
 return TEX/f'window-{number}.png'

def clear():
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 for datablock in [bpy.data.meshes,bpy.data.curves,bpy.data.cameras,bpy.data.lights]:
  for b in list(datablock):
   if b.users==0:datablock.remove(b)

def build(number):
 clear();windowtex=make_textures(number)
 roof=empty('ROOF');door=empty('DOOR');hatch=empty('HATCH',(-.96,-3.015,1.48));hatch_r=empty('HATCH_R',(.96,-3.015,1.48))
 # Structure and true wheel cutouts.
 box('Underfloor', (0,-.02,.54),(1.93,5.88,.15),M['floor'],.045)
 side_profile('Left lower body',-1,lower_profile(-2.99,3.00),M['white'])
 side_profile('Right rear lower body',1,lower_profile(-2.99,-.53),M['white'])
 side_profile('Right front lower body',1,lower_profile(.99,3.00),M['white'])
 side_profile('Sliding door lower',1,[(-.50,.54),(.97,.54),(.97,1.49),(-.50,1.49)],M['white'],door,x=1.02)
 # Realistic tall roof cross-sections, with the photo's three painted zones.
 sections=[(-3.015,.88,2.58),(-2.91,1.005,2.66),(-1.63,1.005,2.68),(.42,1.005,2.68),(1.03,.965,2.64),(1.30,.90,2.56)]
 rv=[]
 for y,w,top in sections:
  for j in range(13):
   t=-math.pi/2+j*math.pi/12;rv.append((math.sin(t)*w,y,top-.12*(1-math.cos(t))))
 rf=[(i*13+j,i*13+j+1,(i+1)*13+j+1,(i+1)*13+j) for i in range(len(sections)-1) for j in range(12)]
 cap=mesh('Continuous painted roof',rv,rf,M['lime'],roof)
 cap.data.materials.append(M['roof']);cap.data.materials.append(M['blue'])
 for index,face in enumerate(cap.data.polygons):
  segment=index//12;face.material_index=0 if segment<2 else 2 if segment>=3 else 1;face.use_smooth=True
 sol=cap.modifiers.new('Roof thickness','SOLIDIFY');sol.thickness=.065
 # Header panels above the passenger belt, same roof livery boundaries.
 for side in (-1,1):
  for ya,yb,paint in [(-2.96,-1.63,'lime'),(-1.63,.42,'roof'),(.42,1.09,'blue')]:
   # Match the curved roof edge exactly, avoiding floating fins or open seams.
   knots=[ya]+[r[0] for r in sections if ya<r[0]<yb]+[yb]
   hv=[]
   for yy in knots:
    aa,bb=next(((sections[k],sections[k+1]) for k in range(len(sections)-1) if sections[k][0]<=yy<=sections[k+1][0]),(sections[0],sections[1]))
    f=(yy-aa[0])/(bb[0]-aa[0]);ww=aa[1]+f*(bb[1]-aa[1]);tt=aa[2]+f*(bb[2]-aa[2])-.12
    hv.extend([(side*1.015,yy,2.285),(side*(ww+.004),yy,tt)])
   header=mesh('Flush painted roof header',hv,[(2*k,2*k+2,2*k+3,2*k+1) for k in range(len(knots)-1)],M[paint],roof)
   thick=header.modifiers.new('Coachwork skin','SOLIDIFY');thick.thickness=.025
  box('Rear pillar',(side*.986,-2.94,1.88),(.065,.13,.90),M['white'],.025)
  box('B pillar',(side*1.018,1.06,1.95),(.055,.15,.99),M['white'],.017)
  # Window belt: a tinted glazed rectangle with individual mullions.
  if side==1:panels=[(-2.82,-1.71,None),(-1.68,-.54,None),(-.49,.96,door)]
  else:panels=[(-2.82,-1.71,None),(-1.68,-.39,None),(-.36,.96,None)]
  for j,(ya,yb,p) in enumerate(panels):
   box('Black window surround',(side*1.026,(ya+yb)/2,1.92),(.016,yb-ya,.82),M['black'],.047,p)
   box('Tinted passenger glass',(side*1.038,(ya+yb)/2,1.928),(.004,yb-ya-.046,.760),M['glass' if j%2 else 'glass2'],.042,p)
   # A fine highlight at the top edge helps it read as curved glass at map scale.
   # Flush dark glazing; reflection is generated by lighting, not a raised bar.
  # Sill, red band and grey protective mouldings, split at the sliding door.
  ranges=[(-2.97,-.53,None),(-.50,.97,door),(.99,1.12,None)] if side==1 else [(-2.97,1.12,None)]
  for ya,yb,p in ranges:
   box('Red call-bus livery',(side*1.048,(ya+yb)/2,1.197),(.018,yb-ya,.225),M['red'],.005,p)
   box('Window lower seal',(side*1.052,(ya+yb)/2,1.494),(.017,yb-ya,.017),M['black'],.004,p)
  for ya,yb,p in [(-2.97,-2.52,None),(-1.40,-.53,None),(-.50,.97,door if side==1 else None),(1.0,1.42,None)]:
   if yb>ya:box('Side protective strip',(side*1.058,(ya+yb)/2,.853),(.055,yb-ya,.185),M['black'],.035,p)
  if side==-1:side_text('Window lettering '+number,side,-1.66,.89,1.70,2.145,windowtex,x=1.044)
  else:
   for ya,yb,par in [(-1.66,-.53,None),(-.50,.89,door)]:
    side_text('Window lettering '+number,side,ya,yb,1.70,2.145,windowtex,par,x=1.044,uv_range=((ya+1.66)/2.55,(yb+1.66)/2.55))
  # Side stripe lettering split ensures the right sliding panel and ink move together.
  if side==-1:side_text('Red stripe wording',side,-2.68,1.01,1.118,1.27,TEX/'red-band-text.png',x=1.073)
  else:
   for ya,yb,par in [(-2.68,-.53,None),(-.50,.97,door),(.99,1.01,None)]:
    side_text('Red stripe wording',side,ya,yb,1.118,1.27,TEX/'red-band-text.png',par,x=1.073,uv_range=((ya+2.68)/3.69,(yb+2.68)/3.69))
  side_text('Cheongju city mark',side,1.18,1.87,1.03,1.40,TEX/'city-mark.png',x=1.051)
  side_text('Baro roof mark',side,.45,1.02,2.36,2.465,TEX/'baro.png',roof,x=1.025)
  # Passenger door seam and handle.
  box('Sliding handle',(side*1.09,.67,1.39),(.055,.22,.05),M['black'],.019,door if side==1 else None)
  if side==1:
   box('Sliding guide rail',(1.077,-1.25,1.39),(.025,2.88,.025),M['steel'],.007)
   box('Passenger step',(1.105,.22,.44),(.25,1.50,.075),M['black'],.026)
  # Close the cab shoulder between the curved roof and the windscreen gasket.
  shoulder=[(side*.965,1.03,2.52),(side*.90,1.30,2.44),(side*.997,1.44,2.40),(side*1.015,1.08,2.40)]
  sh=mesh('Cab roof shoulder',shoulder,[(0,1,2,3)] if side>0 else [(3,2,1,0)],M['blue'],roof)
  th=sh.modifiers.new('Roof shoulder skin','SOLIDIFY');th.thickness=.018
  # Front cabin side panel and raked side window.
  side_profile('Cab door upper',side,[(1.13,1.45),(2.34,1.43),(2.19,1.64),(1.44,2.40),(1.13,2.40)],M['white'],x=.997,thick=.045,bevel=.018)
  side_profile('Cab side black surround',side,[(1.17,1.53),(1.98,1.53),(2.17,1.68),(1.44,2.31),(1.17,2.32)],M['black'],x=1.025,thick=.015,bevel=.025)
  side_profile('Cab side glass',side,[(1.23,1.60),(1.94,1.60),(2.08,1.71),(1.41,2.25),(1.23,2.25)],M['glass2'],x=1.039,thick=.007,bevel=.017)
  rod('Cab window divider',(side*1.05,1.67,1.59),(side*1.05,1.70,2.01),.018,M['black'])
  box('Cab door handle',(side*1.068,1.31,1.405),(.055,.20,.048),M['black'],.018)
  rod('Cab door panel seam',(side*1.043,1.12,.56),(side*1.043,1.12,1.49),.005,M['steel'])
  # Mirror arm and large vertical mirror, as in the reference.
  rod('Mirror arm',(side*1.02,1.87,1.62),(side*1.21,1.95,1.76),.032,M['black'])
  box('Mirror housing',(side*1.25,1.97,1.82),(.20,.135,.37),M['black'],.062)
  box('Mirror reflective face',(side*1.25,1.891,1.82),(.145,.008,.285),M['steel'],.035)
  for cy in [-1.97,1.98]:
   arch(side,cy)
   cylinder('Tire',(side*1.025,cy,.43),.43,.235,M['rubber'],'X',40)
   cylinder('Wheel inner steel',(side*1.154,cy,.43),.285,.025,M['steel'],'X',32)
   cylinder('Wheel dark recess',(side*1.170,cy,.43),.245,.012,M['black'],'X',32)
   # Five paired silver spokes over the recessed wheel.
   for j in range(5):
    a=j*2*math.pi/5
    for off in (-.031,.031):
     yy=cy+math.sin(a)*.158+math.cos(a)*off;zz=.43+math.cos(a)*.158-math.sin(a)*off
     sp=box('Alloy wheel spoke',(side*1.184,yy,zz),(.025,.053,.245),M['silver'],.015);sp.rotation_euler[0]=-a
   cylinder('Wheel rim lip',(side*1.178,cy,.43),.281,.015,M['silver'],'X',40)
   # Remove central face by overlaying the dark well and spokes again, creating a ring visually.
   cylinder('Rim centre recess',(side*1.190,cy,.43),.246,.012,M['steel'],'X',32)
   for j in range(5):
    a=j*2*math.pi/5
    sp=box('Hubcap cutout',(side*1.205,cy+math.sin(a)*.17,.43+math.cos(a)*.17),(.009,.090,.150),M['black'],.032);sp.rotation_euler[0]=-a
   cylinder('Hub cap',(side*1.214,cy,.43),.097,.016,M['silver'],'X',24)
   for j in range(5):
    a=j*2*math.pi/5;cylinder('Lug bolt',(side*1.225,cy+math.sin(a)*.066,.43+math.cos(a)*.066),.014,.012,M['steel'],'X',8)
   box('Side amber marker',(side*1.073,cy-.68 if cy>0 else cy+.67,.87),(.023,.104,.047),M['orange'],.016)
 # Windscreen and bonnet: raked tall cabin with short protruding van nose.
 verts=[(-.89,1.34,2.42),(.89,1.34,2.42),(.988,2.185,1.53),(-.988,2.185,1.53)]
 mesh('Windscreen',verts,[(0,1,2,3)],M['glass'])
 for a,b in [(verts[0],verts[1]),(verts[1],verts[2]),(verts[2],verts[3]),(verts[3],verts[0])]:rod('Windscreen rubber gasket',a,b,.018,M['black'])
 # Windshield reflection remains part of the PBR glazing material.
 for x in (-.52,.42):rod('Wiper',(x-.16,2.194,1.56),(x+.21,2.007,1.75),.012,M['black'])
 mesh('Blue cabin brow',[(-.88,1.30,2.49),(.88,1.30,2.49),(.89,1.365,2.40),(-.89,1.365,2.40)],[(0,3,2,1)],M['blue'],roof)
 # Smooth high-roof van nose; several cross sections avoid a flat slab front.
 rings=[(2.13,1.00,1.49,.55),(2.40,1.00,1.43,.55),(2.78,.96,1.34,.56),(3.035,.90,1.19,.57),(3.10,.83,1.10,.59)]
 verts=[]
 for y,w,top,bottom in rings:
  for xx,zz in [(-w,bottom),(-w,top-.10),(-w*.87,top-.015),(0,top+.025),(w*.87,top-.015),(w,top-.10),(w,bottom)]:verts.append((xx,y,zz))
 faces=[]
 for i in range(len(rings)-1):
  for j in range(6):faces.append((i*7+j,i*7+j+1,(i+1)*7+j+1,(i+1)*7+j))
 faces+=[tuple(range(6,-1,-1)),tuple(range(28,35))]
 hood=mesh('Curved bonnet and nose',verts,faces,M['white'],bevel=.055)
 for face in hood.data.polygons:face.use_smooth=True
 box('Nose bumper',(0,3.075,.680),(1.92,.19,.33),M['black'],.115)
 box('Main grille',(0,3.154,.980),(1.17,.030,.205),M['black'],.066)
 for z in [.936,1.012]:box('Grille fine bar',(0,3.176,z),(1.05,.012,.012),M['steel'],.005)
 for side in (-1,1):
  # Lamps wrap from the rounded front to the shoulder of the hood.
  housing=[(side*.655,3.088,1.026),(side*.881,3.055,1.062),(side*.973,2.685,1.386),(side*.799,2.716,1.410)]
  mesh('Swept headlight housing',housing,[(0,3,2,1)] if side>0 else [(0,1,2,3)],M['black'])
  lens=[(side*.680,3.098,1.050),(side*.864,3.068,1.080),(side*.948,2.714,1.371),(side*.815,2.745,1.389)]
  lamp=mesh('Swept clear headlight',lens,[(0,3,2,1)] if side>0 else [(0,1,2,3)],M['lamp']);sol=lamp.modifiers.new('Lens thickness','SOLIDIFY');sol.thickness=.014
  rod('Headlight inner optic',(side*.738,3.081,1.095),(side*.872,2.808,1.324),.022,M['silver'])
  rod('Front amber lamp',(side*.688,3.110,1.057),(side*.858,3.082,1.087),.020,M['orange'])
  box('Fog light',(side*.70,3.175,.673),(.14,.009,.062),M['steel'],.027)
 # Small white number plate, fictional neutral identifier.
 box('Front plate',(0,3.169,.719),(.45,.015,.10),M['white'],.013)
 # Rear two hinged doors; HATCH swings around a vertical hinge, not a trunk lid.
 for side,par in [(-1,hatch),(1,hatch_r)]:
  x=side*.47
  box('Rear door',(x,-3.003,1.50),(.93,.065,1.96),M['white'],.035,par)
  box('Rear door window surround',(x,-3.047,2.02),(.82,.017,.74),M['black'],.062,par)
  box('Rear door glass',(x,-3.06,2.025),(.75,.009,.66),M['glass'],.052,par)
  box('Rear door red stripe',(x,-3.052,1.197),(.91,.016,.225),M['red'],.005,par)
  box('Rear door handle',(side*.08,-3.06,1.46),(.045,.026,.18),M['black'],.018,par)
  box('Rear tail lamp',(side*.981,-3.03,1.03),(.078,.065,.75),M['darkred'],.024)
  box('Rear clear lamp',(side*.986,-3.071,1.07),(.063,.012,.14),M['lamp'],.014)
 box('Rear bumper',(0,-3.083,.558),(2.02,.18,.24),M['black'],.06)
 # Interior seats, occupants and removable parcel groups retained for replay callbacks.
 seat_positions=[(side*.56,.75-row*.72) for row in range(4) for side in (-1,1)]+[(x,-2.17) for x in [-.56,0,.56]]
 for x,y in seat_positions:
  box('Seat cushion',(x,y,.92),(.50,.47,.13),M['seat'],.07)
  back=box('Seat back',(x,y-.22,1.28),(.51,.13,.69),M['seat'],.07)
  box('Seat headrest',(x,y-.22,1.67),(.30,.12,.17),M['seat'],.055)
  rod('Seat support',(x,y,.59),(x,y,.86),.038,M['steel'])
 for i in range(11):
  x,y=seat_positions[i]
  p=empty('PAX_'+str(i),(x,y,1.0))
  sphere('Passenger torso',(x,y,1.24),(.16,.13,.24),M['shirt'],p)
  sphere('Passenger head',(x,y+.01,1.59),(.10,.10,.12),M['skin'],p)
  sphere('Passenger hair',(x,y-.01,1.65),(.103,.10,.074),M['hair'],p)
  for side in (-1,1):
   rod('Passenger upper arm',(x+side*.14,y,1.35),(x+side*.19,y+.06,1.12),.047,M['shirt'],p)
   rod('Passenger leg',(x+side*.08,y+.10,.99),(x+side*.08,y+.27,.68),.058,M['pants'],p)
   box('Passenger shoe',(x+side*.08,y+.31,.62),(.12,.20,.07),M['black'],.035,p)
 for i in range(8):
  x=(-.57,-.19,.19,.57)[i%4];y=-2.63;z=.73+(i//4)*.29;p=empty('CARGO_'+str(i),(x,y,z))
  box('Parcel',(x,y,z),(.33,.40,.27),M['cargo'],.013,p)
  box('Parcel tape',(x,y,z+.138),(.052,.40,.004),M['tape'],.001,p)
  box('Parcel front tape',(x,y+.202,z),(.052,.004,.27),M['tape'],.001,p)
 # Driver seat and wheel.
 box('Driver seat',(-.50,1.45,.94),(.54,.48,.16),M['seat'],.055)
 box('Driver back',(-.50,1.21,1.27),(.53,.14,.65),M['seat'],.065)
 box('Dashboard',(0,1.98,1.36),(1.77,.37,.21),M['black'],.055)
 # Apply modifiers before glTF export, then merge material/parent batches.
 bpy.context.view_layer.update()
 for ob in list(bpy.context.scene.objects):
  if ob.type=='MESH':
   bpy.context.view_layer.objects.active=ob
   for mod in list(ob.modifiers):
    try:bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:pass
 groups={}
 for ob in list(bpy.context.scene.objects):
  if ob.type=='MESH':groups.setdefault((ob.parent.name if ob.parent else '',ob.active_material.name if ob.active_material else ''),[]).append(ob)
 for (par,material),objects in groups.items():
  if len(objects)>1:
   bpy.ops.object.select_all(action='DESELECT')
   for ob in objects:ob.select_set(True)
   bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();objects[0].name=(par+' ' if par else 'BODY ')+material
 bpy.context.scene['vehicle_forward_gltf']='-Z';bpy.context.scene['vehicle_up_gltf']='+Y';bpy.context.scene['units']='metres'
 for ob in bpy.context.scene.objects:
  if ob.type=='MESH':ob['visual_provenance']='Illustrative geometry and livery reconstructed from user side photograph; dimensions approximate.'
 return roof

def setup_render(output,side=False,rear=False):
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=160;scene.cycles.use_denoising=False
 scene.render.resolution_x=1300;scene.render.resolution_y=850;scene.render.resolution_percentage=100
 scene.world.color=(.4,.4,.4);scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.44,.48,.50,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.26
 scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=-.25
 floor=mat('Studio ground','DDE4E4',.82)
 box('STUDIO FLOOR',(0,0,-.055),(200,200,.1),floor,0)
 for name,loc,power,size in [('Key',(5,3,9),1100,7),('Fill',(-5,0,5),650,7),('Back',(1,-6,7),900,6)]:
  bpy.ops.object.light_add(type='AREA',location=loc);light=bpy.context.object;light.name=name;light.data.energy=power;light.data.shape='DISK';light.data.size=size;light.rotation_euler=(Vector((0,0,1.2))-light.location).to_track_quat('-Z','Y').to_euler()
 bpy.ops.object.camera_add(location=(10,0,2.8) if side else (9,-11,5.7) if rear else (8.8,11.2,5.5));camera=bpy.context.object;camera.name='Studio camera';camera.rotation_euler=(Vector((0,0,1.30))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=7.7 if side else 8.5;scene.camera=camera
 scene.render.image_settings.file_format='PNG';scene.render.filepath=str(output);bpy.ops.render.render(write_still=True)

def main():
 reports=[]
 for i,name in enumerate(['drt-cheongju-01.glb','drt-cheongju-02.glb','drt-cheongju-03.glb'],1):
  number=f'{i:02d}';build(number)
  bpy.ops.object.select_all(action='SELECT')
  target=ASSETS/name
  bpy.ops.export_scene.gltf(filepath=str(target),export_format='GLB',export_yup=True,export_apply=False,export_materials='EXPORT',export_extras=True,export_animations=False,use_selection=True,export_cameras=False,export_lights=False)
  nodes=[o.name for o in bpy.context.scene.objects if o.type=='EMPTY'];tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
  reports.append({'file':name,'bytes':target.stat().st_size,'triangles':tris,'nodes':nodes})
  if i==2 and '--export-only' not in sys.argv:
   bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'cheongju_call_bus_02.blend'))
   clear();bpy.ops.import_scene.gltf(filepath=str(target))
   setup_render(HERE/'cheongju_call_bus_three_quarter.png')
   # Rebuild prevents studio lights/floor being exported into the next vehicle.
   build(number);setup_render(HERE/'cheongju_call_bus_side.png',side=True)
   clear();bpy.ops.import_scene.gltf(filepath=str(target))
   bpy.data.objects['DOOR'].location.x+=.18;bpy.data.objects['DOOR'].location.y-=1.08
   bpy.data.objects['HATCH'].rotation_quaternion=Quaternion((0,0,1),-1.35);bpy.data.objects['HATCH_R'].rotation_quaternion=Quaternion((0,0,1),1.35)
   setup_render(HERE/'cheongju_call_bus_doors_open.png',rear=True)
 (HERE/'model-report.json').write_text(json.dumps({'scale':'metres','forward':'-Z glTF','up':'+Y glTF','wheel_ground_y':0,'body_length_m':6.3,'body_height_m':2.68,'body_width_m':2.10,'mirror_width_m':2.70,'rear_hinges':'HATCH and HATCH_R rotate glTF Y by opposite signs; source Blender Z','models':reports},indent=2))

if __name__=='__main__':
 if '--preview-only' in sys.argv:
  clear();bpy.ops.import_scene.gltf(filepath=str(ASSETS/'drt-cheongju-02.glb'))
  setup_render(HERE/'cheongju_call_bus_three_quarter.png')
  clear();bpy.ops.import_scene.gltf(filepath=str(ASSETS/'drt-cheongju-02.glb'))
  setup_render(HERE/'cheongju_call_bus_side.png',side=True)
  clear();bpy.ops.import_scene.gltf(filepath=str(ASSETS/'drt-cheongju-02.glb'))
  bpy.data.objects['DOOR'].location.x+=.18;bpy.data.objects['DOOR'].location.y-=1.08
  bpy.data.objects['HATCH'].rotation_quaternion=Quaternion((0,0,1),-1.35);bpy.data.objects['HATCH_R'].rotation_quaternion=Quaternion((0,0,1),1.35)
  setup_render(HERE/'cheongju_call_bus_doors_open.png',rear=True)
 else:main()
