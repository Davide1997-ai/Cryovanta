import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { registerBaked, type TexKind } from './textures';

/**
 * Blender-made assets (see tools/blender/build_assets.py): hero meshes in models.glb and baked PBR texture sets.
 * Everything is optional: if a file is missing or fails to load, the procedural fallback in textures.ts / robot.ts is used.
 */
export const models: Record<string, THREE.BufferGeometry> = {};

const KINDS: TexKind[] = ['concrete', 'wood', 'candy', 'grass', 'metal', 'conveyor', 'bounce', 'ice', 'slime', 'stripes', 'stripesRW', 'snow'];
const base = new URL('./assets/', document.baseURI).href;

function loadTex(url: string, srgb: boolean, aniso: number): Promise<THREE.Texture> {
  return new Promise((res, rej) => new THREE.TextureLoader().load(url, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; res(t);
  }, undefined, rej));
}

async function loadModels() {
  const gltf = await new GLTFLoader().loadAsync(base + 'models.glb');
  gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) models[m.name] = m.geometry; });
}

export async function loadAssets(lite: boolean, aniso: number): Promise<void> {
  // 512 px sets everywhere: 1024 px costs 4x the GPU memory/bandwidth for little visible gain at game camera distances (add ?hq for 1024)
  const suf = lite || !/[?&]hq\b/.test(location.search) ? '.512' : '';
  const jobs: Promise<unknown>[] = [loadModels().catch(() => { /* procedural robot/hazards stay */ })];
  for (const k of KINDS) {
    jobs.push(Promise.all([loadTex(`${base}tex/${k}.albedo${suf}.webp`, true, aniso), loadTex(`${base}tex/${k}.height${suf}.webp`, false, aniso), loadTex(`${base}tex/${k}.rough${suf}.webp`, false, aniso)])
      .then(([map, bump, rough]) => registerBaked(k, { map, bump, rough })).catch(() => { /* keep procedural texture for this kind */ }));
  }
  await Promise.all(jobs);
}
