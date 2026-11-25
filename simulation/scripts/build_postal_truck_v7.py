"""Build one original illustrative parked Korean postal delivery truck.

Run with Blender:
  blender -b --python scripts/build_postal_truck_v7.py -- <project-root>
  ... -- <project-root> --preview /absolute/path/postal-truck.png

Metres. Blender +Z up / +Y front becomes glTF +Y up / -Z front,
matching the project's facility and DRT convention. This static scenery asset
has no dispatch identity, animation, parcel payload, or research-data meaning.
Livery and proportions are illustrated from the user-supplied reference;
the parked position is a display offset, not a surveyed parking location.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--preview', type=Path)
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:])


def material(name, rgb, roughness=.65, metallic=0, emissive=None):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*rgb, 1)
    result.use_nodes = True
    bsdf = result.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = result.diffuse_color
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emissive:
        bsdf.inputs['Emission Color'].default_value = (*emissive, 1)
        bsdf.inputs['Emission Strength'].default_value = .25
    return result


def finish(obj, name, paint, bevel=0):
    obj.name = name
    if paint:
        obj.data.materials.append(paint)
    if bevel:
        mod = obj.modifiers.new('Gently rounded manufactured edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        mod = obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name, xyz, dimensions, paint, bevel=.015):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz)
    obj = bpy.context.object
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, paint, bevel)


def polygon(name, points, paint, faces=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points, [], faces or [tuple(range(len(points)))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, paint)


def profile(name, points, half_width, paint, bevel=.035):
    count = len(points)
    vertices = [(x, y, z) for x in (-half_width, half_width) for y, z in points]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, j + count, i + count))
    obj = polygon(name, vertices, paint, faces)
    if bevel:
        mod = obj.modifiers.new('Cab shell rounded edge', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        mod = obj.modifiers.new('Cab weighted normals', 'WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def cylinder(name, a, b, radius, paint, vertices=20):
    a, b = Vector(a), Vector(b)
    direction = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius,
                                      depth=direction.length, location=(a + b) / 2)
    obj = bpy.context.object
    obj.rotation_euler = direction.to_track_quat('Z', 'Y').to_euler()
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return finish(obj, name, paint)


def line(name, a, b, radius, paint):
    return cylinder(name, a, b, radius, paint, 8)


def lettering(name, text, origin, right, up, height, max_width, paint):
    curve = bpy.data.curves.new(name, 'FONT')
    curve.body = text
    curve.size = 1
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.extrude = .0007
    curve.resolution_u = 2
    curve.font = bpy.data.fonts.load('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location = origin
    right, up = Vector(right), Vector(up)
    normal = right.cross(up)
    obj.rotation_euler = Matrix((right, up, normal)).transposed().to_euler()
    obj.data.materials.append(paint)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    obj = bpy.context.object
    # Normalize converted glyph bounds, including the TTC glyph metrics.
    xs = [p.co.x for p in obj.data.vertices]
    ys = [p.co.y for p in obj.data.vertices]
    if not xs:
        return obj
    factor = min(height / max(1e-6, max(ys) - min(ys)),
                 max_width / max(1e-6, max(xs) - min(xs)))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    for point in obj.data.vertices:
        point.co.x = (point.co.x - cx) * factor
        point.co.y = (point.co.y - cy) * factor
    return obj


def build():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    white = material('Warm white postal body', (.89, .90, .88), .38, .10)
    red = material('Postal red paint', (.72, .033, .025), .40, .08)
    orange = material('Postal orange ribbon', (.95, .31, .035), .48)
    silver = material('Brushed aluminium fittings', (.52, .56, .56), .36, .70)
    rim = material('Silver wheel rims', (.58, .62, .63), .26, .78)
    rubber = material('Tyres and underbody', (.026, .031, .035), .91)
    trim = material('Dark graphite mouldings', (.067, .082, .09), .59)
    glass = material('Deep blue tinted cab glass', (.055, .105, .135), .17, .25)
    grille = material('Radiator recess', (.032, .045, .052), .67)
    pale = material('Ivory postal lettering', (.97, .95, .88), .72)
    lamps = material('Headlamp glass', (.88, .94, .91), .20, .18, (.7, .75, .68))
    rear_lamps = material('Red rear lamps', (.80, .025, .019), .26, 0, (.50, .015, .01))
    indicators = material('Amber indicator lenses', (1, .40, .035), .26, 0, (.65, .20, 0))

    # 1-ton-style cab-over light delivery truck, with a closed rectangular box.
    box('Chassis rails', (0, -.10, .48), (1.37, 4.85, .17), rubber, .025)
    for x in (-.49, .49):
        box('Rear frame member', (x, -1.40, .54), (.085, 2.40, .16), trim, .01)
    box('Cargo floor aluminium edge', (0, -.94, .77), (1.96, 3.33, .15), silver, .025)
    box('Insulated cargo box', (0, -.96, 1.74), (1.92, 3.30, 1.88), white, .035)
    box('Cargo roof cap', (0, -.96, 2.69), (1.96, 3.34, .065), silver, .022)
    for x in (-.969, .969):
        for y in (-2.60, .68):
            box('Cargo corner extrusion', (x, y, 1.73), (.045, .055, 1.86), silver, .009)
        box('Cargo bottom extrusion', (x, -.96, .83), (.047, 3.27, .055), silver, .008)

    # Large, sparse red / orange ribbons like the photographed postal box.
    # These are painted surfaces; no tiled logos or repeated window patterns.
    for side in (-1, 1):
        x = side * .963
        pts = [(x, -2.56, .87), (x, .22, .87),
               (x, -1.04, 2.64), (x, -2.56, 2.64)]
        if side < 0:
            pts.reverse()
        polygon('Postal red cargo side', pts, red)
        pts = [(x + side * .001, .29, .87), (x + side * .001, .63, .87),
               (x + side * .001, -.60, 2.64), (x + side * .001, -.95, 2.64)]
        if side < 0:
            pts.reverse()
        polygon('Orange cargo diagonal ribbon', pts, orange)
        lettering('Cargo postal title', '우체국소포', (side * .969, -1.66, 1.82),
                  (0, side, 0), (0, 0, 1), .205, 1.40, pale)
        lettering('Cargo postal subline', 'KOREA POST', (side * .970, -1.66, 1.55),
                  (0, side, 0), (0, 0, 1), .070, 1.15, pale)
        # Two unobtrusive horizontal side-door fitting rails.
        for y in (-.45, .47):
            box('Cargo side hinge spine', (side * .981, y, 1.73), (.022, .032, 1.68), silver, .006)
            for z in (1.02, 1.40, 2.28):
                box('Cargo side hinge plate', (side * .996, y, z), (.020, .15, .045), silver, .004)
        box('Side loading door latch', (side * 1.005, .41, 1.37), (.035, .22, .052), trim, .008)

    # Cargo rear double doors, rubbers, lockbars, handles, and small lamps.
    box('Rear door dark seal', (0, -2.619, 1.73), (1.82, .024, 1.76), trim, .012)
    for side in (-1, 1):
        box('Rear postal door', (side * .452, -2.636, 1.74), (.88, .032, 1.70), red, .01)
        cylinder('Rear lockbar', (side * .51, -2.675, .98),
                 (side * .51, -2.675, 2.51), .013, silver, 8)
        box('Rear locking handle', (side * .41, -2.696, 1.45), (.25, .035, .039), silver, .007)
        for z in (1.09, 2.30):
            box('Rear door hinges', (side * .85, -2.668, z), (.11, .035, .06), silver, .005)
    lettering('Rear postal name', '우체국소포', (0, -2.661, 2.18),
              (-1, 0, 0), (0, 0, 1), .16, 1.34, pale)
    box('Rear step bumper', (0, -2.67, .61), (1.83, .18, .11), trim, .02)
    for x in (-.76, .76):
        box('Rear lamp', (x, -2.702, .78), (.22, .035, .085), rear_lamps, .012)

    # Sculpted cab: curved upper corners, forward-sloping windscreen, low nose.
    profile('Cab white shell', [(.77, .56), (2.55, .56), (2.66, .79),
             (2.62, 1.16), (2.43, 1.38), (2.15, 2.10), (1.98, 2.20),
             (.94, 2.20), (.77, 2.08)], .884, white, .065)
    profile('Red lower cab band', [(.80, .57), (2.56, .57), (2.66, .78),
             (2.63, .98), (.80, .90)], .890, red, .025)

    # Windshield lies on the sloping front of the actual cab shell.
    polygon('Full windscreen rubber surround', [(-.797, 2.468, 1.411),
             (.797, 2.468, 1.411), (.760, 2.178, 2.095), (-.760, 2.178, 2.095)], trim)
    polygon('Broad sloping front windscreen', [(-.746, 2.469, 1.459),
             (.746, 2.469, 1.459), (.712, 2.201, 2.048), (-.712, 2.201, 2.048)], glass)
    for x in (-.37, .37):
        line('Windshield wiper', (x - .22, 2.476, 1.46), (x + .16, 2.428, 1.56), .009, trim)
    box('Front black grille', (0, 2.667, 1.073), (.91, .024, .145), grille, .028)
    for z in (1.026, 1.073, 1.12):
        box('Grille slim chrome rail', (0, 2.684, z), (.76, .013, .009), silver, .003)
    box('Front bumper', (0, 2.657, .66), (1.76, .16, .19), white, .06)
    box('Lower bumper air inlet', (0, 2.744, .65), (.92, .020, .055), trim, .014)
    box('Blank front registration plate', (0, 2.749, .77), (.36, .014, .083), pale, .006)
    for x in (-.65, .65):
        lamp = box('Headlamp', (x, 2.641, 1.09), (.30, .040, .21), lamps, .040)
        lamp.rotation_euler.y = (-.10 if x < 0 else .10)
        box('Front indicator', (x, 2.671, .956), (.26, .026, .050), indicators, .012)

    for side in (-1, 1):
        x = side * .896
        # Cab side window matches the roof and the sloped A-pillar.
        points = [(x, .87, 1.45), (x, 2.34, 1.45),
                  (x, 2.10, 2.078), (x, 1.01, 2.124), (x, .87, 2.013)]
        if side < 0:
            points.reverse()
        polygon('Cab side window rubber', points, trim)
        points = [(x + side * .002, .94, 1.50), (x + side * .002, 2.27, 1.50),
                  (x + side * .002, 2.052, 2.023), (x + side * .002, 1.045, 2.068),
                  (x + side * .002, .94, 1.974)]
        if side < 0:
            points.reverse()
        polygon('Cab side dark window', points, glass)
        line('Slim front quarter-window divider', (x + side * .006, 2.05, 1.49),
             (x + side * .006, 1.92, 2.045), .009, trim)
        for a, b in [((.89, .94), (.89, 1.43)), ((.89, 1.43), (2.27, 1.43))]:
            line('Door seam', (x + side * .005, a[0], a[1]),
                 (x + side * .005, b[0], b[1]), .006, silver)
        box('Recessed black door handle', (side * .911, 1.01, 1.19), (.025, .081, .16), trim, .020)
        lettering('Cab postal shopping sign', '우체국쇼핑', (side * .908, 1.66, 1.20),
                  (0, side, 0), (0, 0, 1), .112, .85, red)
        line('Mirror mounting arm', (side * .89, 2.31, 1.45),
             (side * 1.055, 2.31, 1.58), .025, trim)
        box('Side mirror housing', (side * 1.073, 2.29, 1.66), (.13, .16, .26), trim, .055)
        box('Side mirror glass', (side * 1.144, 2.29, 1.66), (.008, .119, .195), silver, .025)
        box('Cab side repeater', (side * .909, 2.28, 1.02), (.020, .09, .036), indicators, .010)

    # Road wheels with individual simple hubs and dark arches.
    for y in (1.91, -1.62):
        cylinder('Axle', (-.84, y, .35), (.84, y, .35), .065, trim, 12)
        for side in (-1, 1):
            if y > 0:
                arch = [(side * .912, y + math.cos(i * math.pi / 18) * .392,
                         .35 + math.sin(i * math.pi / 18) * .392) for i in range(19)]
                if side < 0:
                    arch.reverse()
                polygon('Front upper wheel arch dark recess', arch, rubber)
            else:
                box('Rear black mudflap', (side * .80, y - .41, .33), (.30, .035, .39), rubber, .006)
            cylinder('Treaded tyre', (side * .77, y, .35),
                     (side * 1.00, y, .35), .342, rubber, 28)
            cylinder('Rounded tyre shoulder', (side * .999, y, .35),
                     (side * 1.012, y, .35), .285, rubber, 24)
            cylinder('Steel wheel rim', (side * 1.015, y, .35),
                     (side * 1.028, y, .35), .215, rim, 24)
            cylinder('Wheel hub', (side * 1.029, y, .35),
                     (side * 1.047, y, .35), .080, silver, 16)
            for i in range(6):
                angle = 2 * math.pi * i / 6
                yy, zz = y + math.cos(angle) * .142, .35 + math.sin(angle) * .142
                cylinder('Wheel rim recess', (side * 1.030, yy, zz),
                         (side * 1.035, yy, zz), .033, trim, 10)

    # Metadata is carried on a single non-operational model node.
    root = bpy.data.objects.new('PARKED_POSTAL_TRUCK', None)
    bpy.context.collection.objects.link(root)
    root['role'] = 'static_scenery'
    root['illustrative'] = True
    root['counts_as_drt'] = False
    root['forward_axis_gltf'] = '-Z'
    for obj in list(bpy.context.scene.objects):
        if obj is not root:
            obj.parent = root
    # A parked prop does not need individual animated nodes. Merge the meshes
    # so glTF draws one primitive per material rather than hundreds of parts.
    bpy.ops.object.select_all(action='DESELECT')
    mesh = bpy.data.meshes.new('Postal truck combined mesh')
    combined = bpy.data.objects.new('Postal delivery truck body', mesh)
    bpy.context.collection.objects.link(combined)
    combined.parent = root
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            obj.select_set(True)
    bpy.context.view_layer.objects.active = combined
    bpy.ops.object.join()
    return root


def export_and_measure(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB',
        export_yup=True, use_selection=True, export_extras=True,
        export_animations=False, export_cameras=False, export_lights=False)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector([min(p[i] for p in corners) for i in range(3)])
    high = Vector([max(p[i] for p in corners) for i in range(3)])
    return {'asset': path.name, 'bounds_blender_z_up': [list(low), list(high)],
            'dimensions_m_xyz': list(high - low), 'bytes': path.stat().st_size,
            'triangles': sum(len(poly.vertices) - 2 for obj in meshes for poly in obj.data.polygons),
            'orientation_gltf': 'Y up; -Z forward', 'illustrative_static_scenery': True}


def preview(path):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 760
    scene.render.resolution_percentage = 100
    scene.world.color = (.52, .52, .52)
    scene.view_settings.view_transform = 'AgX'
    floor = material('Preview floor only', (.45, .49, .50), .9)
    box('Preview floor only', (0, 0, -.05), (200, 200, .07), floor, 0)
    focus = Vector((0, 0, 1.35))
    bpy.ops.object.camera_add(location=(9, 10, 6.5))
    cam = bpy.context.object
    cam.rotation_euler = (focus - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 7.2
    scene.camera = cam
    for xyz, energy, size in [((4, 5, 9), 2000, 7), ((-5, 3, 6), 1100, 6), ((1, -5, 7), 800, 5)]:
        bpy.ops.object.light_add(type='AREA', location=xyz)
        lamp = bpy.context.object
        lamp.data.energy = energy
        lamp.data.size = size
        lamp.rotation_euler = (focus - lamp.location).to_track_quat('-Z', 'Y').to_euler()
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    args = arguments()
    build()
    output = args.root / 'assets' / 'postal-truck.glb'
    output.parent.mkdir(parents=True, exist_ok=True)
    report = export_and_measure(output)
    if args.preview:
        preview(args.preview)
    print('POSTAL_TRUCK_REPORT=' + json.dumps(report, ensure_ascii=False))
