"""Original illustrative facilities and passenger; metres, glTF +Y up / -Z front.
Run: blender -b --python scripts/build_service_models.py -- <project-root>
No surveyed facility dimensions or stop-type classification are implied.
"""
import bpy, math, sys, json
from pathlib import Path
from mathutils import Vector
ROOT=Path(sys.argv[sys.argv.index('--')+1]) if '--' in sys.argv else Path(__file__).resolve().parents[1]
ASSETS=ROOT/'assets'; PREVIEW=ROOT/'docs'/'model-previews'; PREVIEW.mkdir(parents=True,exist_ok=True)

def reset():
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.materials): bpy.data.materials.remove(data)
    global mats
    mats={}

def mat(name,color,rough=.8,metal=0):
    if name in mats:return mats[name]
    m=bpy.data.materials.new(name); m.diffuse_color=(*color[:3],color[3] if len(color)>3 else 1); m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF'); bs.inputs['Base Color'].default_value=m.diffuse_color; bs.inputs['Roughness'].default_value=rough; bs.inputs['Metallic'].default_value=metal
    if m.diffuse_color[3]<1:
        bs.inputs['Alpha'].default_value=m.diffuse_color[3]; m.surface_render_method='DITHERED'; m.use_transparency_overlap=False
    mats[name]=m;return m

def finish(o,name,m,parent=None):
    o.name=name
    if m:o.data.materials.append(m)
    if parent:
        world=o.matrix_world.copy();o.parent=parent;o.matrix_world=world
    return o

def box(name,loc,dims,m,bevel=.025,parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.dimensions=dims
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod=o.modifiers.new('Soft edges','BEVEL');mod.width=bevel;mod.segments=2
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
        mod=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(o,name,m,parent)

def ell(name,loc,scale,m,parent=None,segments=16,rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,radius=1,location=loc)
    o=bpy.context.object;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for p in o.data.polygons:p.use_smooth=True
    return finish(o,name,m,parent)

def cyl(name,a,b,r,m,parent=None,vertices=12,r2=None):
    a=Vector(a);b=Vector(b);d=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=r if r2 is None else r2,radius2=r,depth=d.length,location=(a+b)/2)
    o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler()
    for p in o.data.polygons:p.use_smooth=True
    return finish(o,name,m,parent)

def empty(name,loc):
    o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.location=loc;return o

def text(name,body,loc,size,m,maxwidth=None):
    curve=bpy.data.curves.new(name,'FONT');curve.body=body;curve.size=size;curve.align_x='CENTER';curve.align_y='CENTER';curve.extrude=.002;curve.bevel_depth=0;curve.resolution_u=2
    curve.font=bpy.data.fonts.load('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')
    o=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(o);o.location=loc;o.rotation_euler=(math.pi/2,0,math.pi)
    o.data.materials.append(m);bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH')
    o=bpy.context.object
    # Noto TTC curve bounds differ from converted glyph bounds in Blender 4.3.
    # Normalize the final mesh itself, then centre it on the sign panel.
    xs=[v.co.x for v in o.data.vertices];ys=[v.co.y for v in o.data.vertices]
    width=max(xs)-min(xs);height=max(ys)-min(ys)
    scale=min(size/height,maxwidth/width if maxwidth else size/height)
    cx=(max(xs)+min(xs))/2;cy=(max(ys)+min(ys))/2
    for v in o.data.vertices:
        v.co.x=(v.co.x-cx)*scale;v.co.y=(v.co.y-cy)*scale
    return o

def window(name,x,y,z,w,h,frame,glass):
    box(name+' frame',(x,y,z),(w,.1,h),frame,.015)
    box(name+' glazing',(x,y+.057,z),(w-.1,.015,h-.1),glass,.005)
    box(name+' mullion',(x,y+.07,z),(.045,.028,h-.08),frame,.003)

def roof_gable(width,depth,z,rise,m):
    vs=[(-width/2,-depth/2,z),(width/2,-depth/2,z),(0,-depth/2,z+rise),(-width/2,depth/2,z),(width/2,depth/2,z),(0,depth/2,z+rise)]
    faces=[(0,2,1),(3,4,5),(0,3,5,2),(2,5,4,1),(0,1,4,3)]
    mesh=bpy.data.meshes.new('Gable');mesh.from_pydata(vs,[],faces);mesh.update();o=bpy.data.objects.new('Pitched roof',mesh);bpy.context.collection.objects.link(o);finish(o,'Pitched roof',m)


def passenger():
    reset();skin=mat('Warm skin',(.67,.43,.29));hair=mat('Dark brown hair',(.055,.037,.029));jacket=mat('Soft terracotta jacket',(.54,.26,.16));trim=mat('Jacket trim',(.37,.16,.10));shirt=mat('Ivory shirt',(.83,.80,.70));pants=mat('Navy trousers',(.055,.09,.13));shoe=mat('Dark shoes',(.055,.06,.065));sole=mat('Warm rubber soles',(.20,.20,.18));eye=mat('Eyes',(.025,.021,.020));lip=mat('Mouth',(.34,.17,.12))
    box('Jacket torso',(0,0,1.135),(.43,.265,.49),jacket,.075)
    box('Shirt collar',(0,.137,1.326),(.10,.022,.09),shirt,.012)
    box('Front zip',(0,.139,1.14),(.012,.015,.35),trim,.003)
    for x in (-.125,.125):box('Jacket pocket',(x,.137,1.037),(.11,.015,.065),trim,.009)
    ell('Neck',(0,.002,1.407),(.069,.064,.10),skin)
    ell('Head',(0,.012,1.525),(.119,.107,.151),skin,segments=20,rings=12)
    # Hair cap is cropped rather than a full intersecting second head.
    vs=[];fs=[];seg=20;rows=6
    for j in range(rows+1):
        for i in range(seg):
            phi=2*math.pi*i/seg
            edge=1.60-.45*max(0,math.sin(phi))
            theta=.03+(edge-.03)*j/rows
            vs.append((.129*math.sin(theta)*math.cos(phi),.012+.118*math.sin(theta)*math.sin(phi),1.525+.160*math.cos(theta)))
    for j in range(rows):
        for i in range(seg):a=j*seg+i;b=j*seg+(i+1)%seg;fs.append((a,b,b+seg,a+seg))
    me=bpy.data.meshes.new('Hair cap mesh');me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new('Hair cap',me);bpy.context.collection.objects.link(o);finish(o,'Hair cap',hair)
    for p in me.polygons:p.use_smooth=True
    ell('Back hair',(0,-.066,1.526),(.106,.047,.102),hair)
    for x in (-.117,.117):ell('Ear',(x,.003,1.518),(.022,.018,.037),skin,segments=12,rings=8)
    for x in (-.039,.039):
        ell('Eye',(x,.111,1.551),(.009,.006,.008),eye,segments=12,rings=8)
        box('Eyebrow',(x,.106,1.573),(.030,.007,.007),hair,.003)
    ell('Nose',(0,.122,1.523),(.017,.020,.024),skin,segments=12,rings=8)
    box('Mouth',(0,.112,1.486),(.036,.008,.0045),lip,.002)
    for side,x in [('L',-.249),('R',.249)]:
        arm=empty('ARM_'+side,(x,0,1.326))
        ell('Shoulder '+side,(x,0,1.304),(.075,.092,.093),jacket,arm)
        cyl('Sleeve upper '+side,(x,0,1.30),(x,.006,1.075),.070,jacket,arm,r2=.059)
        ell('Elbow '+side,(x,.006,1.075),(.060,.066,.067),jacket,arm)
        cyl('Sleeve lower '+side,(x,.006,1.082),(x,.035,.906),.059,jacket,arm,r2=.047)
        cyl('Cuff '+side,(x,.031,.924),(x,.036,.893),.051,trim,arm)
        ell('Hand '+side,(x,.040,.854),(.044,.038,.066),skin,arm)
        ell('Thumb '+side,(x-(.030 if x>0 else -.030),.061,.874),(.017,.022,.031),skin,arm,segments=12,rings=8)
    box('Hip',(0,-.01,.892),(.345,.22,.18),pants,.045)
    for side,x in [('L',-.098),('R',.098)]:
        leg=empty('LEG_'+side,(x,-.01,.88))
        cyl('Trouser upper '+side,(x,-.01,.864),(x,-.006,.51),.084,pants,leg,r2=.068)
        ell('Knee '+side,(x,-.006,.51),(.069,.077,.075),pants,leg)
        cyl('Trouser lower '+side,(x,-.006,.51),(x,.012,.144),.069,pants,leg,r2=.055)
        box('Sole '+side,(x,.055,.036),(.157,.284,.055),sole,.018,leg)
        box('Shoe '+side,(x,.056,.088),(.145,.268,.102),shoe,.040,leg)
        for y in (.065,.09,.115):box('Shoe seam '+side,(x,y,.139),(.067,.009,.007),sole,.003,leg)
    return 'passenger', 1.68

def post_office():
    reset();wall=mat('Post office warm white',(.78,.77,.70));red=mat('Postal red',(.70,.035,.04));roof=mat('Graphite roof',(.15,.18,.20));glass=mat('Blue glazing',(.12,.23,.28),.28);frame=mat('Off white frames',(.88,.87,.81));dark=mat('Dark metal',(.18,.20,.21));concrete=mat('Paving',(.49,.49,.45));white=mat('Sign white',(.96,.94,.87));stone=mat('Base stone',(.48,.47,.42))
    box('Foundation',(0,0,.13),(8,5.8,.26),concrete,.05)
    box('Main walls',(0,0,1.73),(7.72,5.5,3.20),wall,.035)
    box('Masonry base',(0,0,.41),(7.75,5.53,.30),stone,.015)
    box('Flat roof coping',(0,0,3.45),(8,5.80,.27),roof,.04)
    box('Front fascia',(0,2.79,2.92),(7.76,.12,.55),red,.02)
    box('Side fascia left',(-3.88,0,2.92),(.10,5.5,.55),red,.01)
    box('Side fascia right',(3.88,0,2.92),(.10,5.5,.55),red,.01)
    text('강내우체국 간판','강내우체국',(0,2.867,2.94),.39,white,4.2)
    for x in (-2.50,2.50):window('Front window',x,2.765,1.61,1.7,1.72,frame,glass)
    box('Entrance frame',(0,2.81,1.35),(1.48,.15,2.35),frame,.025)
    box('Entrance door',(0,2.90,1.35),(1.31,.035,2.22),glass,.007)
    box('Door center mullion',(0,2.93,1.35),(.06,.04,2.24),frame,.004)
    for x in (-.12,.12):box('Door handles',(x,2.97,1.24),(.025,.045,.30),dark,.006)
    box('Entrance canopy',(0,3.08,2.60),(2.10,.85,.13),roof,.025)
    box('Entry step',(0,3.02,.11),(2.10,.60,.22),concrete,.025)
    box('Post box',(-3.20,3.0,.69),(.40,.35,1.16),red,.06)
    box('Mail slot',(-3.20,3.18,.93),(.24,.015,.035),dark,.005)
    text('우편 표식','우편',(-3.20,3.19,.73),.11,white,.27)
    for x in (-2.8,2.8):
        box('Roof vent',(x,-1.4,3.67),(.55,.65,.32),roof,.02)
    return 'service-post-office', 4

def village_hall():
    reset();wall=mat('Hall cream walls',(.77,.75,.66));roof=mat('Hall slate roof',(.18,.24,.25));trim=mat('Blue green trim',(.19,.36,.35));glass=mat('Hall blue glass',(.15,.26,.30),.3);frame=mat('White window trim',(.89,.89,.84));white=mat('Hall lettering',(.94,.93,.86));stone=mat('Stone foundation',(.46,.47,.43));wood=mat('Outdoor bench wood',(.39,.23,.12));dark=mat('Bench legs',(.13,.18,.18))
    box('Hall base',(0,0,.15),(7.05,5.05,.3),stone,.035)
    box('Hall walls',(0,0,1.62),(6.80,4.80,2.94),wall,.035)
    roof_gable(7.20,5.24,3.05,.82,roof)
    box('Front eave',(0,2.64,3.08),(7.20,.13,.14),trim,.01)
    box('Hall name board',(0,2.475,2.66),(2.28,.10,.43),trim,.02)
    text('마을회관 간판','마을회관',(0,2.54,2.66),.30,white,2.05)
    for x in (-2.25,2.25):window('Hall front window',x,2.42,1.64,1.68,1.32,frame,glass)
    box('Hall entry frame',(0,2.44,1.32),(1.35,.12,2.28),trim,.02)
    box('Hall glass door',(0,2.52,1.30),(1.18,.035,2.15),glass,.008)
    box('Door mullion',(0,2.55,1.3),(.05,.025,2.15),frame,.004)
    box('Handle',(.13,2.58,1.24),(.025,.035,.28),frame,.006)
    box('Hall doorstep',(0,2.57,.15),(1.70,.55,.3),stone,.02)
    for x in (-2.20,2.20):
        box('Bench seat',(x,2.80,.53),(1.20,.40,.09),wood,.02)
        box('Bench back',(x,2.64,.81),(1.20,.07,.44),wood,.02)
        for dx in (-.45,.45):box('Bench leg',(x+dx,2.8,.32),(.07,.28,.38),dark,.01)
    return 'service-village-hall',4

def shelter():
    reset();metal=mat('Shelter midnight frame',(.12,.21,.24));roof=mat('Shelter blue teal roof',(.15,.36,.40));glass=mat('Shelter translucent glazing',(.49,.69,.72,.38),.22);wood=mat('Shelter bench slats',(.50,.32,.17));silver=mat('Shelter hardware',(.56,.61,.60),.45);white=mat('Shelter signs',(.94,.94,.88));paper=mat('Timetable',(.86,.89,.85));concrete=mat('Shelter pad',(.55,.56,.52))
    box('Shelter pad',(0,0,.04),(3.5,1.6,.08),concrete,.025)
    for x in (-1.53,1.53):
        for y in (-.57,.54):box('Shelter column',(x,y,1.23),(.075,.075,2.40),metal,.009)
    box('Rear glass',(0,-.565,1.33),(3.0,.025,1.96),glass,.005)
    for x in (-1.53,1.53):box('Side glass',(x,-.02,1.33),(.025,1.02,1.96),glass,.005)
    box('Rear glass rail',(0,-.58,.48),(3.1,.055,.055),metal,.006)
    box('Roof',(0,0,2.49),(3.50,1.65,.18),roof,.055)
    box('Roof front band',(0,.82,2.47),(3.36,.05,.19),metal,.008)
    text('정류장 간판','BUS · 정류장',(0,.856,2.48),.145,white,1.6)
    for y in (-.24,-.10,.04):box('Bench slat',(0,y,.53),(2.36,.125,.075),wood,.014)
    for z in (.77,.91):box('Bench back slat',(0,-.32,z),(2.36,.065,.115),wood,.015)
    for x in (-.85,.85):box('Bench foot',(x,-.08,.29),(.08,.40,.47),metal,.015)
    box('Timetable panel',(-1.05,-.533,1.54),(.48,.025,.69),paper,.008)
    for j in range(6):box('Timetable line',(-1.05,-.513,1.75-j*.075),(.32,.006,.013),metal,.001)
    box('Route header',(-1.05,-.51,1.83),(.37,.006,.035),roof,.002)
    return 'service-stop-shelter',3

def stop_sign():
    reset();blue=mat('Stop blue',(.13,.32,.48));white=mat('Stop white',(.95,.95,.89));metal=mat('Stop pole',(.42,.47,.48),.5,.15);dark=mat('Stop icon',(.12,.23,.29));concrete=mat('Stop base',(.50,.50,.46))
    box('Sign footing',(0,0,.035),(.35,.3,.07),concrete,.025)
    cyl('Sign pole',(0,0,.06),(0,0,2.27),.037,metal)
    box('Stop board',(0,0,2.15),(.52,.10,.62),blue,.08)
    box('Bus icon panel',(0,.056,2.28),(.36,.018,.25),white,.035)
    box('Bus front icon',(0,.07,2.30),(.17,.012,.15),blue,.025)
    box('Bus window',(0,.079,2.32),(.13,.008,.06),white,.006)
    for x in (-.054,.054):ell('Bus icon wheel',(x,.077,2.208),(.019,.008,.020),dark,segments=12,rings=6)
    text('정류장 팻말','정류장',(0,.062,2.04),.11,white,.41)
    box('Route information',(0,.006,1.60),(.24,.08,.36),white,.017)
    for j in range(4):box('Route stripe',(0,.05,1.72-j*.065),(.17,.012,.016),blue,.002)
    return 'service-stop-sign',3

def export(name):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(ASSETS/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_materials='EXPORT')

def render_reimport(name,height):
    # Reimport the delivered GLB, so the preview validates exported hierarchy/materials.
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSETS/(name+'.glb')))
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    corners=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
    lo=Vector([min(v[i] for v in corners) for i in range(3)]);hi=Vector([max(v[i] for v in corners) for i in range(3)])
    center=(lo+hi)/2;span=max(hi.x-lo.x,hi.y-lo.y,hi.z-lo.z)
    ground=mat('Preview ground',(.74,.77,.76));box('Preview floor',(0,0,-.06),(span*14,span*14,.1),ground,0)
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=48;scene.cycles.use_denoising=False
    scene.render.resolution_x=800;scene.render.resolution_y=680;scene.render.resolution_percentage=100
    scene.world.color=(.58,.58,.58)
    scene.view_settings.view_transform='AgX'
    bpy.ops.object.camera_add(location=center+Vector((span*1.1,span*1.7,span*1.02)))
    cam=bpy.context.object;cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=span*1.5;scene.camera=cam
    bpy.ops.object.light_add(type='AREA',location=(span*1.6,span*1.4,span*2.2));light=bpy.context.object;light.data.energy=span**2*140;light.data.shape='DISK';light.data.size=span*1.5;light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.light_add(type='AREA',location=(-span,span*.2,span*1.5));light=bpy.context.object;light.data.energy=span**2*60;light.data.size=span*2;light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
    scene.render.image_settings.file_format='PNG';scene.render.filepath=str(PREVIEW/(name+'.png'));bpy.ops.render.render(write_still=True)
    return {'asset':name+'.glb','bounds_blender_z_up':[list(lo),list(hi)],'dimensions_m':list(hi-lo),'bytes':(ASSETS/(name+'.glb')).stat().st_size,'triangles':sum(len(p.vertices)-2 for o in meshes for p in o.data.polygons),'illustrative':True}

summary=[]
for builder in (passenger,post_office,village_hall,shelter,stop_sign):
    name,height=builder();export(name);summary.append(render_reimport(name,height))
(ROOT/'docs'/'service-model-validation.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print('SERVICE_MODELS_COMPLETE',json.dumps(summary))
