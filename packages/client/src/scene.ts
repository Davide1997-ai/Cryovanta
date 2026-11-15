import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.lite ? 1.25 : 2));
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

  buildCourse(course: Course) {
    this.course = course;
    this.courseGroup.clear(); this.platMeshes = []; this.boxMeshes = [];
    const panel = new THREE.MeshStandardMaterial({ color: 0x1a2142, metalness: 0.55, roughness: 0.55 });
    const under = new THREE.MeshStandardMaterial({ color: 0x0c0f24, metalness: 0.6, roughness: 0.5 });
    for (const p of course.platforms) {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2), [panel, panel, panel, under, panel, panel]);
      const col = p.kind === 'piston' ? 0xff4d4d : NEON[p.hue % NEON.length];
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(top.geometry), new THREE.LineBasicMaterial({ color: col }));
      // glowing slab trim: a thin neon FRAME on the top face (4 bars), what bloom picks up
      const trimMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: col, emissiveIntensity: p.kind === 'piston' ? 2.4 : 1.8 });
      const trim = new THREE.Group(), t = 0.09, y = p.hy + 0.005;
      const bar = (w: number, d: number, x: number, z: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), trimMat); m.position.set(x, y, z); trim.add(m); };
      bar(p.hx * 2, t, 0, p.hz - t / 2); bar(p.hx * 2, t, 0, -p.hz + t / 2); bar(t, p.hz * 2 - 2 * t, p.hx - t / 2, 0); bar(t, p.hz * 2 - 2 * t, -p.hx + t / 2, 0);
      // under-glow strip: sells the "floating platform" read
      const glow = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 1.4, 0.05, p.hz * 1.4), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 }));
      glow.position.y = -p.hy - 0.03;
      g.add(top, edge, trim, glow);
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
    // item boxes
    for (const b of course.boxes) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xff3df2, emissiveIntensity: 1.4, roughness: 0.1, transmission: 0, clearcoat: 1 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.035, 8, 40), new THREE.MeshBasicMaterial({ color: 0x00e5ff }));
      ring.rotation.x = Math.PI / 2; g.add(cube, ring); g.position.set(b.x, b.y, b.z);
      this.courseGroup.add(g); this.boxMeshes[b.id] = g;
    }
    // distant floating decor so the void feels like a station, not a void
    for (let i = 0; i < 26; i++) {
      const s = 3 + (i * 7919 % 13);
      const m2 = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), new THREE.MeshStandardMaterial({ color: 0x1a1f44, metalness: 0.7, roughness: 0.4, flatShading: true }));
      const side = i % 2 ? 1 : -1;
      m2.position.set(side * (40 + (i * 31) % 55), -20 + ((i * 17) % 60), (i / 26) * (course.length + 60) - 20);
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

  animate(dt: number, hiddenBoxes: Set<number>) {
    this.time += dt;
    this.boxMeshes.forEach((m, id) => {
      if (!m) return;
      m.visible = !hiddenBoxes.has(id);
      m.rotation.y += dt * 1.6; m.rotation.x = Math.sin(this.time * 1.4 + id) * 0.3; m.position.y += Math.sin(this.time * 2 + id) * 0.0025;
      const c = new THREE.Color().setHSL((this.time * 0.25 + id * 0.13) % 1, 1, 0.55);
      ((m.children[0] as THREE.Mesh).material as THREE.MeshPhysicalMaterial).emissive.copy(c);
    });
  }

  render() { if (this.lite) this.renderer.render(this.scene, this.camera); else this.composer.render(); }
}
