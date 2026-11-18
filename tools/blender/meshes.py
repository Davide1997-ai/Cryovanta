"""
Blender (bpy) → hero meshes (glTF binary) for Neon Circuit.

Authoring space: Blender Z-up. The glTF exporter maps Blender (x, y, z) -> three.js (x, z, -y), so
  Blender +Z = three +Y (up)   and   Blender -Y = three +Z (the robot's front).
Each part is authored in the LOCAL frame of the primitive it replaces in the client, so swapping geometry keeps pivots.
"""
import math
import bpy
import bmesh
from mathutils import Vector


def lathe(profile, segs=64, shape=None):
    """Revolve a (radius, z) profile around Z. profile runs axis -> axis (first/last radius may be 0)."""
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        if r < 1e-6:
            rings.append(bm.verts.new((0, 0, z)))
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * j / segs), r * math.sin(2 * math.pi * j / segs), z)) for j in range(segs)])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(segs):
            k = (j + 1) % segs
            if isinstance(a, list) and isinstance(b, list): bm.faces.new((a[j], a[k], b[k], b[j]))
            elif isinstance(a, list): bm.faces.new((a[j], a[k], b))
            elif isinstance(b, list): bm.faces.new((a, b[k], b[j]))
    if shape:
        for v in bm.verts:
            d = shape(v.co.x, v.co.y, v.co.z)
            v.co.x += d[0]; v.co.y += d[1]; v.co.z += d[2]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def sample(f, a, b, n):
    return [f(a + (b - a) * i / n) for i in range(n + 1)]


def capsule_profile(r, cyl, rings=22, radial=lambda z: 0.0):
    """Hemisphere - cylinder - hemisphere along Z; `radial(z)` adds to the radius (grooves, bands)."""
    pts = [(0.0, cyl / 2 + r)]
    for i in range(1, rings + 1):                       # upper hemisphere, ends at (r, cyl/2)
        a = math.pi / 2 * (1 - i / rings); pts.append((r * math.cos(a), cyl / 2 + r * math.sin(a)))
    n = max(2, int(cyl / 0.01))
    for i in range(1, n):                               # cylinder body
        pts.append((r, cyl / 2 - cyl * i / n))
    for i in range(0, rings + 1):                       # lower hemisphere, starts at (r, -cyl/2)
        a = -(math.pi / 2) * (i / rings); pts.append((r * math.cos(a), -cyl / 2 + r * math.sin(a)))
    pts[-1] = (0.0, pts[-1][1])
    return [((p[0] * (1.0 + radial(p[1]))) if p[0] > 1e-6 else 0.0, p[1]) for p in pts]


def groove(z, z0, w, depth):
    return -depth * math.exp(-((z - z0) / w) ** 2)


def finish(bm, name, sharp_deg=32, smooth=True):
    """Split hard edges, smooth the rest, make an object."""
    bm.normal_update()
    sharp = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(sharp_deg)]
    if sharp: bmesh.ops.split_edges(bm, edges=sharp)
    for f in bm.faces: f.smooth = smooth
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob


# ---------------------------------------------------------------- robot parts
def torso():
    r, cyl = 0.30, 0.20
    prof = capsule_profile(r, cyl, 26)
    def shape(x, y, z):
        ang = math.atan2(y, x); rad = math.hypot(x, y); nx, ny = (x / rad, y / rad) if rad > 1e-6 else (0, 0)
        d = 0.0
        d += groove(z, -0.02, 0.012, 0.014) * (rad > 0.05)                                  # waist seam
        d += groove(z, 0.17, 0.008, 0.008) * (rad > 0.05)                                   # chest seam
        # chest dish (front = Blender -Y): shallow recess around the chrome ring
        dd = math.hypot(x, z - 0.02)
        if y < -0.1 and dd < 0.24: d -= 0.028 * (1 - (dd / 0.24) ** 2) ** 1.5
        # back service panel + vents (+Y)
        if y > 0.1 and abs(x) < 0.17 and abs(z - 0.05) < 0.16: d -= 0.012
        if y > 0.1 and abs(x) < 0.14:
            for k in (-0.08, 0.0, 0.08, 0.16):
                if abs(z - k) < 0.011: d -= 0.012
        # side shoulder sockets (±X)
        for sx in (-1, 1):
            sd = math.hypot(y, z - 0.05)
            if sx * x > 0.1 and sd < 0.09: d -= 0.02 * (1 - (sd / 0.09) ** 2)
        return (nx * d, ny * d, 0.0)
    return finish(lathe(prof, 72, shape), 'robot_torso')


def skull():
    r = 0.27
    prof = [(0.0, r)] + [(r * math.sin(t), r * math.cos(t)) for t in sample(lambda t: t, math.pi / 40, math.pi - math.pi / 40, 38)] + [(0.0, -r)]
    def shape(x, y, z):
        rad = math.hypot(x, y); nx, ny = (x / rad, y / rad) if rad > 1e-6 else (0, 0)
        d = groove(z, 0.02, 0.010, 0.010)                                                    # cranial seam
        for sx in (-1, 1):                                                                    # ear caps
            ed = math.hypot(y, z - 0.0)
            if sx * x > 0.15 and ed < 0.115:
                d += 0.016 * (1 if ed > 0.085 else 0) - 0.008 * (1 if ed < 0.07 else 0)
        if y < -0.05 and z > 0.12 and z < 0.2: d += 0.006                                    # brow ridge (front)
        return (nx * d, ny * d, 0.0)
    return finish(lathe(prof, 64, shape), 'robot_skull')


def arm():
    r, cyl = 0.07, 0.16
    prof = capsule_profile(r, cyl, 14, radial=lambda z: groove(z, -0.075, 0.006, 0.18) + groove(z, 0.065, 0.005, 0.12))
    return finish(lathe(prof, 36), 'robot_arm')


def foot():
    r = 0.13
    pts = [(0.0, r)] + [(r * math.sin(t), r * math.cos(t)) for t in sample(lambda t: t, math.pi / 24, math.acos(-0.12 / 0.13), 24)]
    pts = [(p[0], max(p[1], -0.12)) for p in pts]                                           # flat sole
    pts.append((0.0, -0.12))
    def shape(x, y, z):
        rad = math.hypot(x, y); nx, ny = (x / rad, y / rad) if rad > 1e-6 else (0, 0)
        d = groove(z, 0.045, 0.01, 0.007) * (rad > 0.02)                                     # toe-cap seam
        if z < -0.09: d += 0.006 * (math.sin(math.atan2(y, x) * 9) > 0.4)                     # tread
        return (nx * d, ny * d, 0.0)
    return finish(lathe(pts, 40, shape), 'robot_foot')


def chest():
    zt = 0.04
    prof = [(0.0, zt - 0.014), (0.07, zt - 0.014), (0.086, zt - 0.002), (0.095, zt), (0.17, zt), (0.188, zt - 0.004), (0.2, zt - 0.018), (0.2, -zt + 0.018),
            (0.188, -zt + 0.004), (0.17, -zt), (0.0, -zt)]
    def shape(x, y, z):
        rad = math.hypot(x, y)
        if z > 0.02 and 0.115 < rad < 0.15: return (0, 0, -0.004)                            # inner groove
        return (0, 0, 0)
    return finish(lathe(prof, 56, shape), 'robot_chest')


# ---------------------------------------------------------------- hazards / pickups
def item_box():
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.05, segments=3, profile=0.6, affect='EDGES')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    big = [f for f in bm.faces if len(f.verts) >= 4 and f.calc_area() > 0.4]                     # the six large faces
    bmesh.ops.inset_individual(bm, faces=big, thickness=0.09, depth=-0.02)                      # recessed panels
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return finish(bm, 'item_box', 28)


def ball():
    prof = [(0.0, 1.0)] + [(math.sin(t), math.cos(t)) for t in sample(lambda t: t, math.pi / 36, math.pi - math.pi / 36, 34)] + [(0.0, -1.0)]
    prof = [(p[0] * (1 + groove(p[1], 0.0, 0.05, 0.045) + groove(p[1], 0.52, 0.03, 0.03) + groove(p[1], -0.52, 0.03, 0.03)) if p[0] > 0 else 0.0, p[1]) for p in prof]
    return finish(lathe(prof, 56), 'hz_ball')


def hub():
    h2 = 0.7
    prof = [(0.0, h2), (0.62, h2), (0.73, h2 - 0.015), (0.77, h2 - 0.09), (0.84, -h2 + 0.3), (0.9, -h2 + 0.08), (0.88, -h2 + 0.02), (0.82, -h2), (0.0, -h2)]
    def shape(x, y, z):
        rad = math.hypot(x, y); nx, ny = (x / rad, y / rad) if rad > 1e-6 else (0, 0)
        d = groove(z, 0.0, 0.035, 0.025) * (rad > 0.1)
        if z > h2 - 0.02 and 0.2 < rad < 0.5 and math.sin(math.atan2(y, x) * 6) > 0.85: d = 0
        return (nx * d, ny * d, 0)
    return finish(lathe(prof, 48, shape), 'hz_hub')


def build_all(out_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import addon_utils; addon_utils.enable('io_scene_gltf2', default_set=True)
    objs = [torso(), skull(), arm(), foot(), chest(), item_box(), ball(), hub()]
    for o in bpy.context.scene.objects: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out_path, export_format='GLB', export_materials='NONE', export_texcoords=False, export_normals=True,
                              export_cameras=False, export_lights=False, export_yup=True, use_selection=True)
    return [(o.name, len(o.data.vertices), len(o.data.polygons)) for o in objs]
