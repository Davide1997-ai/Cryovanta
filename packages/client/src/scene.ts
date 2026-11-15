import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { platformCenter, type Course } from '@cryovanta/shared';

export const NEON = [0x00e5ff, 0xff3df2, 0x7cff3a, 0xffb020, 0x8a6bff, 0xff4d4d];

/** Sci-fi stage: floating metal slabs with neon trim, starfield sky, bloom. Pure view: owns no game state. */
export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  composer: EffectComposer;
  private courseGroup = new THREE.Group();
  private platMeshes: { mesh: THREE.Object3D; id: number }[] = [];
  boxMeshes: THREE.Object3D[] = [];
  private course: Course | null = null;
  private time = 0;
  /** phones/tablets: no post-processing, lower pixel ratio (battery + 7-player load) */
  readonly lite = matchMedia('(pointer: coarse)').matches;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.baseDpr = Math.min(devicePixelRatio, this.lite ? 1.5 : 2); this.renderer.setPixelRatio(this.baseDpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.85;
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; // clean studio reflections => "toy plastic / chrome" look
    this.scene.environmentIntensity = 0.35;
    this.scene.fog = new THREE.FogExp2(0x0a0b24, 0.007);
    this.scene.add(this.sky(), this.stars(), new THREE.HemisphereLight(0x9fb8ff, 0x2a1450, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(-20, 40, -10); this.scene.add(sun);
    this.scene.add(this.courseGroup);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 0.92));
    this.composer.addPass(new OutputPass());
    this.resize(); addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  private sky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x05061a) }, mid: { value: new THREE.Color(0x2a0f5c) }, bot: { value: new THREE.Color(0xff3df2) } },
      vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 p; void main(){ float h = p.y; vec3 c = h>0.0 ? mix(mid, top, pow(h,0.6)) : mix(mid, bot, pow(-h,0.5)); gl_FragColor = vec4(c,1.0); }',
    });
    return new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), mat);
  }
  private stars() {
    const n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(400); pos.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false }));
  }

  private matCache = new Map<string, THREE.Material>();
  private mat(key: string, make: () => THREE.Material) { let m = this.matCache.get(key); if (!m) { m = make(); this.matCache.set(key, m); } return m; }

  buildCourse(course: Course) {
    this.course = course;
    this.courseGroup.clear(); this.platMeshes = []; this.boxMeshes = [];
    const lite = this.lite;
    // Draw-call budget: one top mesh + one merged trim per platform on phones (was 8 per platform).
    const panel = this.mat('panel', () => new THREE.MeshStandardMaterial({ color: 0x1a2142, metalness: 0.55, roughness: 0.55 }));
    for (const p of course.platforms) {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2), panel);
      const col = p.kind === 'piston' ? 0xff4d4d : NEON[p.hue % NEON.length];
      const trimMat = this.mat('trim' + col, () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: col, emissiveIntensity: p.kind === 'piston' ? 2.4 : 1.8 }));
      // neon FRAME on the top face: 4 bars merged into ONE geometry => one draw call
      const t = 0.09, y = p.hy + 0.005, bars: THREE.BufferGeometry[] = [];
      const bar = (w: number, d: number, x: number, z: number) => { const bg = new THREE.BoxGeometry(w, 0.04, d); bg.translate(x, y, z); bars.push(bg); };
      bar(p.hx * 2, t, 0, p.hz - t / 2); bar(p.hx * 2, t, 0, -p.hz + t / 2); bar(t, p.hz * 2 - 2 * t, p.hx - t / 2, 0); bar(t, p.hz * 2 - 2 * t, -p.hx + t / 2, 0);
      const trim = new THREE.Mesh(mergeGeometries(bars)!, trimMat);
      g.add(top, trim);
      if (!lite) { // desktop-only extras
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(top.geometry), new THREE.LineBasicMaterial({ color: col })));
        const glow = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 1.4, 0.05, p.hz * 1.4), this.mat('glow' + col, () => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 })));
        glow.position.y = -p.hy - 0.03; g.add(glow);
      }
      this.courseGroup.add(g);
      this.platMeshes.push({ mesh: g, id: p.id });
    }
    // finish gate: neon arch
    const fz = course.finishZ, arch = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.5 });
    const L = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 0.4), m), R = L.clone(), T = new THREE.Mesh(new THREE.BoxGeometry(16.4, 0.5, 0.5), m);
    L.position.set(-8, 4, 0); R.position.set(8, 4, 0); T.position.set(0, 8, 0); arch.add(L, R, T);
    const goal = course.platforms[course.platforms.length - 1];
    arch.position.set(0, goal.y + goal.hy, fz); this.courseGroup.add(arch);
    // item boxes (shared geometry/materials; colour is animated per box)
    const cubeGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9), ringGeo = new THREE.TorusGeometry(0.75, 0.035, 6, 24), ringMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    for (const b of course.boxes) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff3df2, emissiveIntensity: 1.4, roughness: 0.2 }));
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2; g.add(cube, ring); g.position.set(b.x, b.y, b.z);
      this.courseGroup.add(g); this.boxMeshes[b.id] = g;
    }
    // distant floating decor (fewer on phones)
    const decorN = lite ? 8 : 26, decorGeo = new THREE.IcosahedronGeometry(1, 1), decorMat = new THREE.MeshStandardMaterial({ color: 0x1a1f44, metalness: 0.7, roughness: 0.4, flatShading: true });
    for (let i = 0; i < decorN; i++) {
      const k = lite ? 26 / decorN : 1, j = Math.floor(i * k);
      const m2 = new THREE.Mesh(decorGeo, decorMat); m2.scale.setScalar(3 + (j * 7919 % 13));
      m2.position.set((j % 2 ? 1 : -1) * (40 + (j * 31) % 55), -20 + ((j * 17) % 60), (j / 26) * (course.length + 60) - 20);
      this.courseGroup.add(m2);
    }
  }

  /** Moving platforms are a pure function of tick, so every client renders the identical motion. */
  syncPlatforms(tick: number) {
    if (!this.course) return;
    const c = { x: 0, y: 0, z: 0 };
    for (const pm of this.platMeshes) {
      const p = this.course.platforms[pm.id];
      if (p.kind === 'static') { if (pm.mesh.position.y !== p.y || pm.mesh.position.z !== p.z) pm.mesh.position.set(p.x, p.y, p.z); continue; }
      platformCenter(p, tick, c); pm.mesh.position.set(c.x, c.y, c.z);
    }
  }

  private tmpColor = new THREE.Color();
  animate(dt: number, hiddenBoxes: ReadonlySet<number> | number[]) {
    this.time += dt;
    const hidden = hiddenBoxes instanceof Set ? hiddenBoxes : new Set(hiddenBoxes);
    const cam = this.camera.position;
    this.boxMeshes.forEach((m, id) => {
      if (!m) return;
      const near = Math.abs(m.position.z - cam.z) < 90;
      m.visible = near && !hidden.has(id);
      if (!m.visible) return;
      m.rotation.y += dt * 1.6; m.rotation.x = Math.sin(this.time * 1.4 + id) * 0.3;
      this.tmpColor.setHSL((this.time * 0.25 + id * 0.13) % 1, 1, 0.55);
      ((m.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.copy(this.tmpColor);
    });
  }

  /** Dynamic resolution: trade sharpness for frame-rate so controls stay fluid on slow phones. */
  private baseDpr = 1; private dprScale = 1; private slowT = 0; private fastT = 0;
  adaptQuality(fps: number, dtSec: number) {
    if (!this.lite) return;
    if (fps < 42) { this.slowT += dtSec; this.fastT = 0; } else if (fps > 56) { this.fastT += dtSec; this.slowT = 0; } else { this.slowT = this.fastT = 0; }
    let changed = false;
    if (this.slowT > 1.5 && this.dprScale > 0.45) { this.dprScale = Math.max(0.45, this.dprScale * 0.8); this.slowT = 0; changed = true; }
    if (this.fastT > 5 && this.dprScale < 1) { this.dprScale = Math.min(1, this.dprScale * 1.15); this.fastT = 0; changed = true; }
    if (changed) { this.renderer.setPixelRatio(this.baseDpr * this.dprScale); this.renderer.setSize(innerWidth, innerHeight, false); }
  }

  render() { if (this.lite) this.renderer.render(this.scene, this.camera); else this.composer.render(); }
}
