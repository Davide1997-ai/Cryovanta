"""
Blender (bpy) → tileable PBR texture sets (albedo / height / roughness) for Neon Circuit.

Every material is a Blender shader-node graph evaluated with Cycles. Noise is sampled on a 4-D torus
(cos/sin of the UVs), so every texture tiles with NO visible seam. Run via tools/blender/build_assets.py.
"""
import math, os
import bpy

TAU = 2 * math.pi


class G:
    """Tiny node-graph DSL so each material reads like a formula."""

    def __init__(self, nt):
        self.nt = nt
        uv = nt.nodes.new('ShaderNodeTexCoord')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(uv.outputs['UV'], sep.inputs[0])
        self.u, self.v = sep.outputs[0], sep.outputs[1]

    def _in(self, sock, x):
        if isinstance(x, bpy.types.NodeSocket): self.nt.links.new(x, sock)
        elif x is not None: sock.default_value = x

    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath'); n.operation = op; n.use_clamp = clamp
        self._in(n.inputs[0], a)
        if b is not None: self._in(n.inputs[1], b)
        if c is not None: self._in(n.inputs[2], c)
        return n.outputs[0]

    def add(s, a, b): return s.math('ADD', a, b)
    def sub(s, a, b): return s.math('SUBTRACT', a, b)
    def mul(s, a, b): return s.math('MULTIPLY', a, b)
    def clamp01(s, a): return s.math('ADD', a, 0.0, clamp=True)
    def lt(s, a, b): return s.math('LESS_THAN', a, b)
    def fract(s, a): return s.math('FRACT', a)
    def absf(s, a): return s.math('ABSOLUTE', a)
    def ramp(self, x, stops):
        n = self.nt.nodes.new('ShaderNodeValToRGB')
        cr = n.color_ramp
        while len(cr.elements) < len(stops): cr.elements.new(0.5)
        for e, (p, col) in zip(cr.elements, stops): e.position = p; e.color = col
        self._in(n.inputs[0], x)
        return n.outputs[0]

    def rampv(self, x, stops):
        """Colour ramp returning the red channel as a float."""
        c = self.ramp(x, stops)
        sep = self.nt.nodes.new('ShaderNodeSeparateColor'); self.nt.links.new(c, sep.inputs[0]); return sep.outputs[0]

    def mix(self, fac, a, b):
        n = self.nt.nodes.new('ShaderNodeMix'); n.data_type = 'RGBA'; n.blend_type = 'MIX'
        self._in(n.inputs[0], fac); self._in(n.inputs[6], a); self._in(n.inputs[7], b); return n.outputs[2]

    def mixf(self, fac, a, b):  # float lerp
        return self.add(self.mul(a, self.sub(1.0, fac)), self.mul(b, fac))

    def rgb(self, r, g, b):
        n = self.nt.nodes.new('ShaderNodeCombineColor'); n.mode = 'RGB'
        for i, x in enumerate((r, g, b)): self._in(n.inputs[i], x)
        return n.outputs[0]

    def col(self, r, g, b, a=1.0):
        n = self.nt.nodes.new('ShaderNodeRGB'); n.outputs[0].default_value = (r, g, b, a); return n.outputs[0]

    def torus(self, f, seed=0.0):
        """Embed UV on a 4-D torus: noise/voronoi sampled here is periodic with f cycles per tile."""
        r = f / TAU
        a = self.mul(self.u, TAU); b = self.mul(self.v, TAU)
        x = self.mul(self.math('COSINE', a), r); y = self.mul(self.math('SINE', a), r)
        z = self.mul(self.math('COSINE', b), r); w = self.add(self.mul(self.math('SINE', b), r), seed)
        comb = self.nt.nodes.new('ShaderNodeCombineXYZ')
        for i, s in enumerate((x, y, z)): self.nt.links.new(s, comb.inputs[i])
        return comb.outputs[0], w

    def noise(self, f, detail=4.0, rough=0.55, distortion=0.0, seed=0.0):
        vec, w = self.torus(f, seed)
        n = self.nt.nodes.new('ShaderNodeTexNoise'); n.noise_dimensions = '4D'; n.normalize = True
        self.nt.links.new(vec, n.inputs['Vector']); self.nt.links.new(w, n.inputs['W'])
        n.inputs['Scale'].default_value = 1.0; n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough; n.inputs['Distortion'].default_value = distortion
        return n.outputs['Fac']

    def voronoi(self, f, feature='F1', rnd=1.0, seed=0.0, metric='EUCLIDEAN'):
        vec, w = self.torus(f, seed)
        n = self.nt.nodes.new('ShaderNodeTexVoronoi'); n.voronoi_dimensions = '4D'; n.feature = feature; n.distance = metric
        self.nt.links.new(vec, n.inputs['Vector']); self.nt.links.new(w, n.inputs['W'])
        n.inputs['Scale'].default_value = 1.0; n.inputs['Randomness'].default_value = rnd
        return n.outputs['Distance'] if feature != 'N_SPHERE_RADIUS' else n.outputs['Radius']

    def edges(self, f, seed=0.0):
        """Voronoi cell borders (distance to the nearest edge), 0 on the border."""
        vec, w = self.torus(f, seed)
        n = self.nt.nodes.new('ShaderNodeTexVoronoi'); n.voronoi_dimensions = '4D'; n.feature = 'DISTANCE_TO_EDGE'
        self.nt.links.new(vec, n.inputs['Vector']); self.nt.links.new(w, n.inputs['W'])
        n.inputs['Scale'].default_value = 1.0
        return n.outputs['Distance']

    def grid_lines(self, n_per_tile, width):
        """1 on thin lines that repeat n_per_tile times per tile in u and v."""
        def line(t):
            d = self.absf(self.math('SINE', self.mul(t, TAU * n_per_tile / 2.0)))  # zero at every k/n
            return self.lt(d, width)
        return self.math('MAXIMUM', line(self.u), line(self.v))

    def cell(self, n_per_tile):
        """Fractional position inside each grid cell."""
        return self.fract(self.mul(self.u, n_per_tile)), self.fract(self.mul(self.v, n_per_tile))


def S(*c): return (c[0], c[1], c[2], 1.0)


# ---------------------------------------------------------------------------------------------------------
# Material recipes: return (color, roughness, height) sockets.
# ---------------------------------------------------------------------------------------------------------
def concrete(g):
    n1, n2, n3 = g.noise(5), g.noise(40, 3), g.noise(160, 2, 0.7)
    stain = g.rampv(n1, [(0.3, S(0.0, 0, 0)), (0.75, S(1, 1, 1))])
    agg = g.rampv(g.noise(420, 1, 0.7, 0.0, 5.0), [(0.58, S(0, 0, 0)), (0.7, S(1, 1, 1))])      # aggregate speckle
    pits = g.rampv(g.voronoi(70, 'F1', 1.0, 2.0), [(0.0, S(1, 1, 1)), (0.09, S(0, 0, 0))])       # air pockets
    base = g.ramp(g.add(g.mul(n2, 0.55), g.mul(n3, 0.45)), [(0.15, S(0.40, 0.40, 0.38)), (0.85, S(0.70, 0.69, 0.66))])
    col = g.mix(g.mul(stain, 0.55), base, g.col(0.27, 0.26, 0.24))
    col = g.mix(g.mul(agg, 0.35), col, g.col(0.82, 0.80, 0.76))
    col = g.mix(g.mul(pits, 0.8), col, g.col(0.12, 0.12, 0.11))
    joint = g.grid_lines(2, 0.03)
    col = g.mix(joint, col, g.col(0.05, 0.05, 0.05))
    rough = g.add(g.mul(g.add(g.mul(n2, 0.5), g.mul(n3, 0.5)), 0.2), 0.76)
    height = g.sub(g.add(g.add(g.mul(n3, 0.4), g.mul(n2, 0.4)), g.mul(agg, 0.25)), g.add(g.mul(joint, 0.9), g.mul(pits, 0.45)))
    return col, rough, g.clamp01(height)


def wood(g):
    grain_n = g.noise(8, 4, 0.55, 0.5)
    fine = g.noise(260, 2, 0.6, 0.0, 4.0)
    g1 = g.add(g.mul(g.math('SINE', g.add(g.mul(g.u, TAU * 10), g.mul(grain_n, 14.0))), 0.5), 0.5)
    tone = g.noise(3, 2, 0.5, 0.0, seed=7.0)
    knot = g.rampv(g.voronoi(5, 'F1', 0.9, 9.0), [(0.0, S(1, 1, 1)), (0.12, S(0, 0, 0))])
    base = g.ramp(g.add(g.mul(g1, 0.55), g.mul(tone, 0.45)), [(0.0, S(0.26, 0.13, 0.05)), (0.5, S(0.5, 0.3, 0.14)), (1.0, S(0.68, 0.46, 0.25))])
    col = g.mix(g.mul(knot, 0.5), base, g.col(0.18, 0.09, 0.035))
    col = g.mix(g.mul(fine, 0.18), col, g.col(0.2, 0.11, 0.05))
    gap = g.lt(g.fract(g.mul(g.v, 4.0)), 0.03)
    col = g.mix(gap, col, g.col(0.03, 0.02, 0.012))
    rough = g.add(g.mul(g1, 0.18), 0.5)
    height = g.sub(g.add(g.mul(g1, 0.4), g.add(0.35, g.mul(fine, 0.12))), g.mul(gap, 0.65))
    return col, rough, g.clamp01(height)


def grass(g):
    n1, n2, n3 = g.noise(6), g.noise(48, 3), g.noise(200, 2, 0.8)
    blades = g.noise(520, 1, 0.6, 0.0, 2.0)
    tufts = g.rampv(g.voronoi(36, 'F1', 1.0, 4.0), [(0.0, S(1, 1, 1)), (0.2, S(0, 0, 0))])
    base = g.ramp(g.add(g.mul(n2, 0.5), g.mul(n3, 0.5)), [(0.15, S(0.05, 0.17, 0.03)), (0.55, S(0.16, 0.37, 0.07)), (0.95, S(0.36, 0.58, 0.14))])
    col = g.mix(g.mul(n1, 0.55), base, g.col(0.3, 0.4, 0.09))
    col = g.mix(g.mul(g.rampv(blades, [(0.5, S(0, 0, 0)), (0.8, S(1, 1, 1))]), 0.5), col, g.col(0.62, 0.78, 0.28))
    col = g.mix(g.mul(tufts, 0.4), col, g.col(0.05, 0.14, 0.03))
    return col, g.add(g.mul(n3, 0.12), 0.82), g.clamp01(g.add(g.add(g.mul(n3, 0.35), g.mul(blades, 0.35)), g.mul(tufts, 0.25)))


def metal(g):
    n1, n2 = g.noise(8, 3), g.noise(120, 2, 0.8)
    scr = g.rampv(g.noise(220, 1, 0.5, 0.0, 3.0), [(0.62, S(0, 0, 0)), (0.7, S(1, 1, 1))])
    base = g.ramp(g.add(g.mul(n1, 0.5), g.mul(n2, 0.5)), [(0.2, S(0.38, 0.4, 0.44)), (0.8, S(0.55, 0.57, 0.6))])
    seam = g.grid_lines(2, 0.022)
    cx, cy = g.cell(4)
    dx, dy = g.sub(cx, 0.5), g.sub(cy, 0.5)
    rivet = g.lt(g.math('SQRT', g.add(g.mul(dx, dx), g.mul(dy, dy))), 0.07)
    col = g.mix(g.mul(scr, 0.5), base, g.col(0.8, 0.82, 0.85))
    col = g.mix(seam, col, g.col(0.05, 0.05, 0.06))
    col = g.mix(rivet, col, g.col(0.72, 0.74, 0.78))
    rough = g.add(g.mul(g.add(g.mul(n1, 0.5), g.mul(n2, 0.5)), 0.22), g.add(0.22, g.mul(scr, -0.1)))
    height = g.add(g.sub(0.5, g.mul(seam, 0.45)), g.mul(rivet, 0.5))
    return col, g.clamp01(rough), g.clamp01(height)


def candy(g):
    cx = g.math('MODULO', g.add(g.math('FLOOR', g.mul(g.u, 4.0)), g.math('FLOOR', g.mul(g.v, 4.0))), 2.0)
    n = g.noise(20, 2)
    col = g.mix(cx, g.col(0.95, 0.12, 0.3), g.col(1.0, 0.9, 0.93))
    col = g.mix(g.mul(n, 0.06), col, g.col(1, 1, 1))
    return col, g.add(0.3, g.mul(n, 0.08)), g.clamp01(g.add(0.5, g.mul(n, 0.1)))


def conveyor(g):
    n1, n2 = g.noise(30, 3), g.noise(150, 2, 0.8)
    rubber = g.ramp(g.add(g.mul(n1, 0.5), g.mul(n2, 0.5)), [(0.2, S(0.11, 0.115, 0.13)), (0.8, S(0.2, 0.21, 0.24))])
    cy = g.fract(g.mul(g.v, 4.0)); cxx = g.mul(g.absf(g.sub(g.fract(g.u), 0.5)), 2.0)
    chev = g.lt(g.absf(g.sub(g.sub(cy, 0.25), g.mul(cxx, 0.35))), 0.075)
    ribs = g.lt(g.absf(g.sub(g.fract(g.mul(g.v, 16.0)), 0.5)), 0.12)
    col = g.mix(chev, rubber, g.col(0.95, 0.72, 0.06))
    return col, g.add(0.55, g.mul(n2, 0.15)), g.clamp01(g.sub(g.add(0.55, g.mul(n2, 0.15)), g.mul(ribs, 0.3)))


def bounce(g):
    n = g.noise(60, 2)
    d = g.math('SQRT', g.add(g.math('POWER', g.sub(g.u, 0.5), 2.0), g.math('POWER', g.sub(g.v, 0.5), 2.0)))
    ring = g.lt(g.math('SINE', g.mul(d, TAU * 3.0)), -0.35)
    col = g.mix(ring, g.col(0.85, 0.07, 0.12), g.col(1, 1, 1))
    col = g.mix(g.mul(n, 0.07), col, g.col(0.5, 0.02, 0.05))
    return col, g.add(0.28, g.mul(n, 0.1)), g.clamp01(g.add(g.mul(g.sub(1.0, ring), 0.0), g.add(0.55, g.mul(g.math('SINE', g.mul(d, TAU * 3.0)), 0.18))))


def ice(g):
    n1, n2 = g.noise(4), g.noise(30, 3)
    crack = g.edges(7)
    cr = g.lt(crack, 0.018)
    base = g.ramp(g.add(g.mul(n1, 0.6), g.mul(n2, 0.4)), [(0.2, S(0.62, 0.84, 0.95)), (0.8, S(0.86, 0.96, 1.0))])
    col = g.mix(g.mul(cr, 0.8), base, g.col(1, 1, 1))
    return col, g.add(0.08, g.mul(cr, 0.35)), g.clamp01(g.sub(g.add(0.6, g.mul(n2, 0.1)), g.mul(cr, 0.4)))


def slime(g):
    n1, n2 = g.noise(5, 3, 0.5, 0.6), g.noise(24, 2)
    bub = g.rampv(g.voronoi(10, 'F1'), [(0.0, S(1, 1, 1)), (0.12, S(0, 0, 0))])
    col = g.ramp(g.add(g.mul(n1, 0.7), g.mul(n2, 0.3)), [(0.2, S(0.25, 0.7, 0.08)), (0.8, S(0.55, 0.95, 0.2))])
    col = g.mix(g.mul(bub, 0.55), col, g.col(0.85, 1.0, 0.55))
    return col, g.sub(0.2, g.mul(bub, 0.1)), g.clamp01(g.add(g.mul(n1, 0.5), g.mul(bub, 0.4)))


def stripes(g):
    s = g.lt(g.fract(g.mul(g.add(g.u, g.v), 4.0)), 0.5)
    n1, n2 = g.noise(10, 3), g.noise(90, 2, 0.8)
    wear = g.rampv(n2, [(0.55, S(0, 0, 0)), (0.75, S(1, 1, 1))])
    col = g.mix(s, g.col(0.96, 0.72, 0.05), g.col(0.07, 0.07, 0.08))
    col = g.mix(g.mul(wear, 0.4), col, g.col(0.45, 0.45, 0.47))
    col = g.mix(g.mul(g.rampv(n1, [(0.4, S(0, 0, 0)), (0.9, S(1, 1, 1))]), 0.25), col, g.col(0.2, 0.15, 0.08))
    return col, g.add(0.42, g.mul(wear, -0.12)), g.clamp01(g.add(g.mul(n2, 0.3), 0.4))


def stripesRW(g):
    s = g.lt(g.fract(g.mul(g.add(g.u, g.v), 4.0)), 0.5)
    n2 = g.noise(90, 2, 0.8); n1 = g.noise(10, 3)
    col = g.mix(s, g.col(0.88, 0.14, 0.14), g.col(0.93, 0.93, 0.93))
    col = g.mix(g.mul(g.rampv(n1, [(0.4, S(0, 0, 0)), (0.9, S(1, 1, 1))]), 0.2), col, g.col(0.3, 0.25, 0.2))
    return col, g.add(0.38, g.mul(n2, 0.1)), g.clamp01(g.add(0.45, g.mul(n2, 0.2)))


def snow(g):
    n1, n2, n3 = g.noise(5), g.noise(40, 3), g.noise(220, 1, 0.8)
    spark = g.rampv(g.voronoi(90, 'F1'), [(0.0, S(1, 1, 1)), (0.05, S(0, 0, 0))])
    col = g.ramp(g.add(g.mul(n1, 0.5), g.mul(n2, 0.5)), [(0.2, S(0.8, 0.88, 0.96)), (0.8, S(0.97, 0.985, 1.0))])
    col = g.mix(g.mul(spark, 0.7), col, g.col(1, 1, 1))
    return col, g.add(0.8, g.mul(n3, 0.12)), g.clamp01(g.add(g.mul(n1, 0.4), g.mul(n2, 0.45)))


KINDS = dict(concrete=concrete, wood=wood, candy=candy, grass=grass, metal=metal, conveyor=conveyor, bounce=bounce, ice=ice, slime=slime,
             stripes=stripes, stripesRW=stripesRW, snow=snow)
METALNESS = dict(metal=0.8, conveyor=0.1, stripes=0.15)


def setup_scene(res):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import addon_utils; addon_utils.enable('cycles', default_set=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 6; sc.cycles.use_denoising = False
    sc.render.resolution_x = sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.cycles.filter_width = 1.0
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'; sc.render.image_settings.color_depth = '8'
    sc.display_settings.display_device = 'sRGB'
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0, 0))
    plane = bpy.context.active_object
    cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = 1.0
    co = bpy.data.objects.new('c', cam); co.location = (0, 0, 2); sc.collection.objects.link(co); sc.camera = co
    w = bpy.data.worlds.new('w'); w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (0, 0, 0, 1); sc.world = w
    return sc, plane


def render_kind(sc, plane, kind, out_dir, res):
    recipe = KINDS[kind]
    paths = {}
    for chan in ('albedo', 'rough', 'height'):
        mat = bpy.data.materials.new(f'{kind}-{chan}'); mat.use_nodes = True
        nt = mat.node_tree; nt.nodes.clear()
        g = G(nt); col, rough, height = recipe(g)
        em = nt.nodes.new('ShaderNodeEmission'); outn = nt.nodes.new('ShaderNodeOutputMaterial')
        src = {'albedo': col, 'rough': rough, 'height': height}[chan]
        nt.links.new(src, em.inputs['Color']); nt.links.new(em.outputs[0], outn.inputs['Surface'])
        plane.data.materials.clear(); plane.data.materials.append(mat)
        sc.view_settings.view_transform = 'Standard' if chan == 'albedo' else 'Raw'; sc.view_settings.look = 'None'
        p = os.path.join(out_dir, f'{kind}.{chan}.png'); sc.render.filepath = p
        bpy.ops.render.render(write_still=True); paths[chan] = p
    return paths
