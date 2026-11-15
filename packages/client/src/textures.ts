import * as THREE from 'three';

/**
 * Procedural PBR-ish textures (no image assets needed). Tileable value noise + feature drawing per material.
 * To go further toward photorealism, drop authored texture sets into the same slots (see docs/ARCHITECTURE.md).
 */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Tileable multi-octave value noise in [0,1]. */
function noise(size: number, seed: number, base = 8, octaves = 4): Float32Array {
  const out = new Float32Array(size * size), r = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = base << o, lat = new Float32Array(n * n); for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * n, fy = (y / size) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = lat[(y0 % n) * n + (x0 % n)], b = lat[(y0 % n) * n + ((x0 + 1) % n)], c = lat[((y0 + 1) % n) * n + (x0 % n)], d = lat[((y0 + 1) % n) * n + ((x0 + 1) % n)];
      out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export type TexKind = 'concrete' | 'wood' | 'candy' | 'grass' | 'metal' | 'conveyor' | 'bounce' | 'ice' | 'slime' | 'stripes' | 'snow' | 'stripesRW';
interface Spec { base: [number, number, number]; vary: number; rough: number; metal: number }
export const SPEC: Record<TexKind, Spec> = {
  concrete: { base: [160, 160, 154], vary: 38, rough: 0.9, metal: 0 }, wood: { base: [168, 116, 66], vary: 30, rough: 0.7, metal: 0 },
  candy: { base: [255, 92, 138], vary: 6, rough: 0.35, metal: 0 }, grass: { base: [84, 160, 58], vary: 44, rough: 0.95, metal: 0 },
  metal: { base: [112, 118, 130], vary: 26, rough: 0.38, metal: 0.85 }, conveyor: { base: [46, 48, 56], vary: 16, rough: 0.6, metal: 0.3 },
  bounce: { base: [230, 57, 70], vary: 10, rough: 0.28, metal: 0 }, ice: { base: [185, 232, 245], vary: 20, rough: 0.1, metal: 0.05 },
  slime: { base: [112, 224, 58], vary: 26, rough: 0.12, metal: 0 }, stripes: { base: [250, 200, 20], vary: 4, rough: 0.5, metal: 0.2 },
  snow: { base: [236, 242, 248], vary: 14, rough: 0.85, metal: 0 }, stripesRW: { base: [235, 235, 235], vary: 4, rough: 0.4, metal: 0.1 },
};

const cache = new Map<string, { map: THREE.CanvasTexture; bump: THREE.CanvasTexture }>();

export function surfaceTexture(kind: TexKind, size = 256): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const key = kind + size; const hit = cache.get(key); if (hit) return hit;
  const sp = SPEC[kind], seed = kind.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const n1 = noise(size, seed, 6, 4), n2 = noise(size, seed + 99, 24, 2), r = rng(seed + 5);
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d')!;
  const img = g.createImageData(size, size), hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x; let v = (n1[i] - 0.5) * sp.vary * 2 + (n2[i] - 0.5) * sp.vary * 0.8;
    let [R, G, B] = sp.base; let h = n1[i] * 0.6 + n2[i] * 0.4;
    if (kind === 'wood') { const plank = Math.floor(y / (size / 4)), grain = Math.sin((x / size) * 38 + n1[i] * 9 + plank * 3) * 0.5 + 0.5; v += (grain - 0.5) * 34 + (plank % 2 ? 10 : -8); h = grain * 0.5 + h * 0.3; if (y % (size / 4) < 3) { v -= 60; h = 0; } }
    if (kind === 'concrete') { if (x % (size / 2) < 2 || y % (size / 2) < 2) { v -= 45; h = 0.05; } }
    if (kind === 'candy') { const chk = (Math.floor(x / (size / 4)) + Math.floor(y / (size / 4))) % 2; if (chk) { R = 255; G = 241; B = 246; } }
    if (kind === 'metal') { const rivet = ((x % 32) - 16) ** 2 + ((y % 32) - 16) ** 2 < 14; if (rivet) { v += 38; h = 1; } v += (n2[i] - 0.5) * 30; }
    if (kind === 'stripes' || kind === 'stripesRW') { const s = ((x + y) / (size / 4)) % 1 < 0.5; if (kind === 'stripes') { if (s) { R = 24; G = 24; B = 26; } } else if (s) { R = 220; G = 40; B = 40; } }
    if (kind === 'bounce') { const d = Math.hypot(x - size / 2, y - size / 2), ring = Math.sin(d / 9) > 0.6; if (ring) { R = 255; G = 255; B = 255; } h = 0.5 + Math.sin(d / 9) * 0.2; }
    if (kind === 'conveyor') { const cy = (y / (size / 4)) % 1, cx = Math.abs((x / size) % 1 - 0.5) * 2; const chevron = Math.abs(cy - 0.25 - cx * 0.35) < 0.07; if (chevron) { R = 250; G = 200; B = 30; h = 0.9; } }
    if (kind === 'slime') h = 0.5 + Math.sin(n1[i] * 20) * 0.2;
    const k = 1 + v / 255;
    img.data[i * 4] = Math.max(0, Math.min(255, R * k)); img.data[i * 4 + 1] = Math.max(0, Math.min(255, G * k)); img.data[i * 4 + 2] = Math.max(0, Math.min(255, B * k)); img.data[i * 4 + 3] = 255;
    hgt[i] = h;
  }
  g.putImageData(img, 0, 0);
  if (kind === 'ice') { g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2; for (let i = 0; i < 14; i++) { let x = r() * size, y = r() * size; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (r() - 0.5) * 70; y += (r() - 0.5) * 70; g.lineTo(x, y); } g.stroke(); } }
  if (kind === 'slime') { g.fillStyle = 'rgba(210,255,150,.55)'; for (let i = 0; i < 26; i++) { g.beginPath(); g.arc(r() * size, r() * size, 2 + r() * 6, 0, 7); g.fill(); } }
  if (kind === 'grass') { g.strokeStyle = 'rgba(30,90,20,.35)'; for (let i = 0; i < 500; i++) { const x = r() * size, y = r() * size; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 5); g.stroke(); } }
  // bump map from the height field
  const b = document.createElement('canvas'); b.width = b.height = size; const bg = b.getContext('2d')!, bi = bg.createImageData(size, size);
  for (let i = 0; i < size * size; i++) { const v = Math.max(0, Math.min(255, hgt[i] * 255)); bi.data[i * 4] = bi.data[i * 4 + 1] = bi.data[i * 4 + 2] = v; bi.data[i * 4 + 3] = 255; }
  bg.putImageData(bi, 0, 0);
  const mk = (cv: HTMLCanvasElement, srgb: boolean) => { const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const out = { map: mk(c, true), bump: mk(b, false) }; cache.set(key, out); return out;
}

/** Tileable water normal map (from a height field). */
export function waterNormal(size = 256): THREE.CanvasTexture {
  const h = noise(size, 4242, 8, 4), c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d')!, img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const l = h[y * size + ((x + size - 1) % size)], r = h[y * size + ((x + 1) % size)], u = h[((y + size - 1) % size) * size + x], d = h[((y + 1) % size) * size + x];
    const nx = (l - r) * 6, ny = (u - d) * 6, nz = 1, len = Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
    img.data[i] = (nx / len * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / len * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

export function cloudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d')!, r = rng(11);
  for (let i = 0; i < 26; i++) { const x = 40 + r() * 176, y = 50 + r() * 40, rad = 18 + r() * 34, gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Soft translucent streak texture for wind zones. */
export function windTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d')!, r = rng(3);
  for (let i = 0; i < 18; i++) { const y = r() * 64, x = r() * 256, l = 40 + r() * 110, gr = g.createLinearGradient(x, 0, x + l, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x, y, l, 1.6 + r() * 1.5); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

/** Scale a BoxGeometry's UVs to world size so texel density is constant regardless of the box dimensions. */
export function scaleBoxUV(geo: THREE.BoxGeometry, hx: number, hy: number, hz: number, tile = 4) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // face order in BoxGeometry: +x, -x, +y, -y, +z, -z ; each has 4 vertices
  const dims: [number, number][] = [[hz, hy], [hz, hy], [hx, hz], [hx, hz], [hx, hy], [hx, hy]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * dims[f][0] * 2 / tile, uv.getY(i) * dims[f][1] * 2 / tile); }
  uv.needsUpdate = true;
}
