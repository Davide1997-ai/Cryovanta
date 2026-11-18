"""
Build every Blender-made asset used by the game and write them into packages/client/public/assets.

    pip install bpy pillow numpy          # Blender as a Python module (Python 3.13 wheel for Blender 5.x)
    python tools/blender/build_assets.py [--models-only]

Outputs (committed, so players never need Blender):
    assets/models.glb                      hero meshes (robot parts, item box, hazards)
    assets/tex/<kind>.albedo.webp          1024 px colour           (+ <kind>.albedo.512.webp for phones)
    assets/tex/<kind>.height.webp / .rough.webp   grey maps      (+ .512 variants)
"""
import os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'packages', 'client', 'public', 'assets')
RES = int(os.environ.get('TEX_RES', '1024'))


def main():
    if '--models-only' in sys.argv:
        import meshes; os.makedirs(OUT, exist_ok=True); print('meshes ->', meshes.build_all(os.path.join(OUT, 'models.glb'))); return
    import tempfile
    from PIL import Image
    import textures, meshes
    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)
    t0 = time.time()
    print('meshes ->', meshes.build_all(os.path.join(OUT, 'models.glb')))
    tmp = tempfile.mkdtemp(prefix='cv-tex-')
    sc, plane = textures.setup_scene(RES)
    for kind in textures.KINDS:
        p = textures.render_kind(sc, plane, kind, tmp, RES)
        for size, suf in ((RES, ''), (512, '.512')):
            a = Image.open(p['albedo']).convert('RGB'); h = Image.open(p['height']).convert('L'); r = Image.open(p['rough']).convert('L')
            if size != RES: a, h, r = (im.resize((size, size), Image.LANCZOS) for im in (a, h, r))
            a.save(os.path.join(OUT, 'tex', f'{kind}.albedo{suf}.webp'), quality=88, method=6)
            h.convert('RGB').save(os.path.join(OUT, 'tex', f'{kind}.height{suf}.webp'), quality=90, method=6)
            r.convert('RGB').save(os.path.join(OUT, 'tex', f'{kind}.rough{suf}.webp'), quality=90, method=6)
        print(f'{kind:10s} done  ({time.time() - t0:5.1f}s)')


if __name__ == '__main__':
    main()
